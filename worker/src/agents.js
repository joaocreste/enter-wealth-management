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
import { INDICATORS, MACRO_VINTAGE } from '../../seed/market.mjs';
import { indicatorQuote } from '../../src/adapters/marketdata.js';
import { triggerProximity } from '../../src/core/triggers.js';
import { makeSource } from '../../src/core/sources.js';

export const AGENTS = [
  { step: 1, key: 'dados', title: 'Agente 1 · Dados', what: 'indicadores, eventos e notícias, cada um com a fonte' },
  { step: 2, key: 'inferencia', title: 'Agente 2 · Inferência', what: 'o que importa hoje para as suas carteiras' },
  { step: 3, key: 'gatilhos', title: 'Agente 3 · Gatilhos', what: 'limiares de mercado e desvios de alocação' },
];
const STALE_MS = 10 * 60 * 1000;
const ASSET_CLASSES = ['Cash', 'Fixed Income', 'Equities BR', 'Equities Global', 'Alternatives', 'Real Estate', 'Commodities', 'Digital Assets'];
const CATEGORIES = new Set(['equities', 'rates', 'credit', 'fx', 'commodities', 'macro', 'geopolitics', 'crypto', 'market_move']);
const IMPORTANCE = { high: 0, medium: 1, low: 2 };

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
    const indicators = [];
    for (let i = 0; i < INDICATORS.length; i += 1) {
      const ind = INDICATORS[i];
      await report(1, 2 + (i / INDICATORS.length) * 24, `Agente 1 · Dados — consultando ${providerOf(ind)}: ${ind.label} (${i + 1} de ${INDICATORS.length})`);
      indicators.push(await indicatorQuote(ind));
    }
    const retrieved = indicators.filter((i) => !i.unavailable).length;
    await report(1, 27, `Agente 1 · Dados — ${retrieved} de ${indicators.length} indicadores recuperados; lendo os eventos curados e os movimentos relevantes do mês`);
    const curated = await P.loadMarketEvents(env, { since: addDays(date, -21), limit: 20 });
    const generated = P.eventsFromIndicatorMoves(indicators);

    let newsEvents = []; let newsSources = [];
    let news = { mode: 'skipped', reason: 'sem modelo de linguagem configurado — defina ANTHROPIC_API_KEY para a varredura de notícias com fontes citadas', items: [], dropped: [], searches: 0 };
    if (env.ANTHROPIC_API_KEY) {
      await report(1, 31, 'Agente 1 · Dados — o modelo varre o noticiário na web e cita a fonte de cada item');
      try {
        const scan = await LLM.scanNews(env, { date, indicator_keys: INDICATORS.map((i) => i.key), asset_classes: ASSET_CLASSES });
        ({ events: newsEvents, sources: newsSources } = newsToEvents(scan.items, date));
        news = { mode: 'model', model: scan.model, searches: scan.searches, items: newsEvents.map(compactNews), dropped: scan.dropped, urls: scan.urls };
        await report(1, 44, `Agente 1 · Dados — ${newsEvents.length} notícias com fonte verificada em ${scan.searches} buscas${scan.dropped.length ? `; ${scan.dropped.length} descartadas por falta de fonte` : ''}`);
      } catch (err) {
        news = { mode: 'failed', reason: err.message, items: [], dropped: [], searches: 0 };
        await report(1, 44, `Agente 1 · Dados — varredura de notícias indisponível (${err.message.slice(0, 80)}); seguindo com indicadores e eventos curados`);
      }
    }
    await report(1, 47, 'Agente 1 · Dados — mapeando a exposição de cada carteira por classe de ativo');
    const { clients, portfolios } = await bookExposures(db, advisor.id);
    const events = dedupeEvents([...curated, ...generated, ...newsEvents]);
    const triggerEvals = await P.evaluateTriggers(env, indicators, advisor.id);
    const sources = [...indicators.filter((i) => i.source).map((i) => i.source), ...newsSources];
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
      news: { mode: news.mode, model: news.model ?? null, reason: news.reason ?? null, searches: news.searches ?? 0, kept: news.items?.length ?? 0, dropped: news.dropped ?? [] },
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

/** A verified news item becomes an event with a source record of its own. */
function newsToEvents(items, date) {
  const events = []; const sources = [];
  for (const it of items) {
    const url = it.source_url;
    let host = 'fonte';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the placeholder */ }
    const source = makeSource({
      provider: host, kind: 'news', instrument: it.source_title || it.title, identifier: url,
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
      impact_note_pt: it.impact_note_pt || null,
      discussion_prompt_pt: it.discussion_prompt_pt || null,
      source_id: source.id,
      source_label: `${host} · notícia`,
      source_url: url,
      source_title: it.source_title || null,
      kind: 'news',
    });
    sources.push(source);
  }
  return { events, sources };
}
const compactNews = (e) => ({ id: e.id, date: e.date, title_pt: e.title_pt, category: e.category, importance: e.importance, source_url: e.source_url, source_title: e.source_title, source_label: e.source_label });

function dedupeEvents(events) {
  const seen = new Map();
  for (const e of events) {
    const key = e.kind === 'news' ? e.id : `${e.indicator_key || ''}|${e.category}`;
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
    asOf: i.asOf ?? null, name: i.name ?? null,
    unavailable: !!i.unavailable, reason: i.reason ?? null,
    providers_attempted: i.providers_attempted ?? null,
    source: i.source ?? null,
    asset_classes: def?.asset_classes ?? [],
  };
}

function inferenceFacts({ date, indicators, triggers, events, portfolios, baseRows }) {
  return {
    date,
    indicators: indicators.map((i) => ({
      key: i.key, label: i.label, unit: i.unit, price: i.price ?? null, changePct: i.changePct ?? null, mtdPct: i.mtdPct ?? null,
      asOf: i.asOf ?? null, unavailable: !!i.unavailable, source_id: i.source?.id ?? null,
    })),
    triggers: triggers.filter((t) => t.status !== 'NO_DATA').map((t) => ({ label: t.label, status: t.status, observed: t.observed, threshold: t.threshold, unit: t.unit })),
    events: events.map((e) => ({
      id: e.id, kind: e.kind || (e.generated ? 'move' : 'curated'), date: e.date, title: e.title, title_pt: e.title_pt ?? null,
      category: e.category, summary: e.summary, summary_pt: e.summary_pt ?? null, importance: e.importance,
      indicator_key: e.indicator_key ?? null, asset_classes: e.asset_classes || [],
      source_id: e.source_id ?? null, source_label: e.source_label ?? null, source_url: e.source_url ?? null,
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
  const picked = [];
  for (const m of inference?.what_matters || []) {
    const base = byId.get(m?.event_id);
    if (!base || picked.some((p) => p.event_id === base.event_id)) continue;
    const ev = eventById.get(base.event_id) || {};
    picked.push({
      ...base,
      kind: ev.kind || (ev.generated ? 'move' : 'curated'),
      source_url: ev.source_url ?? null,
      source_title: ev.source_title ?? null,
      importance: IMPORTANCE[m.importance] != null ? m.importance : base.importance,
      why_it_matters_pt: typeof m.why_it_matters_pt === 'string' && m.why_it_matters_pt.trim() ? m.why_it_matters_pt.trim() : base.why_it_matters_pt,
      advisor_action_pt: typeof m.advisor_action_pt === 'string' && m.advisor_action_pt.trim() ? m.advisor_action_pt.trim() : base.advisor_action_pt,
      source_ids: (Array.isArray(m.source_ids) ? m.source_ids : []).filter((s) => knownSources.has(s)),
      inferred: !inference.generated_without_model,
    });
  }
  if (picked.length) return picked.slice(0, 8);
  return baseRows.map((r) => {
    const ev = eventById.get(r.event_id) || {};
    return { ...r, kind: ev.kind || (ev.generated ? 'move' : 'curated'), source_url: ev.source_url ?? null, source_title: ev.source_title ?? null, source_ids: r.source_id ? [r.source_id] : [], inferred: false };
  }).slice(0, 8);
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
    news: { mode: meta.news.mode, searches: meta.news.searches ?? 0, kept: meta.news.items?.length ?? 0 },
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
