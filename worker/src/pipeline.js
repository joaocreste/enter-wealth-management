/**
 * The deterministic pipeline (§32, steps 1–20).
 *
 * Each exported function is one Rivet node's target. They are pure with respect
 * to the language model: nothing in this file asks an LLM for a number. Rivet
 * owns the sequencing and the branching; this file owns the arithmetic and the
 * provenance.
 */
import {
  all, first, run, id, json, nowIso, audit,
  currentPolicy, currentSnapshot, snapshotPositions, positionToAsset, hydratePolicy,
} from './db.js';
import { priceWindow, indicatorQuote } from '../../src/adapters/marketdata.js';
import * as bcb from '../../src/adapters/bcb.js';
import { signals as fetchTvSignals } from '../../src/adapters/tradingview.js';
import { SourceLedger, makeSource } from '../../src/core/sources.js';
import { monthlyProfitability, compareToBenchmark, historicalMetrics } from '../../src/core/performance.js';
import { buildRecommendations } from '../../src/core/recommendations.js';
import { runSuitability } from '../../src/core/suitability.js';
import { evaluateTrigger, mapTriggersToClients, driftTriggers, TRIGGER_STATUS } from '../../src/core/triggers.js';
import { buildWhatMattersTable, mapEventToPortfolio, notableWindow } from '../../src/core/events.js';
import { previousMonth, monthBounds } from '../../src/core/format.js';
import { emptyReport, validateReport, standardDisclosures, REPORT_SCHEMA_VERSION } from '../../src/core/report-schema.js';
import { useKv } from '../../src/adapters/cache.js';

/** Composite benchmark: the policy's own target allocation, priced with real series. */
const BENCHMARK_PROXIES = {
  Cash: { kind: 'cdi', label: 'CDI' },
  'Fixed Income': { kind: 'series', symbol: 'IMAB11.SA', label: 'IMA-B (IMAB11)' },
  'Equities BR': { kind: 'series', symbol: '^BVSP', label: 'Ibovespa' },
  'Equities Global': { kind: 'series', symbol: 'IVVB11.SA', label: 'S&P 500 em reais (IVVB11)' },
  Alternatives: { kind: 'cdi', label: 'CDI', multiplier: 1.0 },
  'Real Estate': { kind: 'series', symbol: 'XPML11.SA', label: 'Fundos imobiliários listados (XPML11)' },
  Commodities: { kind: 'series', symbol: 'GOLD11.SA', label: 'Ouro em reais (GOLD11)' },
  'Digital Assets': { kind: 'series', symbol: 'BTC-USD', label: 'Bitcoin' },
};

export function attachKv(env) {
  if (env.MARKET_CACHE) useKv(env.MARKET_CACHE);
}

// ── 1–4. ingestion ──────────────────────────────────────────────────────────
export async function loadClientContext(env, clientId, { month = null } = {}) {
  const db = env.DB;
  const client = await first(db, 'SELECT * FROM clients WHERE id = ?', clientId);
  if (!client) throw new Error(`client ${clientId} not found`);

  const advisorRow = await first(db, 'SELECT a.*, u.name, u.email FROM advisors a JOIN users u ON u.id = a.user_id WHERE a.id = ?', client.advisor_id);
  const policy = await currentPolicy(db, clientId);
  const snapshot = await currentSnapshot(db, clientId);
  if (!snapshot) throw new Error(`no approved portfolio snapshot for ${clientId}`);
  const positions = await snapshotPositions(db, snapshot.id);

  const reportingMonth = month || previousMonth(new Date().toISOString().slice(0, 10));
  const bounds = monthBounds(reportingMonth);

  const flows = await all(
    db,
    'SELECT * FROM cash_flows WHERE client_id = ? AND date >= ? AND date <= ? ORDER BY date',
    clientId, bounds.start, bounds.end,
  );

  const policyHistory = (await all(db, 'SELECT * FROM investment_policies WHERE client_id = ? ORDER BY version DESC', clientId)).map(hydratePolicy);
  const snapshotHistory = await all(db, 'SELECT * FROM portfolio_snapshots WHERE client_id = ? ORDER BY effective_date DESC', clientId);
  const returnsHistory = await all(db, 'SELECT * FROM monthly_returns WHERE client_id = ? ORDER BY month', clientId);

  return {
    client, advisor: advisorRow, policy, snapshot, positions,
    policy_history: policyHistory, snapshot_history: snapshotHistory, returns_history: returnsHistory,
    flows: flows.filter((f) => f.type === 'contribution' || f.type === 'withdrawal').map((f) => ({ date: f.date, amount: f.amount, type: f.type, description: f.description })),
    income: flows.filter((f) => f.type === 'income').map((f) => ({ date: f.date, amount: f.amount, asset_id: f.asset_id })),
    reporting_period: { month: reportingMonth, ...bounds },
  };
}

// ── 5–6. market data + validation ───────────────────────────────────────────
export async function fetchAndValidateMarketData(env, ctx) {
  attachKv(env);
  const db = env.DB;
  const { positions, reporting_period: rp, policy } = ctx;
  const ledger = new SourceLedger();

  // NAV observations for fund quotas — the custodian statement, not a feed
  const navRows = await all(
    db,
    'SELECT * FROM market_observations WHERE observation_date <= ? AND asset_id IN (SELECT id FROM assets WHERE pricing_mode = ?) ORDER BY observation_date',
    rp.end, 'nav',
  );
  const navObservations = {};
  for (const r of navRows) (navObservations[r.asset_id] ||= []).push({ ...r, ...json(r.metadata_json, {}) });

  // FX: PTAX from the Banco Central is authoritative for a BRL-based client
  const fxSeries = await bcb.series('USD_PTAX_SELL', addDays(rp.priorEnd, -12), rp.end);
  const fxAt = (date) => {
    if (fxSeries.unavailable) return null;
    let best = null;
    for (const p of fxSeries.points) { if (p.date <= date) best = p; else break; }
    return best?.value ?? null;
  };
  if (!fxSeries.unavailable) ledger.add(fxSeries.source);

  const cdi = await bcb.cdiAccumulated(rp.start, rp.end);
  if (!cdi.unavailable) ledger.add(cdi.source);

  const priced = [];
  const validation = [];

  for (const row of positions) {
    const asset = positionToAsset(row);
    if (asset.pricing_mode === 'cash') {
      priced.push({ asset, quantity: row.quantity, market_value: row.market_value, pricing_mode: 'cash', is_cash: true });
      continue;
    }

    const pw = await priceWindow(asset, rp.priorEnd, rp.end, { navObservations, cdi: { [`${rp.start}..${rp.end}`]: cdi } });
    const sourceIds = ledger.addAll(pw.sources || []);

    if (pw.status === 'DATA_UNAVAILABLE' || pw.open == null || pw.close == null) {
      validation.push({
        check: 'position_pricing', status: 'unavailable', asset_id: asset.id, ticker: asset.ticker, name: asset.name,
        reason: pw.reason || 'no valuation pair for the reporting month',
        providers_attempted: pw.providers_attempted || [],
      });
      priced.push({
        asset, quantity: row.quantity, market_value: row.market_value, pricing_mode: asset.pricing_mode,
        reason: pw.reason || 'no valuation pair for the reporting month',
        providers_attempted: pw.providers_attempted || [], source_ids: sourceIds,
      });
      continue;
    }

    const needsFx = asset.currency && asset.currency !== (policy?.base_currency || 'BRL');
    const fxOpen = needsFx ? fxAt(rp.priorEnd) : 1;
    const fxClose = needsFx ? fxAt(rp.end) : 1;
    if (needsFx && (!fxOpen || !fxClose)) {
      validation.push({ check: 'fx_translation', status: 'unavailable', asset_id: asset.id, reason: 'PTAX unavailable for one of the valuation dates' });
    }

    // Sanity checks before a number reaches a client
    if (pw.open <= 0 || pw.close <= 0) {
      validation.push({ check: 'price_positive', status: 'fail', asset_id: asset.id, reason: 'non-positive price returned by the provider' });
    }
    const move = pw.close / pw.open - 1;
    if (Math.abs(move) > 0.6 && asset.pricing_mode === 'market') {
      validation.push({
        check: 'extreme_move', status: 'review', asset_id: asset.id, ticker: asset.ticker,
        reason: `one-month move of ${(move * 100).toFixed(1)}% — verified against the provider series before publication; may reflect a corporate action`,
      });
    }

    priced.push({
      asset,
      quantity: row.quantity,
      open_price: pw.open, close_price: pw.close,
      open_date: pw.open_date, close_date: pw.close_date,
      income_per_unit: pw.income_per_unit || 0,
      fx_open: fxOpen ?? 1, fx_close: fxClose ?? 1,
      market_value: pw.close * row.quantity * (fxClose ?? 1),
      pricing_mode: asset.pricing_mode,
      accrual: pw.accrual || null,
      note: pw.note || null,
      source_ids: sourceIds,
    });
  }

  validation.push({
    check: 'pricing_coverage', status: 'info',
    detail: `${priced.filter((p) => p.open_price != null).length} of ${positions.length} positions priced from an approved provider`,
  });

  return { priced, validation, ledger: ledger.all(), fx: { series: fxSeries, open: fxAt(rp.priorEnd), close: fxAt(rp.end) }, cdi };
}

// ── 7–9. profitability, attribution, benchmark ──────────────────────────────
export async function computeProfitability(env, ctx, market) {
  const { reporting_period: rp, flows, income } = ctx;
  const cashPositions = market.priced.filter((p) => p.is_cash);
  const base = ctx.policy?.base_currency || 'BRL';
  const cashValue = cashPositions.reduce((a, p) => {
    const fx = p.asset.currency !== base ? (market.fx.close || 1) : 1;
    return a + (p.market_value ?? 0) * fx;
  }, 0);

  // Opening cash is the closing balance less the month's net external flows.
  const netFlows = flows.reduce((a, f) => a + f.amount, 0);
  const openingCash = cashValue - netFlows;

  const perf = monthlyProfitability({
    positions: market.priced.filter((p) => !p.is_cash),
    flows,
    income,
    opening_cash: openingCash,
    closing_cash: cashValue,
    start: rp.priorEnd,
    end: rp.end,
  });

  return perf;
}

export async function computeBenchmark(env, ctx, market) {
  attachKv(env);
  const rp = ctx.reporting_period;
  const targets = ctx.policy?.target_allocation || {};
  const ledger = new SourceLedger();
  const legs = [];
  let total = 0;
  let weightCovered = 0;

  const { dailySeries, closeOnOrBefore } = await import('../../src/adapters/yahoo.js');

  for (const [assetClass, weight] of Object.entries(targets)) {
    if (!weight) continue;
    const proxy = BENCHMARK_PROXIES[assetClass];
    if (!proxy) continue;

    if (proxy.kind === 'cdi') {
      if (market.cdi?.unavailable) { legs.push({ asset_class: assetClass, weight, label: proxy.label, unavailable: true, reason: market.cdi.reason }); continue; }
      const r = market.cdi.value;
      ledger.add(market.cdi.source);
      legs.push({ asset_class: assetClass, weight, label: proxy.label, return: r, contribution: weight * r, source_id: market.cdi.source.id });
      total += weight * r; weightCovered += weight;
      continue;
    }

    const s = await dailySeries(proxy.symbol, addDays(rp.priorEnd, -12), rp.end);
    if (s.unavailable) { legs.push({ asset_class: assetClass, weight, label: proxy.label, unavailable: true, reason: s.reason }); continue; }
    const o = closeOnOrBefore(s, rp.priorEnd);
    const c = closeOnOrBefore(s, rp.end);
    if (!o || !c) { legs.push({ asset_class: assetClass, weight, label: proxy.label, unavailable: true, reason: 'no valuation pair in the window' }); continue; }
    const r = c.close / o.close - 1;
    ledger.add(s.source);
    legs.push({ asset_class: assetClass, weight, label: proxy.label, return: r, contribution: weight * r, source_id: s.source.id, symbol: proxy.symbol });
    total += weight * r; weightCovered += weight;
  }

  if (weightCovered < 0.6) {
    return { available: false, reason: `only ${(weightCovered * 100).toFixed(0)}% of the policy allocation could be priced; a composite benchmark is not published below 60% coverage`, legs, sources: ledger.all() };
  }

  // Renormalise across the legs that priced, and say so.
  const value = total / weightCovered;
  return {
    available: true,
    name: 'Carteira de referência da política de investimentos',
    name_en: 'Investment-policy reference portfolio',
    value,
    composition: legs.filter((l) => !l.unavailable).map((l) => ({ asset_class: l.asset_class, weight: l.weight / weightCovered, proxy: l.label, return: l.return })),
    coverage: weightCovered,
    coverage_note: weightCovered < 0.999
      ? `Composto sobre ${(weightCovered * 100).toFixed(0)}% da política; as classes sem série disponível foram excluídas e os pesos renormalizados.`
      : null,
    legs,
    sources: ledger.all(),
    source_ids: ledger.all().map((s) => s.id),
  };
}

// ── 10–13. market indicators, events, portfolio impact ──────────────────────
export async function fetchIndicators(env, indicators) {
  attachKv(env);
  const out = [];
  for (const ind of indicators) out.push(await indicatorQuote(ind));
  return out;
}

export async function evaluateTriggers(env, indicators, advisorId = null) {
  const db = env.DB;
  const rows = await all(db, 'SELECT * FROM market_triggers WHERE enabled = 1 AND (advisor_id IS NULL OR advisor_id = ?)', advisorId);
  const triggers = rows.map((r) => ({
    id: r.id, label: r.label, indicator_key: r.indicator_key, field: r.field,
    comparator: r.comparator, threshold: r.threshold, unit: r.unit,
    approach_ratio: r.approach_ratio, persistence_days: r.persistence_days,
    asset_classes: json(r.asset_classes_json, []), action: r.action, action_pt: r.action_pt,
  }));

  return triggers.map((t) => {
    const ind = indicators.find((i) => i.key === t.indicator_key);
    const value = t.unit === 'mtd' ? ind?.mtdPct : ind?.price;
    return evaluateTrigger(t, ind ? { ...ind, value } : null);
  });
}

export async function loadMarketEvents(env, { since = null, limit = 25 } = {}) {
  const db = env.DB;
  const rows = since
    ? await all(db, 'SELECT * FROM market_events WHERE date >= ? ORDER BY date DESC LIMIT ?', since, limit)
    : await all(db, 'SELECT * FROM market_events ORDER BY date DESC LIMIT ?', limit);
  return rows.map((r) => ({
    id: r.id, date: r.date, title: r.title, category: r.category, summary: r.summary,
    title_pt: r.title_pt, summary_pt: r.summary_pt, impact_note_pt: r.impact_note_pt, discussion_prompt_pt: r.discussion_prompt_pt,
    direction: r.direction, move_label: r.move_label, indicator_key: r.indicator_key,
    asset_classes: json(r.asset_classes_json, []), instruments: json(r.instruments_json, []),
    impact_note: r.impact_note, discussion_prompt: r.discussion_prompt,
    importance: r.importance, source_id: r.source_id, source_label: r.source_id,
  }));
}

/**
 * Turn a significant indicator move into an event row of its own (§6, §8).
 *
 * `window: 'mtd'` measures the reporting month, which is what the monthly
 * letter is about. `window: 'notable'` is for the daily overview: five
 * sessions at 3% or more, else thirty days at 5% or more (see notableWindow),
 * and the timeframe is written into the title, because "up 13% this month" on
 * the sixth session of the month says less than it seems to.
 */
export function eventsFromIndicatorMoves(indicators, { mtdThreshold = 0.05, window = 'mtd' } = {}) {
  const out = [];
  for (const ind of indicators) {
    if (ind.unavailable) continue;
    let pct; let en; let pt; let label;
    if (window === 'notable') {
      const w = notableWindow(ind);
      if (!w) continue;
      pct = w.pct; label = w.key === '5d' ? '5D' : '30D';
      en = w.key === '5d' ? 'over 5 sessions' : 'over 30 days';
      pt = w.label_pt;
    } else {
      if (ind.mtdPct == null || Math.abs(ind.mtdPct) < mtdThreshold) continue;
      pct = ind.mtdPct; label = 'MTD'; en = 'month to date'; pt = 'no mês até aqui';
    }
    const up = pct > 0;
    const abs = (Math.abs(pct) * 100).toFixed(1);
    out.push({
      id: `evt_move_${ind.key}`,
      date: ind.asOf || new Date().toISOString().slice(0, 10),
      title: `${ind.label} ${up ? 'up' : 'down'} ${abs}% ${en}`,
      title_pt: `${ind.label}: ${up ? 'alta' : 'queda'} de ${abs.replace('.', ',')}% ${pt}`,
      category: 'market_move',
      summary: `${ind.label} is at ${formatIndicator(ind)}, a ${up ? 'gain' : 'fall'} of ${abs}% ${en}.`,
      summary_pt: `${ind.label} está em ${formatIndicator(ind)}, ${up ? 'alta' : 'queda'} de ${abs.replace('.', ',')}% ${pt}.`,
      direction: up ? 'positive' : 'negative',
      move_label: `${up ? '+' : '−'}${abs}% ${label}`,
      move_window: window === 'notable' ? (label === '5D' ? '5d' : '30d') : 'mtd',
      indicator_key: ind.key,
      asset_classes: ind.asset_classes || [],
      instruments: [],
      importance: Math.abs(pct) >= (window === 'notable' && label === '5D' ? 0.06 : 0.10) ? 'high' : 'medium',
      source_id: ind.source?.id ?? null,
      source_label: ind.source ? `${ind.source.provider} · ${ind.source.identifier}` : null,
      discussion_prompt_pt: `Revisar a exposição a ${ind.label} e confirmar que ela segue dentro da faixa aprovada.`,
      impact_note_pt: null,
      generated: true,
    });
  }
  return out;
}

function formatIndicator(ind) {
  const v = ind.price;
  if (v == null) return 'DATA UNAVAILABLE';
  if (ind.unit === '%' || ind.unit === '% a.a.' || ind.unit === '% a.m.') return `${v.toFixed(2)}%`;
  if (ind.unit === 'USD' || ind.unit === 'USD/oz' || ind.unit === 'USD/bbl') return `US$ ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (ind.unit === 'BRL') return `R$ ${v.toFixed(4)}`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ── 14–15. TradingView, both families ───────────────────────────────────────
export async function fetchSignals(env, assets) {
  attachKv(env);
  const symbols = [...new Set(assets.map((a) => a.tv_symbol).filter(Boolean))];
  if (!symbols.length) return {};
  const raw = await fetchTvSignals(symbols);

  // persist so a published report can be reproduced from stored inputs (§31)
  const db = env.DB;
  for (const a of assets) {
    const sig = raw[a.tv_symbol];
    if (!sig) continue;
    const sigId = id('tvs');
    sig.signal_id = sigId;
    await run(db,
      `INSERT INTO tradingview_signals (id, asset_id, tv_symbol, technical_signal, technical_rating, technical_timeframe,
        technical_weekly, rsi_14, analyst_signal, analyst_mark, analyst_count, analyst_buy, analyst_hold, analyst_sell,
        target_price, target_high, target_low, implied_upside, unavailable_reason, captured_at, source_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sigId, a.id, a.tv_symbol,
      sig.technical?.signal ?? null, sig.technical?.rating ?? null, sig.technical?.timeframe ?? null,
      sig.technical?.weekly_signal ?? null, sig.technical?.rsi_14 ?? null,
      sig.analyst?.consensus ?? null, sig.analyst?.mark ?? null, sig.analyst?.analyst_count ?? null,
      sig.analyst?.breakdown?.buy ?? null, sig.analyst?.breakdown?.hold ?? null, sig.analyst?.breakdown?.sell ?? null,
      sig.analyst?.target_price?.average ?? null, sig.analyst?.target_price?.high ?? null, sig.analyst?.target_price?.low ?? null,
      sig.analyst?.implied_upside ?? null,
      [sig.technical?.reason, sig.analyst?.reason].filter(Boolean).join(' | ') || null,
      sig.technical?.captured_at || nowIso(), sig.source?.id ?? null,
    );
  }
  return raw;
}

// ── 16–17. recommendations + suitability ────────────────────────────────────
export async function buildAndCheckRecommendations(env, ctx, market, perf, signals, worldView, candidateAssetIds = []) {
  const db = env.DB;
  const base = ctx.policy?.base_currency || 'BRL';
  const totalValue = perf.ending_market_value || 1;

  const positions = market.priced
    .filter((p) => !p.is_cash)
    .map((p) => ({
      asset_id: p.asset.id,
      market_value: p.market_value ?? 0,
      weight: (p.market_value ?? 0) / totalValue,
      quantity: p.quantity,
    }));

  const exposures = {};
  for (const p of market.priced) {
    const k = p.asset.asset_class;
    exposures[k] = (exposures[k] ?? 0) + (p.market_value ?? 0) / totalValue;
  }

  const candidateRows = candidateAssetIds.length
    ? await all(db, `SELECT * FROM assets WHERE id IN (${candidateAssetIds.map(() => '?').join(',')})`, ...candidateAssetIds)
    : [];
  const candidateAssets = candidateRows.map((r) => ({ ...r, accrual_terms: json(r.accrual_terms, null), concentration_exempt: !!r.concentration_exempt }));

  const assets = [...market.priced.map((p) => p.asset), ...candidateAssets];
  const bands = ctx.policy?.permitted_ranges || {};

  const policy = { ...ctx.policy };
  const recs = buildRecommendations({
    assets, positions, signals, policy, bands, exposures, worldView,
    candidates: candidateAssets.map((a) => a.id),
  });

  const unhedgedFx = market.priced
    .filter((p) => p.asset.currency && p.asset.currency !== base)
    .reduce((a, p) => a + (p.market_value ?? 0) / totalValue, 0);

  const targets = ctx.policy?.target_allocation || {};
  const maxDrift = Math.max(0, ...Object.keys({ ...targets, ...exposures }).map((k) => Math.abs((exposures[k] ?? 0) - (targets[k] ?? 0))));

  const checked = runSuitability(recs, {
    assets,
    policy: { ...ctx.policy, risk_profile: ctx.client.risk_profile },
    exposures,
    bands,
    portfolio: { unhedged_fx_weight: unhedgedFx, max_class_drift: maxDrift },
  });

  const portfolioFlags = [];
  if (maxDrift > (ctx.policy?.rebalance_trigger ?? 0.05)) {
    portfolioFlags.push({
      code: 'POLICY_DRIFT', severity: 'medium',
      message: `The portfolio has drifted ${(maxDrift * 100).toFixed(1)} p.p. from its approved allocation, above the ${(((ctx.policy?.rebalance_trigger ?? 0.05)) * 100).toFixed(0)} p.p. review trigger.`,
      message_pt: `A carteira se afastou ${(maxDrift * 100).toFixed(1).replace('.', ',')} p.p. da alocação aprovada, acima do gatilho de revisão de ${(((ctx.policy?.rebalance_trigger ?? 0.05)) * 100).toFixed(0)} p.p.`,
    });
  }
  if (unhedgedFx > (ctx.policy?.max_unhedged_fx ?? 1)) {
    portfolioFlags.push({
      code: 'FX_EXPOSURE_ABOVE_LIMIT', severity: 'high',
      message: `Unhedged exposure outside ${base} is ${(unhedgedFx * 100).toFixed(1)}% against a ${(((ctx.policy?.max_unhedged_fx ?? 1)) * 100).toFixed(0)}% limit.`,
      message_pt: `A exposição sem proteção cambial fora do ${base} está em ${(unhedgedFx * 100).toFixed(1).replace('.', ',')}%, contra um limite de ${(((ctx.policy?.max_unhedged_fx ?? 1)) * 100).toFixed(0)}%.`,
    });
  }

  return { recommendations: checked, exposures, unhedged_fx_weight: unhedgedFx, max_class_drift: maxDrift, portfolio_flags: portfolioFlags };
}

// ── 20. canonical report assembly ───────────────────────────────────────────
export function assembleCanonicalReport({
  ctx, market, perf, benchmark, metrics, signals, recommendations, worldView,
  eventsForClient, narrative, exposures, locale = 'pt-BR', reportId = null, graphRunId = null, promptVersion = null,
}) {
  const ledger = new SourceLedger();
  ledger.addAll(market.ledger || []);
  ledger.addAll(benchmark?.sources || []);
  for (const s of Object.values(signals || {})) if (s.source) ledger.add(s.source);
  for (const e of eventsForClient || []) if (e.source) ledger.add(e.source);
  if (worldView?.sources) ledger.addAll(worldView.sources);

  const report = emptyReport();
  report.report_id = reportId;
  report.generated_at = nowIso();
  report.locale = locale;

  report.client = {
    id: ctx.client.id,
    name: ctx.client.full_name,
    risk_profile: ctx.client.risk_profile,
    base_currency: ctx.client.base_currency,
    segment: ctx.client.segment,
  };
  report.advisor = {
    id: ctx.advisor?.id,
    name: ctx.advisor?.name,
    code: ctx.advisor?.advisor_code,
    email: ctx.advisor?.email,
  };
  report.reporting_period = { ...ctx.reporting_period, generated_for: ctx.reporting_period.month };

  report.portfolio_performance = {
    beginning_market_value: perf.beginning_market_value,
    ending_market_value: perf.ending_market_value,
    contributions: perf.contributions,
    withdrawals: perf.withdrawals,
    net_flows: perf.net_flows,
    income: perf.income,
    absolute_pnl: perf.absolute_pnl,
    monthly_return: perf.monthly_return,
    method: perf.method,
    method_note: perf.method_note,
    coverage: perf.coverage,
    source_ids: ledger.all().filter((s) => s.kind === 'market_price' || s.kind === 'statement').map((s) => s.id),
  };

  report.benchmark = benchmark?.available
    ? {
      name: locale === 'pt-BR' ? benchmark.name : benchmark.name_en,
      value: benchmark.value,
      composition: benchmark.composition,
      coverage: benchmark.coverage,
      coverage_note: benchmark.coverage_note,
      comparison: compareToBenchmark(perf.monthly_return, benchmark),
      source_ids: benchmark.source_ids,
    }
    : { available: false, reason: benchmark?.reason || 'benchmark unavailable' };

  report.performance_attribution = {
    by_asset_class: perf.attribution.by_asset_class,
    by_position: perf.attribution.by_position,
    residual: perf.attribution.residual,
    fx_contribution: perf.attribution.fx_contribution,
    best_contributor: perf.attribution.best_contributor,
    worst_contributor: perf.attribution.worst_contributor,
    top_positive: perf.attribution.top_positive,
    top_negative: perf.attribution.top_negative,
    reconciles: perf.attribution.reconciles,
  };

  report.portfolio_metrics = metrics || { available: false };

  report.market_events = (eventsForClient || []).map((e) => ({
    id: e.event_id || e.id,
    date: e.date,
    title: e.title,
    category: e.category,
    summary: e.why_it_matters || e.summary,
    summary_pt: e.why_it_matters_pt ?? e.summary_pt ?? null,
    title_pt: e.title_pt ?? null,
    direction: e.direction,
    importance: e.importance,
    source_id: e.source_id,
  }));

  report.portfolio_impact = (eventsForClient || []).map((e) => ({
    event_id: e.event_id || e.id,
    title: e.title,
    title_pt: e.title_pt ?? null,
    exposure: e.portfolio_exposure,
    potential_impact: e.potential_impact,
    potential_impact_pt: e.potential_impact_pt ?? null,
    discussion_prompt: e.discussion_prompt,
    discussion_prompt_pt: e.discussion_prompt_pt ?? null,
    relevance: e.relevance,
    // The client sees where the event came from, on the card itself (the ledger holds the record).
    source_id: e.source_id ?? null,
    source_label: e.source_label ?? null,
    source_url: e.source_url ?? null,
    is_discussion_only: true,
  }));

  report.tradingview_signals = Object.entries(signals || {}).map(([sym, s]) => ({
    tv_symbol: sym,
    ticker: s.description || sym.split(':')[1],
    technical_signal: s.technical?.unavailable ? null : s.technical?.signal,
    technical_rating: s.technical?.rating ?? null,
    technical_timeframe: s.technical?.timeframe ?? null,
    technical_unavailable_reason: s.technical?.unavailable ? s.technical.reason : null,
    analyst_signal: s.analyst?.unavailable ? null : s.analyst?.consensus,
    analyst_count: s.analyst?.analyst_count ?? null,
    target_price: s.analyst?.target_price?.average ?? null,
    implied_upside: s.analyst?.implied_upside ?? null,
    analyst_unavailable_reason: s.analyst?.unavailable ? s.analyst.reason : null,
    captured_at: s.technical?.captured_at || s.analyst?.captured_at,
    source_id: s.source?.id ?? null,
  }));

  report.recommendations = (recommendations || []).map((r) => ({
    asset_id: r.asset_id,
    ticker: r.ticker,
    name: r.name,
    asset_class: r.asset_class,
    portfolio_role: r.portfolio_role,
    current_weight: r.current_weight,
    proposed_action: r.proposed_action,
    final_action: r.final_action,
    suitability_result: r.suitability_result,
    signal_conflict: r.signal_conflict,
    technical_signal: r.technical_signal,
    analyst_signal: r.analyst_signal,
    analyst_count: r.analyst_count,
    target_price: r.target_price,
    implied_upside: r.implied_upside,
    conviction: r.conviction,
    factors: r.factors,
    flags: r.flags,
    statement: r.statement,
    rationale: r.rationale || null,
    rationale_pt: r.rationale_pt || null,
    advisor_status: r.advisor_status,
    advisor_note: r.advisor_note || null,
  }));

  report.advisor_view = worldView
    ? {
      date: worldView.date,
      headline: worldView.headline,
      summary: worldView.generated_summary,
      advisor_commentary: worldView.advisor_commentary,
      stance_by_asset_class: worldView.stance_by_asset_class,
      approval_status: worldView.approval_status,
      classification: 'advisor_forward_looking_view',
    }
    : null;

  const totalValue = perf.ending_market_value || 0;
  report.approved_portfolio = {
    snapshot_id: ctx.snapshot.id,
    effective_date: ctx.snapshot.effective_date,
    policy_version: ctx.policy?.version,
    total_value: totalValue,
    base_currency: ctx.policy?.base_currency || 'BRL',
    allocation: Object.entries(exposures || {}).map(([asset_class, weight]) => ({
      asset_class,
      weight,
      target: ctx.policy?.target_allocation?.[asset_class] ?? null,
      range: ctx.policy?.permitted_ranges?.[asset_class] ?? null,
      value: weight * totalValue,
    })).sort((a, b) => b.weight - a.weight),
    holdings: market.priced.map((p) => ({
      asset_id: p.asset.id,
      ticker: p.asset.ticker,
      name: p.asset.name,
      asset_class: p.asset.asset_class,
      currency: p.asset.currency,
      quantity: p.quantity,
      price: p.close_price ?? null,
      market_value: p.market_value ?? null,
      weight: totalValue ? (p.market_value ?? 0) / totalValue : null,
      pricing_mode: p.pricing_mode,
      unavailable_reason: p.reason || null,
    })),
  };

  report.letter = narrative?.letter || null;
  report.sources = ledger.all();
  report.disclosures = standardDisclosures(locale);

  report.data_quality = {
    warnings: (market.validation || []).filter((v) => v.status === 'review'),
    unavailable: [
      ...(market.validation || []).filter((v) => v.status === 'unavailable').map((v) => ({ item: v.ticker || v.asset_id, reason: v.reason, providers_attempted: v.providers_attempted })),
      ...(perf.coverage?.excluded || []).map((e) => ({ item: e.ticker || e.name, reason: e.reason, providers_attempted: e.providers_attempted })),
    ],
    simulated_sources: ledger.all().filter((s) => s.mocked).map((s) => ({ provider: s.provider, instrument: s.instrument })),
  };

  report.provenance = {
    schema_version: REPORT_SCHEMA_VERSION,
    graph_run_id: graphRunId,
    prompt_version: promptVersion,
    narrative_mode: narrative?.mode || 'unknown',
    llm_model: narrative?.model || null,
    engine_version: 'deterministic-1.0.0',
    validation: market.validation,
  };

  return report;
}

/**
 * Historical metrics against the real risk-free rate (§15).
 * The Sharpe ratio is computed against the CDI actually published for each
 * month, not a constant, so it is comparable to any other Brazilian mandate.
 */
export async function computeMetrics(env, ctx) {
  const history = (ctx.returns_history || []).map((r) => ({ month: r.month, value: r.portfolio_return }));
  if (history.length < 2) return { available: false, reason: `insufficient history: ${history.length} monthly observations`, observations: history.length };

  const from = `${history[0].month}-01`;
  const to = `${history[history.length - 1].month}-28`;
  const cdi = await bcb.series('CDI_MONTHLY', from, to);
  let riskFree = null;
  let riskFreeSource = null;
  if (!cdi.unavailable && cdi.points.length) {
    const byMonth = new Map(cdi.points.map((p) => [p.date.slice(0, 7), p.value / 100]));
    riskFree = history.map((h) => byMonth.get(h.month) ?? null);
    if (riskFree.some((v) => v == null)) riskFree = null;
    else riskFreeSource = cdi.source;
  }

  const metrics = historicalMetrics(history, riskFree);
  return {
    ...metrics,
    risk_free: riskFree ? { name: 'CDI', source_id: riskFreeSource?.id ?? null, source: riskFreeSource } : { unavailable: true, reason: 'CDI series unavailable for the full window; Sharpe ratio not published' },
    sharpe_ratio: riskFree ? metrics.sharpe_ratio : null,
  };
}

export { validateReport, mapEventToPortfolio, buildWhatMattersTable, mapTriggersToClients, driftTriggers, TRIGGER_STATUS, historicalMetrics };

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
