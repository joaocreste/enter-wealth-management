/**
 * Return against risk over the trailing twelve months: every mapped asset and
 * the market references on one plane.
 *
 * Everything is measured at a monthly frequency. Fund quotas exist only at
 * month-ends and contractual instruments accrue from a monthly index, and a
 * chart must not compare a daily volatility with a monthly one, so listed
 * assets are sampled at the same month-ends. Return is the compounded variation
 * of the twelve monthly returns; volatility is their sample standard deviation,
 * annualised by √12. The observation count travels with both, and a series with
 * too few months is null — unavailable, never zero.
 *
 * The chart groups assets into four broad classes. The desk's asset classes map
 * onto them here, in one place.
 */
export const PERIODS_PER_YEAR = 12;
export const MIN_MONTHS = 6;

export const RISK_CLASSES = [
  { key: 'equity', label: 'Equity', asset_classes: ['Equities BR', 'Equities Global', 'Real Estate'] },
  { key: 'debt', label: 'Debt', asset_classes: ['Fixed Income', 'Cash'] },
  { key: 'fx_commodities', label: 'FX / Commodities', asset_classes: ['Commodities', 'FX'] },
  { key: 'crypto_other', label: 'Crypto & other', asset_classes: ['Digital Assets', 'Alternatives', 'Other'] },
];

/** The broad class of an asset class; anything unmapped is "crypto & other". */
export const riskClassOf = (assetClass) => (RISK_CLASSES.find((c) => c.asset_classes.includes(assetClass)) || RISK_CLASSES[RISK_CLASSES.length - 1]).key;

/** The last calendar day of a month, "2026-08" → "2026-08-31". */
export function monthEnd(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The month before, "2026-01" → "2025-12". */
export function monthBefore(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/**
 * Monthly returns from closes observed at consecutive month-ends. `closes[0]`
 * is the opening anchor (the end of the month before the window). A missing
 * close leaves that month, and the next, without a return.
 * @param {Array<number|null>} closes
 * @param {string[]} months  the window's months, one per return
 */
export function monthlyReturnsFromCloses(closes, months) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1]; const b = closes[i];
    out.push({ month: months[i - 1], value: a > 0 && b > 0 ? b / a - 1 : null });
  }
  return out;
}

/**
 * @param {Array<{ month: string, value: number|null }>} returns  monthly returns, ascending
 * @returns {{ total_return, volatility, observations, months, mean_monthly } | null}
 */
export function riskFromMonthly(returns, { periodsPerYear = PERIODS_PER_YEAR, minObservations = MIN_MONTHS } = {}) {
  const rs = (returns || []).map((r) => r.value).filter((v) => Number.isFinite(v));
  const n = rs.length;
  if (n < minObservations) return null;
  const mean = rs.reduce((a, r) => a + r, 0) / n;
  const variance = n > 1 ? rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1) : 0;
  return {
    total_return: rs.reduce((a, r) => a * (1 + r), 1) - 1,
    volatility: Math.sqrt(variance * periodsPerYear),
    observations: n,
    months: returns.length,
    mean_monthly: mean,
  };
}

/**
 * The empirical efficient frontier: the upper hull of the points, from the
 * least volatile one to the one with the highest return, so that no point on
 * the plane lies above the line. Returns the keys of the points on it, in
 * order of increasing volatility.
 * @param {Array<{ key: string, x: number, y: number }>} points  x volatility, y return
 */
export function efficientFrontier(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x || b.y - a.y);
  if (pts.length < 2) return pts.map((p) => p.key);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const hull = [];
  for (const p of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) >= 0) hull.pop();
    hull.push(p);
  }
  // the upper hull runs left to right; it stops at the highest return, past which
  // more risk buys less return and the line would turn down
  let top = 0;
  for (let i = 1; i < hull.length; i += 1) if (hull[i].y > hull[top].y) top = i;
  return hull.slice(0, top + 1).map((p) => p.key);
}
