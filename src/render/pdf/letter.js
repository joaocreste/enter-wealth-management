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
import { rangeBarGeometry } from '../charts.js';

const POSITION = color.position;

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
/**
 * Page one is set in a reading measure, not the full width of the annex. A
 * letter is read straight through, and 421 pt of Roboto Light at 10.2 is about
 * as wide as a line can be before the eye starts losing its place on the way
 * back. The annex is scanned, not read, so it takes the full width — the two
 * pages are different measures because they are different kinds of document,
 * and that is the point of the break between them.
 */
const LX = 62;
const LW = 421;

const SZ = {
  // §04 asks for a generous leading; 1.6 is the most the two-page rule allows
  body: 10.2, bodyLead: 16.4,
  h2: 9.4, rail: 7.4, data: 8.6, small: 7.8,
  // the disclaimer is Roboto Light 9/16.2 on the Carta's dark page; 7.4/13.3 keeps the
  // proportion on a page that also has to hold the letter
  disclosure: 7.4,
};
const TRACK = 0.3; // em — the brand's tracked capitals

/**
 * Two independent ladders, because the two pages have nothing to do with
 * each other.
 *
 * With one shared ladder, a long letter on page one climbed the rungs until it
 * fit — and took the annex's chart and its "why" column with it, leaving page
 * two two-thirds empty. The letter is never cut for space: only its type
 * tightens, and only as far as the last rung. The annex gives up content, in
 * the order a client misses it least.
 */
export async function renderLetterPdf(model, { fonts, maxPages = 2 } = {}) {
  const probe = new PdfDocument({ title: 'probe' });
  registerFonts(probe, fonts);
  probe.addPage();
  const discH = disclaimerHeight(probe, model);
  const letterRoom = A4.height - PAGE.headerH - 44 - (PAGE.footerH + 24);
  const annexRoom = A4.height - PAGE.headerH - 30 - (PAGE.footerH + discH + 8);
  const needs = (blocks) => blocks.reduce((a, b, i) => a + b.height + (i < blocks.length - 1 ? (b.gap ?? 14) : 0), 0);

  let type = 0;
  while (type < LETTER_LADDER - 1 && needs(buildLetterBlocks(probe, model, letterBudget(type))) > letterRoom) type += 1;
  let level = 0;
  while (level < ANNEX_LADDER - 1 && needs(buildAnnexBlocks(probe, model, annexBudget(level))) > annexRoom) level += 1;

  const doc = new PdfDocument({
    title: `Carta mensal — ${model.client?.name} — ${model.period.label}`,
    author: `${model.advisor?.name} · XP Asset Management`,
    subject: `Relatório mensal de investimentos — ${model.period.label}`,
    keywords: 'carta mensal, investimentos, XP Asset Management',
  });
  registerFonts(doc, fonts);
  doc.overflow = compose(doc, model, letterBudget(type), annexBudget(level), maxPages);
  doc.reductionLevel = level;
  doc.letterTypeLevel = type;
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
 * The letter's only concession to space is its type, and it has four settings.
 * A paragraph the advisor wrote is what the client opened the envelope for.
 */
const LETTER_LADDER = 6;
function letterBudget(t) {
  return {
    bodySize: [SZ.body, 9.9, 9.5, 9.1, 9.1, 9.1][t] ?? 9.1,
    bodyLead: [SZ.bodyLead, 15.6, 14.8, 14.0, 14.0, 14.0][t] ?? 14.0,
    // The positioning chart tightens with the type, and gives up its caption
    // before it gives up a row: a row is a class the client owns, the caption
    // only says how to read the scale.
    stanceRow: [15.5, 14.5, 13.5, 12.5, 11.5, 11.5][t] ?? 11.5,
    stanceCaption: t < 4,
    // The last rung, and only the last: the chart says something no paragraph
    // says, so it goes after the type has run out of room and before anything
    // the advisor wrote is at risk.
    showStance: t < 5,
    type: t,
  };
}

/**
 * The annex gives up content, in the order a client would miss it least:
 * supporting rows, then table length, then the exhaustive ticker list, then the
 * method note's justification, then the chart, and only last the reasons under
 * the rows. The letter's second paragraph already narrates what moved the month,
 * so the chart repeats it in another form; nothing anywhere else explains why a
 * position is outside the client's policy, which is the one verdict in the
 * annex a client could be alarmed by and unable to interpret.
 */
const ANNEX_LADDER = 9;
function annexBudget(level) {
  return {
    maxAllocationRows: level >= 1 ? 6 : 8,
    maxRecommendations: level >= 3 ? 3 : level >= 2 ? 4 : 5,
    compactSources: level >= 4,
    methodSentences: level >= 2 ? 2 : 99,
    blockGap: level >= 5 ? 8 : level >= 2 ? 10 : 14,
    chartBars: level >= 5 ? 4 : 6,
    showContributionChart: level < 7,
    showRationale: level < 8,
    level,
  };
}

/**
 * Page one is the letter and page two is the annex, always, and the break
 * between them is deliberate rather than whatever the text happened to fill.
 * That single decision is what separates a letter with figures attached from a
 * report with a greeting on top.
 */
function compose(doc, model, letterB, annexB, maxPages) {
  const discH = disclaimerHeight(doc, model);
  const floorLetter = PAGE.footerH + 24;
  // The disclaimer block carries 32 pt of its own padding, so the gap above it
  // does not need another 14 on top.
  const floorAnnex = PAGE.footerH + discH + 8;
  let pageNo = 0;
  let y = 0;
  let overflow = false;

  const newPage = () => { pageNo += 1; doc.addPage(); y = drawMasthead(doc, model, pageNo); };

  // ── page one: the letter ────────────────────────────────────────────────
  newPage();
  for (const block of buildLetterBlocks(doc, model, letterB)) {
    if (y - block.height < floorLetter) { overflow = true; break; }
    y = block.draw(y) - (block.gap ?? 14);
  }
  drawFoot(doc, model, pageNo, false, discH);

  // ── page two: the annex ─────────────────────────────────────────────────
  newPage();
  for (const block of buildAnnexBlocks(doc, model, annexB)) {
    if (y - block.height < floorAnnex) { overflow = true; break; }
    y = block.draw(y) - (block.gap ?? 12);
  }
  drawFoot(doc, model, pageNo, true, discH);
  return overflow || doc.pageCount > maxPages;
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

  // The letter's own head — who it is to, where and when it was written — is a
  // block on the page, not a strip of CRM metadata under the masthead. The
  // profile, the advisor code and the position date belong to the annex.
  return H - PAGE.headerH - (pageNo === 1 ? 44 : 30);
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

/**
 * Page one. A correspondence head, the idea of the month, the greeting, the
 * paragraphs and a signature — in a reading measure, not the full page width.
 */
function buildLetterBlocks(doc, model, b) {
  const L = model.locale;
  const blocks = [];
  const d = model.dateline || {};
  const letter = model.letter || {};
  const body = { font: 'light', size: b.bodySize, leading: b.bodyLead, maxWidth: LW };

  // ── to whom, from where, when ───────────────────────────────────────────
  blocks.push({
    height: 26, gap: 30,
    draw: (y) => {
      doc.text(d.to || model.client?.name || '', LX, y, { font: 'sans5', size: 10.6, color: INK });
      doc.textRight(d.place_date || '', LX + LW, y, { font: 'light', size: 9.2, color: INK2 });
      if (d.to_line) doc.text(d.to_line, LX, y - 13, { font: 'light', size: 7.8, color: SAGE });
      return y - 26;
    },
  });

  // ── the idea of the month ───────────────────────────────────────────────
  if (letter.title) {
    const lines = doc.wrap(letter.title, { font: 'sans7', size: 13, maxWidth: LW });
    blocks.push({
      height: lines.length * 17, gap: 16,
      draw: (y) => {
        let cy = y;
        for (const line of lines) { doc.text(line, LX, cy, { font: 'sans7', size: 13, color: COPPER2 }); cy -= 17; }
        return cy;
      },
    });
  }

  // ── the greeting ────────────────────────────────────────────────────────
  blocks.push({
    height: b.bodyLead, gap: 10,
    draw: (y) => { doc.text(letter.greeting || '', LX, y, { font: 'light', size: b.bodySize, color: INK }); return y - b.bodyLead; },
  });

  // ── the letter ──────────────────────────────────────────────────────────
  for (const [i, text] of (letter.paragraphs || []).entries()) {
    blocks.push({
      key: `p${i}`,
      height: doc.paragraphHeight(text, body),
      gap: 7,
      draw: (y) => doc.paragraph(text, LX, y, { ...body, color: INK }),
    });
  }

  // ── where the carteira stands against the policy ────────────────────────
  // Between the last thing the letter argues and the way it closes: the client
  // has just read what moved and what to discuss, and this is the one picture
  // that says where each class actually sits. It is spliced into the flow
  // rather than appended, so the text continues underneath it.
  if (b.showStance && (model.stance || []).length) {
    const rows = model.stance;
    const stance = {
      key: 'stance', height: stanceHeight(doc, model, rows, b), gap: 16,
      draw: (y) => drawStance(doc, model, rows, LX, y, LW, b),
    };
    // Before the closing paragraph; at the end when the letter is too short to
    // have one to spare.
    const last = blocks.map((x) => x.key).lastIndexOf(`p${(letter.paragraphs || []).length - 1}`);
    if (last > 0) blocks.splice(last, 0, stance); else blocks.push(stance);
  }

  // ── the signature ───────────────────────────────────────────────────────
  blocks.push({
    height: 58, gap: 0,
    draw: (y) => {
      let cy = y - 4;
      doc.text(letter.sign_off || '', LX, cy, { font: 'light', size: b.bodySize, color: INK });
      cy -= 24;
      doc.text(model.advisor?.name || '', LX, cy, { font: 'sans5', size: 9.8, color: INK });
      cy -= 12;
      const role = L === 'pt-BR' ? 'Assessor de investimentos' : 'Investment advisor';
      doc.text(`${role} · XP Asset Management${model.advisor?.code ? ` · ${model.advisor.code}` : ''}`, LX, cy, { font: 'light', size: 7.6, color: INK2 });
      if (model.advisor?.email) { cy -= 11; doc.text(model.advisor.email, LX, cy, { font: 'light', size: 7.6, color: SAGE }); }
      return cy - 4;
    },
  });

  return blocks;
}

/**
 * Page two. Everything the letter refers to and does not reproduce: the
 * figures, what moved them, the points of the meeting, the portfolio and the
 * sources. It carries the metadata that used to sit above the greeting.
 */
function buildAnnexBlocks(doc, model, b) {
  const L = model.locale;
  const blocks = [];

  // ── the annex head ──────────────────────────────────────────────────────
  blocks.push({
    key: 'annexhead', height: 26, gap: 16,
    draw: (y) => {
      // Two lines rather than one. The title already carries the date, so a long
      // month name has nowhere to collide with the metadata beside it.
      tracked(doc, model.annex_title || (L === 'pt-BR' ? 'Anexo' : 'Annex'), X, y, { font: 'light', size: 8.4, color: COPPER, track: 0.16 });
      const meta = [
        `${L === 'pt-BR' ? 'Perfil' : 'Profile'} ${model.client?.risk_profile || '—'}`,
        `${L === 'pt-BR' ? 'Assessor' : 'Advisor'} ${model.advisor?.name || ''}${model.advisor?.code ? ` (${model.advisor.code})` : ''}`,
      ].join(' · ');
      doc.text(meta, X, y - 12, { font: 'light', size: 6.8, color: INK3 });
      doc.line(X, y - 20, X + W, y - 20, { color: RULE, width: 0.6 });
      return y - 26;
    },
  });

  // ── the figures, and what moved them ────────────────────────────────────
  {
    const chartH = b.showContributionChart ? contributorsChartHeight(model, b.chartBars) : 0;
    const method = model.method_note ? firstSentences(model.method_note, b.methodSentences) : '';
    const methodH = method ? doc.paragraphHeight(method, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W }) + 6 : 0;
    blocks.push({
      // 18 for the title, 44 for the figure strip: what those two actually draw.
      key: 'figures', height: 18 + 44 + chartH + methodH, gap: b.blockGap,
      draw: (y) => {
        let cy = sectionTitle(doc, y, L === 'pt-BR' ? 'Quem puxou o resultado' : 'What drove the result');
        cy = drawFigureStrip(doc, model, X, cy, W);
        if (b.showContributionChart) { cy -= 6; cy = drawContributorsChart(doc, model, X, cy, W, b.chartBars); }
        if (method) {
          cy -= 4;
          cy = doc.paragraph(method, X, cy, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W, color: INK2 });
        }
        return cy;
      },
    });
  }

  // ── the points of the meeting, in the order the letter raised them ──────
  {
    const all = model.recommendations || [];
    const recs = all.slice(0, b.maxRecommendations);
    if (recs.length) {
      // What the ladder dropped for space is counted with what was never
      // selected, so the total the client is told about is the true one.
      const trimmed = all.length - recs.length;
      const note = [
        trimmed > 0
          ? (L === 'pt-BR'
            ? `Outros ${trimmed} ${trimmed === 1 ? 'ponto aprovado está' : 'pontos aprovados estão'} no seu portal.`
            : `A further ${trimmed} approved ${trimmed === 1 ? 'point is' : 'points are'} in your portal.`)
          : null,
        model.recommendations_omitted_note,
      ].filter(Boolean).join(' ');
      const omittedH = note
        ? doc.paragraphHeight(note, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W }) + 6
        : 0;
      // Measured, not guessed. A flat 40 pt per row assumed two lines of
      // rationale for every row and cost the whole column a rung on the ladder,
      // which is how "fora da política" ended up on the page without its reason.
      const rowsH = recs.reduce((a, r) => {
        const lines = b.showRationale && r.rationale
          ? Math.min(2, doc.wrap(r.rationale, { font: 'light', size: SZ.small, maxWidth: W - 8 }).length)
          : 0;
        return a + 20 + lines * 9 + 10;
      }, 0);
      blocks.push({
        // 18 title + 22 header band and its gap, both measured from the drawing.
        key: 'meeting', height: 18 + 22 + rowsH + omittedH, gap: b.blockGap,
        draw: (y) => {
          let cy = sectionTitle(doc, y, L === 'pt-BR' ? 'Os pontos da reunião' : 'The points for the meeting',
            L === 'pt-BR' ? 'Sinais técnicos e consenso de analistas: TradingView, capturados na data desta carta' : 'Technical and analyst signals: TradingView, captured on the date of this letter');
          cy = drawRecommendationTable(doc, model, recs, X, cy, W, b);
          if (note) {
            cy -= 4;
            cy = doc.paragraph(note, X, cy, { font: 'light', size: SZ.small, leading: SZ.small * 1.4, maxWidth: W, color: INK2 });
          }
          return cy;
        },
      });
    }
  }

  // ── the portfolio ───────────────────────────────────────────────────────
  {
    const rows = (model.allocation || []).slice(0, b.maxAllocationRows);
    blocks.push({
      // 18 title + 22 bar + 12 gap + (16 band + 4) + 15 a row, less the 5 the
      // table hands back. Guessed high, this block missed its floor by two
      // points and cost the annex three rungs of the ladder.
      key: 'portfolio', height: 18 + 22 + 12 + 20 + rows.length * 15 - 5, gap: b.blockGap,
      draw: (y) => {
        let cy = sectionTitle(doc, y, L === 'pt-BR' ? 'Sua carteira hoje' : 'Your portfolio today',
          model.policy_version ? `${L === 'pt-BR' ? 'Política versão' : 'Policy version'} ${model.policy_version}` : null);
        cy = drawAllocationBar(doc, model, X, cy, W);
        cy -= 12;
        return drawAllocationTable(doc, model, rows, X, cy, W);
      },
    });
  }

  // ── sources ─────────────────────────────────────────────────────────────
  {
    const lines = b.compactSources
      ? [...new Set((model.sources || []).map((x) => x.provider).filter(Boolean))]
      : (model.source_lines || []);
    const text = `${L === 'pt-BR' ? 'Fontes' : 'Sources'}: ${lines.join(' · ')}`;
    const unav = (model.unavailable || []).length
      ? `${L === 'pt-BR' ? 'Sem dado disponível' : 'Data unavailable'}: ${model.unavailable.map((u) => `${u.item} — ${u.reason}`).join('; ')}`
      : null;
    const opts = { font: 'light', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W };
    blocks.push({
      key: 'sources',
      height: doc.paragraphHeight(text, opts) + (unav ? doc.paragraphHeight(unav, opts) + 6 : 0) + 10,
      gap: 6,
      draw: (y) => {
        doc.line(X, y + 6, X + W, y + 6, { color: RULE, width: 0.6 });
        let cy = doc.paragraph(text, X, y - 3, { ...opts, color: INK2 });
        if (unav) { cy -= 4; cy = doc.paragraph(unav, X, cy, { ...opts, color: INK2 }); }
        return cy;
      },
    });
  }

  return blocks;
}

// ── the positioning chart ──────────────────────────────────────────────────
/**
 * Where each class of the carteira sits against the policy, on the five-step
 * scale the house uses everywhere: two steps under, neutral, two steps over,
 * with the direction it moved since the last approved portrait beside it.
 *
 * The step is not an opinion — it is read off the client's own permitted range
 * (src/render/letter-model.js), so this chart and the allocation table in the
 * annex can never disagree. The colours are the brand's position palette (§07),
 * which exists for precisely this picture.
 */
const STANCE_MARKS = [`${MINUS}${MINUS}`, MINUS, '=', '+', '++'];

/** The geometry, computed once so the measurer and the drawing cannot drift apart. */
function stanceGrid(x, w) {
  const ruleX = x + w * 0.505;
  const scaleX0 = ruleX + 12;
  const scaleX1 = x + w;
  const gap = (scaleX1 - scaleX0) / STANCE_MARKS.length;
  return {
    labelX: x,
    mudCx: x + w * 0.465,
    ruleX,
    scaleX0,
    scaleX1,
    at: (i) => scaleX0 + gap * (i + 0.5),
  };
}

const STANCE_HEAD = 30;   // two header rows, from the top of the block to the first row
const STANCE_TAIL = 13;   // air under the last row, before the caption or the next block

function stanceCaptionText(L) {
  return L === 'pt-BR'
    ? `Cada classe contra a faixa combinada na sua política: ${MINUS}${MINUS} e ++ estão fora dela, ${MINUS} e + estão dentro dela mas longe do alvo, = está no alvo. Mud. é a direção que o peso da classe tomou ao longo do mês.`
    : `Each class against the range agreed in your policy: ${MINUS}${MINUS} and ++ are outside it, ${MINUS} and + are inside it but away from target, = is at target. Chg. is the direction the class weight took over the month.`;
}

function stanceHeight(doc, model, rows, b) {
  const cap = b.stanceCaption
    ? doc.paragraphHeight(stanceCaptionText(model.locale), CAPTION) + 6
    : 0;
  return 14 + STANCE_HEAD + rows.length * b.stanceRow + STANCE_TAIL + cap;
}

const CAPTION = { font: 'light', size: 6.8, leading: 10, maxWidth: LW };

function drawStance(doc, model, rows, x, y, w, b) {
  const L = model.locale;
  const g = stanceGrid(x, w);
  const rowH = b.stanceRow;

  doc.text(
    (L === 'pt-BR' ? 'Sua carteira contra a sua política' : 'Your portfolio against your policy').toUpperCase(),
    x, y, { font: 'sans7', size: SZ.h2, color: COPPER2, charSpacing: 0.25 },
  );
  let cy = y - 14;

  // ── the two header rows: the three regions, then the five marks ─────────
  const mid = (a, c) => (a + c) / 2;
  // tracked() draws from a left edge, so a centred tracked cap has to account
  // for the letter spacing itself: measure() does not know about Tc.
  const headCap = (label, cx) => {
    const caps = String(label).toUpperCase();
    const size = 6.4;
    const wide = doc.measure('sans5', caps, size) + size * TRACK * (caps.length - 1);
    tracked(doc, caps, cx - wide / 2, cy, { font: 'sans5', size, color: INK2 });
  };
  headCap('Underweight', mid(g.at(0), g.at(1)));
  headCap(L === 'pt-BR' ? 'Neutro' : 'Neutral', g.at(2));
  headCap('Overweight', mid(g.at(3), g.at(4)));
  doc.textCenter(L === 'pt-BR' ? 'Mud.' : 'Chg.', g.mudCx, cy, { font: 'light', size: 7, color: INK2 });
  cy -= 13;

  for (const [i, mark] of STANCE_MARKS.entries()) {
    doc.textCenter(mark, g.at(i), cy, { font: 'sans5', size: 8.4, color: INK2 });
  }
  cy -= 7;

  // ── the rows ────────────────────────────────────────────────────────────
  const top = cy;
  for (const r of rows) {
    cy -= rowH;
    const mid_ = cy + rowH * 0.34;
    // The cap is 6.6 pt tall, so a baseline 2.3 below the rule puts the name
    // optically on it rather than floating above it.
    doc.text(String(r.label).toUpperCase(), g.labelX, mid_ - 2.3, { font: 'sans7', size: 6.6, color: INK, charSpacing: 6.6 * 0.06 });
    drawChange(doc, r.change, g.mudCx, mid_);
    doc.line(g.scaleX0, mid_, g.scaleX1, mid_, { color: RULE, width: 2 });
    const step = Math.max(-2, Math.min(2, r.step ?? 0));
    dot(doc, g.at(step + 2), mid_, 4.1, step < 0 ? POSITION.underweight : step > 0 ? POSITION.overweight : POSITION.neutral);
  }
  // The rule that separates the names from the scale, the length of the rows.
  doc.line(g.ruleX, top, g.ruleX, cy - 1, { color: INK, width: 1 });
  cy -= STANCE_TAIL;

  if (b.stanceCaption) {
    cy = doc.paragraph(stanceCaptionText(L), x, cy, { ...CAPTION, maxWidth: w, color: INK3 });
    cy -= 6;
  }
  return cy;
}

/** ▲ up, ▼ down, — unchanged; nothing at all when there is no earlier portrait to compare with. */
function drawChange(doc, change, cx, cy) {
  if (!change) return;
  if (change === 'flat') { doc.line(cx - 4.4, cy, cx + 4.4, cy, { color: POSITION.unchanged, width: 2.2 }); return; }
  const up = change === 'up';
  const s = 4.2;
  const h = 6.6;
  const d = up
    ? `${(cx - s).toFixed(2)} ${(cy - h / 2).toFixed(2)} m ${(cx + s).toFixed(2)} ${(cy - h / 2).toFixed(2)} l ${cx.toFixed(2)} ${(cy + h / 2).toFixed(2)} l h`
    : `${(cx - s).toFixed(2)} ${(cy + h / 2).toFixed(2)} m ${(cx + s).toFixed(2)} ${(cy + h / 2).toFixed(2)} l ${cx.toFixed(2)} ${(cy - h / 2).toFixed(2)} l h`;
  doc.path(d, { fill: up ? POSITION.up : POSITION.down, stroke: null });
}

/** A filled circle, in four Béziers. */
function dot(doc, cx, cy, r, fill) {
  const k = r * 0.5523;
  const n = (v) => v.toFixed(2);
  const d = `${n(cx - r)} ${n(cy)} m `
    + `${n(cx - r)} ${n(cy + k)} ${n(cx - k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c `
    + `${n(cx + k)} ${n(cy + r)} ${n(cx + r)} ${n(cy + k)} ${n(cx + r)} ${n(cy)} c `
    + `${n(cx + r)} ${n(cy - k)} ${n(cx + k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c `
    + `${n(cx - k)} ${n(cy - r)} ${n(cx - r)} ${n(cy - k)} ${n(cx - r)} ${n(cy)} c h`;
  doc.path(d, { fill, stroke: null });
}

/** §06 the article title: Roboto Bold, capitals, copper, with an optional note at the right. */
function sectionTitle(doc, y, title, meta = null) {
  doc.text(String(title).toUpperCase(), X, y, { font: 'sans7', size: SZ.h2, color: COPPER2, charSpacing: 0.25 });
  if (meta) doc.textRight(meta, X + W, y, { font: 'light', size: 6.8, color: INK3 });
  return y - 18;
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

/**
 * How tall the contributors chart is, for `bars` rows.
 *
 * Dropping from six bars to four is a far better trade than dropping the chart:
 * the bars are sorted, so the four that remain are the four that moved the
 * month, and the client still sees the shape of the answer.
 */
function contributorsChartHeight(model, bars = 6) {
  return contributorBars(model, bars).length ? contributorBars(model, bars).length * 15 + 26 : 0;
}

/**
 * The bars to draw, when there is not room for all of them.
 *
 * Taking the first N of a list sorted by contribution keeps the winners and
 * throws away the losers, which is the exact opposite of what this chart is
 * for and of the house rule that the loss is described before the gain. Select
 * by how far a position moved the month in either direction, then restore the
 * order so the chart still reads from best to worst.
 */
export function contributorBars(model, bars = 6) {
  const items = model.charts?.contributors?.items || [];
  if (items.length <= bars) return items;
  const kept = new Set(
    items.slice().sort((a, c) => Math.abs(c.value ?? c.contribution ?? 0) - Math.abs(a.value ?? a.contribution ?? 0)).slice(0, bars),
  );
  return items.filter((i) => kept.has(i));
}

/** §09 bars are slate, negative bars red; the value sits outside the bar with its sign. */
function drawContributorsChart(doc, model, x, y, w, bars = 6) {
  const data = model.charts?.contributors;
  const items = contributorBars(model, bars);
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

function drawRecommendationTable(doc, model, recs, x, y, w, b = { showRationale: true }) {
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

    // Two values and no third: the client asked whether their portfolio is
    // inside the policy they approved, and that question has a yes and a no.
    const fitTone = r.within_policy ? INK : CAUTION;
    const fitLines = doc.wrap(r.suitability_label || '', { font: 'sans', size: SZ.small, maxWidth: cols[4].w * w - 6 });
    fitLines.slice(0, 2).forEach((l, i) => doc.text(l, xs[4] + 4, cy - i * 8.5, { font: 'sans', size: SZ.small, color: fitTone }));

    cy -= 20;
    if (r.rationale && b.showRationale) {
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

/**
 * The allocation table. The figures sit close to the name they belong to rather
 * than spread to the right edge, and the permitted range is drawn instead of
 * written: the band between its two extremes, the extremes named quietly at its
 * ends, and a line where the class actually stands today.
 */
function drawAllocationTable(doc, model, rows, x, y, w) {
  const L = model.locale;
  const heads = L === 'pt-BR'
    ? ['Classe de ativo', 'Valor', 'Peso', 'Alvo', 'Faixa permitida']
    : ['Asset class', 'Value', 'Weight', 'Target', 'Permitted range'];
  const rights = [null, x + w * 0.37, x + w * 0.485, x + w * 0.565];
  const bandX = x + w * 0.655;
  const bandW = x + w - bandX - 4;

  let cy = drawHeaderBand(doc, x, y, w, [
    { label: heads[0], x: x + 4 },
    { label: heads[1], x: rights[1], align: 'right' },
    { label: heads[2], x: rights[2], align: 'right' },
    { label: heads[3], x: rights[3], align: 'right' },
    { label: heads[4], x: bandX + 4 },
  ]);
  cy -= 4;
  for (const r of rows) {
    doc.text(r.asset_class, x + 4, cy, { font: 'sans', size: SZ.data, color: INK });
    doc.textRight(r.value_label, rights[1], cy, { font: 'light', size: SZ.data, color: INK });
    doc.textRight(r.weight_label, rights[2], cy, { font: 'sans5', size: SZ.data, color: r.inside_band ? INK : CAUTION });
    doc.textRight(r.target_label, rights[3], cy, { font: 'light', size: SZ.data, color: INK3 });
    drawRangeBar(doc, r, bandX, cy + 3, bandW, L);
    cy -= 4;
    doc.line(x, cy, x + w, cy, { color: RULE2, width: 0.5 });
    cy -= 11;
  }
  return cy + 5;
}

/** One row's range: the two extremes, quietly labelled, and where the class is between them. */
function drawRangeBar(doc, r, x, mid, w, L) {
  if (!r.range || r.range.min == null || r.range.max == null) {
    doc.text(r.range_label || '—', x, mid - 3, { font: 'light', size: SZ.data, color: INK3 });
    return;
  }
  const padLabel = 22;
  const g = rangeBarGeometry({ min: r.range.min, max: r.range.max, weight: r.weight ?? r.range.min }, { width: w, padLabel });
  const lab = (v) => fmtWeight(v, { locale: L, decimals: 0 });
  doc.textRight(lab(r.range.min), x + padLabel - 5, mid - 2.4, { font: 'light', size: 6.8, color: INK3 });
  doc.text(lab(r.range.max), x + w - padLabel + 5, mid - 2.4, { font: 'light', size: 6.8, color: INK3 });
  doc.rect(x + g.bandX0, mid - 2.2, Math.max(1, g.bandX1 - g.bandX0), 4.4, { fill: color.ink[50] });
  doc.rect(x + g.markX - 0.8, mid - 5.2, 1.6, 10.4, { fill: g.inside ? color.ink[900] : CAUTION });
}
