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

    // The newest row is still moving while the session that produced it is open:
    // the last trade falls inside the current regular period and dates that row.
    const m = r.meta || {};
    const regular = m.currentTradingPeriod?.regular || {};
    const lastTrade = m.regularMarketTime;
    const session = {
      last_trade_at: Number.isFinite(lastTrade) ? new Date(lastTrade * 1000).toISOString() : null,
      in_progress: Number.isFinite(lastTrade) && Number.isFinite(regular.start) && Number.isFinite(regular.end)
        && lastTrade >= regular.start && lastTrade < regular.end && points[points.length - 1].date === iso(lastTrade),
    };

    return {
      symbol,
      currency: r.meta?.currency || null,
      name: r.meta?.longName || r.meta?.shortName || symbol,
      exchange: r.meta?.fullExchangeName || null,
      points,
      dividends,
      session,
      // The same response carries the live quote; a caller that already has the series need not ask again.
      quote: Number.isFinite(m.regularMarketPrice) ? {
        price: m.regularMarketPrice,
        changePct: Number.isFinite(m.regularMarketChangePercent) ? m.regularMarketChangePercent / 100 : null,
        asOf: Number.isFinite(lastTrade) ? iso(lastTrade) : points[points.length - 1].date,
        fromCache: !!fromCache,
      } : null,
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

/**
 * Month to date: the move since the last close of the previous month, not
 * since the first bar of a trailing window. `points` are daily bars in order;
 * `month` is the YYYY-MM the price belongs to.
 */
export function monthToDate(points, price, month) {
  let base = null;
  for (const p of points) if (p.date.slice(0, 7) < month && Number.isFinite(p.close)) base = p;
  return base ? { pct: price / base.close - 1, from: base.date } : { pct: null, from: null };
}

/** Latest quote snapshot — the World Overview indicator strip. */
export async function quote(symbol) {
  try {
    const { json } = await chart(symbol, 'range=1mo&interval=1d');
    const r = json?.chart?.result?.[0];
    const m = r?.meta;
    if (!Number.isFinite(m?.regularMarketPrice)) throw new Error('no quote');
    const closesAll = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || [];
    const ts = r.timestamp || [];
    const bars = ts.map((t, k) => ({ date: iso(t), close: closesAll[k] })).filter((b) => Number.isFinite(b.close));
    const asOf = Number.isFinite(m.regularMarketTime) ? iso(m.regularMarketTime) : (ts.length ? iso(ts[ts.length - 1]) : null);
    const mtd = asOf ? monthToDate(bars, m.regularMarketPrice, asOf.slice(0, 7)) : { pct: null, from: null };
    return {
      symbol,
      name: m.longName || m.shortName || symbol,
      currency: m.currency || null,
      price: m.regularMarketPrice,
      changePct: Number.isFinite(m.regularMarketChangePercent) ? m.regularMarketChangePercent / 100 : null,
      mtdPct: mtd.pct,
      mtdFrom: mtd.from,
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
