/**
 * Valor Econômico — headlines from the newspaper's public RSS feeds.
 *
 * Why a feed and not a web search: the search asks a model to guess what
 * happened; the feed says what the newsroom actually published, in order, with
 * a permanent URL for every line. The headline, its subtitle and its first
 * paragraph are all the feed carries and all this adapter uses. Nothing behind
 * the paywall is fetched.
 *
 * What comes back is deliberately dumb: a list of headlines and, from them,
 * clusters of headlines that share the same people and institutions. The size
 * of a cluster is the "most published" signal the pipeline never had — six
 * headlines in one afternoon about the same court decision is a fact, not a
 * judgement. Every headline carries a source record naming Valor Econômico and
 * the article URL, so the portal can always say where a line came from.
 */
import { getText } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';

export const PROVIDER = 'Valor Econômico';
const BASE = 'https://valor.globo.com/rss/valor/';

/** The sections a Brazilian wealth book actually needs. Each is one HTTP call. */
export const FEEDS = [
  { key: 'geral', url: BASE, label: 'Capa' },
  { key: 'politica', url: `${BASE}politica/`, label: 'Política' },
  { key: 'financas', url: `${BASE}financas/`, label: 'Finanças' },
  { key: 'brasil', url: `${BASE}brasil/`, label: 'Brasil' },
  { key: 'empresas', url: `${BASE}empresas/`, label: 'Empresas' },
  { key: 'mundo', url: `${BASE}mundo/`, label: 'Mundo' },
];

/** Paths the feeds carry that are not news: sponsored content and the annual rankings. */
const NOT_NEWS = [/\/patrocinado\//, /\/dino\//, /\/conteudo-de-marca\//];
const NOT_NEWS_TITLE = /^(Valor 1000|Valor Inova|Valor Carreira|Anuário|Especial Publicitário)\b/i;

/**
 * Fetch every feed, merge, deduplicate by URL, keep the last `windowHours`.
 * A feed that fails is reported, not thrown: the others still count.
 */
export async function headlines({ windowHours = 36, now = new Date(), feeds = FEEDS } = {}) {
  const since = now.getTime() - windowHours * 3600 * 1000;
  const byUrl = new Map();
  const report = [];
  for (const feed of feeds) {
    const cacheKey = `valor:rss:${feed.key}`;
    let xml = await cacheGet(cacheKey, 1800);
    try {
      if (!xml) {
        await throttle('valor', 250);
        xml = await getText(feed.url, { retries: 1, timeout: 10000 });
        await cacheSet(cacheKey, xml, 1800);
      }
    } catch (err) {
      report.push({ key: feed.key, label: feed.label, ok: false, count: 0, error: err.message });
      continue;
    }
    const items = parseRss(xml);
    let kept = 0;
    for (const it of items) {
      if (!it.link || !it.title) continue;
      if (NOT_NEWS.some((re) => re.test(it.link)) || NOT_NEWS_TITLE.test(it.title)) continue;
      if (it.publishedAt && it.publishedAt.getTime() < since) continue;
      kept += 1;
      const key = normaliseUrl(it.link);
      const existing = byUrl.get(key);
      if (existing) { existing.feeds.push(feed.key); continue; }
      byUrl.set(key, {
        id: `vlr_${hash(key)}`,
        title: it.title,
        subtitle: it.subtitle || null,
        lead: it.lead || null,
        url: it.link,
        section: sectionOf(it.link),
        published: it.publishedAt ? it.publishedAt.toISOString() : null,
        feeds: [feed.key],
      });
    }
    report.push({ key: feed.key, label: feed.label, ok: true, count: kept, error: null });
  }
  const items = [...byUrl.values()].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  for (const it of items) it.source = sourceFor(it);
  return { provider: PROVIDER, items, feeds: report, retrieved_at: now.toISOString() };
}

export function sourceFor(item) {
  return makeSource({
    provider: PROVIDER,
    kind: 'news',
    instrument: item.title,
    identifier: item.url.replace(/^https?:\/\/(www\.)?/, ''),
    requested_range: item.published ? item.published.slice(0, 10) : null,
    last_observation: item.published ? item.published.slice(0, 10) : null,
    reference: item.url,
    notes: `manchete do feed RSS público do Valor Econômico (seção ${item.section || 'capa'}); só título, subtítulo e primeiro parágrafo foram usados`,
  });
}

// ── clustering: which story is everyone writing about ───────────────────────

/**
 * Group headlines that name the same people and institutions.
 *
 * Not union-find: a chain of pairwise links turns "Lula", "STF" and "EUA" into
 * one cluster holding half the day. Instead each headline joins the cluster
 * whose *core* — the entities most of its members share — it overlaps with,
 * weighted by how rare each entity is across the day. A name every third
 * headline carries (Lula, Trump) counts for little; a name three headlines
 * carry (Andrei Rodrigues) is the story.
 */
export function clusterHeadlines(items) {
  const corpus = corpusStats(items);
  const feats = items.map((it) => features(`${it.title} ${it.subtitle || ''}`, corpus));
  const n = Math.max(1, items.length);
  const idf = (e) => Math.log((n + 1) / ((corpus.df.get(e) || 0) + 1));
  // A name in more than one headline in twenty is furniture (Lula, STF, EUA); it can confirm a match, never make one.
  const commonAbove = Math.max(3, Math.ceil(n * 0.05));
  const rare = (e) => (corpus.df.get(e) || 0) <= commonAbove;
  const order = items.map((_, i) => i).sort((a, b) => (items[a].published || '').localeCompare(items[b].published || ''));
  const clusters = [];
  for (const i of order) {
    let best = null; let bestScore = 0;
    for (const c of clusters) {
      const core = coreOf(c);
      const shared = feats[i].entities.filter((e) => core.has(e));
      const words = feats[i].words.filter((w) => c.words.get(w) >= Math.max(1, Math.ceil(c.idx.length / 2)));
      const score = shared.reduce((a, e) => a + idf(e), 0) + 0.35 * words.length;
      const enough = (shared.length >= 2 && shared.some(rare)) || (shared.length === 1 && rare(shared[0]) && words.length >= 2);
      if (enough && score > bestScore) { best = c; bestScore = score; }
    }
    if (!best) { best = { idx: [], entities: new Map(), words: new Map() }; clusters.push(best); }
    best.idx.push(i);
    for (const e of feats[i].entities) best.entities.set(e, (best.entities.get(e) || 0) + 1);
    for (const w of feats[i].words) best.words.set(w, (best.words.get(w) || 0) + 1);
  }
  // Second pass: two clusters about the same story split when the first lines
  // named different people. Merge clusters whose cores share two entities, one
  // of them rare. Cores are majority-shared, so this cannot chain the day together.
  for (let a = 0; a < clusters.length; a += 1) {
    for (let b = clusters.length - 1; b > a; b -= 1) {
      const coreA = coreOf(clusters[a]); const coreB = coreOf(clusters[b]);
      const shared = [...coreA].filter((e) => coreB.has(e));
      if (shared.length >= 2 && shared.some((e) => idf(e) >= 2)) {
        const from = clusters.splice(b, 1)[0];
        clusters[a].idx.push(...from.idx);
        for (const [e, k] of from.entities) clusters[a].entities.set(e, (clusters[a].entities.get(e) || 0) + k);
        for (const [w, k] of from.words) clusters[a].words.set(w, (clusters[a].words.get(w) || 0) + k);
      }
    }
  }
  return clusters.map((c) => {
    const members = c.idx.map((i) => items[i]).sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    const core = coreOf(c);
    const entities = [...c.entities.entries()].sort((a, b) => b[1] - a[1] || idf(b[0]) - idf(a[0])).map(([e]) => e).slice(0, 6);
    // The lead line is the one that carries the whole core — every name the
    // cluster is about — and, among those, the earliest: the headline that
    // broke the story, not the fifth reaction to it.
    let lead = members[0]; let top = -1;
    const coreSize = Math.max(1, core.size);
    for (const m of [...members].reverse()) {
      const i = items.indexOf(m);
      const inCore = feats[i].entities.filter((e) => core.has(e));
      const score = (inCore.length / coreSize) + 0.01 * inCore.reduce((a, e) => a + idf(e), 0);
      if (score > top) { top = score; lead = m; }
    }
    return {
      id: `cl_${hash(members.map((m) => m.id).sort().join('|'))}`,
      size: members.length, entities, lead, items: members,
      sections: [...new Set(members.map((m) => m.section).filter(Boolean))],
      latest: members[0].published,
    };
  }).sort((a, b) => b.size - a.size || (b.latest || '').localeCompare(a.latest || ''));
}

/** The entities at least half the members carry (all of them, for a cluster of one). */
function coreOf(c) {
  const need = Math.max(1, Math.ceil(c.idx.length / 2));
  return new Set([...c.entities.entries()].filter(([, k]) => k >= need).map(([e]) => e));
}

const STOP = new Set(('a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre entre até após ante contra desde e ou mas que se não sim é são foi era será ser está estão estar tem têm ter há ao aos à às pelo pela pelos pelas seu sua seus suas este esta estes estas esse essa isso isto aquele aquela mais menos muito pouco já ainda também só como quando onde porque diz disse dizem afirma afirmou segundo ontem hoje amanhã nesta neste nesse nessa antes depois durante deve devem pode podem vai vão ficar fica ficam tinha novo nova novos novas ano anos mês meses dia dias semana').split(' '));
/** Words that are capitalised for grammar or house style, not because they name anything. */
const NOT_ENTITY = new Set(['Análise', 'Opinião', 'Editorial', 'Entrevista', 'Exclusivo', 'Ao', 'Vivo', 'Valor', 'Brasil', 'Governo', 'Ministro', 'Ministra', 'Presidente', 'Senador', 'Deputado', 'Justiça', 'País', 'Estado']);

/**
 * Which capitalised words are names: a token counts when it appears
 * capitalised somewhere in the day other than at the start of a headline.
 * That lets "Fachin dá 72 horas" keep Fachin without letting every first
 * word of every headline through.
 */
function corpusStats(items) {
  const nonInitial = new Set();
  const df = new Map();
  for (const it of items) {
    const toks = tokens(`${it.title} ${it.subtitle || ''}`);
    toks.forEach((t, i) => { if (i > 0 && looksProper(t)) nonInitial.add(t); });
  }
  for (const it of items) {
    const f = features(`${it.title} ${it.subtitle || ''}`, { nonInitial, df: new Map() });
    for (const e of f.entities) df.set(e, (df.get(e) || 0) + 1);
  }
  return { nonInitial, df };
}

const tokens = (text) => text.replace(/[“”"'‘’«»()[\]{}:;,.!?…—–-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
const looksProper = (t) => (/^[A-ZÀ-Ý][a-zà-ÿ]{2,}$/.test(t) || /^[A-ZÀ-Ý]{2,6}$/.test(t)) && !NOT_ENTITY.has(t);

function features(text, corpus) {
  const toks = tokens(text);
  const entities = new Set();
  const words = new Set();
  let run = [];
  const flush = () => { if (run.length >= 2) entities.add(run.join(' ')); run = []; };
  toks.forEach((tok, i) => {
    const lower = tok.toLowerCase();
    if (STOP.has(lower)) { flush(); return; }
    const proper = looksProper(tok) && (i > 0 || corpus.nonInitial.has(tok));
    if (proper) { entities.add(tok); run.push(tok); return; }
    flush();
    if (lower.length >= 4) words.add(strip(lower));
  });
  flush();
  return { entities: [...entities], words: [...words] };
}
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── RSS parsing without a DOM: the Worker has none, and the feed is regular ──

export function parseRss(xml) {
  const out = [];
  const re = /<item\b[\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const title = text(tag(block, 'title'));
    const link = text(tag(block, 'link')) || text(tag(block, 'guid'));
    const subtitle = text(tag(block, 'atom:subtitle'));
    const description = tag(block, 'description');
    const pub = text(tag(block, 'pubDate'));
    const publishedAt = pub ? new Date(pub) : null;
    out.push({
      title, link, subtitle,
      lead: description ? firstParagraph(description) : null,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    });
  }
  return out;
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}
function text(s) {
  if (s == null) return null;
  const cdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(cdata.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null;
}
/** The description opens with an image tag; the first sentence-bearing text after it is the lead. */
function firstParagraph(description) {
  const t = text(description);
  if (!t) return null;
  return t.length > 320 ? `${t.slice(0, 317).replace(/\s+\S*$/, '')}…` : t;
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function sectionOf(url) {
  const m = url.match(/valor\.globo\.com\/([a-z-]+)\//i);
  return m ? m[1] : null;
}
function normaliseUrl(u) {
  try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); }
  catch { return String(u).trim().toLowerCase(); }
}
/** FNV-1a, enough to make a stable short id from a URL. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
