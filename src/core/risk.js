/**
 * Trailing return and volatility of one daily price series.
 *
 * Return is the total variation between the first and the last close of the
 * window — adjusted closes when the caller passes them, so an ETF's dividends
 * count. Volatility is the sample standard deviation of daily log returns,
 * annualised by the square root of the sessions in a year. By default that
 * count is observed from the series itself — about 252 for an exchange that
 * closes at weekends, 365 for a market that never closes — so a crypto
 * asset is not understated by a stock-market convention. The observation count
 * and the annualisation used travel with the result, and a window with too few
 * sessions is null — unavailable, never zero.
 *
 * The chart groups the monitored indicators into four broad classes. The
 * desk's indicator groups map onto them here, in one place.
 */
export const TRADING_DAYS = 252;       // the fallback when the dates cannot tell how often a series trades
const DAYS_IN_YEAR = 365.25;

const isoDays = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/** Sessions per year implied by the series: observations over the calendar span. */
export function sessionsPerYear(points) {
  if (!points?.length) return TRADING_DAYS;
  const first = points[0].date; const last = points[points.length - 1].date;
  const span = isoDays(first, last);
  if (!Number.isFinite(span) || span < 30) return TRADING_DAYS;       // too short to tell
  return Math.round(((points.length - 1) / span) * DAYS_IN_YEAR);
}

export const RISK_CLASSES = [
  { key: 'equity', label: 'Equity', groups: ['Equities'] },
  { key: 'debt', label: 'Debt', groups: ['Rates & Credit'] },
  { key: 'fx_commodities', label: 'FX / Commodities', groups: ['FX & Commodities'] },
  { key: 'crypto_other', label: 'Crypto & other', groups: ['Digital Assets'] },
];

/** The broad class of an indicator group; anything unmapped is "crypto & other". */
export const riskClassOf = (group) => (RISK_CLASSES.find((c) => c.groups.includes(group)) || RISK_CLASSES[RISK_CLASSES.length - 1]).key;

/**
 * @param {Array<{ date: string, close: number }>} points  daily closes, ascending
 * @param {{ tradingDays?: number|null, minObservations?: number }} opts
 *   tradingDays  sessions per year for the annualisation; null (default) observes it from the dates
 * @returns {{ from, to, sessions, total_return, volatility, annualisation_days, mean_daily_log_return } | null}
 */
export function riskReturn(points, { tradingDays = null, minObservations = 20 } = {}) {
  const pts = (points || []).filter((p) => p && p.close > 0);
  if (pts.length < 2) return null;
  const perYear = tradingDays ?? sessionsPerYear(pts);
  const rets = [];
  for (let i = 1; i < pts.length; i += 1) rets.push(Math.log(pts[i].close / pts[i - 1].close));
  const n = rets.length;
  if (n < minObservations) return null;
  const mean = rets.reduce((a, r) => a + r, 0) / n;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  const first = pts[0]; const last = pts[pts.length - 1];
  return {
    from: first.date,
    to: last.date,
    sessions: n,
    total_return: last.close / first.close - 1,
    volatility: Math.sqrt(variance * perYear),
    annualisation_days: perYear,
    mean_daily_log_return: mean,
  };
}
