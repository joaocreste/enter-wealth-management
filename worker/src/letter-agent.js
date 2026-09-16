/**
 * The monthly letter agent: four sequential steps that write the letter an
 * advisor asks for from the client page, entirely inside the Worker.
 *
 *   1. Dados        — the approved portfolio, the policy, the month's prices and
 *                     the exchange rate, each with the source record that says
 *                     who priced it
 *   2. Análise      — the month's profitability against the policy's own
 *                     benchmark, the indicators and the events that touch this
 *                     carteira, and what to propose
 *   3. Redação      — the model writes the letter from a FACTS object and is
 *                     never asked for a number; without a model, a template
 *                     phrases the same facts
 *   4. Diagramação  — the letter and its annex as a PDF, an e-mail and the
 *                     portal page, and the report row the portal reads
 *
 * The letter that comes out is the same document the Rivet graph produces: both
 * drive the stages in worker/src/letter-pipeline.js, and both end in one row of
 * `reports` for that client and month. What this agent adds is that an advisor
 * can ask for it from the portal, without a terminal and without Rivet.
 *
 * The letter lands as `pending_approval`: it is written for the advisor to read
 * and approve, and only a published letter reaches the client. Regenerating a
 * month replaces the draft; a published month is refused, because a letter a
 * client has already read is not something to overwrite by pressing a button.
 *
 * Progress is written to letter_runs after every meaningful sub-step so the tab
 * that opened the run shows what is happening. The pipeline runs as a
 * Cloudflare Workflow for the same reason the daily agents do — work started
 * from an HTTP request is cut off long before a model has finished writing —
 * and without the binding the four functions run in-process.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { all, first, run, id, json, nowIso, audit } from './db.js';
import * as P from './pipeline.js';
import * as A from './agents.js';
import * as LP from './letter-pipeline.js';
import { renderLetterPdf } from '../../src/render/pdf/letter.js';
import { buildLetterModel } from '../../src/render/letter-model.js';
import { brandFonts } from '../../src/render/fonts/index.js';
import { artefactLinks } from './links.js';
import { previousMonth, monthLabel } from '../../src/core/format.js';
import { INDICATORS } from '../../seed/market.mjs';
import { PROMPT_VERSION } from '../../src/llm/prompts.js';
import { withinPolicy } from '../../src/core/suitability.js';

export const LETTER_AGENTS = [
  { step: 1, key: 'dados', title: 'Carta · Dados', what: 'a carteira aprovada, a política, os preços do mês e o câmbio' },
  { step: 2, key: 'analise', title: 'Carta · Análise', what: 'a rentabilidade contra a referência, os eventos que tocam a carteira, o que propor' },
  { step: 3, key: 'redacao', title: 'Carta · Redação', what: 'uma carta ao cliente, pelo nome, sem escrever um número que não esteja nos fatos' },
  { step: 4, key: 'diagramacao', title: 'Carta · Diagramação', what: 'a carta e o anexo em duas páginas, o e-mail e a página do portal' },
];
const STALE_MS = 15 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const isStale = (row) => row.status === 'running' && Date.now() - Date.parse(row.started_at) > STALE_MS;
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** What the portal sees of a run: progress, and the letter it produced once there is one. */
export async function runView(env, row) {
  if (!row) return null;
  const stale = isStale(row);
  return {
    id: row.id, client_id: row.client_id,
    status: stale ? 'failed' : row.status,
    step: row.step, progress: row.progress, message: row.message,
    error: stale ? 'sem progresso há mais de quinze minutos' : row.error,
    started_at: row.started_at, finished_at: row.finished_at,
    reporting_month: row.reporting_month, page_count: row.page_count,
    narrative_mode: row.narrative_mode,
    report_id: row.report_id, report_status: row.report_status,
    blocked_by: row.blocked_by, reissue: !!row.reissue,
    graph_run_id: row.graph_run_id,
    log: json(row.log_json, []).slice(-12),
    agents: LETTER_AGENTS,
    // Signed, because the tab shows the letter in an iframe and opens the PDF by
    // navigation, and neither carries the Authorization header (worker/src/links.js).
    links: row.report_id ? await artefactLinks(env, row.report_id) : null,
  };
}

export async function listLetterRuns(env, clientId) {
  const rows = await all(env.DB, 'SELECT * FROM letter_runs WHERE client_id = ? ORDER BY started_at DESC LIMIT 20', clientId);
  const out = [];
  for (const r of rows) out.push(await runView(env, r));
  return out;
}

/**
 * The run row, queued but not dispatched. The bulk sweep
 * (worker/src/bulk-reports.js) drives the four steps itself, one client at a
 * time, so it stops here.
 *
 * A graph_runs row is opened alongside it, with the same intermediate state the
 * Rivet path keeps, so a letter written from the portal appears in the client's
 * Auditoria tab exactly as one written from the graph does.
 */
export async function createLetterRun(env, { clientId, advisorId, actorId = null, month = null, reissue = false }) {
  const runId = id('carta');
  const graphRunId = id('run');
  await run(env.DB, 'INSERT INTO graph_runs (id, graph_name, client_id, advisor_id, started_at, status, prompt_version, inputs_json, outputs_json) VALUES (?,?,?,?,?,?,?,?,?)',
    graphRunId, 'monthly_client_letter', clientId, advisorId, nowIso(), 'running', PROMPT_VERSION || null,
    JSON.stringify({ client_id: clientId, month, source: 'letter_agent' }), '{}');
  await run(env.DB,
    'INSERT INTO letter_runs (id, client_id, advisor_id, graph_run_id, status, step, progress, message, reporting_month, reissue, actor_id, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    runId, clientId, advisorId, graphRunId, 'running', 0, 0, 'Na fila', month || previousMonth(today()), reissue ? 1 : 0, actorId, nowIso());
  return runId;
}

/** Start a run in the background and return its row at once. The tab polls it. */
export async function startLetterRun(env, ctx, { scope, actorId = null, month = null, reissue = false }) {
  const { client, advisor } = scope;
  const runId = await createLetterRun(env, { clientId: client.id, advisorId: advisor.id, actorId, month, reissue });
  if (env.LETTER_AGENT) {
    await env.LETTER_AGENT.create({ id: runId, params: { runId } });
  } else {
    const job = runLetterPipeline(env, runId).catch((err) => console.error('letter run failed', err?.stack || err));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
  return runView(env, await first(env.DB, 'SELECT * FROM letter_runs WHERE id = ?', runId));
}

/** The Workflow: four durable steps. Each step records its own failure, so a step that throws is not retried. */
export class LetterAgent extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId } = event.payload;
    const guard = (fn) => async () => {
      try { return await fn(); } catch (err) { throw new NonRetryableError(String(err?.message || err)); }
    };
    const opts = { timeout: '15 minutes', retries: { limit: 0, delay: '1 second' } };
    const s1 = await step.do('dados', opts, guard(() => agentDados(this.env, runId)));
    if (!s1) return;
    const s2 = await step.do('analise', opts, guard(() => agentAnalise(this.env, runId, s1)));
    if (!s2) return;
    const s3 = await step.do('redacao', opts, guard(() => agentRedacao(this.env, runId, s2)));
    if (!s3) return;
    await step.do('diagramacao', opts, guard(() => agentDiagramacao(this.env, runId, s3)));
  }
}

/** The same four steps, in-process, for a runtime without the Workflow binding. */
export async function runLetterPipeline(env, runId) {
  const s1 = await agentDados(env, runId);
  if (!s1) return;
  const s2 = await agentAnalise(env, runId, s1);
  if (!s2) return;
  const s3 = await agentRedacao(env, runId, s2);
  if (!s3) return;
  await agentDiagramacao(env, runId, s3);
}

// ── the run's bookkeeping ─────────────────────────────────────────────────────
/**
 * The progress row and the state row, together.
 *
 * The four steps hand their state to each other through the return value, but
 * a Workflow step is resumable and its argument is serialised, so the state is
 * also written to graph_runs: a run picked up after a restart reads back the
 * same object the previous step produced.
 */
async function loadRun(db, runId) {
  const row = await first(db, 'SELECT * FROM letter_runs WHERE id = ?', runId);
  if (!row) throw new Error(`letter run ${runId} not found`);
  const client = await first(db, 'SELECT * FROM clients WHERE id = ?', row.client_id);
  const advisor = await first(db, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id WHERE a.id = ?', row.advisor_id);
  const log = json(row.log_json, []);

  const report = async (step, progress, message) => {
    log.push({ at: nowIso(), step, message });
    await run(db, 'UPDATE letter_runs SET step = ?, progress = ?, message = ?, log_json = ? WHERE id = ?',
      step, Math.round(progress), message, JSON.stringify(log.slice(-60)), runId);
  };
  const saveState = async (state) => {
    await run(db, 'UPDATE graph_runs SET outputs_json = ? WHERE id = ?', JSON.stringify(state), row.graph_run_id);
  };
  const fail = async (err, blockedBy = null) => {
    if (!blockedBy) console.error('letter agent', err?.stack || err);
    await run(db, 'UPDATE letter_runs SET status = ?, error = ?, blocked_by = ?, finished_at = ?, log_json = ? WHERE id = ?',
      'failed', String(err?.message || err), blockedBy, nowIso(), JSON.stringify(log.slice(-60)), runId);
    await run(db, 'UPDATE graph_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?',
      'failed', String(err?.message || err), nowIso(), row.graph_run_id);
  };
  return { row, client, advisor, log, report, saveState, fail };
}

/** 1 · Dados — the carteira the letter is about, priced for the month it covers. */
async function agentDados(env, runId) {
  const db = env.DB;
  const { row, client, report, saveState, fail } = await loadRun(db, runId);
  try {
    P.attachKv(env);
    const month = row.reporting_month || previousMonth(today());
    await report(1, 5, `Carta · Dados — lendo a carteira aprovada, a política e os lançamentos de ${client.full_name}`);
    const ctx = await P.loadClientContext(env, client.id, { month });
    await report(1, 12, `Carta · Dados — ${ctx.positions.length} posições e ${ctx.flows.length} ${ctx.flows.length === 1 ? 'movimentação' : 'movimentações'} em ${monthLabel(month, 'pt-BR')}; buscando os preços de abertura e fechamento`);

    const market = await P.fetchAndValidateMarketData(env, ctx);
    const priced = market.priced.filter((p) => p.open_price != null).length;
    const unavailable = market.validation.filter((v) => v.status === 'unavailable');

    // A meeting already in the diary is what the letter closes on, so it is read
    // here with everything else the letter rests on rather than guessed later.
    const meeting = await first(db, "SELECT date FROM meetings WHERE client_id = ? AND status IN ('scheduled','in_preparation') ORDER BY date LIMIT 1", client.id);

    const state = { ctx, market, next_meeting: meeting?.date || null };
    await saveState(state);
    await report(1, 22, `Carta · Dados — ${priced} de ${market.priced.length} posições precificadas${unavailable.length ? `, ${unavailable.length} sem preço (${unavailable.map((v) => v.ticker).slice(0, 3).join(', ')})` : ''} · ${market.ledger.length} fontes registradas`);
    return state;
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 2 · Análise — the month's numbers, the events that touch this carteira, and what to propose. */
async function agentAnalise(env, runId, s1) {
  const db = env.DB;
  const { row, report, saveState, fail } = await loadRun(db, runId);
  try {
    P.attachKv(env);
    const state = { ...s1 };
    await report(2, 28, 'Carta · Análise — apurando a rentabilidade do mês e a carteira de referência da política');
    state.perf = await P.computeProfitability(env, state.ctx, state.market);
    state.benchmark = await P.computeBenchmark(env, state.ctx, state.market);
    state.metrics = await P.computeMetrics(env, state.ctx);

    await run(db, `INSERT INTO monthly_returns (id, client_id, month, portfolio_return, benchmark_return, method) VALUES (?,?,?,?,?,?)
      ON CONFLICT(client_id, month) DO UPDATE SET portfolio_return=excluded.portfolio_return, benchmark_return=excluded.benchmark_return, method=excluded.method, computed_at=datetime('now')`,
      id('mr'), state.ctx.client.id, state.ctx.reporting_period.month, state.perf.monthly_return, state.benchmark.available ? state.benchmark.value : null, state.perf.method);

    await report(2, 36, state.perf.monthly_return == null
      ? 'Carta · Análise — não foi possível apurar o retorno do mês com os dados disponíveis'
      : `Carta · Análise — ${(state.perf.monthly_return * 100).toFixed(2).replace('.', ',')}% no mês${state.benchmark.available ? ` contra ${(state.benchmark.value * 100).toFixed(2).replace('.', ',')}% da referência` : ''}; lendo os indicadores e os eventos do período`);

    const indicators = await P.fetchIndicators(env, INDICATORS);
    const triggers = await P.evaluateTriggers(env, indicators, state.ctx?.advisor?.id);
    const curated = await P.loadMarketEvents(env, { since: addDays(today(), -35), limit: 20 });
    const events = A.dedupeEvents([...curated, ...P.eventsFromIndicatorMoves(indicators)]);

    const total = state.perf?.ending_market_value || 1;
    const exposures = {};
    for (const p of state.market.priced) exposures[p.asset.asset_class] = (exposures[p.asset.asset_class] ?? 0) + (p.market_value ?? 0) / total;
    const portfolio = {
      exposures,
      base_currency: state.ctx.policy?.base_currency || 'BRL',
      positions: state.market.priced.map((p) => ({ ticker: p.asset.ticker, asset_id: p.asset.id, asset_class: p.asset.asset_class, weight: (p.market_value ?? 0) / total, currency: p.asset.currency })),
    };
    state.indicators = indicators.map(A.compactIndicator);
    state.triggers = triggers;
    state.events = events;
    state.impact = events.map((e) => P.mapEventToPortfolio(e, portfolio)).filter((i) => i.relevance !== 'none');
    state.exposures = exposures;

    await report(2, 44, `Carta · Análise — ${state.impact.length} de ${events.length} eventos tocam esta carteira; lendo a leitura técnica e o consenso de analistas`);
    const heldAssets = state.market.priced.map((p) => p.asset).filter((a) => a.tv_symbol);
    const candidateIds = await LP.defaultCandidates(env, state);
    const candidateRows = candidateIds.length
      ? await all(db, `SELECT * FROM assets WHERE id IN (${candidateIds.map(() => '?').join(',')})`, ...candidateIds)
      : [];
    state.signals = await P.fetchSignals(env, [...heldAssets, ...candidateRows.filter((a) => a.tv_symbol)]);
    state.candidates = candidateIds;

    await report(2, 50, 'Carta · Análise — medindo cada posição contra a política e compondo os pontos a discutir');
    state.world_view = await LP.loadWorldView(env, state.ctx.advisor?.id);
    const built = await P.buildAndCheckRecommendations(env, state.ctx, state.market, state.perf, state.signals, state.world_view, state.candidates);
    const { setId, carried } = await LP.persistRecommendations(env, state, built);
    state.recommendations = built.recommendations;
    state.portfolio_flags = built.portfolio_flags;
    state.recommendation_set_id = setId;
    state.exposures = built.exposures;

    await saveState(state);
    // withinPolicy, not a string comparison against a value suitability_result
    // never takes. The field holds PASS, DISCUSS_ONLY, DO_NOT_ADD,
    // REDUCE_REQUIRED or BLOCKED; "within_policy" is the name of the question,
    // not one of the answers, so every evaluated position failed the test and
    // the advisor watched the card announce that all fourteen of Albert's
    // positions were out of policy while the letter named two.
    const outside = built.recommendations.filter((r) => !withinPolicy(r)).length;
    await report(2, 58, `Carta · Análise — ${built.recommendations.length} ${built.recommendations.length === 1 ? 'posição avaliada' : 'posições avaliadas'}${outside ? `, ${outside} fora da política` : ', todas dentro da política'}${carried ? `; ${carried} ${carried === 1 ? 'decisão sua foi mantida' : 'decisões suas foram mantidas'}` : ''}`);
    return state;
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 3 · Redação — the model writes from FACTS, or the template phrases the same facts. */
async function agentRedacao(env, runId, s2) {
  const { report, saveState, fail } = await loadRun(env.DB, runId);
  try {
    const firstName = String(s2.ctx.client.full_name || '').trim().split(/\s+/)[0] || 'o cliente';
    await report(3, 64, `Carta · Redação — escrevendo para ${firstName}: o mês, o que aconteceu nos mercados e o que isso significa para a carteira`);
    const narrative = await LP.buildNarrative(env, s2);
    const state = { ...s2, narrative };
    await saveState(state);
    /**
     * When the model was tried and refused, the card says so and says why.
     *
     * "Sem modelo de linguagem" covers two different events: no key configured,
     * and a key that answered with something the guardrail would not publish.
     * The advisor needs to tell them apart — the first is how the product is
     * meant to run offline, the second is a fault someone has to look at — and
     * the reason was being computed, returned and thrown away.
     */
    const how = narrative.mode === 'model'
      ? narrative.model
      : narrative.mode === 'deterministic_template'
        ? 'sem modelo de linguagem: texto determinístico a partir dos mesmos fatos'
        : `texto determinístico: o modelo foi consultado e a resposta foi recusada — ${narrative.fallback_reason || 'motivo não registrado'}`;
    await report(3, 74, `Carta · Redação — carta pronta em ${narrative.letter.paragraphs.length} ${narrative.letter.paragraphs.length === 1 ? 'parágrafo' : 'parágrafos'} (${how})`);
    return state;
  } catch (err) {
    await fail(err);
    return null;
  }
}

/**
 * 4 · Diagramação — the letter, its annex, the e-mail and the portal page, and
 * the report row the portal reads.
 *
 * Only proposals the advisor has already approved are printed: a letter is not
 * the place a client learns about a suggestion their advisor has not yet
 * decided on. On a first run for the month that is usually none, and the letter
 * is a letter without a table — which is the honest state of it.
 */
async function agentDiagramacao(env, runId, s3) {
  const db = env.DB;
  const { row, log, report, saveState, fail } = await loadRun(db, runId);
  try {
    await report(4, 80, 'Carta · Diagramação — montando o objeto canônico da carta e conferindo cada número contra a sua fonte');
    const assembled = await LP.assembleLetter(env, s3, { force: !!row.reissue, graphRunId: row.graph_run_id, promptVersion: PROMPT_VERSION });
    // Not a crash: a published letter is one the client has already read, so
    // replacing it is the advisor's decision to take, not this agent's. The run
    // stops and says so, and the tab offers the way past it.
    if (assembled.conflict) {
      const when = String(assembled.conflict.published_at || '').slice(0, 10);
      await fail(new Error(`a carta de ${monthLabel(row.reporting_month, 'pt-BR')} foi publicada${when ? ` em ${when.split('-').reverse().join('/')}` : ''} e o cliente já pode tê-la lido. Reescrevê-la substitui o que ele leu.`), 'published');
      return null;
    }
    const blocking = assembled.check.errors.filter((e) => !e.includes('only advisor-approved'));
    if (blocking.length) throw new Error(`a carta não passou na validação: ${blocking.slice(0, 2).join('; ')}`);

    const state = { ...s3, report: assembled.report, report_id: assembled.report_id };
    await report(4, 88, 'Carta · Diagramação — desenhando as duas páginas, o e-mail e a página do portal');
    const rendered = await LP.renderLetter(env, state, { approvedOnly: true });
    if (rendered.invalid) throw new Error(`a carta não passou na validação: ${rendered.invalid.errors.slice(0, 2).join('; ')}`);
    state.report = rendered.report;
    state.render = rendered.render;
    await saveState(state);

    await report(4, 96, 'Carta · Diagramação — gravando a carta, as fontes que a sustentam e a linha de auditoria');
    await LP.persistLetter(env, state, { status: 'pending_approval', actorId: row.actor_id, graphRunId: row.graph_run_id });

    const printed = rendered.report.recommendations.length;
    const message = `Concluído — ${rendered.render.page_count} ${rendered.render.page_count === 1 ? 'página' : 'páginas'}, ${rendered.report.sources.length} fontes${printed ? `, ${printed} ${printed === 1 ? 'recomendação aprovada impressa' : 'recomendações aprovadas impressas'}` : ', sem recomendações aprovadas para imprimir'}. Aguardando a sua aprovação.`;
    await run(db, `UPDATE letter_runs SET status = ?, step = 5, progress = 100, message = ?, report_id = ?, report_status = ?, page_count = ?, narrative_mode = ?, finished_at = ?, log_json = ? WHERE id = ?`,
      'completed', message, state.report_id, 'pending_approval', rendered.render.page_count, s3.narrative?.mode || null,
      nowIso(), JSON.stringify([...log, { at: nowIso(), step: 5, message }].slice(-60)), runId);
    await run(db, 'UPDATE graph_runs SET status = ?, finished_at = ? WHERE id = ?', 'completed', nowIso(), row.graph_run_id);
    await audit(db, {
      entity: 'letter_run', entity_id: runId, action: 'completed', actor_id: row.actor_id,
      detail: { client_id: state.ctx.client.id, report_id: state.report_id, month: row.reporting_month, pages: rendered.render.page_count, narrative: s3.narrative?.mode },
    });
    return { ok: true };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/**
 * The letter as PDF bytes: the R2 object when it is there, re-rendered from the
 * canonical report the row stores when it is not. `null` when the run never got
 * as far as writing a letter.
 */
export async function letterBytes(env, reportRow) {
  if (!reportRow) return null;
  if (env.REPORTS && reportRow.pdf_r2_key) {
    const obj = await env.REPORTS.get(reportRow.pdf_r2_key);
    if (obj) return new Uint8Array(await obj.arrayBuffer());
  }
  const report = json(reportRow.canonical_report_json, null);
  if (!report) return null;
  const doc = await renderLetterPdf(buildLetterModel(report, { locale: report.locale }), { fonts: brandFonts() });
  return doc.build();
}
