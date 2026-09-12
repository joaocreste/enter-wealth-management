/**
 * Client analysis shared by the API routes and the report agent: the current
 * allocation against the policy, the discussion points a meeting should open
 * with, and the live profitability of a month that has no published letter.
 * Moved out of the route file so the agent does not import the router.
 */
import { all, first, json } from './db.js';
import * as P from './pipeline.js';
import { previousMonth } from '../../src/core/format.js';
const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
};
const classPt = (k) => CLASS_PT[k] || k;

export function hydrateRecommendation(r) {
  return {
    id: r.id, asset_id: r.asset_id, proposed_action: r.proposed_action, final_action: r.final_action,
    suitability_result: r.suitability_result, score: r.score, conviction: r.conviction,
    signal_conflict: !!r.signal_conflict, current_weight: r.current_weight,
    rationale: r.rationale, factors: json(r.factors_json, []), flags: json(r.flags_json, []),
    statement: json(r.statement_json, null), advisor_status: r.advisor_status, advisor_note: r.advisor_note,
    decided_at: r.decided_at, created_at: r.created_at, recommendation_set_id: r.recommendation_set_id,
  };
}

export function allocationOf(positions, total, policy) {
  const map = new Map();
  for (const p of positions) {
    const k = p.asset_class;
    map.set(k, (map.get(k) ?? 0) + (p.market_value || 0));
  }
  return [...map.entries()].map(([asset_class, value]) => {
    const weight = total ? value / total : 0;
    const range = policy?.permitted_ranges?.[asset_class] ?? null;
    return {
      asset_class, value, weight,
      target: policy?.target_allocation?.[asset_class] ?? null,
      range,
      inside_band: range ? weight >= range.min && weight <= range.max : true,
    };
  }).sort((a, b) => b.weight - a.weight);
}

export async function meetingPrep(env, scope, month) {
  const db = env.DB;
  const { client } = scope;
  const m = month || previousMonth(new Date().toISOString().slice(0, 10));
  const ctx = await P.loadClientContext(env, client.id, { month: m });
  const total = ctx.positions.reduce((a, p) => a + (p.market_value || 0), 0);
  const exposures = {};
  for (const p of ctx.positions) exposures[p.asset_class] = (exposures[p.asset_class] ?? 0) + (p.market_value || 0) / (total || 1);

  const opportunities = [];
  const policy = ctx.policy;
  for (const [k, band] of Object.entries(policy?.permitted_ranges || {})) {
    const w = exposures[k] ?? 0;
    if (band.min != null && w < band.min) opportunities.push({ kind: 'below_band', asset_class: k, message: `${classPt(k)} está em ${(w * 100).toFixed(1)}%, abaixo do mínimo de ${(band.min * 100).toFixed(0)}% da política.`, severity: 'medium' });
    if (band.max != null && w > band.max) opportunities.push({ kind: 'above_band', asset_class: k, message: `${classPt(k)} está em ${(w * 100).toFixed(1)}%, acima do máximo de ${(band.max * 100).toFixed(0)}% da política.`, severity: 'high' });
  }
  for (const d of P.driftTriggers(exposures, policy?.target_allocation || {}, policy?.rebalance_trigger ?? 0.05)) {
    opportunities.push({ kind: 'drift', asset_class: d.asset_classes[0], message: d.action_pt || d.action, severity: 'medium' });
  }
  const cap = policy?.single_name_cap ?? 0.1;
  for (const p of ctx.positions) {
    const w = (p.market_value || 0) / (total || 1);
    if (w > cap && !['etf', 'cash', 'reit'].includes(p.type)) {
      opportunities.push({ kind: 'concentration', asset_class: p.asset_class, message: `${p.asset_name} representa ${(w * 100).toFixed(1)}% da carteira, acima do teto de ${(cap * 100).toFixed(0)}% por emissor.`, severity: 'high' });
    }
    if (p.corporate_action) {
      opportunities.push({ kind: 'corporate_action', asset_class: p.asset_class, message: `${p.ticker || p.asset_name}: ${p.corporate_action}`, severity: 'high' });
    }
  }

  const recs = await all(db, 'SELECT * FROM recommendations WHERE client_id = ? AND reporting_month = (SELECT MAX(reporting_month) FROM recommendations WHERE client_id = ?)', client.id, client.id);
  const conflicts = recs.filter((r) => r.signal_conflict).map((r) => ({ kind: 'signal_conflict', asset_id: r.asset_id, message: json(r.statement_json, {})?.market_signal || 'sinais divergentes', severity: 'medium' }));

  return {
    month: m,
    client: { id: client.id, name: client.full_name, risk_profile: client.risk_profile },
    total_value: total,
    allocation: allocationOf(ctx.positions, total, policy),
    policy,
    holdings: ctx.positions.map((p) => ({ ticker: p.ticker, name: p.asset_name, asset_class: p.asset_class, market_value: p.market_value, weight: (p.market_value || 0) / (total || 1), pricing_mode: p.pricing_mode })),
    discussion_opportunities: [...opportunities, ...conflicts],
    recommendations: recs.map(hydrateRecommendation),
    next_meeting: (await first(db, "SELECT * FROM meetings WHERE client_id = ? AND status IN ('scheduled','in_preparation') ORDER BY date LIMIT 1", client.id)) ?? null,
    returns_history: ctx.returns_history.map((r) => ({ month: r.month, portfolio: r.portfolio_return, benchmark: r.benchmark_return })),
  };
}

export async function runProfitabilityLive(env, clientId, month) {
  const ctx = await P.loadClientContext(env, clientId, { month });
  const market = await P.fetchAndValidateMarketData(env, ctx);
  const perf = await P.computeProfitability(env, ctx, market);
  const benchmark = await P.computeBenchmark(env, ctx, market);
  const metrics = await P.computeMetrics(env, ctx);
  return { performance: perf, benchmark, metrics, sources: market.ledger, validation: market.validation };
}
