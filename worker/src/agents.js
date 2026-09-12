/**
 * The daily agents (§34): three sequential steps that rebuild the World
 * Overview, on the daily cron or on demand, entirely inside the Worker.
 *
 *   1. Dados       — retrieve every monitored indicator, the curated events,
 *                    the events generated from significant moves, and, with a
 *                    model, today's news — each with a source record
 *   2. Inferência  — the model reads what agent 1 gathered and decides what
 *                    matters for this advisor's book; it writes the day's
 *                    summary and the What Matters rows in Portuguese. Without
 *                    a model, a template ranks the same rows by rule
 *   3. Gatilhos    — thresholds and allocation drift against each policy, with
 *                    a proximity so the portal draws them as bars and says
 *                    plainly when an action is due
 *
 * Progress is written to overview_runs after every meaningful sub-step so the
 * person waiting sees what is happening. A manual refresh replaces the day's
 * result; the portal always reads the last completed run.
 *
 * The pipeline runs as a Cloudflare Workflow — one durable step per agent —
 * because work started from an HTTP request is cut off after thirty seconds,
 * and a day's run with a model and a news scan takes longer than that. The
 * Workflow survives the advisor closing the tab; the cron and the button both
 * start one. Without the binding (a local run without it) the same three
 * functions run in-process.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { all, first, run, id, json, nowIso, audit, currentSnapshot, snapshotPositions, currentPolicy } from './db.js';
import * as P from './pipeline.js';
import * as LLM from './llm.js';
import * as S from './series.js';
import { INDICATORS, MACRO_VINTAGE } from '../../seed/market.mjs';
import { indicatorQuote } from '../../src/adapters/marketdata.js';
import * as Valor from '../../src/adapters/valor.js';
import * as Google from '../../src/adapters/googlenews.js';
import * as Bing from '../../src/adapters/bingnews.js';
import { monthToDate } from '../../src/adapters/yahoo.js';
import { triggerProximity } from '../../src/core/triggers.js';
import { makeSource } from '../../src/core/sources.js';
import { percent, num, pp, monthLabel } from '../../src/core/format.js';

export const AGENTS = [
  { step: 1, key: 'dados', title: 'Agente 1 · Dados', what: 'indicadores, eventos e notícias, cada um com a fonte' },
  { step: 2, key: 'inferencia', title: 'Agente 2 · Inferência', what: 'o que importa hoje para as suas carteiras' },
  { step: 3, key: 'gatilhos', title: 'Agente 3 · Gatilhos', what: 'limiares de mercado e desvios de alocação' },
];
const STALE_MS = 10 * 60 * 1000;
/** Nothing older than this reaches "O que importa hoje": a headline, a scanned story or a curated event. */
const NEWS_WINDOW_HOURS = 48;
const ASSET_CLASSES = ['Cash', 'Fixed Income', 'Equities BR', 'Equities Global', 'Alternatives', 'Real Estate', 'Commodities', 'Digital Assets'];
const CATEGORIES = new Set(['equities', 'rates', 'credit', 'fx', 'commodities', 'macro', 'politics', 'geopolitics', 'crypto', 'market_move']);
const IMPORTANCE = { high: 0, medium: 1, low: 2 };
const WHAT_MATTERS_ROWS = 10;

const today = () => new Date().toISOString().slice(0, 10);
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isStale = (row) => row.status === 'running' && Date.now() - Date.parse(row.started_at) > STALE_MS;

/** What the portal sees of a run. A run that stopped reporting is shown as failed. */
export function runView(row) {
  if (!row) return null;
  const stale = isStale(row);
  return {
    id: row.id, date: row.date, trigger: row.trigger,
    status: stale ? 'failed' : row.status,
    step: row.step, progress: row.progress, message: row.message,
    error: stale ? 'sem progresso há mais de dez minutos' : row.error,
    started_at: row.started_at, finished_at: row.finished_at,
    log: json(row.log_json, []),
    agents: AGENTS,
  };
}

export async function latestRun(db, advisorId, { status = null } = {}) {
  return status
    ? first(db, 'SELECT * FROM overview_runs WHERE advisor_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1', advisorId, status)
    : first(db, 'SELECT * FROM overview_runs WHERE advisor_id = ? ORDER BY started_at DESC LIMIT 1', advisorId);
}

/**
 * Start a run in the background and return its row at once. A run already in
 * progress for this advisor is returned instead of starting a second one; a
 * run that stopped reporting is marked failed and replaced.
 */
export async function startOverviewRun(env, ctx, { advisor, trigger, actorId = null }) {
  const db = env.DB;
  const active = await latestRun(db, advisor.id, { status: 'running' });
  if (active && !isStale(active)) return runView(active);
  if (active) await run(db, 'UPDATE overview_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?', 'failed', 'abandonada: sem progresso há mais de dez minutos', nowIso(), active.id);

  const runId = id('run');
  await run(db,
    'INSERT INTO overview_runs (id, advisor_id, date, trigger, status, step, progress, message, actor_id, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    runId, advisor.id, today(), trigger, 'running', 0, 0, 'Na fila', actorId, nowIso());
  if (env.OVERVIEW_AGENTS) {
    await env.OVERVIEW_AGENTS.create({ id: runId, params: { runId } });
  } else {
    const job = runOverviewPipeline(env, runId).catch((err) => console.error('overview run failed', err?.stack || err));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
  return runView(await first(db, 'SELECT * FROM overview_runs WHERE id = ?', runId));
}

/** The Workflow: three durable steps. Each agent records its own failure, so a step that throws is not retried. */
export class OverviewAgents extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId } = event.payload;
    const guard = (fn) => async () => {
      try { return await fn(); } catch (err) { throw new NonRetryableError(String(err?.message || err)); }
    };
    const opts = { timeout: '10 minutes', retries: { limit: 0, delay: '1 second' } };
    const s1 = await step.do('dados', opts, guard(() => agentDados(this.env, runId)));
    if (!s1) return;
    const s2 = await step.do('inferencia', opts, guard(() => agentInferencia(this.env, runId, s1)));
    if (!s2) return;
    await step.do('gatilhos', opts, guard(() => agentGatilhos(this.env, runId, s2)));
  }
}

/** The same three agents, in-process, for a runtime without the Workflow binding. */
export async function runOverviewPipeline(env, runId) {
  const s1 = await agentDados(env, runId);
  if (!s1) return;
  const s2 = await agentInferencia(env, runId, s1);
  if (!s2) return;
  await agentGatilhos(env, runId, s2);
}

// ── the run's bookkeeping ─────────────────────────────────────────────────────
async function loadRun(db, runId) {
  const row = await first(db, 'SELECT * FROM overview_runs WHERE id = ?', runId);
  if (!row) throw new Error(`run ${runId} not found`);
  const advisor = await first(db, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id WHERE a.id = ?', row.advisor_id);
  const log = json(row.log_json, []);
  const report = async (step, progress, message, detail = null) => {
    log.push({ at: nowIso(), step, message, detail });
    await run(db, 'UPDATE overview_runs SET step = ?, progress = ?, message = ?, log_json = ? WHERE id = ?',
      step, Math.round(progress), message, JSON.stringify(log.slice(-80)), runId);
  };
  const fail = async (err) => {
    console.error('overview pipeline', err?.stack || err);
    await run(db, 'UPDATE overview_runs SET status = ?, error = ?, finished_at = ?, log_json = ? WHERE id = ?',
      'failed', String(err?.message || err), nowIso(), JSON.stringify(log.slice(-80)), runId);
  };
  return { row, advisor, log, report, fail };
}

/** 1 · Dados — everything the day rests on, each with a source record. */
async function agentDados(env, runId) {
  const db = env.DB;
  const { row, advisor, report, fail } = await loadRun(db, runId);
  const date = today();
  try {
    P.attachKv(env);
    // The Worker may make fifty outbound calls per run, all three agents
    // included. A Yahoo indicator therefore costs one call: the daily history
    // in R2 is brought up to date and the quote is read off that same
    // response; the quote endpoint is asked only when the store was already
    // fresh and nothing was fetched.
    const indicators = [];
    const series = new Map();
    for (let i = 0; i < INDICATORS.length; i += 1) {
      const ind = INDICATORS[i];
      await report(1, 2 + (i / INDICATORS.length) * 24, `Agente 1 · Dados — consultando ${providerOf(ind)}: ${ind.label} (${i + 1} de ${INDICATORS.length})`);
      if (ind.yahoo_symbol) {
        let s = null;
        try { s = await S.ensureSeries(env, ind); } catch { /* the quote endpoint still answers */ }
        if (s && !s.unavailable) series.set(ind.key, s);
        const fromSeries = quoteFromSeries(ind, s);
        indicators.push(fromSeries || await indicatorQuote(ind));
      } else {
        indicators.push(await indicatorQuote(ind));
      }
    }
    const retrieved = indicators.filter((i) => !i.unavailable).length;
    await report(1, 26, `Agente 1 · Dados — ${retrieved} de ${indicators.length} indicadores recuperados (${indicators.filter((i) => i.from_series).length} cotações lidas da própria série diária); medindo 5 sessões e 30 dias nas séries em R2`);
    await windowMoves(env, indicators, series);
    // The signal dashboard reads the newest capture per instrument; without this it would show the capture made at seed time forever.
    await report(1, 27, 'Agente 1 · Dados — recapturando na TradingView a leitura técnica e o consenso de analistas de cada instrumento');
    let signalsCaptured = 0;
    try {
      const assets = await all(db, 'SELECT * FROM assets WHERE tv_symbol IS NOT NULL');
      signalsCaptured = Object.keys(await P.fetchSignals(env, assets)).length;
    } catch (err) {
      await report(1, 27, `Agente 1 · Dados — sinais da TradingView indisponíveis nesta execução (${String(err.message).slice(0, 80)}); o painel segue com a captura anterior`);
    }
    await report(1, 28, `Agente 1 · Dados — ${signalsCaptured} sinais recapturados; lendo os eventos curados das últimas 48 horas e os movimentos que se destacam em 5 sessões ou 30 dias`);
    const curated = (await P.loadMarketEvents(env, { since: addDays(date, -1), limit: 20 })).filter((e) => withinNewsWindow(e.date, date));
    const generated = P.eventsFromIndicatorMoves(indicators, { window: 'notable' });

    // The headlines come from newsrooms, not from a search: Valor Econômico's own feeds and the Google News feeds, Brazil and abroad.
    await report(1, 29, 'Agente 1 · Dados — lendo as manchetes das últimas 48 horas: Valor Econômico (RSS) e Google News (Brasil e internacional)');
    const brazil = await gatherHeadlines(env, { date, modelOn: !!env.ANTHROPIC_API_KEY || !!env.OPENAI_API_KEY, report });

    let newsEvents = []; let newsSources = [];
    let news = { mode: 'skipped', reason: 'sem modelo de linguagem configurado — defina ANTHROPIC_API_KEY para a varredura da imprensa internacional com fontes citadas', items: [], dropped: [], searches: 0 };
    if (env.ANTHROPIC_API_KEY) {
      await report(1, 37, 'Agente 1 · Dados — o modelo varre a imprensa internacional na web e cita a fonte de cada item');
      try {
        const facts = { date, indicator_keys: INDICATORS.map((i) => i.key), asset_classes: ASSET_CLASSES };
        let scan;
        try {
          scan = await LLM.scanNews(env, facts);
        } catch (err) {
          // A gateway timeout on a search-heavy turn is the usual failure; one more try, with fewer searches.
          if (!/\b5\d\d\b|timeout|timed out|abort/i.test(err.message)) throw err;
          await report(1, 41, `Agente 1 · Dados — a varredura na web falhou (${err.message.slice(0, 60)}); tentando de novo com menos buscas`);
          scan = await LLM.scanNews(env, facts, { maxSearches: 2 });
        }
        // The model is asked for the last 48 hours; whatever it brings from before that is dropped here, and the drop is recorded.
        const fresh = scan.items.filter((it) => withinNewsWindow(it.date, date));
        const stale = scan.items.filter((it) => !withinNewsWindow(it.date, date)).map((it) => ({ title: it.title || '(sem título)', reason: `mais de ${NEWS_WINDOW_HOURS} horas (${it.date})` }));
        ({ events: newsEvents, sources: newsSources } = newsToEvents(fresh, date));
        news = { mode: 'model', model: scan.model, searches: scan.searches, items: newsEvents.map(compactNews), dropped: [...scan.dropped, ...stale], urls: scan.urls };
        await report(1, 44, `Agente 1 · Dados — ${newsEvents.length} notícias internacionais com fonte verificada em ${scan.searches} buscas${scan.dropped.length ? `; ${scan.dropped.length} descartadas por falta de fonte` : ''}`);
      } catch (err) {
        news = { mode: 'failed', reason: err.message, items: [], dropped: [], searches: 0 };
        await report(1, 44, `Agente 1 · Dados — varredura internacional indisponível (${err.message.slice(0, 80)}); seguindo com as manchetes do Valor, indicadores e eventos curados`);
      }
    }
    news.headlines = brazil.meta;
    await report(1, 47, 'Agente 1 · Dados — mapeando a exposição de cada carteira por classe de ativo');
    const { clients, portfolios } = await bookExposures(db, advisor.id);
    const events = dedupeEvents([...brazil.events, ...curated, ...generated, ...newsEvents]);
    const triggerEvals = await P.evaluateTriggers(env, indicators, advisor.id);
    const sources = [...indicators.filter((i) => i.source).map((i) => i.source), ...brazil.sources, ...newsSources];
    return { date, advisorId: advisor.id, actorId: row.actor_id, trigger: row.trigger, indicators, retrieved, events, clients, portfolios, triggerEvals, sources, news };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 2 · Inferência — what matters for this book today, written in Portuguese. */
async function agentInferencia(env, runId, s) {
  const db = env.DB;
  const { report, fail } = await loadRun(db, runId);
  try {
    const modelOn = LLM.llmAvailable(env);
    await report(2, 52, modelOn
      ? `Agente 2 · Inferência — o modelo lê ${s.events.length} eventos, ${s.retrieved} indicadores e ${s.portfolios.length} carteiras e decide o que importa hoje`
      : `Agente 2 · Inferência — sem modelo configurado: ordenando ${s.events.length} eventos por relevância e exposição`);
    const baseRows = P.buildWhatMattersTable(s.events, s.indicators, s.portfolios);
    const facts = inferenceFacts({ date: s.date, indicators: s.indicators, triggers: s.triggerEvals, events: s.events, portfolios: s.portfolios, baseRows });
    let inference; let mode = 'deterministic_template'; let model = null; let promptVersion = null;
    if (modelOn) {
      try {
        const r = await LLM.runPrompt(env, 'advisor_daily_inference', facts, { maxTokens: 7000 });
        inference = r.data; mode = 'model'; model = r.model; promptVersion = r.prompt_version;
      } catch (err) {
        inference = LLM.deterministicDailyInference(facts);
        inference.fallback_reason = err.message;
        await report(2, 70, `Agente 2 · Inferência — o modelo falhou (${err.message.slice(0, 80)}); usando o texto determinístico`);
      }
    } else {
      inference = LLM.deterministicDailyInference(facts);
    }
    await report(2, 74, 'Agente 2 · Inferência — escrevendo o resumo do dia e a tabela do que importa');
    const whatMatters = mergeInference(baseRows, inference, s.events);
    const worldView = await upsertWorldView(db, s.advisorId, s.date, inference, { mode, model, promptVersion, news: s.news, sources: s.sources });
    return { ...s, whatMatters, worldView, inference: { mode, model, prompt_version: promptVersion, fallback_reason: inference.fallback_reason ?? null } };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 3 · Gatilhos — thresholds and drift, with a proximity, and the finished payload. */
async function agentGatilhos(env, runId, s) {
  const db = env.DB;
  const { advisor, log, report, fail } = await loadRun(db, runId);
  try {
    await report(3, 82, `Agente 3 · Gatilhos — avaliando ${s.triggerEvals.length} limiares de mercado contra ${s.portfolios.length} carteiras`);
    const exposures = s.portfolios.map((p) => ({ client_id: p.client_id, client_name: p.client_name, exposures: p.portfolio.exposures }));
    const triggers = P.mapTriggersToClients(s.triggerEvals, exposures).map((t) => ({
      ...t, proximity: triggerProximity(t), action_due: t.status === 'BREACHED',
    }));
    await report(3, 90, 'Agente 3 · Gatilhos — medindo os desvios de alocação contra a política de cada cliente');
    const driftAlerts = [];
    for (const c of s.clients) {
      const policy = await currentPolicy(db, c.id);
      const p = s.portfolios.find((x) => x.client_id === c.id);
      if (!policy || !p) continue;
      const thresholdPp = policy.rebalance_trigger ?? 0.05;
      for (const d of P.driftTriggers(p.portfolio.exposures, policy.target_allocation, thresholdPp)) {
        driftAlerts.push({ ...d, client_id: c.id, client_name: c.full_name, threshold_pp: thresholdPp, ratio: Math.abs(d.drift) / thresholdPp, action_due: true });
      }
    }
    const breached = triggers.filter((t) => t.status === 'BREACHED').length;
    await report(3, 96, `Agente 3 · Gatilhos — ${breached} ${breached === 1 ? 'limiar rompido' : 'limiares rompidos'}, ${driftAlerts.length} ${driftAlerts.length === 1 ? 'desvio' : 'desvios'} além do gatilho de rebalanceamento`);

    const news = s.news;
    const hl = news.headlines || null;
    const result = {
      date: s.date,
      advisor: { id: advisor.id, name: advisor.name, code: advisor.advisor_code, team: advisor.team },
      world_view: s.worldView,
      indicators: s.indicators.map(compactIndicator),
      triggers,
      drift_alerts: driftAlerts,
      what_matters: s.whatMatters,
      clients_count: s.clients.length,
      sources: s.sources,
      news: {
        mode: news.mode, model: news.model ?? null, reason: news.reason ?? null, searches: news.searches ?? 0, kept: news.items?.length ?? 0, dropped: news.dropped ?? [],
        headlines: hl ? { provider: hl.provider, providers: hl.providers ?? [], window_hours: hl.window_hours ?? NEWS_WINDOW_HOURS, mode: hl.mode, reason: hl.reason ?? null, feeds: hl.feeds, items: hl.items, clusters: hl.clusters, kept: hl.kept, classified_by: hl.classified_by, model: hl.model ?? null, dropped: hl.dropped ?? [], top_story: hl.top_story ?? null } : null,
      },
      inference: s.inference,
      events_count: s.events.length,
    };
    await run(db, 'UPDATE overview_runs SET status = ?, step = 4, progress = 100, message = ?, result_json = ?, finished_at = ?, log_json = ? WHERE id = ?',
      'completed', 'Concluído', JSON.stringify(result), nowIso(), JSON.stringify([...log, { at: nowIso(), step: 4, message: 'Concluído' }].slice(-80)), runId);
    await audit(db, { entity: 'overview_run', entity_id: runId, action: 'completed', actor_id: s.actorId, detail: { trigger: s.trigger, inference: s.inference.mode, news: news.mode, breached, drifts: driftAlerts.length } });
    return { ok: true };
  } catch (err) {
    await fail(err);
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const providerOf = (ind) => (ind.coingecko_id ? 'CoinGecko' : ind.yahoo_symbol ? 'Yahoo Finance' : 'Banco Central do Brasil');

/** A date (or timestamp) is news when it falls inside the window ending today; a bare date counts from its midnight. */
function withinNewsWindow(when, today) {
  if (!when) return false;
  const stamp = String(when).length > 10 ? Date.parse(when) : Date.parse(`${String(when).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(stamp)) return false;
  const end = Date.parse(`${today}T23:59:59Z`);
  return stamp >= end - NEWS_WINDOW_HOURS * 3600 * 1000 && stamp <= end;
}

/**
 * The day move comes with the quote. The five-session and thirty-day moves
 * come from the daily histories kept in R2 (worker/src/series.js), measured
 * on the unadjusted close like the indicators strip, so the table and the
 * strip can never disagree about the same window. A series that fails leaves
 * the indicator with its day move only.
 */
async function windowMoves(env, indicators, series = new Map()) {
  for (const ind of indicators) {
    const def = INDICATORS.find((i) => i.key === ind.key);
    if (ind.unavailable || !def?.yahoo_symbol) continue;
    try {
      const s = series.get(ind.key) || await S.ensureSeries(env, def);
      if (s.unavailable) continue;
      const v5 = S.windowView(s, S.windowBounds('5d'));
      const v30 = S.windowView(s, S.windowBounds('30d'));
      ind.d5Pct = v5?.change_pct ?? null; ind.d5From = v5?.start.date ?? null;
      ind.d30Pct = v30?.change_pct ?? null; ind.d30From = v30?.start.date ?? null;
      ind.windowsAsOf = (v30 || v5)?.end.date ?? null;
    } catch { /* the day move stands on its own */ }
  }
}

/** The indicator record built from a series refresh that carried the live quote; null when there was no fetch this run. */
function quoteFromSeries(ind, s) {
  const q = s?.live_quote;
  if (!q || !Number.isFinite(q.price)) return null;
  const bars = (s.points || []).map((p) => ({ date: p.date, close: p.close }));
  const mtd = monthToDate(bars, q.price, q.asOf.slice(0, 7));
  return {
    key: ind.key, label: ind.label, unit: ind.unit,
    symbol: ind.yahoo_symbol, name: s.name || ind.label, currency: s.currency || null,
    price: q.price, changePct: q.changePct, mtdPct: mtd.pct, mtdFrom: mtd.from, asOf: q.asOf,
    from_series: true,
    source: makeSource({
      provider: 'Yahoo Finance', kind: 'market_price', instrument: s.name || ind.label, identifier: ind.yahoo_symbol,
      requested_range: 'daily history, refreshed today', last_observation: q.asOf,
      reference: `https://finance.yahoo.com/quote/${encodeURIComponent(ind.yahoo_symbol)}`,
      notes: 'cotação lida da mesma resposta que atualizou a série diária mantida em R2',
    }),
  };
}

async function bookExposures(db, advisorId) {
  const clients = await all(db, 'SELECT * FROM clients WHERE advisor_id = ?', advisorId);
  const portfolios = [];
  for (const c of clients) {
    const snap = await currentSnapshot(db, c.id);
    if (!snap) continue;
    const positions = await snapshotPositions(db, snap.id);
    const total = positions.reduce((a, p) => a + (p.market_value || 0), 0) || 1;
    const exposures = {};
    for (const p of positions) exposures[p.asset_class] = (exposures[p.asset_class] ?? 0) + (p.market_value || 0) / total;
    portfolios.push({
      client_id: c.id,
      client_name: c.full_name,
      portfolio: {
        exposures,
        base_currency: c.base_currency,
        positions: positions.map((p) => ({ ticker: p.ticker, asset_id: p.asset_id, asset_class: p.asset_class, weight: (p.market_value || 0) / total, currency: p.currency })),
      },
    });
  }
  return { clients, portfolios };
}

// ── Brazil: Valor Econômico's headlines ───────────────────────────────────────

/** How a news host is named on the portal. The reader should see a newspaper, not a domain. */
const PROVIDER_NAMES = [
  [/valor\.globo\.com/, 'Valor Econômico'], [/g1\.globo\.com/, 'g1'], [/oglobo\.globo\.com/, 'O Globo'],
  [/folha\.uol\.com\.br/, 'Folha de S.Paulo'], [/estadao\.com\.br/, 'Estadão'], [/infomoney\.com\.br/, 'InfoMoney'],
  [/exame\.com/, 'Exame'], [/cnnbrasil\.com\.br/, 'CNN Brasil'], [/poder360\.com\.br/, 'Poder360'], [/bcb\.gov\.br/, 'Banco Central do Brasil'],
  [/reuters\.com/, 'Reuters'], [/bloomberg\.com/, 'Bloomberg'], [/ft\.com/, 'Financial Times'], [/wsj\.com/, 'The Wall Street Journal'],
  [/finance\.yahoo\.com/, 'Yahoo Finance'], [/tradingeconomics\.com/, 'Trading Economics'], [/tradingview\.com/, 'TradingView'],
  [/federalreserve\.gov/, 'Federal Reserve'], [/bls\.gov/, 'U.S. Bureau of Labor Statistics'], [/cnbc\.com/, 'CNBC'], [/investing\.com/, 'Investing.com'],
];
export function providerName(host) {
  const hit = PROVIDER_NAMES.find(([re]) => re.test(host));
  return hit ? hit[1] : host;
}

/**
 * Fetch, cluster, classify. Two newsrooms feed the same table: Valor
 * Econômico's own RSS (Brazil, with subtitle and lead) and the Google News
 * feeds (Brazil and abroad, breadth). Everything is capped at 48 hours.
 * Returns events with a source record each and a meta block the portal shows
 * verbatim, so a morning without headlines is a visible fact rather than a
 * quiet gap.
 */
async function gatherHeadlines(env, { date, modelOn, report }) {
  const meta = { provider: `${Valor.PROVIDER} e ${Google.PROVIDER}`, window_hours: NEWS_WINDOW_HOURS, mode: 'feed', reason: null, feeds: [], providers: [], items: 0, clusters: 0, kept: 0, classified_by: 'rule', model: null, dropped: [], top_story: null };
  const failed = (name) => (err) => ({ provider: name, items: [], feeds: [{ key: name, label: name, ok: false, count: 0, error: err.message }] });
  // Google News first; when Google refuses this server (it answers Cloudflare with HTTP 503), Bing News answers the same questions.
  const [valor, google] = await Promise.all([
    Valor.headlines({ windowHours: NEWS_WINDOW_HOURS }).catch(failed(Valor.PROVIDER)),
    Google.headlines({ windowHours: NEWS_WINDOW_HOURS }).catch(failed(Google.PROVIDER)),
  ]);
  const bing = google.items.length ? null : await Bing.headlines({ windowHours: NEWS_WINDOW_HOURS }).catch(failed(Bing.PROVIDER));
  const engine = bing || google;
  meta.provider = `${Valor.PROVIDER} e ${engine.provider}`;
  meta.feeds = [...valor.feeds, ...google.feeds, ...(bing ? bing.feeds : [])];
  const describe = (src) => ({ name: src.provider, items: src.items.length, feeds_ok: src.feeds.filter((f) => f.ok).length, feeds: src.feeds.length, error: src.feeds.find((f) => f.error)?.error ?? null, regions: { br: src.items.filter((i) => i.region === 'br').length, intl: src.items.filter((i) => i.region === 'intl').length } });
  meta.providers = [
    { name: Valor.PROVIDER, items: valor.items.length, feeds_ok: valor.feeds.filter((f) => f.ok).length, feeds: valor.feeds.length, error: valor.feeds.find((f) => f.error)?.error ?? null },
    describe(google),
    ...(bing ? [describe(bing)] : []),
  ];
  const items = [...valor.items, ...engine.items].filter((it) => withinNewsWindow(it.published, date));
  meta.items = items.length;
  if (!items.length) {
    meta.mode = 'failed';
    meta.reason = meta.feeds.map((f) => f.error).filter(Boolean)[0] || `nenhuma manchete nas últimas ${NEWS_WINDOW_HOURS} horas`;
    await report(1, 33, `Agente 1 · Dados — manchetes indisponíveis (${meta.reason.slice(0, 80)})`);
    return { events: [], sources: [], meta };
  }
  const clusters = Valor.clusterHeadlines(items).map((c) => ({ ...c, region: regionOfCluster(c), lead: preferredLead(c) }));
  meta.clusters = clusters.length;
  const candidates = [
    ...pickCandidates(clusters.filter((c) => c.region === 'br'), 16),
    ...pickCandidates(clusters.filter((c) => c.region === 'intl'), 14),
  ].sort((a, b) => b.coverage - a.coverage || (b.lead.published || '').localeCompare(a.lead.published || ''))
    .map((c, rank) => ({ ...c, rank }));
  const okFeeds = meta.feeds.filter((f) => f.ok).length;
  let classified = null;
  if (modelOn) {
    await report(1, 33, `Agente 1 · Dados — ${items.length} manchetes (${valor.items.length} do Valor, ${engine.items.length} do ${engine.provider}) em ${okFeeds} feeds; o modelo classifica as ${candidates.length} mais cobertas`);
    try {
      const r = await LLM.classifyHeadlines(env, {
        date,
        headlines: candidates.map(candidateFacts),
        indicator_keys: INDICATORS.map((i) => i.key),
        asset_classes: ASSET_CLASSES,
        categories: [...CATEGORIES].filter((c) => c !== 'market_move'),
      });
      classified = r.items; meta.classified_by = 'model'; meta.model = r.model; meta.dropped = r.dropped;
    } catch (err) {
      meta.reason = `classificação pelo modelo falhou (${err.message.slice(0, 80)}); manchetes classificadas por regra`;
    }
  } else {
    await report(1, 33, `Agente 1 · Dados — ${items.length} manchetes (${valor.items.length} do Valor, ${engine.items.length} do ${engine.provider}) em ${okFeeds} feeds; sem modelo, as mais cobertas entram classificadas por regra`);
  }
  const picked = classified && classified.length ? classified : ruleClassify(candidates);
  const { events, sources } = headlinesToEvents(picked, candidates, date);
  meta.kept = events.length;
  const top = events.find((e) => e.market_wide);
  if (top) meta.top_story = { title: top.title_pt, url: top.source_url, coverage: top.coverage, provider: top.source_provider };
  await report(1, 35, `Agente 1 · Dados — ${events.length} manchetes entram como eventos (${events.filter((e) => e.region === 'br').length} Brasil, ${events.filter((e) => e.region === 'intl').length} internacional)${top ? `; notícia do dia: “${top.title_pt.slice(0, 70)}” (${top.coverage} manchetes, ${top.source_provider})` : ''}`);
  return { events, sources, meta };
}

/**
 * The line that represents a story on the portal comes from an established
 * newsroom when one covered it: the same story from Valor or Folha and from
 * a site nobody has heard of is attributed to the former. Among equals, the
 * earliest line — the one that broke it.
 */
const PUBLISHER_RANK = [
  /^Valor Econômico$/i, /^Folha de S\.Paulo$/i, /^Estadão$/i, /^O Globo$/i, /^g1$/i, /^InfoMoney$/i, /^Exame$/i, /^CNN Brasil$/i, /^Agência Brasil$/i, /^UOL$/i, /^Money Times$/i, /^Poder360$/i, /^Bloomberg Línea$/i,
  /^Reuters$/i, /^Bloomberg/i, /^Financial Times$/i, /^The Wall Street Journal$|^WSJ$/i, /^CNBC$/i, /^The New York Times$/i, /^Investing\.com/i, /^MarketWatch$/i, /^Yahoo Finance$/i, /^Barron's$/i, /^The Guardian$/i, /^BBC/i, /^AP News$|^Associated Press$/i,
];
// Unranked newsrooms come after the ranked ones; a publisher that is only a domain (a local TV site syndicating a wire story) comes last.
const publisherRank = (name) => { const i = PUBLISHER_RANK.findIndex((re) => re.test(String(name || ''))); return i >= 0 ? i : /\.[a-z]{2,4}$/i.test(String(name || '')) ? PUBLISHER_RANK.length + 1 : PUBLISHER_RANK.length; };
function preferredLead(c) {
  const top = new Set(c.entities.slice(0, 3));
  const carries = (it) => top.size === 0 || Valor.entitiesOf(it).some((e) => top.has(e));
  const pool = c.items.filter(carries);
  const ranked = (pool.length ? pool : c.items).slice().sort((a, b) => publisherRank(a.provider) - publisherRank(b.provider) || (a.published || '').localeCompare(b.published || ''));
  return ranked[0] || c.lead;
}

/** A cluster belongs to the region most of its lines came from; the lead line breaks a tie. */
function regionOfCluster(c) {
  const intl = c.items.filter((i) => i.region === 'intl').length;
  return intl > c.items.length / 2 || (intl * 2 === c.items.length && c.lead.region === 'intl') ? 'intl' : 'br';
}

/**
 * The most covered stories first, then the freshest single lines from the
 * market sections. Coverage counts distinct stories, not lines: thirty
 * headlines filled from one template are one story (Valor.distinctStories).
 * Two clusters that name the same people are one story told from two angles:
 * the second folds into the first and its lines count towards the coverage.
 */
const MARKET_SECTIONS = new Set(['financas', 'brasil', 'politica', 'empresas', 'agronegocios', 'internacional']);
function pickCandidates(clusters, limit) {
  const out = [];
  const seen = new Set();
  const sameStory = (a, b) => a.entities.slice(0, 6).filter((e) => b.entities.slice(0, 6).includes(e)).length >= 2;
  const stories = (c) => Valor.distinctStories(c.items);
  const push = (c) => {
    if (seen.has(c.lead.id) || out.length >= limit) return;
    seen.add(c.lead.id);
    const n = stories(c);
    const twin = n >= 2 ? out.find((o) => o.cluster && sameStory(o.cluster, c)) : null;
    if (twin) {
      twin.coverage += n;
      twin.related = [...twin.related, ...c.items].filter((x, i, arr) => x.id !== twin.lead.id && arr.findIndex((y) => y.id === x.id) === i);
      return;
    }
    out.push({ id: c.lead.id, lead: c.lead, cluster: c, related: c.items.filter((x) => x.id !== c.lead.id), coverage: n, rank: out.length, sections: c.sections, region: c.region });
  };
  const ranked = clusters.slice().sort((a, b) => stories(b) - stories(a) || (b.latest || '').localeCompare(a.latest || ''));
  for (const c of ranked) if (stories(c) >= 2) push(c);
  for (const c of ranked) if (stories(c) === 1 && MARKET_SECTIONS.has(c.lead.section)) push(c);
  for (const o of out) { o.related = o.related.sort((a, b) => (b.published || '').localeCompare(a.published || '')).slice(0, 10); delete o.cluster; }
  return out;
}

const candidateFacts = (c) => ({
  id: c.id, title: c.lead.title, subtitle: c.lead.subtitle, lead: c.lead.lead, section: c.lead.section, published: c.lead.published,
  publisher: c.lead.provider, region: c.region || c.lead.region || 'br',
  coverage: c.coverage, related_titles: c.related.slice(0, 5).map((r) => r.title),
});

const SECTION_CATEGORY = { politica: 'politics', financas: 'macro', brasil: 'macro', empresas: 'equities', mundo: 'geopolitics', agronegocios: 'commodities', internacional: 'macro' };
const CATEGORY_CLASSES = {
  politics: ['Equities BR', 'Fixed Income', 'FX'], macro: ['Fixed Income', 'Equities BR'], rates: ['Fixed Income', 'Cash'], credit: ['Fixed Income'],
  fx: ['FX', 'Equities Global'], equities: ['Equities BR'], geopolitics: ['Equities Global', 'Commodities'], commodities: ['Commodities', 'Equities BR'], crypto: ['Digital Assets'],
};
const CATEGORY_INDICATOR = { politics: 'usdbrl', fx: 'usdbrl', rates: 'selic', equities: 'ibovespa', commodities: 'brent', crypto: 'btc', macro: null, credit: null, geopolitics: null };
/** The indicator a headline names outright beats the one its category implies. */
const INDICATOR_WORDS = [
  [/\bipca\b|inflação|deflação/i, 'ipca'], [/\binflation\b|\bcpi\b|\bpce\b/i, 'us10y'], [/\bselic\b|\bcopom\b/i, 'selic'], [/ibovespa|\bb3\b|bolsa brasileira/i, 'ibovespa'],
  [/dólar|câmbio|\bptax\b/i, 'usdbrl'], [/\bdxy\b|dollar index/i, 'dxy'], [/euro\b.*dólar|eur\/usd/i, 'eurusd'],
  [/treasury|treasuries|\byields?\b|\bfed\b|federal reserve|rate (hike|cut)/i, 'us10y'], [/s&p 500|\bs&p\b/i, 'sp500'], [/nasdaq/i, 'nasdaq'], [/\bvix\b|volatility index/i, 'vix'],
  [/\bbrent\b|petróleo|\boil\b|\bopec\b/i, 'brent'], [/\bwti\b/i, 'wti'], [/\bouro\b|\bgold\b/i, 'gold'], [/\bcobre\b|\bcopper\b/i, 'copper'],
  [/bitcoin|\bbtc\b/i, 'btc'], [/\bether\b|ethereum|\beth\b/i, 'eth'], [/high.yield|junk bond|\bhyg\b/i, 'hy_etf'],
];
function indicatorByRule(c, category) {
  const t = `${c.lead.title} ${c.lead.subtitle || ''}`;
  const hit = INDICATOR_WORDS.find(([re]) => re.test(t));
  return hit ? hit[1] : (CATEGORY_INDICATOR[category] ?? null);
}

/** Category from the words of the headline when the section is ambiguous; Portuguese and English, since both feeds land here. */
function categoryByRule(c) {
  const t = `${c.lead.title} ${c.lead.subtitle || ''}`.toLowerCase();
  if (/selic|copom|\bjuros?\b|treasury|treasuries|\bfed\b|federal reserve|rate (hike|cut)|interest rate|\byields?\b|curva/.test(t)) return 'rates';
  if (/dólar|câmbio|\breal\b|ptax|\bdollar\b|\byen\b|\beuro\b|\bforex\b/.test(t)) return 'fx';
  if (/ibovespa|\bbolsa\b|ações|\bb3\b|s&p 500|nasdaq|dow jones|wall street|\bstocks?\b|\bequit/.test(t)) return 'equities';
  if (/petróleo|brent|\bwti\b|minério|soja|commodit|\boil\b|opec|\bgold\b|copper|iron ore/.test(t)) return 'commodities';
  if (/bitcoin|cripto|crypto|\bether\b|ethereum/.test(t)) return 'crypto';
  if (/ipca|inflação|\bpib\b|fiscal|arcabouço|déficit|orçamento|inflation|\bcpi\b|\bgdp\b|jobs report|payrolls|unemployment/.test(t)) return 'macro';
  if (/tariff|sanction|trade war|\bwar\b|\biran\b|geopolit|missile|ceasefire/.test(t)) return 'geopolitics';
  if (/stf|senado|câmara|congresso|governo|ministro|eleição|eleições|\bpf\b|polícia federal|lula|bolsonaro|datafolha|tarcísio|haddad/.test(t)) return 'politics';
  return SECTION_CATEGORY[c.lead.section] || 'macro';
}

/**
 * Without a model: per region, the biggest clusters and the freshest market
 * lines, summarised by the newsroom's own first paragraph when the feed had
 * one. The story of the day is the most covered story overall. Nothing is
 * written here that a feed did not publish.
 */
function ruleClassify(candidates) {
  const out = [];
  for (const region of ['br', 'intl']) {
    const mine = candidates.filter((c) => (c.region || 'br') === region);
    const big = mine.filter((c) => c.coverage >= 3).slice(0, 3);
    for (const c of big) out.push(ruleItem(c, c.rank === 0 ? 'high' : 'medium', c.rank === 0));
    const market = mine.filter((c) => !big.includes(c) && MARKET_SECTIONS.has(c.lead.section)).slice(0, 2);
    for (const c of market) out.push(ruleItem(c, c.coverage >= 2 ? 'medium' : 'low', false));
  }
  if (!out.length && candidates[0]) out.push(ruleItem(candidates[0], 'medium', candidates[0].coverage >= 3));
  return out;
}
/**
 * Without a model the mechanism and the conversation are fixed sentences per
 * category — never a fact about the story, which only the newsroom's own
 * paragraph is allowed to state.
 */
const RULE_TEXT = {
  politics: {
    impact: 'Notícia política chega à carteira pelo câmbio, pela curva de juros e pelo prêmio de risco dos ativos brasileiros, não por uma posição específica.',
    prompt: 'Explicar ao cliente o que foi publicado e por que a carteira não muda por causa de uma manchete; combinar o que observar no câmbio e nos juros nos próximos dias.',
  },
  macro: {
    impact: 'Dados e decisões macro alteram a inflação esperada e a curva de juros, e por elas a marcação da renda fixa e o valor das ações brasileiras.',
    prompt: 'Conversar sobre o que a notícia muda na premissa de inflação e juros por trás da alocação em renda fixa.',
  },
  rates: {
    impact: 'Juros mais altos ou mais baixos mudam a marcação dos títulos prefixados e indexados e o custo de oportunidade das ações.',
    prompt: 'Revisar com o cliente o equilíbrio entre prefixado, IPCA e CDI diante do que a notícia sinaliza para a Selic.',
  },
  fx: {
    impact: 'A variação do real afeta em reais tudo o que a carteira tem no exterior e o preço das exportadoras na bolsa.',
    prompt: 'Rever com o cliente quanto da carteira está exposto ao dólar e se essa exposição continua sendo a combinada.',
  },
  equities: {
    impact: 'Notícia de empresa ou de bolsa afeta as ações brasileiras da carteira, diretamente ou pelo setor.',
    prompt: 'Verificar se a empresa ou o setor da notícia está na carteira e o que a política aprovada permite discutir.',
  },
  commodities: {
    impact: 'Commodities chegam à carteira pelas exportadoras da bolsa, pelo câmbio e pela inflação que a renda fixa carrega.',
    prompt: 'Discutir se a carteira tem exposição direta a commodities e como um movimento persistente afeta a inflação assumida na renda fixa.',
  },
  geopolitics: {
    impact: 'Risco geopolítico eleva a aversão a risco global: pesa em ações no exterior, sustenta o dólar e o petróleo.',
    prompt: 'Enquadrar a notícia no prazo de investimento combinado antes de qualquer conversa sobre reduzir risco.',
  },
  credit: {
    impact: 'Condições de crédito mais apertadas afetam os fundos de crédito privado e o preço dos títulos corporativos.',
    prompt: 'Revisar a parcela de crédito privado da carteira e a liquidez combinada na política.',
  },
  crypto: {
    impact: 'Ativos digitais reagem a notícia regulatória e de fluxo com volatilidade muito acima das demais classes.',
    prompt: 'Confirmar que a parcela em ativos digitais segue dentro da faixa aprovada.',
  },
};

function ruleItem(c, importance, marketWide) {
  const category = categoryByRule(c);
  const text = RULE_TEXT[category] || RULE_TEXT.macro;
  return {
    headline_id: c.id, category, direction: null, indicator_key: indicatorByRule(c, category),
    asset_classes: CATEGORY_CLASSES[category] || ['Equities BR'], importance, market_wide: marketWide,
    summary_pt: c.lead.lead || c.lead.subtitle || coverageSentence(c), impact_note_pt: text.impact, discussion_prompt_pt: text.prompt,
  };
}
/**
 * A Google News line carries only its title. Rather than repeat the title as
 * its own summary, say the one thing the feed does establish: who else is
 * covering the story, and how widely.
 */
function coverageSentence(c) {
  const others = [...new Set(c.related.map((r) => r.provider).filter((p) => p && p !== c.lead.provider))].slice(0, 4);
  if (c.coverage <= 1 && !others.length) return `Manchete publicada por ${c.lead.provider} nas últimas 48 horas; só o título foi lido.`;
  return `${c.coverage} ${c.coverage === 1 ? 'manchete' : 'manchetes'} sobre o assunto nas últimas 48 horas${others.length ? `, também em ${others.join(', ')}` : ''}; só os títulos foram lidos.`;
}

/** A classified headline becomes an event; its title is the newsroom's, verbatim, and its source is the article. */
function headlinesToEvents(items, candidates, date) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const events = []; const sources = [];
  for (const it of items) {
    const c = byId.get(it.headline_id);
    if (!c) continue;
    const h = c.lead;
    const category = CATEGORIES.has(it.category) && it.category !== 'market_move' ? it.category : categoryByRule(c);
    const classes = (it.asset_classes || []).filter((k) => ASSET_CLASSES.includes(k) || k === 'FX');
    const marketWide = it.market_wide === true || it.market_wide === 'true' || (c.rank === 0 && c.coverage >= 3);
    const provider = h.provider || Valor.PROVIDER;
    events.push({
      id: `evt_hl_${h.id.replace(/^(vlr|gn|bn)_/, '')}`,
      date: (h.published || date).slice(0, 10),
      region: c.region || h.region || 'br',
      title: h.title, title_pt: h.title,
      category,
      summary: it.summary_pt || h.lead || h.subtitle || h.title,
      summary_pt: it.summary_pt || h.lead || h.subtitle || h.title,
      subtitle: h.subtitle || null,
      direction: ['positive', 'negative', 'mixed'].includes(it.direction) ? it.direction : null,
      indicator_key: INDICATORS.some((k) => k.key === it.indicator_key) ? it.indicator_key : (CATEGORY_INDICATOR[category] ?? null),
      asset_classes: classes.length ? classes : (CATEGORY_CLASSES[category] || ['Equities BR']),
      instruments: [],
      importance: IMPORTANCE[it.importance] != null ? it.importance : (marketWide ? 'high' : 'medium'),
      market_wide: marketWide,
      coverage: c.coverage,
      impact_note_pt: it.impact_note_pt || null,
      discussion_prompt_pt: it.discussion_prompt_pt || null,
      source_id: h.source.id,
      source_provider: provider,
      source_via: h.via || null,
      source_label: `${provider} · manchete${h.via ? ` via ${h.via}` : ''}`,
      source_url: h.url,
      source_title: h.title,
      published_at: h.published,
      section: h.section,
      related: c.related.map((r) => ({ title: r.title, url: r.url, published: r.published, section: r.section, provider: r.provider || Valor.PROVIDER, via: r.via || null })),
      kind: 'headline',
    });
    sources.push(h.source);
  }
  return { events, sources };
}

/** A verified news item becomes an event with a source record of its own. */
function newsToEvents(items, date) {
  const events = []; const sources = [];
  for (const it of items) {
    const url = it.source_url;
    let host = 'fonte';
    const region = 'intl';                                   // the scan is asked for the world outside Brazil
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the placeholder */ }
    const provider = providerName(host);
    const source = makeSource({
      provider, kind: 'news', instrument: it.source_title || it.title, identifier: url,
      requested_range: it.date || date, last_observation: it.date || date, reference: url,
      notes: 'notícia recuperada pelo modelo com busca na web; a URL constou dos resultados da busca',
    });
    const slug = String(it.title || 'news').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    events.push({
      id: `evt_news_${slug}_${source.id.slice(-4)}`,
      date: it.date || date,
      title: it.title || it.title_pt || 'Notícia',
      title_pt: it.title_pt || it.title,
      category: CATEGORIES.has(it.category) ? it.category : 'macro',
      summary: it.summary || it.summary_pt || '',
      summary_pt: it.summary_pt || it.summary || '',
      direction: ['positive', 'negative', 'mixed'].includes(it.direction) ? it.direction : null,
      indicator_key: INDICATORS.some((k) => k.key === it.indicator_key) ? it.indicator_key : null,
      asset_classes: (it.asset_classes || []).filter((k) => ASSET_CLASSES.includes(k)),
      instruments: [],
      importance: IMPORTANCE[it.importance] != null ? it.importance : 'medium',
      region,
      impact_note_pt: it.impact_note_pt || null,
      discussion_prompt_pt: it.discussion_prompt_pt || null,
      source_id: source.id,
      source_provider: provider,
      source_label: `${provider} · notícia`,
      source_url: url,
      source_title: it.source_title || null,
      kind: 'news',
    });
    sources.push(source);
  }
  return { events, sources };
}
const compactNews = (e) => ({ id: e.id, date: e.date, title_pt: e.title_pt, category: e.category, importance: e.importance, source_url: e.source_url, source_title: e.source_title, source_label: e.source_label, source_provider: e.source_provider ?? null });

function dedupeEvents(events) {
  const seen = new Map();
  for (const e of events) {
    const key = e.kind === 'news' || e.kind === 'headline' ? e.id : `${e.indicator_key || ''}|${e.category}`;
    const existing = seen.get(key);
    if (!existing || IMPORTANCE[e.importance] < IMPORTANCE[existing.importance]) seen.set(key, e);
    if (!e.indicator_key) seen.set(e.id, e);
  }
  return [...new Set([...seen.values()])];
}

export function compactIndicator(i) {
  const def = INDICATORS.find((x) => x.key === i.key);
  return {
    key: i.key, label: i.label, group: def?.group ?? null,
    unit: i.unit, price: i.price ?? null, changePct: i.changePct ?? null, mtdPct: i.mtdPct ?? null,
    d5Pct: i.d5Pct ?? null, d5From: i.d5From ?? null, d30Pct: i.d30Pct ?? null, d30From: i.d30From ?? null,
    mtdFrom: i.mtdFrom ?? null, level: i.level ?? null,
    asOf: i.asOf ?? null, name: i.name ?? null,
    unavailable: !!i.unavailable, reason: i.reason ?? null,
    providers_attempted: i.providers_attempted ?? null,
    source: i.source ?? null,
    asset_classes: def?.asset_classes ?? [],
  };
}

/** A level as the letter would print it, so the model quotes a string the code formatted. */
function levelText(price, unit) {
  if (price == null || !Number.isFinite(price)) return null;
  if (['%', '% a.a.', '% a.m.'].includes(unit)) return `${num(price, { decimals: 2 })}%${unit === '% a.a.' ? ' a.a.' : unit === '% a.m.' ? ' a.m.' : ''}`;
  if (unit === 'USD' || unit === 'USD/oz') return `US$ ${num(price, { decimals: 0 })}`;
  if (unit === 'USD/bbl' || unit === 'USD/lb') return `US$ ${num(price, { decimals: 2 })}`;
  if (unit === 'BRL') return `R$ ${num(price, { decimals: Number.isInteger(price * 100) ? 2 : 4 })}`; // a quote keeps four decimals; a round threshold does not pretend to
  return num(price, { decimals: price >= 1000 ? 0 : 2 });
}

/**
 * What a rate or a monthly index says instead of a day move, as a sentence
 * the model and the template both quote verbatim.
 */
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
function levelNote(i) {
  const l = i.level;
  if (!l) return null;
  if (l.kind === 'policy_rate') {
    if (l.prev_value == null) return `sem mudança desde ${dmy(l.since)}, pelo menos`;
    return `${pp(l.delta / 100)} em ${dmy(l.since)}, de ${num(l.prev_value, { decimals: 2 })}% para ${num(i.price, { decimals: 2 })}%`;
  }
  if (l.kind === 'monthly_index') {
    return `referente a ${monthLabel(l.period)}${l.prev_value != null ? `; ${monthLabel(l.prev_period)}: ${num(l.prev_value, { decimals: 2 })}%` : ''}`;
  }
  return null;
}

function inferenceFacts({ date, indicators, triggers, events, portfolios, baseRows }) {
  return {
    date,
    indicators: indicators.map((i) => ({
      key: i.key, label: i.label, unit: i.unit,
      level: levelText(i.price, i.unit),
      level_note: levelNote(i),
      day: i.changePct == null ? null : percent(i.changePct, { decimals: 1 }),
      d5: i.d5Pct == null ? null : percent(i.d5Pct, { decimals: 1 }),
      d30: i.d30Pct == null ? null : percent(i.d30Pct, { decimals: 1 }),
      mtd: i.mtdPct == null ? null : percent(i.mtdPct, { decimals: 1 }),
      asOf: i.asOf ?? null, unavailable: !!i.unavailable, source_id: i.source?.id ?? null,
    })),
    triggers: triggers.filter((t) => t.status !== 'NO_DATA').map((t) => ({
      label: t.label, status: t.status, unit: t.unit,
      observed: levelText(t.observed, t.unit === 'mtd' ? '%' : t.unit), threshold: levelText(t.threshold, t.unit === 'mtd' ? '%' : t.unit),
    })),
    events: events.map((e) => ({
      id: e.id, kind: e.kind || (e.generated ? 'move' : 'curated'), region: e.region ?? null, date: e.date, title: e.title, title_pt: e.title_pt ?? null,
      category: e.category, summary: e.summary, summary_pt: e.summary_pt ?? null, importance: e.importance,
      market_wide: !!e.market_wide, coverage: e.coverage ?? null,
      indicator_key: e.indicator_key ?? null, asset_classes: e.asset_classes || [],
      source_id: e.source_id ?? null, source_label: e.source_label ?? null, source_url: e.source_url ?? null, source_provider: e.source_provider ?? null,
    })),
    candidates: baseRows.map((r) => ({
      event_id: r.event_id, clients_affected: r.exposure_summary.clients_affected, max_exposure: r.exposure_summary.max_exposure,
      clients: r.per_client.map((c) => c.client_name.split(' ')[0]),
    })),
    book: portfolios.map((p) => ({ client: p.client_name, exposures: p.portfolio.exposures })),
    asset_classes: ASSET_CLASSES,
    macro_vintage: MACRO_VINTAGE,
  };
}

/**
 * The model chooses and writes; the code keeps the exposure arithmetic. A row
 * the model did not select is dropped; an id the model invented is ignored;
 * if nothing usable comes back the rule-ordered rows stand.
 */
function mergeInference(baseRows, inference, events) {
  const byId = new Map(baseRows.map((r) => [r.event_id, r]));
  const knownSources = new Set(events.map((e) => e.source_id).filter(Boolean));
  const eventById = new Map(events.map((e) => [e.id, e]));
  // What every row carries regardless of who wrote it: where it came from, and whether it is the story of the day.
  const attributed = (base) => {
    const ev = eventById.get(base.event_id) || {};
    return {
      kind: ev.kind || (ev.generated ? 'move' : 'curated'),
      source_url: ev.source_url ?? null,
      source_title: ev.source_title ?? null,
      source_provider: ev.source_provider ?? null,
      source_via: ev.source_via ?? null,
      region: ev.region ?? base.region ?? null,
      published_at: ev.published_at ?? null,
      related: ev.related ?? [],
      market_wide: !!ev.market_wide,
      coverage: ev.coverage ?? null,
    };
  };
  const picked = [];
  for (const m of inference?.what_matters || []) {
    const base = byId.get(m?.event_id);
    if (!base || picked.some((p) => p.event_id === base.event_id)) continue;
    picked.push({
      ...base,
      ...attributed(base),
      importance: IMPORTANCE[m.importance] != null ? m.importance : base.importance,
      why_it_matters_pt: typeof m.why_it_matters_pt === 'string' && m.why_it_matters_pt.trim() ? m.why_it_matters_pt.trim() : base.why_it_matters_pt,
      advisor_action_pt: typeof m.advisor_action_pt === 'string' && m.advisor_action_pt.trim() ? m.advisor_action_pt.trim() : base.advisor_action_pt,
      source_ids: (Array.isArray(m.source_ids) ? m.source_ids : []).filter((s) => knownSources.has(s)),
      inferred: !inference.generated_without_model,
    });
  }
  if (picked.length) {
    // The story of the day is on the table whether or not the model chose it: the code guarantees it, at the top.
    for (const base of baseRows) {
      if (!base.market_wide || picked.some((p) => p.event_id === base.event_id)) continue;
      picked.unshift({ ...base, ...attributed(base), source_ids: base.source_id ? [base.source_id] : [], inferred: false });
    }
    // The model's choice stands, but the news of each region keeps a seat:
    // two headline or news rows per region are guaranteed when the data
    // agent found them, and an indicator move gives way before a headline.
    const isNews = (r) => r.kind === 'headline' || r.kind === 'news';
    for (const region of ['br', 'intl']) {
      for (const base of baseRows) {
        if (picked.filter((r) => isNews(r) && r.region === region).length >= 2) break;
        const ev = eventById.get(base.event_id) || {};
        if (!['headline', 'news'].includes(ev.kind) || (ev.region ?? base.region) !== region || picked.some((p) => p.event_id === base.event_id)) continue;
        picked.push({ ...base, ...attributed(base), source_ids: base.source_id ? [base.source_id] : [], inferred: false });
      }
    }
    while (picked.length > WHAT_MATTERS_ROWS) {
      let i = picked.length - 1;
      while (i > 0 && isNews(picked[i])) i -= 1;
      picked.splice(i, 1);
    }
    return picked;
  }
  return baseRows.map((r) => ({ ...r, ...attributed(r), source_ids: r.source_id ? [r.source_id] : [], inferred: false })).slice(0, WHAT_MATTERS_ROWS);
}

async function upsertWorldView(db, advisorId, date, inference, meta) {
  const payload = {
    headline_pt: inference.headline_pt || '',
    summary_pt: inference.summary_pt || '',
    briefing: inference.briefing || {},
    stance_by_asset_class: inference.stance_by_asset_class || {},
    stance_rationale_pt: inference.stance_rationale_pt || '',
    mode: meta.mode, model: meta.model, prompt_version: meta.promptVersion,
    fallback_reason: inference.fallback_reason ?? null,
    generated_without_model: !!inference.generated_without_model,
    news: {
      mode: meta.news.mode, searches: meta.news.searches ?? 0, kept: meta.news.items?.length ?? 0,
      headlines: meta.news.headlines ? { provider: meta.news.headlines.provider, providers: meta.news.headlines.providers ?? [], window_hours: meta.news.headlines.window_hours ?? NEWS_WINDOW_HOURS, mode: meta.news.headlines.mode, items: meta.news.headlines.items, kept: meta.news.headlines.kept, top_story: meta.news.headlines.top_story ?? null } : null,
    },
    generated_at: nowIso(),
  };
  const existing = await first(db, 'SELECT * FROM world_overviews WHERE advisor_id = ? AND date = ?', advisorId, date);
  const sourcesJson = JSON.stringify(meta.sources);
  if (existing) {
    await run(db, 'UPDATE world_overviews SET generated_summary = ?, briefing_json = ?, stance_json = ?, sources_json = ? WHERE id = ?',
      payload.headline_pt, JSON.stringify(payload), JSON.stringify(payload.stance_by_asset_class), sourcesJson, existing.id);
  } else {
    await run(db, 'INSERT INTO world_overviews (id, advisor_id, date, generated_summary, briefing_json, stance_json, approval_status, sources_json) VALUES (?,?,?,?,?,?,?,?)',
      id('wov'), advisorId, date, payload.headline_pt, JSON.stringify(payload), JSON.stringify(payload.stance_by_asset_class), 'draft', sourcesJson);
  }
  const row = await first(db, 'SELECT * FROM world_overviews WHERE advisor_id = ? AND date = ?', advisorId, date);
  return { ...row, briefing: json(row.briefing_json, {}), stance: json(row.stance_json, {}) };
}
