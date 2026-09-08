/**
 * Yahoo Finance adapter — primary market-price provider.
 *
 * Daily adjusted closes plus a source record for every series. A symbol with no
 * data yields { unavailable: true } and the caller decides whether an approved
 * fallback applies (§30). Nothing here ever invents a price.
 */
import { getJson } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const GAP_MS = 420;          // one request at a time, spaced
const TTL_SERIES = 6 * 3600; // a closed month never changes
const TTL_QUOTE = 300;

const iso = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

async function chart(symbol, query, ttl = null) {
  const cacheKey = `yahoo:${symbol}:${query}`;
  const ttlSeconds = ttl ?? (query.includes('range=') ? TTL_QUOTE : TTL_SERIES);
  const cached = await cacheGet(cacheKey, ttlSeconds);
  if (cached) return { ...cached, fromCache: true };

  let lastErr = null;
  for (let i = 0; i < HOSTS.length; i += 1) {
    await throttle('yahoo', GAP_MS);
    const url = `${HOSTS[i]}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
    try {
      const json = await getJson(url, { retries: 2, timeout: 14000 });
      if (json?.chart?.error) throw new Error(json.chart.error.description || 'provider error');
      const payload = { json, host: HOSTS[i], hostIndex: i };
      await cacheSet(cacheKey, payload, ttlSeconds);
      return payload;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('yahoo unavailable');
}

/**
 * Daily series for one symbol over an inclusive date window.
 * `cacheTtl` overrides the adapter cache for callers that need the newest close
 * sooner than a six-hour cache allows (the series store refreshing today's row).
 */
export async function dailySeries(symbol, fromIso, toIsoDate, { cacheTtl = null } = {}) {
  const period1 = Math.floor(Date.parse(`${fromIso}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${toIsoDate}T23:59:59Z`) / 1000);
  const range = `${fromIso}..${toIsoDate}`;
  try {
    const { json, hostIndex, fromCache } = await chart(symbol, `period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit`, cacheTtl);
    const r = json?.chart?.result?.[0];
    if (!r?.timestamp?.length) throw new Error('empty series');

    const adj = r.indicators?.adjclose?.[0]?.adjclose;
    const close = r.indicators?.quote?.[0]?.close;
    const points = [];
    for (let k = 0; k < r.timestamp.length; k += 1) {
      const v = adj?.[k] ?? close?.[k];
      if (!Number.isFinite(v)) continue;
      points.push({ date: iso(r.timestamp[k]), close: v, raw: Number.isFinite(close?.[k]) ? close[k] : v });
    }
    if (!points.length) throw new Error('no usable closes');

    const dividends = Object.values(r.events?.dividends || {}).map((d) => ({ date: iso(d.date), amount: d.amount }));

    return {
      symbol,
      currency: r.meta?.currency || null,
      name: r.meta?.longName || r.meta?.shortName || symbol,
      exchange: r.meta?.fullExchangeName || null,
      points,
      dividends,
      fromCache: !!fromCache,
      source: makeSource({
        provider: 'Yahoo Finance',
        kind: 'market_price',
        instrument: r.meta?.longName || r.meta?.shortName || symbol,
        identifier: symbol,
        requested_range: range,
        last_observation: points[points.length - 1].date,
        reference: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
        fallback_for: hostIndex > 0 ? 'Yahoo Finance (query1 host)' : null,
      }),
    };
  } catch (err) {
    return {
      symbol,
      unavailable: true,
      reason: err.message,
      providers_attempted: ['Yahoo Finance'],
      points: [],
      source: null,
    };
  }
}

/** Latest quote snapshot — the World Overview indicator strip. */
export async function quote(symbol) {
  try {
    const { json } = await chart(symbol, 'range=1mo&interval=1d');
    const r = json?.chart?.result?.[0];
    const m = r?.meta;
    if (!Number.isFinite(m?.regularMarketPrice)) throw new Error('no quote');
    const closes = (r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || []).filter(Number.isFinite);
    const ts = r.timestamp || [];
    const first = closes.length ? closes[0] : null;
    return {
      symbol,
      name: m.longName || m.shortName || symbol,
      currency: m.currency || null,
      price: m.regularMarketPrice,
      changePct: Number.isFinite(m.regularMarketChangePercent) ? m.regularMarketChangePercent / 100 : null,
      mtdPct: first ? m.regularMarketPrice / first - 1 : null,
      fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
      asOf: ts.length ? iso(ts[ts.length - 1]) : null,
      source: makeSource({
        provider: 'Yahoo Finance',
        kind: 'market_price',
        instrument: m.longName || m.shortName || symbol,
        identifier: symbol,
        requested_range: 'trailing 1 month, daily',
        last_observation: ts.length ? iso(ts[ts.length - 1]) : null,
        reference: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
      }),
    };
  } catch (err) {
    return { symbol, unavailable: true, reason: err.message, providers_attempted: ['Yahoo Finance'] };
  }
}

export async function quotes(symbols) {
  const out = {};
  for (const s of symbols) out[s] = await quote(s);  // serialised on purpose
  return out;
}

/** Close on or immediately before an anchor date. null when the window has no observation. */
export function closeOnOrBefore(series, isoDate) {
  if (!series?.points?.length) return null;
  let best = null;
  for (const p of series.points) {
    if (p.date <= isoDate) best = p; else break;
  }
  return best;
}

/** Sum of dividends paid inside [from, to]. */
export function dividendsBetween(series, fromIso, toIsoDate) {
  if (!series?.dividends?.length) return 0;
  return series.dividends
    .filter((d) => d.date > fromIso && d.date <= toIsoDate)
    .reduce((a, d) => a + d.amount, 0);
}
