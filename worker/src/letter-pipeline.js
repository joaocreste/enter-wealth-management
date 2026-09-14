/**
 * The monthly letter's stages, apart from whoever is driving them.
 *
 * The letter has two drivers: the Rivet graph, which calls /api/pipeline/* one
 * step at a time so the prompts stay visible and editable inside the graph, and
 * the letter agent (worker/src/letter-agent.js), which runs the same stages
 * inside the Worker when an advisor presses "criar carta mensal" on the client
 * page. Both must produce the same document from the same numbers, so the work
 * itself lives here and neither driver owns it.
 *
 * Nothing in this file asks a language model for a number. The model is given
 * FACTS — every figure already formatted as a string — and writes prose around
 * them; the arithmetic and the provenance stay in worker/src/pipeline.js.
 */
import { all, first, run, id, json, nowIso, audit } from './db.js';
import * as P from './pipeline.js';
import * as LLM from './llm.js';
import { buildLetterModel, prioritiseForLetter, sanitiseLetter, houseView } from '../../src/render/letter-model.js';
import { renderLetterHtml, renderPortalLetter } from '../../src/render/html-email.js';
import { renderLetterPdf } from '../../src/render/pdf/letter.js';
import { brandFonts } from '../../src/render/fonts/index.js';
import { validateReport } from '../../src/core/report-schema.js';
import { shortAssetName, monthLabel, dateLong, percent, money, pp } from '../../src/core/format.js';
import { withinPolicy } from '../../src/core/suitability.js';
import { PROMPT_VERSION } from '../../src/llm/prompts.js';

/**
 * A candidate is an instrument that would move an under-allocated class back
 * toward its policy target. Nothing is proposed for a class already in range.
 */
export async function defaultCandidates(env, state) {
  const db = env.DB;
  const policy = state.ctx.policy;
  const total = state.perf?.ending_market_value || 1;
  const exposures = {};
  for (const p of state.market.priced) exposures[p.asset.asset_class] = (exposures[p.asset.asset_class] ?? 0) + (p.market_value ?? 0) / total;
  const held = new Set(state.market.priced.map((p) => p.asset.id));

  const under = Object.entries(policy?.permitted_ranges || {})
    .filter(([k, band]) => band.min != null && (exposures[k] ?? 0) < band.min)
    .map(([k]) => k);
  if (!under.length) return [];

  const rows = await all(db, `SELECT id FROM assets WHERE asset_class IN (${under.map(() => '?').join(',')}) AND tv_symbol IS NOT NULL AND pricing_mode = 'market'`, ...under);
  return rows.map((r) => r.id).filter((x) => !held.has(x)).slice(0, 3);
}

/**
 * The run state holds the recommendations as the engine proposed them. The
 * advisor's decisions live in D1. Every step that speaks for the client — the
 * narrative, the validation and the render — reads the decisions back first, so
 * an approval made in the portal is reflected without re-running the pipeline.
 */
export async function refreshRecommendationStatus(env, state) {
  if (!state.recommendation_set_id) return state.recommendations || [];
  const decided = await all(env.DB, 'SELECT * FROM recommendations WHERE client_id = ? AND reporting_month = ?',
    state.ctx.client.id, state.ctx.reporting_period.month);
  const byAsset = new Map(decided.map((d) => [d.asset_id, d]));
  return (state.recommendations || []).map((r) => {
    const d = byAsset.get(r.asset_id);
    return d ? { ...r, advisor_status: d.advisor_status, advisor_note: d.advisor_note, final_action: d.final_action ?? r.final_action } : r;
  });
}

/**
 * The proposals, written to D1.
 *
 * An advisor decision survives a re-run of the workflow. It is reset only when
 * the underlying proposal actually changed, and how many were carried forward
 * and how many were reopened is reported back, because that is the number an
 * advisor needs to know before reading the letter again.
 */
export async function persistRecommendations(env, state, built) {
  const db = env.DB;
  const month = state.ctx.reporting_period.month;
  const existingRows = await all(db, 'SELECT * FROM recommendations WHERE client_id = ? AND reporting_month = ?', state.ctx.client.id, month);
  const existingByAsset = new Map(existingRows.map((r) => [r.asset_id, r]));
  const setId = existingRows[0]?.recommendation_set_id || id('recset');
  let carried = 0;
  let reopened = 0;

  for (const r of built.recommendations) {
    const prev = existingByAsset.get(r.asset_id);
    const materiallyChanged = prev
      && (prev.proposed_action !== r.proposed_action
        || prev.suitability_result !== r.suitability_result
        || (prev.signal_conflict === 1) !== r.signal_conflict);
    const advisorStatus = prev && !materiallyChanged ? prev.advisor_status : 'proposed';
    const advisorNote = prev && !materiallyChanged ? prev.advisor_note : null;
    const finalAction = prev && !materiallyChanged && prev.advisor_status === 'edited' ? prev.final_action : r.final_action;
    if (prev && !materiallyChanged && prev.advisor_status !== 'proposed') carried += 1;
    if (prev && materiallyChanged && prev.advisor_status !== 'proposed') reopened += 1;

    await run(db, `INSERT INTO recommendations (id, client_id, asset_id, reporting_month, recommendation_set_id, tradingview_signal_id, proposed_action, final_action, suitability_result, score, conviction, signal_conflict, current_weight, rationale, factors_json, flags_json, statement_json, advisor_status, advisor_note, decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(client_id, reporting_month, asset_id) DO UPDATE SET
        recommendation_set_id = excluded.recommendation_set_id,
        tradingview_signal_id = excluded.tradingview_signal_id,
        proposed_action = excluded.proposed_action, final_action = excluded.final_action,
        suitability_result = excluded.suitability_result, score = excluded.score,
        conviction = excluded.conviction, signal_conflict = excluded.signal_conflict,
        current_weight = excluded.current_weight, factors_json = excluded.factors_json,
        flags_json = excluded.flags_json, statement_json = excluded.statement_json,
        advisor_status = excluded.advisor_status, advisor_note = excluded.advisor_note`,
      prev?.id || id('rec'), state.ctx.client.id, r.asset_id, month, setId, r.tradingview_signal_id ?? null,
      r.proposed_action, finalAction, r.suitability_result, r.score, r.conviction,
      r.signal_conflict ? 1 : 0, r.current_weight, null,
      JSON.stringify(r.factors), JSON.stringify(r.flags), JSON.stringify(r.statement),
      advisorStatus, advisorNote, prev?.decided_at ?? null);
  }

  // An asset that left the book no longer needs a decision.
  const currentAssets = new Set(built.recommendations.map((r) => r.asset_id));
  for (const prev of existingRows) {
    if (!currentAssets.has(prev.asset_id)) await run(db, 'DELETE FROM recommendations WHERE id = ?', prev.id);
  }
  return { setId, carried, reopened };
}

/** The house view the recommendations and the letter are written against. */
export async function loadWorldView(env, advisorId) {
  const wv = advisorId ? await first(env.DB, 'SELECT * FROM world_overviews WHERE advisor_id = ? ORDER BY date DESC LIMIT 1', advisorId) : null;
  return wv
    ? { ...json(wv.briefing_json, {}), stance_by_asset_class: json(wv.stance_json, {}), date: wv.date, approval_status: wv.approval_status, advisor_commentary: wv.advisor_commentary }
    : {};
}

/**
 * The letter's text.
 *
 * A letter that fails the check is asked for once more with the reason stated,
 * because the usual failure is a stray figure in one sentence and the second
 * attempt fixes it. After that the deterministic text stands.
 */
export async function buildNarrative(env, state, body = {}) {
  state = { ...state, recommendations: await refreshRecommendationStatus(env, state) };
  const facts = narrativeFacts(state);
  let letter = null; let rationales = null; let mode = 'deterministic_template'; let model = null; let fallbackReason = null;

  if (body.mode !== 'deterministic' && LLM.llmAvailable(env)) {
    let note = null;
    for (let attempt = 1; attempt <= 2 && !letter; attempt += 1) {
      try {
        const r = await LLM.runPrompt(env, 'client_letter', facts, { maxTokens: 3000, appendUser: note });
        letter = sanitiseLetter(r.data, facts);
        model = r.model; mode = 'model';
      } catch (err) {
        fallbackReason = err.message;
        note = `Your previous reply was rejected: ${err.message}. Reply again with ONLY the JSON object described under "Output", obeying the paragraph count and using no figure that is not in FACTS.labels.`;
      }
    }
    if (letter) {
      try {
        const rr = await LLM.runPrompt(env, 'recommendation_rationale', { recommendations: facts.recommendations }, { maxTokens: 1600 });
        rationales = rr.data;
      } catch { rationales = LLM.deterministicRationales(facts); }
    }
  }

  if (!letter) {
    letter = LLM.deterministicLetter(facts);
    rationales = LLM.deterministicRationales(facts);
    mode = LLM.llmAvailable(env) ? 'deterministic_fallback_after_error' : 'deterministic_template';
  }
  return { letter, rationales: rationales || {}, mode, model, prompt_version: PROMPT_VERSION, fallback_reason: fallbackReason, facts_digest: Object.keys(facts) };
}

/**
 * The canonical report the letter is drawn from.
 *
 * One report per client per month. Regenerating reuses the existing id so the
 * link an advisor already has keeps working and the stored source records stay
 * attached to it. A published letter is immutable: it comes back as a conflict
 * rather than being overwritten, and is reissued only deliberately.
 */
export async function assembleLetter(env, state, { force = false, reportId = null, graphRunId = null, promptVersion = null } = {}) {
  const db = env.DB;
  const decided = await refreshRecommendationStatus(env, state);
  const recs = decided.map((r) => ({ ...r, rationale_pt: state.narrative?.rationales?.[r.asset_id] ?? null }));

  const existing = await first(db, 'SELECT id, status, published_at FROM reports WHERE client_id = ? AND reporting_month = ?',
    state.ctx.client.id, state.ctx.reporting_period.month);
  if (existing?.status === 'published' && !force) {
    return { conflict: { report_id: existing.id, published_at: existing.published_at } };
  }
  const finalId = reportId || existing?.id || id('rep');
  const report = P.assembleCanonicalReport({
    ctx: state.ctx, market: state.market, perf: state.perf, benchmark: state.benchmark,
    metrics: state.metrics, signals: state.signals, recommendations: recs,
    worldView: state.world_view,
    eventsForClient: state.impact.map((i) => {
      const src = state.events.find((e) => e.id === i.event_id) || {};
      return { ...i, summary: src.summary, summary_pt: src.summary_pt ?? null, category: src.category, importance: src.importance, direction: src.direction, date: i.date ?? src.date };
    }),
    narrative: state.narrative, exposures: state.exposures,
    locale: env.REPORT_LOCALE || 'pt-BR', reportId: finalId, graphRunId,
    promptVersion,
  });
  return { report, report_id: finalId, check: validateReport(report) };
}

/**
 * The letter as the three files it is read in: the PDF, the e-mail and the
 * portal page. Only advisor-approved proposals reach the page, and a report
 * that does not pass validation is not drawn at all.
 */
export async function renderLetter(env, state, { approvedOnly = true } = {}) {
  let report = state.report;

  if (approvedOnly) {
    const decided = await refreshRecommendationStatus(env, state);
    const byAsset = new Map(decided.map((d) => [d.asset_id, d]));
    report = {
      ...report,
      recommendations: report.recommendations
        .map((r) => {
          const d = byAsset.get(r.asset_id);
          return d ? { ...r, advisor_status: d.advisor_status, advisor_note: d.advisor_note, final_action: d.final_action ?? r.final_action } : r;
        })
        .filter((r) => r.advisor_status === 'approved'),
    };
    const check = validateReport(report);
    if (!check.ok) return { invalid: check };
  }

  const model = buildLetterModel(report, { locale: report.locale });
  const html = renderLetterHtml(model, { variant: 'email', pdfUrl: `/api/reports/${state.report_id}/pdf`, portalUrl: `/client/#/report/${state.report_id}` });
  const portalHtml = renderPortalLetter(model);
  const pdfDoc = await renderLetterPdf(model, { fonts: brandFonts() });
  const pdf = pdfDoc.build();

  const keys = {
    html: `reports/${state.ctx.client.id}/${state.ctx.reporting_period.month}/${state.report_id}.email.html`,
    portal: `reports/${state.ctx.client.id}/${state.ctx.reporting_period.month}/${state.report_id}.portal.html`,
    pdf: `reports/${state.ctx.client.id}/${state.ctx.reporting_period.month}/${state.report_id}.pdf`,
  };
  if (env.REPORTS) {
    await env.REPORTS.put(keys.html, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    await env.REPORTS.put(keys.portal, portalHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    await env.REPORTS.put(keys.pdf, pdf, { httpMetadata: { contentType: 'application/pdf' } });
  }
  return {
    report, model,
    render: { keys, page_count: pdfDoc.pageCount, pdf_bytes: pdf.length, html_bytes: html.length, layout_reduction_level: pdfDoc.reductionLevel ?? 0 },
  };
}

/** The letter, in the record: the report row, the sources behind it, the audit line. */
export async function persistLetter(env, state, { status = 'pending_approval', actorId = null, graphRunId = null } = {}) {
  const db = env.DB;
  const r = state.report;
  await run(db, `INSERT INTO reports (id, client_id, advisor_id, portfolio_snapshot_id, reporting_month, canonical_report_json, html_r2_key, pdf_r2_key, portal_r2_key, status, page_count, graph_run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(client_id, reporting_month) DO UPDATE SET canonical_report_json=excluded.canonical_report_json,
      html_r2_key=excluded.html_r2_key, pdf_r2_key=excluded.pdf_r2_key, portal_r2_key=excluded.portal_r2_key,
      status=excluded.status, page_count=excluded.page_count, graph_run_id=excluded.graph_run_id`,
    state.report_id, state.ctx.client.id, state.ctx.advisor.id, state.ctx.snapshot.id,
    state.ctx.reporting_period.month, JSON.stringify(r),
    state.render?.keys?.html ?? null, state.render?.keys?.pdf ?? null, state.render?.keys?.portal ?? null,
    status, state.render?.page_count ?? null, graphRunId);

  await run(db, 'DELETE FROM data_sources WHERE report_id = ?', state.report_id);
  for (const s of r.sources || []) {
    await run(db, `INSERT INTO data_sources (id, report_id, provider, kind, instrument, identifier, requested_range, retrieval_timestamp, last_observation, source_reference, fallback_for, mocked, metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id('ds'), state.report_id, s.provider, s.kind, s.instrument, s.identifier, s.requested_range,
      s.retrieval_timestamp, s.last_observation, s.reference, s.fallback_for, s.mocked ? 1 : 0, JSON.stringify(s));
  }
  await audit(db, {
    entity: 'report', entity_id: state.report_id, action: 'generated', actor_id: actorId,
    detail: { month: state.ctx.reporting_period.month, run_id: graphRunId, page_count: state.render?.page_count, narrative_mode: state.narrative?.mode },
  });
  return { report_id: state.report_id, status, sources_persisted: (r.sources || []).length };
}

/**
 * The FACTS object. Nothing outside it may appear in the letter.
 */
export function narrativeFacts(state) {
  const perf = state.perf;
  const bench = state.benchmark;
  return {
    client: {
      name: state.ctx.client.full_name,
      first_name: String(state.ctx.client.full_name || '').trim().split(/\s+/)[0] || '',
      risk_profile: state.ctx.client.risk_profile,
      base_currency: state.ctx.client.base_currency,
    },
    advisor: { name: state.ctx.advisor?.name },
    reporting_period: state.ctx.reporting_period,
    performance: {
      monthly_return: perf.monthly_return,
      absolute_pnl: perf.absolute_pnl,
      beginning_market_value: perf.beginning_market_value,
      ending_market_value: perf.ending_market_value,
      contributions: perf.contributions,
      withdrawals: perf.withdrawals,
      income: perf.income,
      method: perf.method,
      method_note: perf.method_note,
      unavailable_reason: perf.monthly_return == null ? 'não foi possível apurar o retorno com os dados disponíveis' : null,
      excluded_positions: perf.coverage.excluded.map((e) => ({ name: e.name, reason: e.reason })),
    },
    benchmark: bench.available
      ? { name: bench.name, value: bench.value, excess_return: perf.monthly_return - bench.value, composition: bench.composition }
      : { unavailable: true, reason: bench.reason },
    attribution: {
      best_contributor: perf.attribution.best_contributor ? { name: perf.attribution.best_contributor.name, short_name: shortAssetName(perf.attribution.best_contributor.name), ticker: perf.attribution.best_contributor.ticker, contribution: perf.attribution.best_contributor.contribution, total_return: perf.attribution.best_contributor.total_return } : null,
      worst_contributor: perf.attribution.worst_contributor ? { name: perf.attribution.worst_contributor.name, short_name: shortAssetName(perf.attribution.worst_contributor.name), ticker: perf.attribution.worst_contributor.ticker, contribution: perf.attribution.worst_contributor.contribution, total_return: perf.attribution.worst_contributor.total_return } : null,
      by_asset_class: perf.attribution.by_asset_class.map((c) => ({ asset_class: c.asset_class, contribution: c.contribution, return: c.return })),
      fx_contribution: perf.attribution.fx_contribution,
    },
    events: (state.events || []).slice(0, 6).map((e) => ({
      id: e.id, title: e.title, title_pt: e.title_pt ?? null,
      why_it_matters: e.summary, why_it_matters_pt: e.summary_pt ?? null,
      category: e.category, importance: e.importance,
    })),
    impact: (state.impact || []).map((i) => ({
      event_id: i.event_id, title: i.title, title_pt: i.title_pt ?? null,
      exposure: i.portfolio_exposure.total_exposure,
      potential_impact: i.potential_impact, potential_impact_pt: i.potential_impact_pt ?? null,
      discussion_prompt_pt: i.discussion_prompt_pt ?? null,
      relevance: i.relevance,
    })),
    recommendations: (state.recommendations || []).map((r) => ({
      asset_id: r.asset_id, ticker: r.ticker, name: r.name, short_name: shortAssetName(r.name), asset_class: r.asset_class,
      within_policy: withinPolicy(r),
      final_action: r.final_action, suitability_result: r.suitability_result, signal_conflict: r.signal_conflict,
      technical_signal: r.technical_signal, analyst_signal: r.analyst_signal, analyst_count: r.analyst_count,
      target_price: r.target_price, implied_upside: r.implied_upside, current_weight: r.current_weight,
      factors: r.factors, flags: r.flags, advisor_status: r.advisor_status,
    })),
    allocation: Object.entries(state.exposures || {}).map(([k, v]) => ({ asset_class: k, weight: v, target: state.ctx.policy?.target_allocation?.[k] ?? null, range: state.ctx.policy?.permitted_ranges?.[k] ?? null })),
    /**
     * The house view. Without this the letter has no opinion in it, and an
     * opinion is the one thing a client cannot get from their own statement.
     */
    advisor_view: houseView(state.world_view),
    /** Exactly the items the letter will print, so the copy and the table agree. */
    letter_recommendations: prioritiseForLetter(state.recommendations || []).selected.map((r) => ({
      asset_id: r.asset_id, ticker: r.ticker, name: r.name, short_name: shortAssetName(r.name),
      final_action: r.final_action, suitability_result: r.suitability_result, signal_conflict: r.signal_conflict,
      within_policy: withinPolicy(r), current_weight: r.current_weight,
      rationale_pt: r.rationale_pt || r.rationale || null,
    })),
    next_meeting: state.next_meeting ?? null,
    next_meeting_label: state.next_meeting ? dateLong(state.next_meeting, 'pt-BR') : null,
    /**
     * Every figure the letter is allowed to write, already formatted.
     *
     * The model is not asked to format a number, because a model that formats is
     * a model that rounds. It copies one of these strings or it writes the
     * sentence without a figure — and because they are strings, the check that
     * no other number reached the letter is exact rather than approximate.
     */
    labels: {
      month: monthLabel(state.ctx.reporting_period?.month, 'pt-BR'),
      period_end: dateLong(state.ctx.reporting_period?.end, 'pt-BR'),
      monthly_return: perf.monthly_return == null ? null : percent(perf.monthly_return, { locale: 'pt-BR' }),
      absolute_pnl: perf.absolute_pnl == null ? null : money(perf.absolute_pnl, { currency: state.ctx.client.base_currency || 'BRL', locale: 'pt-BR', signed: true }),
      benchmark: bench.available && bench.value != null ? percent(bench.value, { locale: 'pt-BR' }) : null,
      excess: bench.available && bench.value != null && perf.monthly_return != null ? pp(perf.monthly_return - bench.value, { locale: 'pt-BR' }) : null,
      excess_abs: bench.available && bench.value != null && perf.monthly_return != null ? pp(Math.abs(perf.monthly_return - bench.value), { locale: 'pt-BR', signed: false }) : null,
      ending_value: perf.ending_market_value == null ? null : money(perf.ending_market_value, { currency: state.ctx.client.base_currency || 'BRL', locale: 'pt-BR' }),
      next_meeting: state.next_meeting ? dateLong(state.next_meeting, 'pt-BR') : null,
    },
  };
}
