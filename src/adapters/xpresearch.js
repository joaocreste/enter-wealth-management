/**
 * XP Research — the house's own monthly macro report.
 *
 * Every other adapter in this directory answers "what is the market doing".
 * This one answers "what does XP think about it", and it is the only source in
 * the system that carries a *view* rather than an observation. An advisor at XP
 * who tells a client something the house has just published the opposite of has
 * a problem no amount of live data fixes, so the macro agent reads this first
 * and every other macro input is read against it.
 *
 * Where it comes from: conteudos.xpi.com.br/economia/ shows the report behind a
 * "Relatório Mensal" tab that the page fills in with JavaScript, so there is
 * nothing to parse at that URL. The same tab's permanent home is the Brasil
 * Macro Mensal archive, which is server-rendered, lists every edition newest
 * first, and is what the tab links to. This adapter reads the archive, takes
 * the newest edition, and then reads that edition's own page.
 *
 * What it takes from the edition:
 *
 *   · the summary bullets — XP's seven or eight conclusions for the month,
 *     verbatim, which is the report in miniature and the part the model is
 *     given to reason with;
 *   · the section theses — each heading is written "Inflação – Reduzimos a
 *     projeção para o IPCA de 2026", a topic and a claim separated by an en
 *     dash, so the headings alone are a stance per topic;
 *   · the editorial, verbatim;
 *   · the figures, and only where a sentence matches one of a few unambiguous
 *     patterns. Every figure keeps the sentence it was read from. A month XP
 *     phrases differently yields no figure rather than a wrong one — the
 *     sentence is still there, and the sentence is what the model quotes.
 *
 * Nothing behind the client login is fetched; the summary, the headings and the
 * editorial are in the public HTML. The two PDF links are recorded so the
 * advisor can open the full report, never downloaded.
 */
import { getText } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';

export const PROVIDER = 'XP Research — Brasil Macro Mensal';
export const INDEX_URL = 'https://conteudos.xpi.com.br/economia/';
export const ARCHIVE_URL = 'https://conteudos.xpi.com.br/brasil-macro-mensal/';
export const FEED_URL = 'https://conteudos.xpi.com.br/economia/feed/';
/** The edition is the one whose title starts here. "Economia em Destaque" links to the report and is not it. */
const TITLE_PREFIX = /^\s*Brasil Macro Mensal\b/i;

/** Past this the newest edition on the archive is stale, and the reader is told so rather than shown it as current. */
const STALE_AFTER_DAYS = 75;
const LISTING_TTL = 6 * 3600;
const REPORT_TTL = 24 * 3600;

/** The routes that actually reach XP. What a deposit job is allowed to read. */
export const LIVE_ROUTES = ['feed', 'archive'];

/** The key a Node job writes the edition to, for runtimes XP will not serve. */
export const DEPOSIT_KEY = 'xp:mensal:deposited';
/** A deposited edition answers for this long. Longer than the monthly cadence, so a job that misses a day changes nothing. */
const DEPOSIT_TTL = 45 * 24 * 3600;

/**
 * Three routes to the same edition, tried in order.
 *
 * The Economia feed is XP's own syndication of the section and carries the
 * whole report inside content:encoded — one call for the summary, the
 * headings, the editorial and the PDF links, which is both cheaper and more
 * faithful than reading the page. It holds only the last ten Economia posts,
 * though, and the report is monthly, so late in the month it has scrolled off.
 * The archive of every edition is what answers then, at the cost of a second
 * call for the edition's own page.
 *
 * The third route is not a route to XP at all. conteudos.xpi.com.br sits
 * behind a WAF that refuses the Cloudflare Workers runtime on every path —
 * below the headers, so nothing the Worker can put in a request gets through,
 * while the same request from Node is served normally. A Node job therefore
 * fetches the edition and deposits it (`scripts/fetch-xp-report.mjs`), and the
 * Worker reads what was deposited. It is tried *first*, because a runtime that
 * has a deposited edition should not spend two doomed calls a run finding out
 * it is still blocked; a live route that does answer overwrites the deposit on
 * its way past, so a runtime XP does serve is never held back by it.
 */
const ROUTES = [
  { key: 'deposited', label: 'edição depositada por um processo Node', url: null, load: fromDeposit, empty: 'nenhuma edição depositada' },
  { key: 'feed', label: 'feed do Economia (RSS)', url: FEED_URL, load: fromFeed, empty: 'o feed não trouxe nenhuma edição do Brasil Macro Mensal' },
  { key: 'archive', label: 'arquivo do Brasil Macro Mensal', url: ARCHIVE_URL, load: fromArchive, empty: 'o arquivo não trouxe nenhuma edição' },
];

/**
 * The newest edition, parsed. Never throws: a macro agent that cannot reach XP
 * still has to finish its run, so the failure comes back as a record naming
 * every route that was tried and why each one did not answer.
 *
 * `routes` narrows the chain. The job that deposits an edition passes the live
 * routes only: a fetcher that accepted route 0 would read back what it last
 * deposited and deposit it again, and the house view would circle unchanged
 * long after XP had published a new one.
 *
 * @returns {Promise<object>} the house view, or `{ unavailable: true, reason, attempts }`
 */
export async function monthlyReport({ now = new Date(), maxAgeDays = STALE_AFTER_DAYS, routes = null } = {}) {
  const attempts = [];
  const chain = routes ? ROUTES.filter((r) => routes.includes(r.key)) : ROUTES;
  if (!chain.length) throw new Error(`no such route: ${routes.join(', ')}`);
  for (const route of chain) {
    try {
      const found = await route.load();
      if (!found) { attempts.push({ route: route.key, ok: false, reason: route.empty }); continue; }
      attempts.push({ route: route.key, ok: true, reason: null });
      const ageDays = found.published ? Math.floor((now.getTime() - Date.parse(`${found.published}T00:00:00Z`)) / 86400000) : null;
      const report = {
        ...found.edition,
        unavailable: false,
        provider: PROVIDER,
        route: route.key,
        route_label: route.label,
        route_url: route.url,
        deposited_at: found.deposited_at || null,
        index_url: INDEX_URL,
        archive_url: ARCHIVE_URL,
        age_days: ageDays,
        stale: ageDays != null && ageDays > maxAgeDays,
        retrieved_at: now.toISOString(),
        attempts,
        previous: found.previous || [],
      };
      report.source = sourceFor(report);
      return report;
    } catch (err) {
      attempts.push({ route: route.key, ok: false, reason: err.message });
    }
  }
  return unavailableReport(attempts.map((a) => `${a.route}: ${a.reason}`).join('; '), ARCHIVE_URL, null, attempts);
}

export function sourceFor(report) {
  return makeSource({
    provider: PROVIDER,
    kind: 'macro',
    instrument: report.title,
    identifier: String(report.url || ARCHIVE_URL).replace(/^https?:\/\/(www\.)?/, ''),
    requested_range: report.published || null,
    last_observation: report.published || null,
    reference: report.url || ARCHIVE_URL,
    notes: [
      'relatório macro mensal publicado pela própria XP',
      report.authors?.length ? `por ${report.authors.map((a) => a.name).join(', ')}` : null,
      report.published_label ? `edição de ${report.published_label}` : null,
      report.route_label ? `via ${report.route_label}` : null,
      report.deposited_at ? `depositado em ${report.deposited_at.slice(0, 16).replace('T', ' ')}Z` : null,
      report.stale ? `publicado há ${report.age_days} dias — nenhuma edição mais recente estava disponível` : null,
    ].filter(Boolean).join('; '),
  });
}

function unavailableReport(reason, url, latest = null, attempts = []) {
  return {
    unavailable: true, reason, attempts, provider: PROVIDER, index_url: INDEX_URL, archive_url: ARCHIVE_URL, url,
    title: latest?.title ?? null, published: latest?.published ?? null, published_label: latest?.published_label ?? null,
    summary: [], sections: [], editorial: [], figures: [], projection_sentences: [], authors: latest?.authors ?? [], pdf: {}, source: null,
  };
}

// ── route 0: an edition deposited by a runtime XP serves ─────────────────────

async function fromDeposit() {
  const held = await cacheGet(DEPOSIT_KEY, DEPOSIT_TTL);
  if (!held?.edition?.published) return null;
  return { published: held.edition.published, edition: held.edition, previous: held.previous || [], deposited_at: held.deposited_at || null };
}

/**
 * Hand an edition to the runtimes that cannot fetch it. Called by the Node job
 * through the Worker; the payload is the parsed edition, so the Worker stores
 * exactly what it would have parsed itself.
 */
export async function deposit(report, { at = new Date().toISOString() } = {}) {
  if (!report || report.unavailable || !report.published) throw new Error('refusing to deposit an edition that was never retrieved');
  const { source, attempts, ...edition } = report;
  await cacheSet(DEPOSIT_KEY, { edition, previous: report.previous || [], deposited_at: at }, DEPOSIT_TTL);
  return { published: report.published, title: report.title, deposited_at: at };
}

// ── route 1: the Economia feed ───────────────────────────────────────────────

async function fromFeed() {
  const xml = await cached('xp:feed', LISTING_TTL, () => getText(FEED_URL, { retries: 1, timeout: 20000 }));
  const editions = parseFeed(xml);
  if (!editions.length) return null;
  const [latest] = editions;
  return {
    published: latest.published,
    edition: parseEdition(latest.content, latest),
    previous: editions.slice(1, 4).map(compactEdition),
  };
}

/**
 * The feed items that are editions of the report, newest first. The report
 * carries no category of its own, so it is recognised by its title; the
 * weekly "Economia em Destaque" links to it every month and must not be
 * mistaken for it.
 */
export function parseFeed(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = textOf(tagOf(block, 'title'));
    if (!title || !TITLE_PREFIX.test(title)) continue;
    const published = isoFromRfc822(textOf(tagOf(block, 'pubDate')));
    out.push({
      url: (textOf(tagOf(block, 'link')) || '').split('?')[0],
      title,
      published,
      published_label: ptLabel(published),
      authors: [...block.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((a) => ({ name: textOf(a[1]), role: null })).filter((a) => a.name),
      content: cdata(tagOf(block, 'content:encoded')) || '',
    });
  }
  return out.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
}

// ── route 2: the archive of every edition ────────────────────────────────────

async function fromArchive() {
  const { editions } = await archive();
  const [latest] = editions;
  if (!latest) return null;
  const edition = await cached(`xp:mensal:${latest.url}`, REPORT_TTL, async () => {
    await throttle('xpi', 400);
    return parseEdition(await getText(latest.url, { retries: 1, timeout: 20000 }), latest);
  });
  return { published: latest.published, edition, previous: editions.slice(1, 4).map(compactEdition) };
}

/** The archive cards, parsed. Cached, because the page changes once a month. */
export async function archive() {
  const listing = await cached('xp:mensal:archive', LISTING_TTL, async () => {
    await throttle('xpi', 400);
    return { url: ARCHIVE_URL, editions: parseArchive(await getText(ARCHIVE_URL, { retries: 1, timeout: 20000 })) };
  });
  return listing;
}

/**
 * Each edition is one `a.bloco-materia` card carrying the URL, the title, a
 * "3 Set 2026 • 33 mins de leitura" line and the authors. The cards are in
 * publication order; they are sorted here anyway, because an archive that
 * one day pins an edition to the top must not silently become the source of
 * a six-month-old view.
 */
export function parseArchive(html) {
  const out = [];
  const re = /<a\s+class="bloco-materia[^"]*"\s+href="([^"]+)"[^>]*?title="([^"]*)"([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [url, title, body] = [m[1], decode(m[2]), m[3]];
    if (!/\/economia\/brasil-macro-mensal/i.test(url)) continue;
    const label = textOf(block(body, 'div', 'data'))?.split('•')[0].trim() || null;
    out.push({
      url: url.split('?')[0],
      title,
      published: ptDate(label),
      published_label: label,
      authors: authorsIn(body),
    });
  }
  return out.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
}

const compactEdition = (e) => ({ title: e.title, url: e.url, published: e.published, published_label: e.published_label });

/** Read through the cache, write on a miss. A cache that fails is a slow run, never a failed one. */
async function cached(key, ttl, load) {
  const hit = await cacheGet(key, ttl);
  if (hit) return hit;
  const value = await load();
  await cacheSet(key, value, ttl);
  return value;
}

// ── one edition ──────────────────────────────────────────────────────────────

export function parseEdition(html, meta = {}) {
  const article = strip(match(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i) || html);
  const summary = listItems(match(article, /<ul class="wp-block-list">([\s\S]*?)<\/ul>/i));
  const sections = sectionsIn(article);
  const editorial = sections.find((s) => /^editorial/i.test(s.topic))?.paragraphs || [];
  // Everything XP states as its own view: the month's conclusions, the stance
  // in each heading, the editorial, and the body of the sections that carry a
  // projection. The figures and the projection sentences are read from these
  // and from nothing else, so nothing is ever read out of a chart caption or a
  // navigation label.
  const claims = [...summary, ...sections.map((s) => s.thesis), ...sections.flatMap((s) => s.paragraphs)];
  const year = Number(String(meta.published || '').slice(0, 4)) || null;
  const pdf = {};
  for (const [href, label] of links(html)) {
    if (!/\.pdf(\?|$)/i.test(href)) continue;
    if (/\bEN\b|ingl/i.test(label)) pdf.en ||= href;
    else pdf.pt ||= href;
  }
  return {
    url: meta.url || null,
    title: meta.title || textOf(match(html, /<title>([\s\S]*?)<\/title>/i))?.replace(/\s*[-–]\s*XP Investimentos\s*$/i, '') || null,
    published: meta.published || null,
    published_label: meta.published_label || null,
    modified: match(html, /property="article:modified_time"\s+content="([^"]+)"/i) || null,
    authors: meta.authors?.length ? meta.authors : authorsIn(html),
    summary,
    sections: sections.map((s) => ({ topic: s.topic, thesis: s.thesis, paragraphs: s.paragraphs.slice(0, 4) })),
    editorial: editorial.slice(0, 6),
    figures: figuresIn(claims, year),
    projection_sentences: projectionSentences(claims),
    pdf,
  };
}

/**
 * The headings are written "Inflação – Reduzimos a projeção para o IPCA de
 * 2026 de 5,1% para 5,0%": a topic, an en dash, and the month's claim about
 * it. Splitting there gives a stance per topic without asking anyone to
 * summarise anything.
 */
function sectionsIn(article) {
  const out = [];
  const re = /<(h[23])\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*?)(?=<h[23]\b|$)/gi;
  let m;
  while ((m = re.exec(article))) {
    const heading = textOf(m[2]);
    if (!heading) continue;
    const [, topic, thesis] = heading.match(/^(.{2,40}?)\s+[–—-]\s+(.+)$/) || [null, heading, heading];
    out.push({
      heading, topic: topic.trim(), thesis: thesis.trim(),
      paragraphs: paragraphs(m[3]),
    });
  }
  return out;
}

// ── figures ──────────────────────────────────────────────────────────────────

/**
 * XP's projections, read out of XP's own sentences.
 *
 * Precision over recall, deliberately. Each indicator has an ordered list of
 * shapes the report has actually used, first match wins, and a sentence that
 * fits none of them yields no figure at all — it is still carried verbatim in
 * `projection_sentences`, and a sentence quoted as written is worth more to a
 * client letter than a number this parser guessed at.
 *
 * Three things the editions teach, each of which produced a wrong number
 * before it was handled:
 *
 *   · a revision reads "de 5,1% para 5,0%". The figure is the one after
 *     "para". Reading the first number reports the projection XP has just
 *     abandoned, which is worse than reporting nothing;
 *   · the year is as often a word as a number — "no final deste ano", "4,2%
 *     no ano que vem". Those resolve against the edition's own publication
 *     year, so they are exact, not inferred;
 *   · "0,3% do PIB" and "83,3% do PIB" are the denominator, not growth. Any
 *     figure followed by "do PIB" is refused for the growth series.
 *
 * `value` is a fraction, like every other rate in this system — 13,25%
 * arrives as 0.1325. `written` is XP's own formatting, for quoting.
 */
const YEAR = String.raw`(?<y>(?:de\s+|em\s+)?(?:19|20)\d{2}|(?:deste|neste|este)\s+ano|(?:d[oe]\s+|no\s+)?ano\s+que\s+vem|(?:d[oe]\s+|no\s+)?pr[oó]ximo\s+ano)`;
const PCT = String.raw`(?<v>\d{1,3},\d{1,2})\s*%`;
const REVISED = String.raw`de\s+\d{1,3},\d{1,2}\s*%\s*(?:\)|,)?\s*para\s+${PCT}`;
const LEVEL = String.raw`(?<v>\d{1,2},\d{2})`;
const rx = (body) => new RegExp(body, 'i');

const INDICATORS = [
  {
    key: 'ipca',
    label: 'IPCA',
    unit: 'rate',
    shapes: [
      rx(String.raw`\bIPCA\b[^.;]{0,30}?(?:em|de|para)\s+${YEAR}[^.;]{0,45}?${REVISED}`),
      rx(String.raw`\bIPCA\b[^.;]{0,30}?(?:em|de)\s+${PCT}\s+(?:em|no\s+final\s+de|para)\s+${YEAR}`),
      rx(String.raw`\bIPCA\b[^.;]{0,45}?(?:em|de)\s+${PCT}\s+${YEAR}`),
    ],
    tail: rx(String.raw`\be\s+${PCT}\s+${YEAR}`),
  },
  {
    key: 'gdp',
    label: 'PIB',
    unit: 'rate',
    // Growth only. A share of output ("0,3% do PIB") is refused below.
    shapes: [
      rx(String.raw`\bPIB\b[^.;]{0,30}?(?:em|de|para)\s+${YEAR}[^.;]{0,45}?${REVISED}`),
      rx(String.raw`(?:alta|crescimento|aumento|avanço|expansão)\s+de\s+${PCT}[^.;]{0,30}?\bPIB\b[^.;]{0,15}?(?:em|de)\s+${YEAR}`),
      rx(String.raw`${PCT}\s+de\s+(?:alta|crescimento|aumento|avanço|expansão)[^.;]{0,20}?\bPIB\b[^.;]{0,15}?(?:em|de)\s+${YEAR}`),
      rx(String.raw`\bPIB\b[^.;]{0,20}?(?:em|de)\s+${YEAR}[^.;]{0,40}?(?:alta|crescimento|aumento|avanço|expansão)\s+de\s+${PCT}`),
    ],
  },
  {
    key: 'selic',
    label: 'Selic',
    unit: 'rate',
    shapes: [
      rx(String.raw`\bSelic\b[^.;]{0,40}?${PCT}[^.;]{0,25}?(?:n|a)o\s+final\s+${YEAR}`),
      rx(String.raw`${PCT}\s+para\s+a\s+(?:taxa\s+)?Selic[^.;]{0,25}?(?:n|a)o\s+final\s+${YEAR}`),
      rx(String.raw`\bSelic\b[^.;]{0,40}?(?:em|de)\s+${PCT}[^.;]{0,20}?(?:em|no\s+final\s+de)\s+${YEAR}`),
    ],
    tail: rx(String.raw`\be\s+${PCT}\s+(?:em|no\s+final\s+${'de'}?\s*)?${YEAR}`),
  },
  {
    key: 'fx',
    label: 'Câmbio',
    unit: 'brl_per_usd',
    shapes: [
      rx(String.raw`${LEVEL}\s+reais\s+por\s+d[oó]lar[^.;]{0,30}?(?:n|a)o\s+final\s+${YEAR}`),
      rx(String.raw`(?:câmbio|paridade|d[oó]lar)[^.;]{0,30}?(?:em|de|para)\s+${LEVEL}[^.;]{0,30}?(?:n|a)o\s+final\s+${YEAR}`),
    ],
    tail: rx(String.raw`\be\s+${LEVEL}\s+(?:n|a)o\s+final\s+${YEAR}`),
  },
];

/**
 * @param {string[]} texts     the report's own sentences, as written
 * @param {number}   pubYear   the edition's publication year, for "deste ano"
 */
export function figuresIn(texts, pubYear = null) {
  const out = [];
  const seen = new Set();
  const keep = (ind, rawYear, raw, sentence) => {
    const year = resolveYear(rawYear, pubYear);
    const key = `${ind.key}_${year}`;
    if (!year || seen.has(key)) return;
    // "0,3% do PIB" is a share of output, never growth.
    if (ind.key === 'gdp' && new RegExp(`${raw.replace(',', '[,]')}\\s*%?\\s*do\\s+PIB`, 'i').test(sentence)) return;
    seen.add(key);
    out.push({
      key: ind.key, label: ind.label, year, unit: ind.unit,
      value: numberOf(raw, ind.unit), written: `${raw}${ind.unit === 'rate' ? '%' : ''}`,
      quote: sentence.trim(),
    });
  };
  for (const text of texts.filter(Boolean)) {
    let named = null;                       // the indicator this bullet has already put a name to
    for (const sentence of sentences(text)) {
      let matched = false;
      for (const ind of INDICATORS) {
        const shape = ind.shapes.find((re) => re.test(sentence));
        const m = shape && sentence.match(shape);
        if (!m) continue;
        matched = true;
        named = ind;
        keep(ind, m.groups.y, m.groups.v, sentence);
        const rest = ind.tail ? sentence.slice(m.index + m[0].length).match(ind.tail) : null;
        if (rest) keep(ind, rest.groups.y, rest.groups.v, sentence);
      }
      if (matched || named?.unit !== 'rate') continue;
      const c = CONTINUATION.reduce((hit, re) => hit || sentence.match(re), null);
      if (c) keep(named, c.groups.y, c.groups.v, sentence);
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.year - b.year);
}

/**
 * The year after, stated without naming the indicator again: XP writes the
 * current year in full and then "Para 2027, mantivemos nossa projeção em
 * 4,2%". Only followed inside the bullet that has already named an indicator,
 * so a rate can never be attached to whatever the previous bullet was about,
 * and revision-first for the same reason the shapes are.
 */
const CONTINUATION = [
  rx(String.raw`\bpara\s+${YEAR}\b[^.;]{0,90}?${REVISED}`),
  rx(String.raw`\bpara\s+${YEAR}\b[^.;]{0,90}?${PCT}`),
];

/** "de 2026" → 2026; "deste ano" → the edition's year; "no ano que vem" → the year after it. */
function resolveYear(token, pubYear) {
  const t = String(token || '').trim().toLowerCase();
  const literal = t.match(/(19|20)\d{2}/);
  if (literal) return Number(literal[0]);
  if (!pubYear) return null;
  if (/ano que vem|pr[oó]ximo ano/.test(t)) return pubYear + 1;
  if (/(deste|neste|este)\s+ano/.test(t)) return pubYear;
  return null;
}

/** Every sentence that states a projection, verbatim — the safety net under the figures. */
const PROJECTION_VERB = /\bproje(?:ta|tamos|ção|ções|tando)|\bestimamos\b|\besperamos\b|\bexpectativa\b|\bmantivemos\b|\bmantemos\b|\breduzimos\b|\belevamos\b|\baumentamos\b|\bvemos\b/i;
export function projectionSentences(texts) {
  const out = [];
  const seen = new Set();
  for (const text of texts.filter(Boolean)) {
    for (const s of sentences(text)) {
      const t = s.trim();
      if (t.length < 40 || !PROJECTION_VERB.test(t) || !/\d,\d/.test(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** A full stop inside "5,00" or "R$ 1.234" does not end a sentence; a semicolon does. */
const sentences = (text) => String(text).split(/(?<=[.;])\s+/).filter(Boolean);

const numberOf = (raw, unit) => {
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return unit === 'rate' ? n / 100 : n;
};

// ── HTML, plainly ────────────────────────────────────────────────────────────

const strip = (h) => String(h).replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
const match = (h, re) => { const m = String(h).match(re); return m ? m[1] : null; };

function block(html, tag, className) {
  const m = String(html).match(new RegExp(`<${tag}\\s+class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

function textOf(html) {
  if (html == null) return null;
  const bare = String(html).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(bare.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null;
}

function listItems(html) {
  if (!html) return [];
  return [...String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => textOf(m[1])?.replace(/[;\s]+$/, ''))
    .filter((t) => t && t.length > 30);
}

function paragraphs(html) {
  return [...String(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => textOf(m[1]))
    .filter((t) => t && t.length > 60);
}

function links(html) {
  return [...String(html).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => [m[1], textOf(m[2]) || '']);
}

/** The card and the byline both put the name in an h4 and the role in the p under it. */
function authorsIn(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<h4\b[^>]*>([\s\S]*?)<\/h4>\s*(?:<p\b[^>]*>([\s\S]*?)<\/p>)?/gi)) {
    const name = textOf(m[1]);
    if (!name || name.length > 60 || seen.has(name)) continue;
    seen.add(name);
    const role = textOf(m[2]);
    out.push({ name, role: role && role !== '-' ? role : null });
  }
  return out.slice(0, 8);
}

function tagOf(block, name) {
  const m = String(block).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : null;
}
const cdata = (s) => (s == null ? null : String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());

/** "Thu, 03 Sep 2026 19:39:25 +0000" → "2026-09-03". */
export function isoFromRfc822(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
/** "2026-09-03" → "3 Set 2026", the way the archive cards write it. */
export function ptLabel(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  return MONTH_LABELS[m - 1] ? `${d} ${MONTH_LABELS[m - 1]} ${y}` : null;
}

const MONTHS = { jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06', jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12' };
/** "3 Set 2026" → "2026-09-03". */
export function ptDate(label) {
  const m = String(label || '').match(/(\d{1,2})\s+([A-Za-zÇç]{3})[a-zç]*\.?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
  return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…' };
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/**
 * What the macro agent hands the model and the portal shows: the edition named
 * and dated, its conclusions, its stance per topic, and its figures with the
 * sentence each was read from. Compact on purpose — the FACTS object carries
 * this next to a day of indicators and headlines.
 */
export function houseView(report) {
  if (!report || report.unavailable) {
    return { available: false, provider: PROVIDER, reason: report?.reason || 'não consultado', where: INDEX_URL };
  }
  return {
    available: true,
    provider: PROVIDER,
    title: report.title,
    published: report.published,
    published_label: report.published_label,
    age_days: report.age_days,
    stale: !!report.stale,
    url: report.url,
    route: report.route,
    route_label: report.route_label,
    deposited_at: report.deposited_at || null,
    authors: (report.authors || []).map((a) => a.name),
    conclusions: report.summary,
    // The report's own order, minus the two headings that are structure rather
    // than stance: the editorial, which is carried whole in its own field, and
    // the divider before the Brazil sections, which has no text of its own and
    // repeats the title. What is left is one claim per economic topic.
    stance_by_topic: (report.sections || [])
      .filter((s) => s.topic && s.thesis && s.topic !== s.thesis)
      .filter((s) => !/^editorial/i.test(s.topic) && s.paragraphs?.length)
      .map((s) => ({ topic: s.topic, thesis: s.thesis }))
      .slice(0, 8),
    editorial: (report.editorial || []).slice(0, 3),
    projections: (report.figures || []).map((f) => ({ indicator: f.label, year: f.year, unit: f.unit, written: f.written, quote: f.quote })),
    projection_sentences: (report.projection_sentences || []).slice(0, 12),
    pdf: report.pdf || {},
    source_id: report.source?.id ?? null,
  };
}
