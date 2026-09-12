/**
 * The report agent: four sequential steps that produce the two-page client
 * report an advisor asks for from the client page, entirely inside the Worker.
 *
 *   1. Dados        — the approved portfolio, the policy, the return history,
 *                     the day's World Overview and the month's profitability,
 *                     each from the record the portal already trusts
 *   2. Análise      — returns for the month, the year and twelve months, the
 *                     monthly matrix, the allocation against the policy with a
 *                     position and a change per class, the discussion points
 *   3. Redação      — the model writes the market view and the comments from a
 *                     FACTS object and is never asked for a number; without a
 *                     model, a template phrases the same facts
 *   4. Diagramação  — the renderer measures every block and drops the least
 *                     important until the report fits in two pages. Never three.
 *
 * Progress is written to pdf_reports after every meaningful sub-step so the
 * tab that opened the run shows what is happening. The pipeline runs as a
 * Cloudflare Workflow for the same reason the daily agents do; without the
 * binding the four functions run in-process.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { all, first, run, id, json, nowIso, audit, snapshotPositions } from './db.js';
import * as P from './pipeline.js';
import * as LLM from './llm.js';
import * as A from './agents.js';
import { meetingPrep, runProfitabilityLive } from './client-analysis.js';
import { assetRiskReturn } from './risk-return.js';
import { signArtefact } from './links.js';
import { analyseForReport, factsForNarrative, buildReportModel, sanitiseNarrative } from '../../src/render/report-model.js';
import { renderReportPdf } from '../../src/render/pdf/report.js';
import { brandFonts } from '../../src/render/fonts/index.js';
import { previousMonth, monthLabel } from '../../src/core/format.js';
import { renderPrompt } from '../../src/llm/prompts.js';

export const ARTEFACT_KIND = 'pdf-report';
export const REPORT_AGENTS = [
  { step: 1, key: 'dados', title: 'Relatório · Dados', what: 'a carteira, o histórico, os eventos do dia e o risco e retorno de cada ativo' },
  { step: 2, key: 'analise', title: 'Relatório · Análise', what: 'performance, o que pode melhorar, o que pode piorar' },
  { step: 3, key: 'redacao', title: 'Relatório · Redação', what: 'uma carta ao cliente, pelo nome, sem inventar um número' },
  { step: 4, key: 'diagramacao', title: 'Relatório · Diagramação', what: 'duas páginas, nunca mais do que isso' },
];
const STALE_MS = 10 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const isStale = (row) => row.status === 'running' && Date.now() - Date.parse(row.started_at) > STALE_MS;

/** What the portal sees of a run: progress, and the signed link once the PDF exists. */
export async function runView(env, row) {
  if (!row) return null;
  const stale = isStale(row);
  const token = row.status === 'completed' ? await signArtefact(env, row.id, ARTEFACT_KIND) : null;
  return {
    id: row.id, client_id: row.client_id,
    status: stale ? 'failed' : row.status,
    step: row.step, progress: row.progress, message: row.message,
    error: stale ? 'sem progresso há mais de dez minutos' : row.error,
    started_at: row.started_at, finished_at: row.finished_at,
    reporting_month: row.reporting_month, page_count: row.page_count, reduction_level: row.reduction_level,
    omitted: json(row.omitted_json, []), narrative_mode: row.narrative_mode,
    log: json(row.log_json, []).slice(-12),
    agents: REPORT_AGENTS,
    links: row.status === 'completed' ? { pdf: `/api/pdf-reports/${row.id}/pdf${token ? `?t=${encodeURIComponent(token)}` : ''}` } : null,
  };
}

export async function listReportRuns(env, clientId) {
  const rows = await all(env.DB, 'SELECT * FROM pdf_reports WHERE client_id = ? ORDER BY started_at DESC LIMIT 20', clientId);
  const out = [];
  for (const r of rows) out.push(await runView(env, r));
  return out;
}

/** Start a run in the background and return its row at once. The tab polls it. */
export async function startReportRun(env, ctx, { scope, actorId = null }) {
  const db = env.DB;
  const { client, advisor } = scope;
  const runId = id('pdf');
  await run(db,
    'INSERT INTO pdf_reports (id, client_id, advisor_id, status, step, progress, message, actor_id, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
    runId, client.id, advisor.id, 'running', 0, 0, 'Na fila', actorId, nowIso());
  if (env.REPORT_AGENT) {
    await env.REPORT_AGENT.create({ id: runId, params: { runId } });
  } else {
    const job = runReportPipeline(env, runId).catch((err) => console.error('report run failed', err?.stack || err));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
  return runView(env, await first(db, 'SELECT * FROM pdf_reports WHERE id = ?', runId));
}

/** The Workflow: four durable steps. Each step records its own failure, so a step that throws is not retried. */
export class ReportAgent extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId } = event.payload;
    const guard = (fn) => async () => {
      try { return await fn(); } catch (err) { throw new NonRetryableError(String(err?.message || err)); }
    };
    const opts = { timeout: '10 minutes', retries: { limit: 0, delay: '1 second' } };
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
export async function runReportPipeline(env, runId) {
  const s1 = await agentDados(env, runId);
  if (!s1) return;
  const s2 = await agentAnalise(env, runId, s1);
  if (!s2) return;
  const s3 = await agentRedacao(env, runId, s2);
  if (!s3) return;
  await agentDiagramacao(env, runId, s3);
}

// ── the run's bookkeeping ─────────────────────────────────────────────────────
async function loadRun(db, runId) {
  const row = await first(db, 'SELECT * FROM pdf_reports WHERE id = ?', runId);
  if (!row) throw new Error(`run ${runId} not found`);
  const client = await first(db, 'SELECT * FROM clients WHERE id = ?', row.client_id);
  const advisor = await first(db, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id WHERE a.id = ?', row.advisor_id);
  const log = json(row.log_json, []);
  const report = async (step, progress, message, detail = null) => {
    log.push({ at: nowIso(), step, message, detail });
    await run(db, 'UPDATE pdf_reports SET step = ?, progress = ?, message = ?, log_json = ? WHERE id = ?',
      step, Math.round(progress), message, JSON.stringify(log.slice(-60)), runId);
  };
  const fail = async (err) => {
    console.error('report agent', err?.stack || err);
    await run(db, 'UPDATE pdf_reports SET status = ?, error = ?, finished_at = ?, log_json = ? WHERE id = ?',
      'failed', String(err?.message || err), nowIso(), JSON.stringify(log.slice(-60)), runId);
  };
  return { row, client, advisor, log, report, fail };
}

const pt = (obj, key) => obj?.[`${key}_pt`] || obj?.[key] || null;

/** 1 · Dados — everything the report rests on, from the record the portal already trusts. */
async function agentDados(env, runId) {
  const db = env.DB;
  const { client, advisor, report, fail } = await loadRun(db, runId);
  try {
    P.attachKv(env);
    const month = previousMonth(today());
    await report(1, 4, `Relatório · Dados — lendo a carteira aprovada, a política e o histórico de ${client.full_name}`);
    const ctx = await P.loadClientContext(env, client.id, { month });
    const total = ctx.positions.reduce((a, p) => a + (p.market_value || 0), 0);
    const positions = ctx.positions.map((p) => ({
      asset_id: p.asset_id, ticker: p.ticker, name: p.asset_name, asset_class: p.asset_class, type: p.type,
      market_value: p.market_value || 0, weight: total ? (p.market_value || 0) / total : 0, pricing_mode: p.pricing_mode, currency: p.currency,
    }));

    // The previous approved snapshot gives the "mudança" column of the allocation view.
    let previousWeights = null;
    const prev = (ctx.snapshot_history || []).find((s) => s.id !== ctx.snapshot.id && s.effective_date <= ctx.snapshot.effective_date);
    if (prev) {
      const rows = await snapshotPositions(db, prev.id);
      const t = rows.reduce((a, p) => a + (p.market_value || 0), 0) || 1;
      previousWeights = {};
      for (const p of rows) previousWeights[p.asset_class] = (previousWeights[p.asset_class] ?? 0) + (p.market_value || 0) / t;
    }

    await report(1, 12, 'Relatório · Dados — lendo o último panorama do dia dos agentes diários');
    const last = await A.latestRun(db, advisor.id, { status: 'completed' });
    const ov = last ? json(last.result_json, {}) : null;
    const held = new Set(positions.map((p) => p.asset_class));
    const wv = ov?.world_view || null;
    const view = wv?.briefing || {};
    const briefingRaw = view.briefing || {};
    const overview = ov ? {
      date: ov.date,
      headline: wv?.generated_summary || view.headline || null,
      summary: view.summary_pt || null,
      briefing: {
        equities: pt(briefingRaw, 'equities'), rates_credit: pt(briefingRaw, 'rates_credit'),
        fx_commodities: pt(briefingRaw, 'fx_commodities'), macro_political: pt(briefingRaw, 'macro_political'),
        main_risk_or_opportunity: pt(briefingRaw, 'main_risk_or_opportunity'),
      },
      indicators: (ov.indicators || []).filter((i) => !i.unavailable),
      triggers: (ov.triggers || []).filter((t) => t.status === 'BREACHED' && (t.asset_classes || []).some((c) => held.has(c))),
      // the day's What Matters rows, as the client will read them: what happened, why it matters, who reported it
      what_matters: (ov.what_matters || []).slice(0, 8).map((r) => ({
        title: r.event_pt || r.event, why: r.why_it_matters_pt || r.why_it_matters || null, impact: r.potential_impact_pt || r.potential_impact || null,
        region: r.region || null, importance: r.importance || 'medium', kind: r.kind || null,
        source: r.source_provider || (r.source_label ? String(r.source_label).split(':')[0].trim() : null),
        touches: (r.exposure_summary?.asset_classes || []).some((c) => held.has(c)),
      })),
      sources: [...new Set((ov.sources || []).filter((s) => !/news|headline|press|manchete/i.test(`${s.kind || ''} ${s.id || ''}`)).map((s) => s.provider).filter(Boolean))],
      inference_mode: ov.inference?.mode ?? null,
    } : null;

    // twelve months of return and volatility for each asset held, from the same
    // computation the signals page draws; a line that cannot be measured is named
    await report(1, 16, 'Relatório · Dados — medindo retorno e volatilidade de 12 meses de cada ativo da carteira');
    let riskReturn = null;
    try {
      const rr = await assetRiskReturn(env, db);
      const heldIds = new Set(positions.map((p) => p.asset_id));
      const weightOf = new Map(positions.map((p) => [p.asset_id, p.weight]));
      riskReturn = {
        window: rr.window,
        assets: rr.assets.filter((a) => heldIds.has(a.id)).map((a) => ({
          id: a.id, ticker: a.ticker, name: a.name, asset_class: a.asset_class, risk_class: a.risk_class,
          total_return: a.total_return, volatility: a.volatility, partial: a.partial, simulated: a.simulated, weight: weightOf.get(a.id) ?? 0,
        })),
        references: rr.references.map((r) => ({ key: r.key, label: r.label, total_return: r.total_return, volatility: r.volatility })),
        excluded: rr.excluded.filter((e) => heldIds.has(e.id)).map((e) => ({ label: e.ticker || e.label || e.name, reason: e.reason })),
        sources: [...new Set((rr.sources || []).map((x) => x.provider).filter(Boolean))],
      };
    } catch (err) {
      await report(1, 18, `Relatório · Dados — risco e retorno por ativo indisponível nesta execução (${String(err.message).slice(0, 80)})`);
    }

    await report(1, 20, `Relatório · Dados — apurando a rentabilidade de ${monthLabel(month)}: preços, carteira de referência e medidas históricas`);
    const existing = await first(db, 'SELECT * FROM reports WHERE client_id = ? AND reporting_month = ? ORDER BY created_at DESC LIMIT 1', client.id, month);
    let perf;
    if (existing) {
      const c = json(existing.canonical_report_json, {});
      perf = {
        from_report: existing.id, performance: c.portfolio_performance || null, attribution: c.performance_attribution || null,
        benchmark: c.benchmark || null, metrics: c.portfolio_metrics || null,
        sources: [...new Set((c.sources || []).map((s) => s.provider).filter(Boolean))],
      };
    } else {
      const live = await runProfitabilityLive(env, client.id, month);
      const src = typeof live.sources?.all === 'function' ? live.sources.all() : (live.sources || []);
      perf = {
        from_report: null, performance: live.performance || null, attribution: live.performance?.attribution || null,
        benchmark: live.benchmark || null, metrics: live.metrics || null,
        sources: [...new Set(src.map((s) => s.provider).filter(Boolean))],
      };
    }

    await report(1, 30, 'Relatório · Dados — reunindo recomendações aprovadas, sinais divergentes e a preparação da reunião');
    const prep = await meetingPrep(env, { client }, month);
    const recs = (prep.recommendations || []).filter((r) => r.advisor_status === 'approved' && r.final_action && r.final_action !== 'HOLD');
    const written = new Map(((existing && json(existing.canonical_report_json, {}).recommendations) || []).map((r) => [r.asset_id, r.rationale_pt || r.rationale || null]));
    const assetRows = recs.length
      ? await all(db, `SELECT id, ticker, name, asset_class FROM assets WHERE id IN (${recs.map(() => '?').join(',')})`, ...recs.map((r) => r.asset_id))
      : [];
    const byId = new Map(assetRows.map((a) => [a.id, a]));
    const recommendations = recs.map((r) => ({
      asset_id: r.asset_id, ticker: byId.get(r.asset_id)?.ticker || null, name: byId.get(r.asset_id)?.name || r.asset_id,
      asset_class: byId.get(r.asset_id)?.asset_class || null, final_action: r.final_action, suitability_result: r.suitability_result,
      rationale: r.rationale || r.statement?.rationale_pt || written.get(r.asset_id) || null, signal_conflict: r.signal_conflict, current_weight: r.current_weight,
    }));

    const policy = ctx.policy || {};
    const state = {
      date: today(), month,
      client: { id: client.id, name: client.full_name, risk_profile: client.risk_profile, segment: client.segment, base_currency: client.base_currency },
      advisor: { name: advisor.name, code: advisor.advisor_code, team: advisor.team },
      policy: {
        version: policy.version, effective_date: policy.effective_date, risk_profile: policy.risk_profile,
        target_allocation: policy.target_allocation || {}, permitted_ranges: policy.permitted_ranges || {},
        rebalance_trigger: policy.rebalance_trigger ?? 0.05, single_name_cap: policy.single_name_cap ?? null,
      },
      snapshot: { id: ctx.snapshot.id, effective_date: ctx.snapshot.effective_date },
      total, positions, previous_weights: previousWeights,
      returns_history: (ctx.returns_history || []).map((r) => ({ month: r.month, portfolio: r.portfolio_return, benchmark: r.benchmark_return, method: r.method })),
      overview, perf, risk_return: riskReturn,
      discussion_opportunities: prep.discussion_opportunities || [],
      recommendations,
      next_meeting: prep.next_meeting?.date || null,
    };
    await report(1, 34, `Relatório · Dados — ${positions.length} posições, ${state.returns_history.length} meses de histórico, ${overview ? overview.what_matters.length : 0} eventos do panorama de ${overview?.date || 'hoje'}, ${riskReturn ? riskReturn.assets.length : 0} ativos com risco e retorno medidos`);
    return state;
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 2 · Análise — pure computation over what agent 1 gathered. */
async function agentAnalise(env, runId, s1) {
  const { report, fail } = await loadRun(env.DB, runId);
  try {
    await report(2, 40, 'Relatório · Análise — compondo retornos: mês, ano, doze meses e desde o início; lendo o risco e o retorno de cada ativo');
    const analysis = analyseForReport(s1);
    await report(2, 48, `Relatório · Análise — ${analysis.events.length} eventos, ${analysis.scatter.assets.length} ativos no gráfico de risco e retorno, ${analysis.improve.length} ${analysis.improve.length === 1 ? 'ponto que pode melhorar' : 'pontos que podem melhorar'}, ${analysis.worsen.length} ${analysis.worsen.length === 1 ? 'que pode piorar' : 'que podem piorar'}`);
    return { ...s1, analysis };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 3 · Redação — the model writes from FACTS, or the template phrases the same facts. */
async function agentRedacao(env, runId, s2) {
  const { report, fail } = await loadRun(env.DB, runId);
  try {
    const facts = factsForNarrative(s2);
    let narrative = null; let mode = 'deterministic_template'; let model = null;
    if (LLM.llmAvailable(env)) {
      await report(3, 56, `Relatório · Redação — o modelo escreve para ${s2.client.name.split(' ')[0]}: o mundo, os eventos, a performance e o que pode melhorar ou piorar`);
      // Claude Opus 5 thinks before it answers and the thinking shares max_tokens
      // with the reply, so the budget is generous; a reply that is not the JSON
      // asked for is sent back once with the shape restated, then the template.
      const prompt = renderPrompt('pdf_report', facts);
      let user = prompt.user;
      for (let attempt = 1; attempt <= 2 && !narrative; attempt += 1) {
        try {
          const out = await LLM.complete(env, { system: prompt.system, user, maxTokens: 6000 });
          const data = LLM.parseJsonBlock(out.text);
          if (!data) throw new Error(`no parsable JSON (${String(out.text || '').replace(/\s+/g, ' ').slice(0, 120)}…)`);
          narrative = sanitiseNarrative(data, facts);
          mode = 'model'; model = out.model;
        } catch (err) {
          await report(3, 58 + attempt * 2, `Relatório · Redação — o modelo ${attempt === 1 ? 'não devolveu o JSON pedido' : 'falhou de novo'} (${String(err.message).slice(0, 160)})${attempt === 1 ? '; pedindo outra vez' : '; usando o texto determinístico'}`);
          user = `${prompt.user}\n\nYour previous reply was not the JSON object requested. Reply with ONLY the JSON object described under "Output": no prose before or after it, no markdown fence.`;
        }
      }
    }
    if (!narrative) narrative = LLM.deterministicReportNarrative(facts);
    await report(3, 66, `Relatório · Redação — texto pronto (${mode === 'model' ? model : 'sem modelo de linguagem: texto determinístico a partir dos mesmos fatos'})`);
    return { ...s2, narrative, narrative_mode: mode, narrative_model: model };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** 4 · Diagramação — the renderer measures, reduces and never draws a third page. */
async function agentDiagramacao(env, runId, s3) {
  const db = env.DB;
  const { log, report, fail } = await loadRun(db, runId);
  try {
    await report(4, 74, 'Relatório · Diagramação — montando os eventos, o gráfico acumulado, o risco × retorno dos ativos e a carteira');
    const model = buildReportModel(s3);
    await report(4, 84, 'Relatório · Diagramação — medindo cada bloco para caber em duas páginas');
    const doc = await renderReportPdf(model, { fonts: brandFonts(), maxPages: 2 });
    const pdf = doc.build();
    const key = `pdf-reports/${s3.client.id}/${runId}.pdf`;
    if (env.REPORTS) await env.REPORTS.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
    const omitted = doc.omitted || [];
    const message = `Concluído — ${doc.pageCount} ${doc.pageCount === 1 ? 'página' : 'páginas'}${doc.reductionLevel ? `, nível de redução ${doc.reductionLevel}` : ''}${omitted.length ? `, ${omitted.length} ${omitted.length === 1 ? 'bloco omitido' : 'blocos omitidos'} para caber` : ''}`;
    await run(db, `UPDATE pdf_reports SET status = ?, step = 5, progress = 100, message = ?, reporting_month = ?, model_json = ?, pdf_r2_key = ?, page_count = ?, reduction_level = ?, omitted_json = ?, narrative_mode = ?, finished_at = ?, log_json = ? WHERE id = ?`,
      'completed', message, s3.month, JSON.stringify(model), env.REPORTS ? key : null, doc.pageCount, doc.reductionLevel ?? 0,
      JSON.stringify(omitted), s3.narrative_mode, nowIso(), JSON.stringify([...log, { at: nowIso(), step: 5, message }].slice(-60)), runId);
    await audit(db, { entity: 'pdf_report', entity_id: runId, action: 'completed', actor_id: null, detail: { client_id: s3.client.id, pages: doc.pageCount, reduction: doc.reductionLevel, omitted, narrative: s3.narrative_mode } });
    return { ok: true };
  } catch (err) {
    await fail(err);
    return null;
  }
}

/** The PDF from R2, or re-rendered from the stored model when the object is gone. */
export async function servePdfReport(env, row) {
  const headers = {
    'content-type': 'application/pdf',
    'content-disposition': `inline; filename="relatorio-${row.reporting_month || 'carteira'}.pdf"`,
    'cache-control': 'private, max-age=300',
  };
  if (env.REPORTS && row.pdf_r2_key) {
    const obj = await env.REPORTS.get(row.pdf_r2_key);
    if (obj) return new Response(obj.body, { headers });
  }
  const model = json(row.model_json, null);
  if (!model) return new Response(JSON.stringify({ error: 'report not rendered' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const doc = await renderReportPdf(model, { fonts: brandFonts(), maxPages: 2 });
  return new Response(doc.build(), { headers });
}
