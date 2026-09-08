/**
 * Deterministic portfolio return engine.
 *
 * No language model touches any figure produced in this file (§32).
 *
 * Method selection, in order of preference:
 *   1. TWR  — true time-weighted return by daily revaluation and geometric
 *             linking around external flows. Requires a daily valuation for
 *             every position across the month.
 *   2. Modified Dietz — day-weights each external flow. Correct when only the
 *             opening and closing valuations are available, which is the case
 *             whenever the book holds fund quotas priced from a monthly
 *             custodian statement.
 *   3. Simple — (EMV − BMV) / BMV. Only when there are no flows at all.
 *
 * Whichever is used is recorded on the result together with the assumption it
 * rests on, and that sentence is carried through to the client letter.
 */

/** Day-weighted denominator used by Modified Dietz and by the attribution split. */
function dietzDenominator(bmv, flows, startIso, endIso) {
  const totalDays = Math.max(1, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 86400000));
  let weighted = 0;
  for (const f of flows) {
    const d = Math.round((Date.parse(f.date) - Date.parse(startIso)) / 86400000);
    const w = Math.min(1, Math.max(0, (totalDays - d) / totalDays));
    weighted += f.amount * w;
  }
  return { denominator: bmv + weighted, totalDays, weightedFlows: weighted };
}

export function modifiedDietz(bmv, emv, flows, startIso, endIso) {
  const net = flows.reduce((a, f) => a + f.amount, 0);
  const { denominator, totalDays, weightedFlows } = dietzDenominator(bmv, flows, startIso, endIso);
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return {
    method: 'modified_dietz',
    value: (emv - bmv - net) / denominator,
    denominator,
    net_flows: net,
    weighted_flows: weightedFlows,
    days: totalDays,
  };
}

export function simpleReturn(bmv, emv) {
  if (!Number.isFinite(bmv) || bmv === 0) return null;
  return { method: 'simple', value: emv / bmv - 1, denominator: bmv, net_flows: 0 };
}

/**
 * True time-weighted return: revalue on every flow date, link the sub-period
 * returns geometrically.
 *
 * Convention: `dailyValues` are end-of-day marks, so a flow dated D is already
 * inside the value at D. Each sub-period return therefore removes the flow from
 * the closing value: (V_d − F_d) / V_{d−1}. This is the correct treatment for
 * end-of-day valuations. If a custodian supplies marks taken immediately BEFORE
 * the flow instead, pass the flow dated to the following day.
 */
export function timeWeightedReturn(dailyValues, flows) {
  if (!dailyValues?.length || dailyValues.length < 2) return null;
  const flowByDate = new Map();
  for (const f of flows) flowByDate.set(f.date, (flowByDate.get(f.date) || 0) + f.amount);

  let linked = 1;
  let subPeriods = 0;
  for (let i = 1; i < dailyValues.length; i += 1) {
    const prev = dailyValues[i - 1];
    const cur = dailyValues[i];
    const flow = flowByDate.get(cur.date) || 0;
    const base = prev.value;
    if (!Number.isFinite(base) || base === 0) continue;
    linked *= (cur.value - flow) / base;
    subPeriods += 1;
  }
  if (!subPeriods) return null;
  return { method: 'twr_daily_linked', value: linked - 1, sub_periods: subPeriods };
}

const METHOD_NOTE = {
  twr_daily_linked: {
    en: 'Time-weighted return, daily revaluation linked geometrically around external cash flows.',
    pt: 'Retorno ponderado pelo tempo (TWR), com reavaliação diária e encadeamento geométrico em torno das movimentações.',
  },
  modified_dietz: {
    en: 'Modified Dietz. Each external flow is weighted by the fraction of the month it was invested. Used because at least one holding is valued only at month-end (fund quotas priced from the custodian statement), so a daily portfolio valuation does not exist for the whole book.',
    pt: 'Método de Dietz modificado. Cada movimentação é ponderada pela fração do mês em que esteve investida. Utilizado porque ao menos uma posição é avaliada apenas no fechamento do mês (cotas de fundos, precificadas pelo extrato do custodiante), de modo que não existe avaliação diária para toda a carteira.',
  },
  simple: {
    en: 'Simple period return. There were no contributions or withdrawals during the month, so no cash-flow adjustment applies.',
    pt: 'Retorno simples do período. Não houve aportes nem resgates no mês, portanto nenhum ajuste de fluxo de caixa se aplica.',
  },
};

/**
 * Monthly profitability for one portfolio (§13).
 *
 * @param {object} input
 * @param {Array}  input.positions   [{ asset, quantity, open_price, close_price, income_per_unit, fx_open, fx_close, unavailable, ... }]
 * @param {Array}  input.flows       [{ date, amount, type }] external contributions (+) / withdrawals (−)
 * @param {Array}  input.income      [{ date, amount, asset_id }] distributions credited as cash
 * @param {number} input.opening_cash
 * @param {number} input.closing_cash
 * @param {string} input.start, input.end
 * @param {Array}  [input.dailyPortfolioValues]
 */
export function monthlyProfitability(input) {
  const { positions, flows = [], income = [], opening_cash = 0, closing_cash = 0, start, end } = input;

  const priced = [];
  const excluded = [];

  for (const p of positions) {
    const hasOpen = Number.isFinite(p.open_price) && Number.isFinite(p.quantity);
    const hasClose = Number.isFinite(p.close_price) && Number.isFinite(p.quantity);
    const fxo = Number.isFinite(p.fx_open) ? p.fx_open : 1;
    const fxc = Number.isFinite(p.fx_close) ? p.fx_close : 1;

    if (!hasOpen || !hasClose) {
      excluded.push({
        asset_id: p.asset.id,
        name: p.asset.name,
        ticker: p.asset.ticker,
        asset_class: p.asset.asset_class,
        market_value: hasClose ? p.close_price * p.quantity * fxc : (Number.isFinite(p.market_value) ? p.market_value : null),
        reason: p.reason || 'no valuation pair available for the reporting month',
        providers_attempted: p.providers_attempted || [],
      });
      continue;
    }

    const bmv = p.open_price * p.quantity * fxo;
    const emv = p.close_price * p.quantity * fxc;
    const inc = (p.income_per_unit || 0) * p.quantity * fxc;
    const localReturn = p.open_price ? (p.close_price + (p.income_per_unit || 0)) / p.open_price - 1 : null;
    const fxReturn = fxo ? fxc / fxo - 1 : 0;

    priced.push({
      asset_id: p.asset.id,
      name: p.asset.name,
      ticker: p.asset.ticker,
      asset_class: p.asset.asset_class,
      currency: p.asset.currency,
      quantity: p.quantity,
      open_price: p.open_price,
      close_price: p.close_price,
      open_date: p.open_date ?? null,
      close_date: p.close_date ?? null,
      fx_open: fxo,
      fx_close: fxc,
      bmv,
      emv,
      income: inc,
      pnl: emv - bmv + inc,
      local_return: localReturn,
      fx_return: fxReturn,
      // total return in base currency, decomposed
      total_return: localReturn == null ? null : (1 + localReturn) * (1 + fxReturn) - 1,
      pricing_mode: p.pricing_mode || 'market',
      source_ids: p.source_ids || [],
    });
  }

  const bmvPositions = priced.reduce((a, p) => a + p.bmv, 0);
  const emvPositions = priced.reduce((a, p) => a + p.emv, 0);
  const incomeTotal = priced.reduce((a, p) => a + p.income, 0) + income.reduce((a, i) => a + i.amount, 0);

  // Excluded positions are carried at their statement value on both sides so the
  // portfolio total reconciles, but they contribute exactly zero to the return
  // and the letter says so.
  const excludedValue = excluded.reduce((a, e) => a + (e.market_value || 0), 0);

  const bmv = bmvPositions + opening_cash + excludedValue;
  const emv = emvPositions + closing_cash + excludedValue;

  const contributions = flows.filter((f) => f.amount > 0).reduce((a, f) => a + f.amount, 0);
  const withdrawals = flows.filter((f) => f.amount < 0).reduce((a, f) => a + f.amount, 0);

  // ── method selection ──────────────────────────────────────────────────────
  let ret = null;
  const everyPositionDaily = priced.length > 0 && priced.every((p) => p.pricing_mode === 'market');
  if (everyPositionDaily && input.dailyPortfolioValues?.length > 2) {
    ret = timeWeightedReturn(input.dailyPortfolioValues, flows);
  }
  if (!ret && flows.length) ret = modifiedDietz(bmv, emv, flows, start, end);
  if (!ret && !flows.length) ret = simpleReturn(bmv, emv);
  if (!ret) ret = modifiedDietz(bmv, emv, flows, start, end);

  const denominator = ret?.denominator ?? bmv;

  // ── attribution: exactly additive against the selected denominator ────────
  const byPosition = priced
    .map((p) => ({ ...p, contribution: denominator ? p.pnl / denominator : null }))
    .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0));

  const classMap = new Map();
  for (const p of byPosition) {
    const k = p.asset_class || 'Other';
    if (!classMap.has(k)) classMap.set(k, { asset_class: k, bmv: 0, emv: 0, pnl: 0, contribution: 0, positions: 0 });
    const g = classMap.get(k);
    g.bmv += p.bmv; g.emv += p.emv; g.pnl += p.pnl;
    g.contribution += p.contribution ?? 0; g.positions += 1;
  }
  const byAssetClass = [...classMap.values()]
    .map((g) => ({ ...g, weight_start: bmv ? g.bmv / bmv : null, weight_end: emv ? g.emv / emv : null, return: g.bmv ? g.pnl / g.bmv : null }))
    .sort((a, b) => b.contribution - a.contribution);

  // FX contribution — the part of the base-currency result that came from the
  // exchange rate rather than from the asset (§14).
  const fxContribution = byPosition.reduce((a, p) => {
    if (!p.fx_return) return a;
    const local = p.local_return ?? 0;
    const fxPart = (1 + local) * p.fx_return;
    return a + (denominator ? (p.bmv * fxPart) / denominator : 0);
  }, 0);

  // Cash, uncovered positions and rounding are shown as an explicit residual so
  // the attribution always adds up to the reported portfolio return. A silent
  // gap between "sum of the parts" and "the number on page one" is the single
  // fastest way to lose an advisor's trust in a report.
  const portfolioPnl = emv - bmv - (contributions + withdrawals);
  const positionPnl = byPosition.reduce((a, p) => a + p.pnl, 0);
  const residual = {
    label: 'Cash and unpriced positions',
    pnl: portfolioPnl - positionPnl,
    contribution: denominator ? (portfolioPnl - positionPnl) / denominator : 0,
  };

  const positives = byPosition.filter((p) => (p.contribution ?? 0) > 0);
  const negatives = byPosition.filter((p) => (p.contribution ?? 0) < 0);

  return {
    period: { start, end, month: String(start).slice(0, 7) },
    beginning_market_value: bmv,
    ending_market_value: emv,
    opening_cash,
    closing_cash,
    contributions,
    withdrawals,
    net_flows: contributions + withdrawals,
    income: incomeTotal,
    absolute_pnl: emv - bmv - (contributions + withdrawals),
    monthly_return: ret?.value ?? null,
    method: ret?.method ?? 'unavailable',
    method_note: METHOD_NOTE[ret?.method] || { en: 'No return could be computed from the available data.', pt: 'Não foi possível calcular o retorno com os dados disponíveis.' },
    denominator,
    coverage: {
      priced_positions: priced.length,
      excluded_positions: excluded.length,
      priced_value_share: emv ? emvPositions / emv : null,
      excluded,
    },
    attribution: {
      by_position: byPosition,
      by_asset_class: byAssetClass,
      residual,
      fx_contribution: fxContribution,
      best_contributor: positives[0] || null,
      worst_contributor: negatives[negatives.length - 1] || null,
      top_positive: positives.slice(0, 3),
      top_negative: negatives.slice(-3).reverse(),
      // sum of every contribution line, including the residual, equals monthly_return
      reconciles: Math.abs(
        byPosition.reduce((a, p) => a + (p.contribution ?? 0), 0) + residual.contribution - (ret?.value ?? 0),
      ) < 1e-9,
    },
  };
}

/** Benchmark comparison. Excess return is arithmetic — the industry convention for a single month. */
export function compareToBenchmark(portfolioReturn, benchmark) {
  if (portfolioReturn == null || benchmark?.value == null) {
    return { available: false, reason: 'benchmark return unavailable for the period' };
  }
  return {
    available: true,
    benchmark_name: benchmark.name,
    benchmark_return: benchmark.value,
    excess_return: portfolioReturn - benchmark.value,
    outperformed: portfolioReturn > benchmark.value,
    composition: benchmark.composition || null,
    source_ids: benchmark.source_ids || [],
  };
}

/**
 * Historical and forward-looking metrics (§15).
 * Historical measures are computed from a monthly return history; the advisor's
 * forward-looking view is stored separately and never merged into these.
 */
export function historicalMetrics(monthlyReturns, riskFreeMonthly = null) {
  const rs = monthlyReturns.map((m) => m.value).filter(Number.isFinite);
  if (rs.length < 2) {
    return { available: false, reason: `insufficient history: ${rs.length} monthly observations`, observations: rs.length };
  }
  const n = rs.length;
  const cumulative = rs.reduce((a, r) => a * (1 + r), 1) - 1;
  const annualised = (1 + cumulative) ** (12 / n) - 1;
  const mean = rs.reduce((a, r) => a + r, 0) / n;
  const variance = rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  const volMonthly = Math.sqrt(variance);
  const volAnnual = volMonthly * Math.sqrt(12);

  const rf = riskFreeMonthly?.length ? riskFreeMonthly : null;
  let sharpe = null;
  if (rf && rf.length === n) {
    const excess = rs.map((r, i) => r - rf[i]);
    const em = excess.reduce((a, r) => a + r, 0) / n;
    const ev = Math.sqrt(excess.reduce((a, r) => a + (r - em) ** 2, 0) / (n - 1));
    sharpe = ev ? (em * 12) / (ev * Math.sqrt(12)) : null;
  } else if (rf) {
    const rfMean = rf.reduce((a, r) => a + r, 0) / rf.length;
    sharpe = volAnnual ? (annualised - ((1 + rfMean) ** 12 - 1)) / volAnnual : null;
  }

  // maximum drawdown on the compounded equity curve
  let peak = 1, equity = 1, maxDd = 0, ddStart = null, ddTrough = null, curPeakDate = monthlyReturns[0]?.month ?? null;
  for (const m of monthlyReturns) {
    if (!Number.isFinite(m.value)) continue;
    equity *= 1 + m.value;
    if (equity > peak) { peak = equity; curPeakDate = m.month; }
    const dd = equity / peak - 1;
    if (dd < maxDd) { maxDd = dd; ddStart = curPeakDate; ddTrough = m.month; }
  }

  const last36 = monthlyReturns.slice(-36).map((m) => m.value).filter(Number.isFinite);
  const threeYear = last36.length >= 36 ? last36.reduce((a, r) => a * (1 + r), 1) - 1 : null;

  return {
    available: true,
    observations: n,
    period: { from: monthlyReturns[0]?.month, to: monthlyReturns[monthlyReturns.length - 1]?.month },
    cumulative_return: cumulative,
    annualised_return: annualised,
    annualised_volatility: volAnnual,
    sharpe_ratio: sharpe,
    max_drawdown: maxDd,
    max_drawdown_window: maxDd < 0 ? { peak_month: ddStart, trough_month: ddTrough } : null,
    three_year_return: threeYear,
    three_year_available: last36.length >= 36,
    three_year_note: last36.length >= 36
      ? null
      : `Only ${last36.length} months of history are available; a three-year figure is not published.`,
    // §15 — a historical figure is never relabelled as an expectation
    classification: 'historical_measure',
  };
}
