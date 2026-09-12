/**
 * The two-page Portuguese client letter, rendered programmatically.
 *
 * Layout: the Carta ao Investidor line of the XP Advisory brand system — a
 * 69 pt #242424 header bar with the tracked series title and the white symbol,
 * a 27 pt copper footer bar, a tracked byline, article titles in Roboto Bold
 * copper, Roboto Light body with generous leading, tables with a charcoal header
 * band and hairlines, and the disclaimer as white Light text on the bar colour
 * (§04, §05, §06, §08). A reference rail at the left carries the section
 * numbers and marginal source notes.
 *
 * The two-page limit is a hard constraint, not an aspiration. Blocks are
 * measured before they are drawn and, if the content would spill onto a third
 * page, optional blocks are dropped in a fixed priority order until it fits.
 * The letter never silently truncates a sentence mid-way.
 */
import { PdfDocument, A4 } from './writer.js';
import { svgPathToPdf } from './svgpath.js';
import { color, semantic, inkOn, LOGO_SYMBOL_PATH, LOGO_SYMBOL_ASPECT } from '../../core/brand.js';
import { money, percent, pp, weight as fmtWeight, dateLong, MINUS } from '../../core/format.js';

const INK = color.ink[950];
const INK2 = color.ink[600];
const INK3 = color.ink[400];
const RULE = color.rule;
const RULE2 = color.rule2;
const RULE3 = color.rule3;
const BAR = color.bar;
const COPPER = color.copper[500];
const COPPER2 = color.copper[400];
const SAGE = color.sage;
const CHARCOAL = color.charcoal;
const SLATE = color.slate[600];
const HEADER_TEXT = color.headerText;
const GAIN_T = semantic.light.gainText;
const LOSS_T = semantic.light.lossText;
const GAIN_G = semantic.light.gainGraphic;
const LOSS_G = semantic.light.lossGraphic;
const BENCH = semantic.light.benchmark;
const CAUTION = semantic.light.caution;

/** §05 the Carta's page: 30 pt side margins, a 69.3 pt bar above, a 26.7 pt bar below */
const PAGE = { left: 30.2, right: 29.8, headerH: 69.3, footerH: 26.7 };
const M = { left: PAGE.left, right: PAGE.right };
const RAIL = 54;
const X = M.left + RAIL;
const W = A4.width - X - M.right;
const FULL = A4.width - M.left - M.right;

const SZ = {
  // §04 asks for a generous leading; 1.6 is the most the two-page rule allows
  body: 10.2, bodyLead: 16.4,
  h2: 9.4, rail: 7.4, data: 8.6, small: 7.8,
  // the disclaimer is Roboto Light 9/16.2 on the Carta's dark page; 7.4/13.3 keeps the
  // proportion on a page that also has to hold the letter
  disclosure: 7.4,
};
const TRACK = 0.3; // em — the brand's tracked capitals

export async function renderLetterPdf(model, { fonts, maxPages = 2 } = {}) {
  let attempt = 0;
  let reductions = 0;
  let doc = null;

  while (attempt < 10) {
    doc = new PdfDocument({
      title: `Carta mensal — ${model.client?.name} — ${model.period.label}`,
      author: `${model.advisor?.name} · XP Asset Management`,
      subject: `Relatório mensal de investimentos — ${model.period.label}`,
      keywords: 'carta mensal, investimentos, XP Asset Management',
    });
    registerFonts(doc, fonts);
    const overflow = compose(doc, model, reductions, maxPages);
    doc.reductionLevel = reductions;
    if (!overflow && doc.pageCount <= maxPages) return doc;
    reductions += 1;
    attempt += 1;
  }
  return doc;
}

function registerFonts(doc, fonts) {
  doc.registerFont('light', fonts.sans300);
  doc.registerFont('sans', fonts.sans400);
  doc.registerFont('sans5', fonts.sans500);
  doc.registerFont('sans7', fonts.sans700);
}

/** Tracked capitals: draws `str` upper-cased with letter spacing and returns the advance. */
function tracked(doc, str, x, y, { font = 'light', size = 8, color: c = INK, track = TRACK } = {}) {
  const s = String(str || '').toUpperCase();
  const cs = size * track;
  return doc.text(s, x, y, { font, size, color: c, charSpacing: cs });
}

/**
 * Reduction ladder — what gets dropped first when two pages are not enough.
 *
 * Ordered by what a client actually loses. Supporting rows go first, then table
 * length, then leading and body size. The contribution chart is last, because
 * "why did my portfolio move" is the question the letter exists to answer, and
 * one chart answers it better than the paragraph beside it.
 */
function budget(level) {
  return {
    maxImpact: level >= 1 ? 2 : 3,
    showMetrics: level < 2,
    sectionGap: level >= 2 ? 12 : 15,
    showBandChart: level < 3,
    maxAllocationRows: level >= 3 ? 6 : 8,
    bodySize: level >= 7 ? 9.4 : level >= 4 ? 9.7 : SZ.body,
    bodyLead: level >= 7 ? 13.8 : level >= 4 ? 14.8 : SZ.bodyLead,
    maxImpactLines: level >= 5 ? 1 : 2,
    // The discussion table is the operative half of the letter, so it is
    // trimmed late and never below three rows.
    maxRecommendations: level >= 7 ? 3 : level >= 6 ? 4 : 5,
    showContributionChart: level < 8,
    level,
  };
}

function compose(doc, model, level, maxPages) {
  const b = budget(level);
  const blocks = buildBlocks(doc, model, b);
  const discH = disclaimerHeight(doc, model);
  const floorLast = PAGE.footerH + discH + 14;          // the dark disclaimer block sits above the footer
  const floorMore = PAGE.footerH + 26;                  // room for "continua na página 2"

  let page = null;
  let y = 0;
  let pageNo = 0;
  let overflow = false;

  const newPage = () => {
    pageNo += 1;
    page = doc.addPage();
    y = drawMasthead(doc, model, pageNo);
    return y;
  };

  newPage();

  for (const block of blocks) {
    const h = block.height;
    const floor = pageNo >= maxPages ? floorLast : floorMore;
    if (y - h < floor) {
      if (pageNo >= maxPages) { overflow = true; break; }
      drawFoot(doc, model, pageNo, false, discH);
      newPage();
    }
    y = block.draw(y);
    y -= block.gap ?? 14;
  }

  // The disclaimer must share a page with the figures; if the letter ended on
  // page one without room for it, it closes on page two.
  if (!overflow && y < floorLast) {
    if (pageNo >= maxPages) overflow = true;
    else { drawFoot(doc, model, pageNo, false, discH); newPage(); }
  }
  drawFoot(doc, model, pageNo, true, discH);
  return overflow;
}

// ── chrome ─────────────────────────────────────────────────────────────────

function drawMasthead(doc, model, pageNo) {
  const H = A4.height;
  const L = model.locale;

  // §06 the header bar: the series title Light + Bold, tracked; the copper
  // separator; the date in sage; the white symbol at the right
  doc.rect(0, H - PAGE.headerH, A4.width, PAGE.headerH, { fill: BAR });
  const baseline = H - 45;
  let cx = 30.6;
  const [first, ...rest] = (L === 'pt-BR' ? 'Carta mensal' : 'Monthly letter').split(' ');
  cx += tracked(doc, first, cx, baseline, { font: 'light', size: 14, color: HEADER_TEXT, track: 0.32 });
  cx += 14 * 0.32;
  cx += tracked(doc, rest.join(' '), cx, baseline, { font: 'sans7', size: 14, color: HEADER_TEXT, track: 0.32 });
  cx += 16;
  doc.text('l', cx, baseline, { font: 'light', size: 8, color: COPPER });
  cx += 14;
  tracked(doc, model.period.label, cx, baseline + 0.5, { font: 'light', size: 8, color: SAGE, track: 0.32 });
  drawSymbol(doc, A4.width - 20 - 28.9 * LOGO_SYMBOL_ASPECT, H - 31.1 - 28.9, 28.9, '#FFFFFF');

  if (pageNo === 1) {
    // §06 the byline, tracked, the name in Regular
    const by = H - PAGE.headerH - 16;
    let bx = M.left;
    bx += tracked(doc, L === 'pt-BR' ? 'Por ' : 'By ', bx, by, { font: 'light', size: 8, color: INK });
    bx += tracked(doc, model.advisor?.name || '', bx, by, { font: 'sans', size: 8, color: INK });
    tracked(doc, ', XP Asset Management', bx, by, { font: 'light', size: 8, color: INK });

    const y = by - 21;
    doc.text(model.client?.name || '', M.left, y, { font: 'sans5', size: 12.5, color: INK, charSpacing: -0.1 });
    const meta = [
      `${L === 'pt-BR' ? 'Perfil' : 'Profile'}: ${model.client?.risk_profile}`,
      `${L === 'pt-BR' ? 'Assessor' : 'Advisor'}: ${model.advisor?.name}${model.advisor?.code ? ` (${model.advisor.code})` : ''}`,
      `${L === 'pt-BR' ? 'Posição em' : 'As at'} ${dateLong(model.period.end, L)}`,
    ].join('   ·   ');
    doc.textRight(meta, A4.width - M.right, y + 2, { font: 'light', size: 7.6, color: INK3 });
    doc.line(M.left, y - 9, A4.width - M.right, y - 9, { color: RULE, width: 0.6 });
    return y - 26;
  }
  return H - PAGE.headerH - 30;
}

/** §02 the XP symbol, from the same path data every surface uses, filled even-odd so the letters stay open. */
function drawSymbol(doc, x, y, height, fill) {
  const scale = height / 238.67;
  const ops = svgPathToPdf(LOGO_SYMBOL_PATH, { x, y, scale, viewBox: [6, 0, 266.33, 238.67] });
  doc.path(ops, { fill, stroke: null, fillRule: 'evenodd' });
}

function disclaimerHeight(doc, model) {
  const text = (model.disclosures || []).join(' ');
  return doc.paragraphHeight(text, { font: 'light', size: SZ.disclosure, leading: SZ.disclosure * 1.6, maxWidth: FULL - 2 }) + 34;
}

function drawFoot(doc, model, pageNo, isLast, discH) {
  const L = model.locale;
  // §06 the copper footer bar: the house tracked at the left, the page number in white at the right
  doc.rect(0, 0, A4.width, PAGE.footerH, { fill: COPPER });
  tracked(doc, 'XP Asset Management', 31.3, 9.8, { font: 'light', size: 8, color: INK, track: 0.32 });
  doc.textRight(String(pageNo), A4.width - 31.3, 9.6, { font: 'sans', size: 8.8, color: '#FFFFFF' });

  if (isLast) {
    // §06 the disclaimer page, folded into a block: white Light text on the bar colour, the title tracked in copper
    const top = PAGE.footerH + discH;
    doc.rect(0, PAGE.footerH, A4.width, discH, { fill: BAR });
    tracked(doc, 'Disclaimer', 31.9, top - 15, { font: 'sans', size: 8.5, color: COPPER });
    doc.paragraph((model.disclosures || []).join(' '), 31.9, top - 28, {
      font: 'light', size: SZ.disclosure, leading: SZ.disclosure * 1.6, maxWidth: FULL - 2, color: '#FFFFFF',
    });
  } else {
    doc.text(
      L === 'pt-BR' ? 'Continua na página 2' : 'Continued on page 2',
      M.left, PAGE.footerH + 11, { font: 'light', size: SZ.small, color: INK3 },
    );
  }
}

// ── block construction ─────────────────────────────────────────────────────

function buildBlocks(doc, model, b) {
  const L = model.locale;
  const blocks = [];
  let sectionNo = 0;

  const railNote = (y, lines) => {
    let cy = y - 6;
    for (const line of lines) {
      const wrapped = doc.wrap(line, { font: 'light', size: SZ.rail, maxWidth: RAIL - 10 });
      for (const w of wrapped) {
        doc.text(w, M.left, cy, { font: 'light', size: SZ.rail, color: INK3 });
        cy -= SZ.rail * 1.3;
      }
      cy -= 2;
    }
  };

  // §06 the article title: Roboto Bold, capitals, copper; the number in the rail
  const section = (key, title, drawBody, { gap = b.sectionGap, note = null } = {}) => {
    sectionNo += 1;
    const num = String(sectionNo).padStart(2, '0');
    const headH = 18;
    const bodyH = drawBody.measure();
    blocks.push({
      height: headH + bodyH,
      gap,
      draw: (y) => {
        doc.text(num, M.left, y - 1, { font: 'sans5', size: SZ.rail, color: COPPER, charSpacing: 0.6 });
        doc.text(String(title).toUpperCase(), X, y, { font: 'sans7', size: SZ.h2, color: COPPER2, charSpacing: 0.25 });
        if (note) railNote(y - 18, note);
        return drawBody.draw(y - headH);
      },
    });
  };

  // ── 01 opening ──────────────────────────────────────────────────────────
  blocks.push({
    height: doc.paragraphHeight(model.letter.opening || '', { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W }) + 22,
    gap: 16,
    draw: (y) => {
      doc.text(model.letter.greeting || '', X, y, { font: 'light', size: b.bodySize + 1.6, color: INK });
      return doc.paragraph(model.letter.opening || '', X, y - 20, {
        font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK,
      });
    },
  });

  // ── 02 performance ──────────────────────────────────────────────────────
  {
    const paraH = doc.paragraphHeight(model.letter.performance || '', { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W });
    const figH = 52;
    const chartH = b.showContributionChart ? contributorsChartHeight(model) : 0;
    const methodH = model.method_note ? doc.paragraphHeight(model.method_note, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W }) + 6 : 0;

    section('performance', model.sections.performance, {
      measure: () => paraH + 12 + figH + 12 + chartH + methodH,
      draw: (y) => {
        let cy = drawFigureStrip(doc, model, X, y, W);
        cy -= 12;
        cy = doc.paragraph(model.letter.performance || '', X, cy, {
          font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK,
        });
        if (b.showContributionChart) {
          cy -= 6;
          cy = drawContributorsChart(doc, model, X, cy, W);
        }
        if (model.method_note) {
          cy -= 4;
          cy = doc.paragraph(model.method_note, X, cy, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W, color: INK2 });
        }
        return cy;
      },
    }, { note: sourceNoteFor(model, ['market_price', 'statement']) });
  }

  // ── 03 markets ──────────────────────────────────────────────────────────
  section('markets', model.sections.markets, {
    measure: () => doc.paragraphHeight(model.letter.markets || '', { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W }),
    draw: (y) => doc.paragraph(model.letter.markets || '', X, y, { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK }),
  });

  // ── 04 what it means ────────────────────────────────────────────────────
  {
    const impact = (model.impact || []).slice(0, b.maxImpact);
    const rowsH = impact.length ? impact.length * (15 + b.maxImpactLines * 9 + 9) + 8 : 0;
    section('meaning', model.sections.meaning, {
      measure: () => doc.paragraphHeight(model.letter.meaning || '', { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W }) + rowsH,
      draw: (y) => {
        let cy = doc.paragraph(model.letter.meaning || '', X, y, { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK });
        if (!impact.length) return cy;
        cy -= 8;
        for (const i of impact) {
          doc.text(i.title, X, cy, { font: 'sans5', size: SZ.data, color: INK });
          if (i.exposure_label) {
            doc.textRight(`${L === 'pt-BR' ? 'exposição' : 'exposure'} ${i.exposure_label}`, X + W, cy, { font: 'light', size: SZ.small, color: INK3 });
          }
          cy -= 11;
          const lines = doc.wrap(firstSentences(i.impact, b.maxImpactLines), { font: 'light', size: SZ.small, maxWidth: W }).slice(0, b.maxImpactLines);
          for (const l of lines) { doc.text(l, X, cy, { font: 'light', size: SZ.small, color: INK2 }); cy -= 9; }
          cy += 1;
          doc.line(X, cy, X + W, cy, { color: RULE2, width: 0.5 });
          cy -= 8;
        }
        return cy;
      },
    });
  }

  // ── 05 recommendations ──────────────────────────────────────────────────
  {
    const recs = (model.recommendations || []).slice(0, b.maxRecommendations);
    const introH = doc.paragraphHeight(model.letter.recommendations_intro || '', { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W });
    const omittedH = model.recommendations_omitted_note
      ? doc.paragraphHeight(model.recommendations_omitted_note, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W }) + 6
      : 0;
    const tableH = (recs.length ? 18 + recs.length * 40 : 0) + omittedH;
    section('recommendations', model.sections.recommendations, {
      measure: () => introH + 10 + tableH,
      draw: (y) => {
        let cy = doc.paragraph(model.letter.recommendations_intro || '', X, y, { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK });
        if (!recs.length) return cy;
        cy -= 10;
        cy = drawRecommendationTable(doc, model, recs, X, cy, W);
        if (model.recommendations_omitted_note) {
          cy -= 4;
          cy = doc.paragraph(model.recommendations_omitted_note, X, cy, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W, color: INK2 });
        }
        return cy;
      },
    }, { note: [L === 'pt-BR' ? 'Sinais técnicos e consenso de analistas: TradingView, capturados na data desta carta.' : 'Technical and analyst signals: TradingView, captured on the date of this letter.'] });
  }

  // ── 06 the portfolio ────────────────────────────────────────────────────
  {
    const rows = (model.allocation || []).slice(0, b.maxAllocationRows);
    const barH = 30;
    const tableH = 16 + rows.length * 15;
    section('portfolio', model.sections.portfolio, {
      measure: () => barH + 14 + tableH,
      draw: (y) => {
        let cy = drawAllocationBar(doc, model, X, y, W);
        cy -= 12;
        return drawAllocationTable(doc, model, rows, X, cy, W);
      },
    });
  }

  // ── 07 closing ──────────────────────────────────────────────────────────
  blocks.push({
    height: doc.paragraphHeight(model.letter.closing || '', { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W }) + 36,
    gap: 10,
    draw: (y) => {
      let cy = doc.paragraph(model.letter.closing || '', X, y, { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK });
      cy -= 12;
      doc.text(model.letter.sign_off || '', X, cy, { font: 'light', size: b.bodySize, color: INK });
      cy -= 14;
      doc.text(model.advisor?.name || '', X, cy, { font: 'sans5', size: SZ.data, color: INK });
      cy -= 11;
      tracked(doc, `XP Asset Management${model.advisor?.code ? ` · ${model.advisor.code}` : ''}`, X, cy, { font: 'light', size: 6.6, color: SAGE });
      return cy - 6;
    },
  });

  // ── sources ─────────────────────────────────────────────────────────────
  {
    const lines = model.source_lines || [];
    const text = `${L === 'pt-BR' ? 'Fontes' : 'Sources'}: ${lines.join(' · ')}`;
    const unav = (model.unavailable || []).length
      ? `${L === 'pt-BR' ? 'Sem dado disponível' : 'Data unavailable'}: ${model.unavailable.map((u) => `${u.item} — ${u.reason}`).join('; ')}`
      : null;
    blocks.push({
      height: doc.paragraphHeight(text, { font: 'light', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W })
        + (unav ? doc.paragraphHeight(unav, { font: 'light', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W }) + 6 : 0) + 10,
      gap: 6,
      draw: (y) => {
        doc.line(X, y + 6, X + W, y + 6, { color: RULE, width: 0.6 });
        let cy = doc.paragraph(text, X, y - 3, { font: 'light', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W, color: INK2 });
        if (unav) {
          cy -= 4;
          cy = doc.paragraph(unav, X, cy, { font: 'light', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W, color: INK2 });
        }
        return cy;
      },
    });
  }

  return blocks;
}

/** Trim to whole sentences so a truncated line never ends mid-thought. */
function firstSentences(text, maxLines) {
  const t = String(text || '').trim();
  if (!t) return '';
  const parts = t.split(/(?<=[.!?])\s+/);
  const budgetChars = maxLines * 118;
  let out = '';
  for (const p of parts) {
    if (out && (out.length + p.length) > budgetChars) break;
    out = out ? `${out} ${p}` : p;
    if (out.length >= budgetChars) break;
  }
  return out || parts[0];
}

function sourceNoteFor(model, kinds) {
  const s = (model.sources || []).filter((x) => kinds.includes(x.kind));
  // The rail carries provider names only. The full citation with instruments
  // and date ranges lives in the sources block on the last page.
  const providers = [...new Set(s.map((x) => x.provider.replace(/\s*\(.*\)$/, '')))];
  if (!providers.length) return null;
  return providers.slice(0, 4);
}

// ── data drawing ───────────────────────────────────────────────────────────

function drawFigureStrip(doc, model, x, y, w) {
  const figs = model.figures.slice(0, 5);
  const colW = w / figs.length;
  doc.line(x, y + 4, x + w, y + 4, { color: RULE3, width: 0.75 });
  figs.forEach((f, i) => {
    const cx = x + i * colW;
    // Labels are tracked capitals in sage; they wrap inside their column.
    const cs = 6.2 * 0.16;
    const lines = wrapTracked(doc, String(f.short_label || f.label).toUpperCase(), { font: 'sans', size: 6.2, maxWidth: colW - 8, charSpacing: cs }).slice(0, 2);
    lines.forEach((l, k) => doc.text(l, cx, y - 8 - k * 8.2, { font: 'sans', size: 6.2, color: SAGE, charSpacing: cs }));
    const tone = f.tone === 'gain' ? GAIN_T : f.tone === 'loss' ? LOSS_T : f.tone === 'benchmark' ? BENCH : INK;
    let size = f.emphasis ? 15.5 : 12;
    const font = f.emphasis ? 'sans' : 'light';
    while (size > 8 && doc.measure(font, f.value, size) > colW - 8) size -= 0.5;
    doc.text(f.value, cx, y - 32, { font, size, color: tone });
  });
  doc.line(x, y - 40, x + w, y - 40, { color: RULE, width: 0.6 });
  return y - 48;
}

/** Word wrap that counts the letter spacing a tracked label carries. */
function wrapTracked(doc, str, { font, size, maxWidth, charSpacing }) {
  const words = String(str ?? '').split(/\s+/).filter(Boolean);
  const width = (t) => doc.measure(font, t, size) + charSpacing * t.length;
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (width(test) <= maxWidth || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function contributorsChartHeight(model) {
  const n = Math.min(6, (model.charts?.contributors?.items || []).length);
  return n ? n * 15 + 26 : 0;
}

/** §09 bars are slate, negative bars red; the value sits outside the bar with its sign. */
function drawContributorsChart(doc, model, x, y, w) {
  const data = model.charts?.contributors;
  const items = (data?.items || []).slice(0, 6);
  if (!items.length) return y;
  const L = model.locale;

  doc.text(
    L === 'pt-BR' ? 'Quem puxou o resultado, em pontos percentuais da carteira' : 'What drove the result, in percentage points of the portfolio',
    x, y, { font: 'sans', size: SZ.small, color: INK },
  );
  let cy = y - 14;
  const labelW = 96;
  const valueW = 52;
  const plotW = w - labelW - valueW;
  const zeroX = x + labelW + plotW / 2;
  const scale = (plotW / 2) / Math.max(1e-6, data.bound);

  for (const it of items) {
    const bw = Math.max(0.8, Math.abs(it.value) * scale);
    const bx = it.value >= 0 ? zeroX : zeroX - bw;
    doc.rect(bx, cy - 8, bw, 8, { fill: it.tone === 'loss' ? LOSS_G : GAIN_G });
    doc.textRight(it.label, x + labelW - 6, cy - 6, { font: 'light', size: SZ.small, color: INK });

    const label = pp(it.value, { locale: L });
    const tw = doc.measure('sans', label, SZ.small);
    if (it.value >= 0) {
      doc.text(label, zeroX + bw + 5, cy - 6, { font: 'sans', size: SZ.small, color: GAIN_T });
    } else if (zeroX - bw - 5 - tw > x + labelW + 2) {
      doc.textRight(label, zeroX - bw - 5, cy - 6, { font: 'sans', size: SZ.small, color: LOSS_T });
    } else {
      doc.text(label, zeroX - bw + 4, cy - 6, { font: 'sans', size: SZ.small, color: '#FFFFFF' });
    }
    cy -= 15;
  }
  // the axis, over the bars, in the chart grammar's axis grey
  doc.line(zeroX, y - 6, zeroX, cy + 7, { color: color.axis, width: 0.6 });
  return cy - 4;
}

/** §08 a table header: a charcoal band with white capitals; no black rules anywhere. */
function drawHeaderBand(doc, x, y, w, cells) {
  const h = 12;
  doc.rect(x, y - h + 3, w, h, { fill: CHARCOAL });
  for (const c of cells) {
    const text = String(c.label).toUpperCase();
    const opts = { font: 'sans', size: 6.4, color: '#FFFFFF', charSpacing: 0.5 };
    if (c.align === 'right') doc.text(text, c.x - doc.measure('sans', text, 6.4) - 0.5 * text.length, y - 5.5, opts);
    else doc.text(text, c.x, y - 5.5, opts);
  }
  return y - h - 4;
}

function drawRecommendationTable(doc, model, recs, x, y, w) {
  const L = model.locale;
  const cols = [
    { key: 'asset', w: 0.30 },
    { key: 'action', w: 0.13 },
    { key: 'tech', w: 0.15 },
    { key: 'analyst', w: 0.18 },
    { key: 'fit', w: 0.24 },
  ];
  const heads = L === 'pt-BR'
    ? ['Ativo', 'Sugestão', 'Técnico', 'Analistas', 'Enquadramento']
    : ['Asset', 'Suggestion', 'Technical', 'Analyst', 'Policy fit'];

  let cx = x;
  const xs = cols.map((c) => { const v = cx; cx += c.w * w; return v; });
  let cy = drawHeaderBand(doc, x, y, w, heads.map((h, i) => ({ label: h, x: xs[i] + 4 })));
  cy -= 6;

  for (const r of recs) {
    const nameW = cols[0].w * w - 8;
    let label = r.ticker || r.name;
    if (doc.measure('sans5', label, SZ.data) > nameW) {
      while (label.length > 4 && doc.measure('sans5', `${label}…`, SZ.data) > nameW) label = label.slice(0, -1);
      label = `${label.trimEnd()}…`;
    }
    doc.text(label, xs[0] + 4, cy, { font: 'sans5', size: SZ.data, color: INK });
    doc.text(`${r.weight_label} ${L === 'pt-BR' ? 'da carteira' : 'of portfolio'}`, xs[0] + 4, cy - 9, { font: 'light', size: SZ.small - 0.4, color: INK3 });

    const actionTone = r.action === 'ADD' ? GAIN_T : (r.action === 'REDUCE' || r.action === 'EXIT') ? LOSS_T : INK;
    doc.text(r.action_label, xs[1] + 4, cy, { font: 'sans7', size: SZ.data, color: actionTone });

    doc.text(r.technical || (L === 'pt-BR' ? 'sem cobertura' : 'not covered'), xs[2] + 4, cy, { font: 'light', size: SZ.small, color: r.technical ? INK : INK3 });

    if (r.analyst) {
      doc.text(r.analyst, xs[3] + 4, cy, { font: 'light', size: SZ.small, color: INK });
      if (r.analyst_count) doc.text(`${r.analyst_count} ${L === 'pt-BR' ? 'analistas' : 'analysts'}`, xs[3] + 4, cy - 9, { font: 'light', size: SZ.small - 0.4, color: INK3 });
    } else {
      const lines = doc.wrap(r.analyst_missing_label || '', { font: 'light', size: SZ.small - 0.4, maxWidth: cols[3].w * w - 8 });
      lines.slice(0, 2).forEach((l, i) => doc.text(l, xs[3] + 4, cy - i * 8, { font: 'light', size: SZ.small - 0.4, color: INK3 }));
    }

    const fitTone = r.suitability === 'PASS' ? INK : CAUTION;
    const fitLines = doc.wrap(r.suitability_label || '', { font: 'sans', size: SZ.small, maxWidth: cols[4].w * w - 6 });
    fitLines.slice(0, 2).forEach((l, i) => doc.text(l, xs[4] + 4, cy - i * 8.5, { font: 'sans', size: SZ.small, color: fitTone }));

    cy -= 20;
    if (r.rationale) {
      const lines = doc.wrap(r.rationale, { font: 'light', size: SZ.small, maxWidth: w - 8 }).slice(0, 2);
      for (const l of lines) { doc.text(l, x + 4, cy, { font: 'light', size: SZ.small, color: INK2 }); cy -= 9; }
    }
    doc.line(x, cy + 1, x + w, cy + 1, { color: RULE2, width: 0.5 });
    cy -= 10;
  }
  return cy + 4;
}

function drawAllocationBar(doc, model, x, y, w) {
  const items = model.charts?.allocation?.items || [];
  if (!items.length) return y;
  const total = items.reduce((a, i) => a + i.weight, 0) || 1;
  let cx = x;
  const h = 18;
  for (const it of items) {
    const bw = (it.weight / total) * w;
    doc.rect(cx, y - h, bw, h, { fill: it.color });
    if (bw > 38) doc.textCenter(fmtWeight(it.weight, { locale: model.locale, decimals: 1 }), cx + bw / 2, y - h + 6, { font: 'sans', size: 7.2, color: inkOn(it.color) });
    cx += bw;
  }
  return y - h - 4;
}

function drawAllocationTable(doc, model, rows, x, y, w) {
  const L = model.locale;
  const heads = L === 'pt-BR'
    ? ['Classe de ativo', 'Valor', 'Peso', 'Alvo', 'Faixa permitida']
    : ['Asset class', 'Value', 'Weight', 'Target', 'Permitted range'];
  const xs = [x, x + w * 0.42, x + w * 0.62, x + w * 0.75, x + w * 0.86];
  const rights = [null, xs[1] + w * 0.16, xs[2] + w * 0.11, xs[3] + w * 0.09, x + w - 4];

  let cy = drawHeaderBand(doc, x, y, w, [
    { label: heads[0], x: xs[0] + 4 },
    { label: heads[1], x: rights[1], align: 'right' },
    { label: heads[2], x: rights[2], align: 'right' },
    { label: heads[3], x: rights[3], align: 'right' },
    { label: heads[4], x: rights[4], align: 'right' },
  ]);
  cy -= 4;
  for (const r of rows) {
    doc.text(r.asset_class, xs[0] + 4, cy, { font: 'sans', size: SZ.data, color: INK });
    doc.textRight(r.value_label, rights[1], cy, { font: 'light', size: SZ.data, color: INK });
    doc.textRight(r.weight_label, rights[2], cy, { font: 'sans5', size: SZ.data, color: r.inside_band ? INK : CAUTION });
    doc.textRight(r.target_label, rights[3], cy, { font: 'light', size: SZ.data, color: INK3 });
    doc.textRight(r.inside_band ? r.range_label : `${r.range_label} !`, rights[4], cy, { font: 'light', size: SZ.data, color: r.inside_band ? INK3 : CAUTION });
    cy -= 4;
    doc.line(x, cy, x + w, cy, { color: RULE2, width: 0.5 });
    cy -= 11;
  }
  return cy + 5;
}
