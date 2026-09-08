/**
 * TradingView adapter — two INDEPENDENT signal families (§16).
 *
 *   1. Technical  — the moving-average / oscillator rating (Recommend.*)
 *   2. Analyst    — sell-side consensus (recommendation_mark + the buy/hold/sell
 *                   split + price targets)
 *
 * They are captured, stored and displayed as separate fields. Technical output
 * is never used to infer analyst sentiment, and where a security has no analyst
 * coverage the record says "No analyst consensus available" rather than
 * borrowing the technical rating (§30).
 *
 * Public scanner endpoint. No credentials required for the columns used here;
 * see README for the licensed-feed upgrade path.
 */
import { getJson } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';

const SCANNERS = {
  america: 'https://scanner.tradingview.com/america/scan',
  brazil: 'https://scanner.tradingview.com/brazil/scan',
  europe: 'https://scanner.tradingview.com/europe/scan',
  crypto: 'https://scanner.tradingview.com/crypto/scan',
};

const EXCHANGE_SCANNER = {
  BMFBOVESPA: 'brazil', NASDAQ: 'america', NYSE: 'america', AMEX: 'america',
  BATS: 'america', ARCA: 'america', CBOE: 'america',
  XETR: 'europe', LSE: 'europe', EURONEXT: 'europe',
  BINANCE: 'crypto', COINBASE: 'crypto', CRYPTO: 'crypto',
};

const TECHNICAL_COLUMNS = ['Recommend.All', 'Recommend.MA', 'Recommend.Other', 'RSI', 'close', 'currency', 'description'];
const TECHNICAL_WEEKLY = ['Recommend.All|1W'];
const ANALYST_COLUMNS = ['recommendation_mark', 'recommendation_total', 'recommendation_buy', 'recommendation_hold', 'recommendation_sell', 'price_target_average', 'price_target_high', 'price_target_low'];

/** TradingView's own thresholds on the −1..+1 technical rating. */
export function technicalLabel(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 0.5) return 'Strong Buy';
  if (v >= 0.1) return 'Buy';
  if (v > -0.1) return 'Neutral';
  if (v > -0.5) return 'Sell';
  return 'Strong Sell';
}

/** TradingView's analyst consensus mark, 1 (strong buy) .. 5 (strong sell). */
export function analystLabel(mark) {
  if (mark == null || !Number.isFinite(mark)) return null;
  if (mark < 1.5) return 'Strong Buy';
  if (mark < 2.5) return 'Buy';
  if (mark < 3.5) return 'Neutral';
  if (mark < 4.5) return 'Sell';
  return 'Strong Sell';
}

function groupByScanner(tickers) {
  const groups = {};
  for (const t of tickers) {
    const ex = String(t).split(':')[0];
    const key = EXCHANGE_SCANNER[ex] || 'america';
    (groups[key] ||= []).push(t);
  }
  return groups;
}

async function scan(scannerKey, tickers, columns) {
  const url = SCANNERS[scannerKey] || SCANNERS.america;
  const cacheKey = `tv:${scannerKey}:${tickers.join(',')}:${columns.join(',')}`;
  const cached = await cacheGet(cacheKey, 900);
  if (cached) return cached;
  await throttle('tradingview', 300);
  const body = JSON.stringify({ symbols: { tickers, query: { types: [] } }, columns });
  const json = await getJson(url, {
    method: 'POST', body, retries: 1, timeout: 15000,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' },
  });
  const rows = {};
  for (const row of json?.data || []) {
    rows[row.s] = Object.fromEntries(columns.map((c, i) => [c, row.d[i]]));
  }
  await cacheSet(cacheKey, rows, 900);
  return rows;
}

/**
 * Capture both families for a list of "EXCHANGE:TICKER" symbols.
 * @returns {Promise<Record<string, object>>} keyed by the tradingview symbol
 */
export async function signals(tvSymbols) {
  const captured_at = new Date().toISOString();
  const out = {};
  const groups = groupByScanner(tvSymbols);

  for (const [scannerKey, tickers] of Object.entries(groups)) {
    let tech = {}, weekly = {}, analyst = {};
    let techErr = null, analystErr = null;

    try { tech = await scan(scannerKey, tickers, TECHNICAL_COLUMNS); }
    catch (err) { techErr = err.message; }
    try { weekly = await scan(scannerKey, tickers, TECHNICAL_WEEKLY); }
    catch { /* weekly is supplementary; daily is the contract */ }
    try { analyst = await scan(scannerKey, tickers, ANALYST_COLUMNS); }
    catch (err) { analystErr = err.message; }

    for (const t of tickers) {
      const T = tech[t];
      const A = analyst[t];
      const ratingAll = T?.['Recommend.All'];
      const hasAnalyst = A && Number.isFinite(A.recommendation_mark) && Number.isFinite(A.recommendation_total) && A.recommendation_total > 0;

      out[t] = {
        tv_symbol: t,
        description: T?.description ?? null,
        last_close: Number.isFinite(T?.close) ? T.close : null,
        currency: T?.currency ?? null,

        // ── family 1: technical ────────────────────────────────────────────
        technical: T && Number.isFinite(ratingAll) ? {
          signal: technicalLabel(ratingAll),
          rating: ratingAll,
          moving_averages: technicalLabel(T['Recommend.MA']),
          oscillators: technicalLabel(T['Recommend.Other']),
          rsi_14: Number.isFinite(T.RSI) ? T.RSI : null,
          timeframe: '1D',
          weekly_signal: technicalLabel(weekly[t]?.['Recommend.All|1W']) ?? null,
          captured_at,
        } : {
          signal: null,
          unavailable: true,
          reason: techErr || 'no technical rating published for this instrument',
          captured_at,
        },

        // ── family 2: analyst consensus — never inferred from the above ────
        analyst: hasAnalyst ? {
          consensus: analystLabel(A.recommendation_mark),
          mark: A.recommendation_mark,
          analyst_count: A.recommendation_total,
          breakdown: {
            buy: A.recommendation_buy ?? null,
            hold: A.recommendation_hold ?? null,
            sell: A.recommendation_sell ?? null,
          },
          target_price: {
            average: Number.isFinite(A.price_target_average) ? A.price_target_average : null,
            high: Number.isFinite(A.price_target_high) ? A.price_target_high : null,
            low: Number.isFinite(A.price_target_low) ? A.price_target_low : null,
          },
          implied_upside: Number.isFinite(A.price_target_average) && Number.isFinite(T?.close) && T.close > 0
            ? A.price_target_average / T.close - 1 : null,
          captured_at,
        } : {
          consensus: null,
          unavailable: true,
          reason: analystErr ? `provider error: ${analystErr}` : 'No analyst consensus available',
          captured_at,
        },

        source: makeSource({
          provider: 'TradingView',
          kind: 'signal',
          instrument: T?.description || t,
          identifier: t,
          requested_range: 'technical 1D + 1W; analyst consensus current',
          retrieval_timestamp: captured_at,
          last_observation: captured_at.slice(0, 10),
          reference: `https://www.tradingview.com/symbols/${t.replace(':', '-')}/`,
        }),
      };
    }
  }

  // Symbols the scanner did not return at all (delisted, wrong exchange, unsupported)
  for (const t of tvSymbols) {
    if (!out[t]) {
      out[t] = {
        tv_symbol: t,
        unavailable: true,
        reason: 'symbol not returned by the TradingView scanner (delisted, renamed, or not covered)',
        technical: { signal: null, unavailable: true, reason: 'symbol not covered', captured_at },
        analyst: { consensus: null, unavailable: true, reason: 'No analyst consensus available', captured_at },
        source: null,
      };
    }
  }
  return out;
}
