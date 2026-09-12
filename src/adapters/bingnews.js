/**
 * Bing News — headlines from the public RSS search feeds.
 *
 * The engine used when Google News cannot be reached: Google answers the
 * Worker's requests from Cloudflare with HTTP 503 ("Sorry..."), while Bing
 * answers with the feed. Same shape as googlenews.js: a query, a market,
 * items with the publisher's name (`News:Source`), the time published and a
 * link that resolves to the article on the publisher's own site (the feed's
 * link is a Bing redirect carrying the real URL, which is decoded here).
 * Only the headline is used.
 */
import { getText } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';
import { parseRss, isServicePiece } from './valor.js';

export const PROVIDER = 'Bing News';
const BASE = 'https://www.bing.com/news/search';
const MARKET = { br: 'pt-br', intl: 'en-us' };

/** Fewer, broader questions than the Google set: each feed answers with about a dozen lines, and each costs one outbound call. */
export const QUERIES = [
  // Bing joins terms with AND, so each question is one or two words — the
  // ones that answered with the most fresh lines when measured (2026-09-12).
  { key: 'bn_bolsa', region: 'br', label: 'Bolsa', q: 'Ibovespa' },
  { key: 'bn_juros', region: 'br', label: 'Juros', q: 'juros' },
  { key: 'bn_ipca', region: 'br', label: 'Inflação', q: 'IPCA' },
  { key: 'bn_fed', region: 'intl', label: 'Fed', q: 'Fed' },
  { key: 'bn_treasuries', region: 'intl', label: 'Treasuries', q: 'Treasury yields' },
  { key: 'bn_equities', region: 'intl', label: 'US equities', q: 'Wall Street' },
  { key: 'bn_commodities', region: 'intl', label: 'Commodities', q: 'oil prices' },
  { key: 'bn_crypto', region: 'intl', label: 'Digital assets', q: 'bitcoin' },
];

export function feedUrl(query) {
  return `${BASE}?q=${encodeURIComponent(query.q)}&format=rss&mkt=${MARKET[query.region] || MARKET.br}`;
}

/** The feed's link is a Bing redirect; the article's own URL travels in its `url` parameter. */
export function articleUrl(link) {
  try {
    const u = new URL(link);
    if (/\bbing\.com$/i.test(u.hostname)) { const real = u.searchParams.get('url'); if (real && /^https?:/i.test(real)) return real; }
  } catch { /* keep the link as it came */ }
  return link;
}

export async function headlines({ windowHours = 48, now = new Date(), queries = QUERIES } = {}) {
  const since = now.getTime() - windowHours * 3600 * 1000;
  const byUrl = new Map();
  const report = [];
  for (const query of queries) {
    const cacheKey = `bnews:rss:${query.key}`;
    let xml = await cacheGet(cacheKey, 1800);
    try {
      if (!xml) {
        await throttle('bingnews', 300);
        xml = await getText(feedUrl(query), { retries: 0, timeout: 12000 });   // one call per feed: the Worker's outbound budget is small
        await cacheSet(cacheKey, xml, 1800);
      }
    } catch (err) {
      report.push({ key: query.key, label: query.label, region: query.region, ok: false, count: 0, error: err.message });
      continue;
    }
    let kept = 0;
    for (const it of parseRss(xml)) {
      if (!it.link || !it.title || !it.publishedAt || it.publishedAt.getTime() < since) continue;
      if (isServicePiece(it.title)) continue;
      kept += 1;
      const url = articleUrl(it.link);
      const key = normaliseUrl(url);
      const existing = byUrl.get(key);
      if (existing) { existing.feeds.push(query.key); continue; }
      let host = null;
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* no host to show */ }
      byUrl.set(key, {
        id: `bn_${hash(key)}`,
        title: it.title,
        subtitle: null,
        lead: null,
        url,
        section: query.region === 'br' ? 'financas' : 'internacional',
        published: it.publishedAt.toISOString(),
        feeds: [query.key],
        provider: it.source || host || PROVIDER,
        provider_url: host ? `https://${host}` : null,
        via: PROVIDER,
        region: query.region,
      });
    }
    report.push({ key: query.key, label: query.label, region: query.region, ok: true, count: kept, error: null });
  }
  const items = [...byUrl.values()].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  for (const it of items) it.source = sourceFor(it);
  return { provider: PROVIDER, items, feeds: report, retrieved_at: now.toISOString() };
}

export function sourceFor(item) {
  return makeSource({
    provider: item.provider || PROVIDER,
    kind: 'news',
    instrument: item.title,
    identifier: item.provider_url ? item.provider_url.replace(/^https?:\/\/(www\.)?/, '') : 'bing.com/news',
    requested_range: item.published ? item.published.slice(0, 10) : null,
    last_observation: item.published ? item.published.slice(0, 10) : null,
    reference: item.url,
    notes: `manchete do feed RSS público do Bing News (busca: ${item.feeds.join(', ')}); só o título foi usado, o link abre o artigo no site do veículo`,
  });
}

function normaliseUrl(u) {
  try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); }
  catch { return String(u).trim().toLowerCase(); }
}
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
