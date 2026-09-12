/**
 * Google News — headlines from the public RSS search feeds.
 *
 * Google Finance has no feed or API of its own; the news it shows next to a
 * ticker is Google News filtered by the instrument. The RSS search endpoint is
 * the public face of that engine: a query, a locale, and `when:2d` to keep
 * only the last two days. Every item carries the publisher's name and site
 * (`<source>`), the time it was published, and a Google link that opens the
 * article. Nothing behind any paywall is fetched; only the headline is used.
 *
 * Why it sits next to Valor Econômico rather than replacing it: Valor's feed
 * carries the subtitle and first paragraph, which the classifier reads; the
 * Google feeds carry breadth — dozens of newsrooms on the same story, which is
 * the coverage signal that says what the market is actually reading today,
 * and the international side that a Brazilian newspaper's feed does not have.
 */
import { getText } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';
import { parseRss, isServicePiece } from './valor.js';

export const PROVIDER = 'Google News';
const BASE = 'https://news.google.com/rss/search';
const LOCALE = {
  br: 'hl=pt-BR&gl=BR&ceid=BR:pt-419',
  intl: 'hl=en-US&gl=US&ceid=US:en',
};

/** The questions a Brazilian wealth book asks every morning, one feed each. */
export const QUERIES = [
  { key: 'gn_bolsa', region: 'br', label: 'Bolsa', q: 'Ibovespa OR B3 OR "bolsa brasileira"' },
  { key: 'gn_cambio', region: 'br', label: 'Câmbio', q: 'dólar OR câmbio OR "real brasileiro"' },
  { key: 'gn_juros', region: 'br', label: 'Juros', q: 'Selic OR Copom OR "Banco Central"' },
  { key: 'gn_macro', region: 'br', label: 'Macro e fiscal', q: 'IPCA OR inflação OR PIB OR "arcabouço fiscal"' },
  { key: 'gn_fed', region: 'intl', label: 'Fed and Treasuries', q: 'Fed OR "Federal Reserve" OR "Treasury yields"' },
  { key: 'gn_equities', region: 'intl', label: 'US equities', q: '"S&P 500" OR Nasdaq OR "Wall Street"' },
  { key: 'gn_commodities', region: 'intl', label: 'Commodities and the dollar', q: '"oil prices" OR Brent OR OPEC OR "gold price" OR "dollar index"' },
  { key: 'gn_crypto', region: 'intl', label: 'Digital assets', q: 'bitcoin OR ether OR "crypto market"' },
  { key: 'gn_geo', region: 'intl', label: 'Geopolitics and trade', q: 'tariffs OR sanctions OR "trade war" OR "global markets"' },
];

/** How many of the newest lines each feed contributes; the clustering is quadratic. */
const PER_FEED = 40;

export function feedUrl(query, windowHours) {
  const days = Math.max(1, Math.ceil(windowHours / 24));
  return `${BASE}?q=${encodeURIComponent(`${query.q} when:${days}d`)}&${LOCALE[query.region] || LOCALE.br}`;
}

/**
 * Fetch every query feed, merge, deduplicate by URL, keep the last
 * `windowHours`. A feed that fails is reported, not thrown.
 *
 * Google answers requests from some networks (Cloudflare Workers among them)
 * with HTTP 503 "Sorry...". One such answer marks the engine as blocked for
 * six hours, so a run does not spend its outbound budget on eight more
 * refusals; the caller falls back to another engine.
 */
const BLOCKED_KEY = 'gnews:blocked';
const BLOCKED_FOR = 6 * 3600;
export const blocked = () => cacheGet(BLOCKED_KEY, BLOCKED_FOR);

export async function headlines({ windowHours = 48, now = new Date(), queries = QUERIES } = {}) {
  const since = now.getTime() - windowHours * 3600 * 1000;
  const byUrl = new Map();
  const report = [];
  const block = await blocked();
  if (block) {
    return { provider: PROVIDER, items: [], blocked: true, feeds: queries.map((q) => ({ key: q.key, label: q.label, region: q.region, ok: false, count: 0, error: `Google News bloqueou este servidor (HTTP ${block.status}) às ${block.at}; nova tentativa em até 6 horas` })), retrieved_at: now.toISOString() };
  }
  for (const query of queries) {
    const cacheKey = `gnews:rss:${query.key}`;
    let xml = await cacheGet(cacheKey, 1800);
    try {
      if (!xml) {
        await throttle('googlenews', 400);
        xml = await getText(feedUrl(query, windowHours), { retries: 0, timeout: 12000 });   // one call per feed: the Worker's outbound budget is small
        await cacheSet(cacheKey, xml, 1800);
      }
    } catch (err) {
      report.push({ key: query.key, label: query.label, region: query.region, ok: false, count: 0, error: err.message });
      if (err.status === 503 || err.status === 403 || err.status === 429) {
        await cacheSet(BLOCKED_KEY, { status: err.status, at: now.toISOString() }, BLOCKED_FOR);
        for (const q of queries.slice(queries.indexOf(query) + 1)) report.push({ key: q.key, label: q.label, region: q.region, ok: false, count: 0, error: `não tentado: Google News bloqueou este servidor (HTTP ${err.status})` });
        return { provider: PROVIDER, items: [], blocked: true, feeds: report, retrieved_at: now.toISOString() };
      }
      continue;
    }
    const items = parseRss(xml)
      .filter((it) => it.link && it.title && it.publishedAt && it.publishedAt.getTime() >= since)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, PER_FEED);
    let kept = 0;
    for (const it of items) {
      const { title, publisher } = splitTitle(it.title, it.source);
      if (isServicePiece(title)) continue;
      kept += 1;
      const key = normaliseUrl(it.link);
      const existing = byUrl.get(key);
      if (existing) { existing.feeds.push(query.key); continue; }
      byUrl.set(key, {
        id: `gn_${hash(key)}`,
        title,
        subtitle: null,
        lead: null,
        url: it.link,
        section: query.region === 'br' ? 'financas' : 'internacional',
        published: it.publishedAt.toISOString(),
        feeds: [query.key],
        provider: publisher || PROVIDER,
        provider_url: it.sourceUrl || null,
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

/** Google appends " - Publisher" to every title; the publisher is named again in <source>, so the suffix goes. */
export function splitTitle(title, source) {
  const t = String(title || '').trim();
  const m = t.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  if (!m) return { title: t, publisher: source || null };
  const publisher = source && m[2].trim().toLowerCase() === source.trim().toLowerCase() ? source : (source || m[2].trim());
  return { title: m[1].trim(), publisher };
}

export function sourceFor(item) {
  return makeSource({
    provider: item.provider || PROVIDER,
    kind: 'news',
    instrument: item.title,
    identifier: item.provider_url ? item.provider_url.replace(/^https?:\/\/(www\.)?/, '') : 'news.google.com',
    requested_range: item.published ? item.published.slice(0, 10) : null,
    last_observation: item.published ? item.published.slice(0, 10) : null,
    reference: item.url,
    notes: `manchete do feed RSS público do Google News (busca: ${item.feeds.join(', ')}); só o título foi usado, o link abre o artigo no site do veículo`,
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
