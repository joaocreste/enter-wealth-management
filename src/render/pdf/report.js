/**
 * The two-page portfolio report, rendered programmatically.
 *
 * The page is the Carteira XP Global Strategies fact sheet in the Carta's
 * frame: the 69 pt #242424 header bar with the tracked series title and the
 * white symbol, the 27 pt copper footer, a tracked "DADOS ATÉ" line, label
 * boxes on grey for the identification, article titles in Roboto Bold copper,
 * a composição table with copper class rows, a framed "Retorno histórico"
 * chart with the copper line, the monthly-return matrix with negatives in red,
 * the Comitê's index tables, its allocation view with the underweight and
 * overweight dots, its decision callouts for the discussion points, and the
 * disclaimer as white Light text on the bar colour (brand §05, §06, §07, §08, §09).
 *
 * Two pages is a hard rule. Every block is measured before it is drawn; when
 * the content does not fit, a reduction ladder trims the least important
 * material first and the composition is tried again; a block that still does
 * not fit on page two is left out and named in doc.omitted. A third page is
 * never started.
 */
import { PdfDocument, A4 } from './writer.js';
import { svgPathToPdf } from './svgpath.js';
import { inkOn, LOGO_SYMBOL_PATH, LOGO_SYMBOL_ASPECT } from '../../core/brand.js';

const INK = '#222222'; const INK2 = '#595959'; const INK3 = '#989898';
const RULE = '#D9D9D9'; const RULE2 = '#E9E9E9';
const BAR = '#242424'; const COPPER = '#BB795E'; const COPPER2 = '#C57D5C'; const COPPER3 = '#C55A11';
const SAGE = '#A1A894'; const CHARCOAL = '#45484A'; const SLATE = '#2A3B43'; const HEADER_TEXT = '#DDDDDD';
const G100 = '#F2F2F2'; const G200 = '#D9D9D9'; const G250 = '#D8D8D8';
const POS = '#548235'; const NEG = '#A62900';
const FRAME = '#E0E5EB'; const AXIS = '#44546A'; const CHART_TITLE = '#3B3838';
const UW = '#B50303'; const OW = '#385723'; const NEU = '#7F7F7F'; const DOWN = '#C00000';

const PAGE = { left: 30.2, right: 29.8, headerH: 69.3, footerH: 26.7 };
const X = PAGE.left;
const W = A4.width - PAGE.left - PAGE.right;
const H = A4.height;
const GUTTER = 14;
const TRACK = 0.3;

/**
 * The reduction ladder: what is trimmed at each level when two pages are not
 * enough, least important first. The last levels cut into the operative content.
 */
const LADDER = [
  {},
  { compositionItems: 3 },
  { discussion: 5 },
  { matrixYears: 3 },
  { indicatorsPerBlock: 5 },
  { narrativeSentences: 3, discussion: 4 },
  { allocView: false },
  { pie: false, compositionItems: 2 },
  { matrixYears: 2, discussion: 3 },
  { chart: false },
  { compositionItems: 1, discussion: 2, indicatorsPerBlock: 4 },
  { matrix: false, narrativeSentences: 2 },
];

function budget(level) {
  const b = { compositionItems: 4, discussion: 6, matrixYears: 4, matrix: true, indicatorsPerBlock: 8, narrativeSentences: 4, allocView: true, pie: true, chart: true, level };
  for (let i = 1; i <= level; i += 1) Object.assign(b, LADDER[i] || {});
  return b;
}

export async function renderReportPdf(model, { fonts, maxPages = 2 } = {}) {
  let best = null;
  for (let level = 0; level < LADDER.length; level += 1) {
    const doc = new PdfDocument({
      title: `Relatório de carteira — ${model.client?.name} — ${model.data_until}`,
      author: `${model.advisor?.name} · XP Asset Management`,
      subject: 'Relatório de carteira',
      keywords: 'relatório de carteira, investimentos, XP Asset Management',
    });
    registerFonts(doc, fonts);
    const omitted = compose(doc, model, budget(level), maxPages);
    doc.reductionLevel = level;
    doc.omitted = omitted;
    if (!omitted.length) return doc;
    if (!best || omitted.length < best.omitted.length) best = doc;
  }
  return best;
}

function registerFonts(doc, fonts) {
  doc.registerFont('light', fonts.sans300);
  doc.registerFont('sans', fonts.sans400);
  doc.registerFont('sans5', fonts.sans500);
  doc.registerFont('sans7', fonts.sans700);
}

// ── small helpers ──────────────────────────────────────────────────────────

function tracked(doc, str, x, y, { font = 'light', size = 8, color = INK, track = TRACK } = {}) {
  const s = String(str || '').toUpperCase();
  return doc.text(s, x, y, { font, size, color, charSpacing: size * track });
}

function trackedRight(doc, str, xRight, y, opts = {}) {
  const s = String(str || '').toUpperCase();
  const size = opts.size || 8; const cs = size * (opts.track ?? TRACK);
  const w = doc.measure(opts.font || 'light', s, size) + cs * s.length;
  return tracked(doc, s, xRight - w, y, opts);
}

/** Cut a string to a width, with an ellipsis. */
function fit(doc, text, font, size, maxW) {
  let t = String(text ?? '');
  if (doc.measure(font, t, size) <= maxW) return t;
  while (t.length > 2 && doc.measure(font, `${t}…`, size) > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const firstSentences = (text, n) => String(text || '').split(/(?<=[.!?])\s+/).slice(0, n).join(' ');

function circleOps(cx, cy, r) {
  const k = 0.5523 * r;
  const f = (v) => v.toFixed(2);
  return [
    `${f(cx + r)} ${f(cy)} m`,
    `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
    `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
    `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
    `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
    'h',
  ].join(' ');
}

/** A pie wedge from angle a0 to a1 (radians, standard orientation, decreasing = clockwise). */
function wedgeOps(cx, cy, r, a0, a1) {
  const f = (v) => v.toFixed(2);
  const ops = [`${f(cx)} ${f(cy)} m`, `${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))} l`];
  const total = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const d = total / steps;
  const k = (4 / 3) * Math.tan(d / 4);
  let a = a0;
  for (let i = 0; i < steps; i += 1) {
    const b = a + d;
    const x1 = cx + r * (Math.cos(a) - k * Math.sin(a)); const y1 = cy + r * (Math.sin(a) + k * Math.cos(a));
    const x2 = cx + r * (Math.cos(b) + k * Math.sin(b)); const y2 = cy + r * (Math.sin(b) - k * Math.cos(b));
    ops.push(`${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(cx + r * Math.cos(b))} ${f(cy + r * Math.sin(b))} c`);
    a = b;
  }
  ops.push('h');
  return ops.join(' ');
}

const toneColor = (t) => (t === 'gain' ? POS : t === 'loss' ? NEG : t === 'benchmark' ? COPPER : INK);
const signColor = (v) => (v == null ? INK : v < 0 ? NEG : v > 0 ? POS : INK);

// ── composition ────────────────────────────────────────────────────────────

function compose(doc, model, b, maxPages) {
  const blocks = buildBlocks(doc, model, b);
  const discH = disclaimerHeight(doc, model);
  const floorLast = PAGE.footerH + discH + 12;
  const floorMore = PAGE.footerH + 22;
  let pageNo = 0; let y = 0;
  const omitted = [];
  const newPage = () => { pageNo += 1; doc.addPage(); y = drawMasthead(doc, model, pageNo); };
  newPage();

  for (const block of blocks) {
    let floor = pageNo >= maxPages ? floorLast : floorMore;
    if (y - block.height < floor) {
      if (pageNo < maxPages) { drawFoot(doc, model, pageNo, false, discH); newPage(); floor = pageNo >= maxPages ? floorLast : floorMore; }
      if (y - block.height < floor) { omitted.push(block.key); continue; }
    }
    y = block.draw(y) - (block.gap ?? 12);
  }
  if (y < floorLast && pageNo < maxPages) { drawFoot(doc, model, pageNo, false, discH); newPage(); }
  drawFoot(doc, model, pageNo, true, discH);
  return omitted;
}

// ── chrome ─────────────────────────────────────────────────────────────────

function drawMasthead(doc, model, pageNo) {
  doc.rect(0, H - PAGE.headerH, A4.width, PAGE.headerH, { fill: BAR });
  const baseline = H - 45;
  let cx = 30.6;
  cx += tracked(doc, model.header.title_light, cx, baseline, { font: 'light', size: 14, color: HEADER_TEXT, track: 0.32 });
  cx += 14 * 0.32;
  cx += tracked(doc, model.header.title_bold, cx, baseline, { font: 'sans7', size: 14, color: HEADER_TEXT, track: 0.32 });
  cx += 16;
  doc.text('l', cx, baseline, { font: 'light', size: 8, color: COPPER });
  cx += 14;
  tracked(doc, model.header.date, cx, baseline + 0.5, { font: 'light', size: 8, color: SAGE, track: 0.32 });
  const scale = 28.9 / 238.67;
  doc.path(svgPathToPdf(LOGO_SYMBOL_PATH, { x: A4.width - 20 - 28.9 * LOGO_SYMBOL_ASPECT, y: H - 31.1 - 28.9, scale, viewBox: [6, 0, 266.33, 238.67] }), { fill: '#FFFFFF', stroke: null, fillRule: 'evenodd' });
  return H - PAGE.headerH - (pageNo === 1 ? 26 : 30);
}

function disclaimerHeight(doc, model) {
  const text = (model.disclosures || []).join(' ');
  return doc.paragraphHeight(text, { font: 'light', size: 7.2, leading: 7.2 * 1.6, maxWidth: W - 2 }) + 32;
}

function drawFoot(doc, model, pageNo, isLast, discH) {
  doc.rect(0, 0, A4.width, PAGE.footerH, { fill: COPPER });
  tracked(doc, 'XP Asset Management', 31.3, 9.8, { font: 'light', size: 8, color: INK, track: 0.32 });
  doc.textRight(String(pageNo), A4.width - 31.3, 9.6, { font: 'sans', size: 8.8, color: '#FFFFFF' });
  if (isLast) {
    const top = PAGE.footerH + discH;
    doc.rect(0, PAGE.footerH, A4.width, discH, { fill: BAR });
    tracked(doc, 'Disclaimer', 31.9, top - 14, { font: 'sans', size: 8.5, color: COPPER });
    doc.paragraph((model.disclosures || []).join(' '), 31.9, top - 26, { font: 'light', size: 7.2, leading: 7.2 * 1.6, maxWidth: W - 2, color: '#FFFFFF' });
  } else {
    doc.text('Continua na página 2', X, PAGE.footerH + 10, { font: 'light', size: 7.4, color: INK3 });
  }
}

/** §06 the article title: Roboto Bold, capitals, copper. */
function sectionTitle(doc, y, title, meta = null) {
  doc.text(String(title).toUpperCase(), X, y - 8, { font: 'sans7', size: 9.2, color: COPPER2, charSpacing: 0.25 });
  if (meta) doc.textRight(meta, X + W, y - 8, { font: 'light', size: 6.8, color: INK3 });
  return y - 22;
}

/** §08 a header band: charcoal (or copper for the name cell) with white capitals. */
function headerBand(doc, x, y, w, h, cells, { fill = CHARCOAL } = {}) {
  doc.rect(x, y - h, w, h, { fill });
  for (const c of cells) {
    if (c.fill && c.fill !== fill) doc.rect(c.x0, y - h, c.w, h, { fill: c.fill });
    const text = String(c.label).toUpperCase();
    const opts = { font: 'sans', size: 6.0, color: '#FFFFFF', charSpacing: 0.45 };
    const tw = doc.measure('sans', text, 6.0) + 0.45 * text.length;
    const tx = c.align === 'right' ? c.x0 + c.w - 4 - tw : c.align === 'center' ? c.x0 + (c.w - tw) / 2 : c.x0 + 4;
    doc.text(text, tx, y - h + (h - 6) / 2 + 0.6, opts);
  }
  return y - h;
}

// ── blocks ─────────────────────────────────────────────────────────────────

function buildBlocks(doc, model, b) {
  const blocks = [];

  // ── identification: "DADOS ATÉ" and the fact sheet's label boxes ─────────
  blocks.push({
    key: 'ident', height: 40, gap: 14,
    draw: (y) => {
      tracked(doc, model.data_until, X, y - 8, { font: 'light', size: 8.4, color: COPPER, track: 0.16 });
      const row = y - 30;
      const pairs = [
        ['Nome', model.client.name, COPPER2],
        ['Perfil', model.client.profile || '—', INK],
        ['Assessor', `${model.advisor.name}${model.advisor.code ? ` (${model.advisor.code})` : ''}`, INK],
        ['Política', model.policy.version != null ? `v${model.policy.version}${model.policy.effective ? ` · ${model.policy.effective}` : ''}` : '—', INK],
      ];
      const pw = W / pairs.length;
      pairs.forEach(([label, value, colour], i) => {
        const px = X + i * pw;
        doc.rect(px, row - 4, 40, 13, { fill: G100 });
        doc.textCenter(label, px + 20, row, { font: 'sans7', size: 6.4, color: INK });
        doc.text(fit(doc, value, 'sans', 7.4, pw - 50), px + 46, row, { font: 'sans', size: 7.4, color: colour });
      });
      return row - 6;
    },
  });

  // ── visão de mercado ─────────────────────────────────────────────────────
  {
    const text = firstSentences(model.market_view, b.narrativeSentences);
    const headline = model.headline ? fit(doc, model.headline, 'light', 10.5, W) : null;
    const paraH = doc.paragraphHeight(text, { font: 'light', size: 9, leading: 14.4, maxWidth: W });
    const rowsPer = Math.min(b.indicatorsPerBlock, Math.max(...model.market_blocks.map((m) => m.rows.length), 0));
    const tableH = rowsPer ? 13 + rowsPer * 11.5 : 0;
    const height = 22 + (headline ? 16 : 0) + paraH + (tableH ? 10 + tableH + 10 : 0);
    blocks.push({
      key: 'market', height, gap: 12,
      draw: (y) => {
        let cy = sectionTitle(doc, y, 'Visão de mercado', model.market_date ? `Panorama de ${model.market_date}` : null);
        if (headline) { doc.text(headline, X, cy - 2, { font: 'light', size: 10.5, color: INK }); cy -= 16; }
        cy = doc.paragraph(text, X, cy - 2, { font: 'light', size: 9, leading: 14.4, maxWidth: W, color: INK });
        if (!tableH) return cy;
        cy -= 8;
        const bw = (W - GUTTER) / 2;
        model.market_blocks.forEach((blk, i) => drawIndexTable(doc, X + i * (bw + GUTTER), cy, bw, blk, rowsPer));
        return cy - tableH - 6;
      },
    });
  }

  // ── performance ──────────────────────────────────────────────────────────
  {
    const comment = firstSentences(model.performance_comment, b.narrativeSentences);
    const commentH = comment ? doc.paragraphHeight(comment, { font: 'light', size: 9, leading: 14.4, maxWidth: W }) + 6 : 0;
    const chartH = b.chart ? 152 : 0;
    const kvH = 2 * 62 + 10;
    const rowH = Math.max(chartH, kvH);
    const height = 22 + 50 + commentH + 8 + rowH;
    blocks.push({
      key: 'performance', height, gap: 12,
      draw: (y) => {
        let cy = sectionTitle(doc, y, 'Performance', model.figures[0] ? `Rentabilidade apurada até o fim do mês de referência` : null);
        cy = drawFigureStrip(doc, model.figures, X, cy, W);
        if (comment) { cy = doc.paragraph(comment, X, cy - 4, { font: 'light', size: 9, leading: 14.4, maxWidth: W, color: INK }); cy -= 2; }
        cy -= 6;
        const chartW = b.chart ? W * 0.60 : 0;
        const kvX = b.chart ? X + chartW + GUTTER : X;
        const kvW = b.chart ? W - chartW - GUTTER : W;
        if (b.chart) drawHistoryChart(doc, model.chart, X, cy, chartW, chartH);
        let ky = drawKvBlock(doc, model.performance_block, kvX, cy, kvW);
        ky -= 10;
        drawKvBlock(doc, model.risk_block, kvX, ky, kvW);
        return cy - rowH;
      },
    });
  }

  // ── monthly matrix ───────────────────────────────────────────────────────
  if (b.matrix && model.matrix.rows.length) {
    const rows = model.matrix.rows.slice(0, b.matrixYears);
    const height = 14 + 12 + rows.length * 11 + (model.matrix.simulated ? 10 : 0);
    blocks.push({
      key: 'matrix', height, gap: 12,
      draw: (y) => drawMatrix(doc, model.matrix, rows, X, y, W),
    });
  }

  // ── alocação ─────────────────────────────────────────────────────────────
  {
    const comment = firstSentences(model.allocation_comment, 2);
    const commentH = comment ? doc.paragraphHeight(comment, { font: 'light', size: 9, leading: 14.4, maxWidth: W }) + 6 : 0;
    const leftW = W * 0.56; const rightW = W - leftW - GUTTER;
    const classes = model.composition.classes.map((c) => ({ ...c, shown: c.items.slice(0, b.compositionItems), more: Math.max(0, c.items.length - b.compositionItems) }));
    const compH = 12 + classes.reduce((a, c) => a + 4 + 12 + c.shown.length * 9.5 + (c.more ? 9.5 : 0), 0) + 4 + 12;
    const pieH = b.pie ? 82 : 0;
    const viewH = b.allocView ? 24 + model.alloc_view.length * 12 + 6 : 0;
    const rightH = pieH + (pieH && viewH ? 8 : 0) + viewH;
    const height = 22 + commentH + Math.max(compH, rightH);
    blocks.push({
      key: 'allocation', height, gap: 16,
      draw: (y) => {
        let cy = sectionTitle(doc, y, 'Alocação', `${model.positions_count} posições · ${model.total_label}`);
        if (comment) { cy = doc.paragraph(comment, X, cy - 2, { font: 'light', size: 9, leading: 14.4, maxWidth: W, color: INK }); cy -= 6; }
        const top = cy;
        drawComposition(doc, classes, model.composition.total_label, X, top, leftW);
        let ry = top;
        if (b.pie) { drawPie(doc, model.pie, X + leftW + GUTTER, ry, rightW, pieH); ry -= pieH + 8; }
        if (b.allocView) drawAllocView(doc, model.alloc_view, X + leftW + GUTTER, ry, rightW);
        return top - Math.max(compH, rightH);
      },
    });
  }

  // ── pontos a discutir ────────────────────────────────────────────────────
  {
    const items = model.discussion.slice(0, b.discussion);
    if (items.length) {
      const bodyW = W - 66 - 12;
      const rows = items.map((d) => {
        const lines = doc.wrap(d.text, { font: 'light', size: 7.8, maxWidth: bodyW });
        const titleLines = doc.wrap(String(d.title).toUpperCase(), { font: 'sans7', size: 5.8, maxWidth: 58 }).slice(0, 3);
        const h = Math.max(24, lines.length * 11.2 + 10, titleLines.length * 7.5 + 10);
        return { ...d, lines, titleLines, h };
      });
      const height = 22 + rows.reduce((a, r) => a + r.h, 0);
      blocks.push({
        key: 'discussion', height, gap: 10,
        draw: (y) => {
          let cy = sectionTitle(doc, y, 'Pontos a discutir', model.next_meeting ? `Próxima reunião ${model.next_meeting}` : `${rows.length} ${rows.length === 1 ? 'ponto' : 'pontos'}`);
          for (const r of rows) cy = drawCallout(doc, r, X, cy, W);
          return cy;
        },
      });
    }
  }

  // ── fonte ────────────────────────────────────────────────────────────────
  blocks.push({
    key: 'sources', height: doc.paragraphHeight(model.sources_line, { font: 'light', size: 6.6, leading: 9.5, maxWidth: W }) + 4, gap: 4,
    draw: (y) => doc.paragraph(model.sources_line, X, y - 2, { font: 'light', size: 6.6, leading: 9.5, maxWidth: W, color: INK2 }),
  });

  return blocks;
}

// ── drawing ────────────────────────────────────────────────────────────────

/** §08 B · the Comitê's index table: name cells on grey, values on lighter grey, a white grid. */
function drawIndexTable(doc, x, y, w, block, maxRows) {
  const cols = [0.44, 0.22, 0.17, 0.17].map((f) => f * w);
  const xs = [x, x + cols[0], x + cols[0] + cols[1], x + cols[0] + cols[1] + cols[2]];
  const hh = 13; const rh = 11.5;
  headerBand(doc, x, y, w, hh, [
    { x0: xs[0], w: cols[0], label: block.title, fill: COPPER },
    { x0: xs[1], w: cols[1], label: 'Nível', align: 'right', fill: BAR },
    { x0: xs[2], w: cols[2], label: 'Dia', align: 'right', fill: BAR },
    { x0: xs[3], w: cols[3], label: '30 dias', align: 'right', fill: BAR },
  ], { fill: BAR });
  let cy = y - hh;
  for (const r of block.rows.slice(0, maxRows)) {
    doc.rect(xs[0], cy - rh, cols[0], rh, { fill: G200 });
    doc.rect(xs[1], cy - rh, w - cols[0], rh, { fill: G100 });
    doc.line(xs[1], cy, xs[1], cy - rh, { color: '#FFFFFF', width: 0.5 });
    doc.line(xs[2], cy, xs[2], cy - rh, { color: '#FFFFFF', width: 0.5 });
    doc.line(xs[3], cy, xs[3], cy - rh, { color: '#FFFFFF', width: 0.5 });
    doc.line(x, cy - rh, x + w, cy - rh, { color: '#FFFFFF', width: 0.5 });
    const ty = cy - rh + 3.4;
    doc.text(fit(doc, r.label, 'light', 6.6, cols[0] - 8), xs[0] + 4, ty, { font: 'light', size: 6.6, color: INK });
    doc.textRight(r.level, xs[1] + cols[1] - 4, ty, { font: 'light', size: 6.6, color: INK });
    doc.textRight(r.day, xs[2] + cols[2] - 4, ty, { font: 'light', size: 6.6, color: signColor(r.day_v) });
    doc.textRight(r.d30, xs[3] + cols[3] - 4, ty, { font: 'light', size: 6.6, color: signColor(r.d30_v) });
    cy -= rh;
  }
  return cy;
}

/** The figure strip: tracked labels in sage, Light values, the month's return emphasised. */
function drawFigureStrip(doc, figures, x, y, w) {
  const figs = figures.slice(0, 5);
  const colW = w / figs.length;
  doc.line(x, y, x + w, y, { color: '#C8C8C8', width: 0.75 });
  figs.forEach((f, i) => {
    const cx = x + i * colW;
    const label = fit(doc, String(f.label).toUpperCase(), 'sans', 6, colW - 8 - 0.9 * f.label.length);
    doc.text(label, cx, y - 11, { font: 'sans', size: 6, color: SAGE, charSpacing: 0.9 });
    let size = f.emphasis ? 15 : 12;
    const font = f.emphasis ? 'sans' : 'light';
    while (size > 8 && doc.measure(font, f.value, size) > colW - 8) size -= 0.5;
    doc.text(f.value, cx, y - 32, { font, size, color: toneColor(f.tone) });
  });
  doc.line(x, y - 40, x + w, y - 40, { color: RULE, width: 0.6 });
  return y - 44;
}

/** §09 the Excel grammar of the fund sheet: a pale frame, horizontal grid, the copper line. */
function drawHistoryChart(doc, chart, x, y, w, h) {
  doc.rect(x, y - h, w, h, { stroke: FRAME, lineWidth: 0.83 });
  doc.textCenter(chart.title, x + w / 2, y - 12, { font: 'sans7', size: 8, color: CHART_TITLE });
  const pad = { l: 36, r: 10, t: 22, b: 30 };
  const px = x + pad.l; const pw = w - pad.l - pad.r; const py = y - h + pad.b; const ph = h - pad.t - pad.b;
  const port = chart.portfolio || []; const bench = chart.benchmark || [];
  if (port.length < 2) return;
  const vals = [...port, ...bench].map((p) => p.value);
  const lo = Math.min(0, ...vals); const hi = Math.max(0, ...vals);
  const span = Math.max(1e-6, hi - lo);
  const step = niceStep(span / 4);
  const y0 = Math.floor(lo / step) * step; const y1 = Math.ceil(hi / step) * step;
  const sy = (v) => py + ((v - y0) / (y1 - y0)) * ph;
  const sx = (i, n) => px + (i / Math.max(1, n - 1)) * pw;
  for (let v = y0; v <= y1 + step / 2; v += step) {
    doc.line(px, sy(v), px + pw, sy(v), { color: FRAME, width: 0.6 });
    doc.textRight(`${(v * 100).toFixed(0).replace('-', '−')}%`, px - 4, sy(v) - 2, { font: 'light', size: 5.5, color: AXIS });
  }
  const n = port.length;
  const every = n > 30 ? 6 : n > 18 ? 3 : 2;
  for (let i = 0; i < n; i += every) {
    const m = port[i].month;
    doc.textCenter(`${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`, sx(i, n), py - 9, { font: 'light', size: 5.5, color: AXIS });
  }
  const pathOf = (pts) => pts.map((p, i) => `${sx(i, pts.length).toFixed(2)} ${sy(p.value).toFixed(2)} ${i ? 'l' : 'm'}`).join(' ');
  if (bench.length > 1) doc.path(pathOf(bench), { stroke: NEU, width: 0.8, cap: 1, join: 1 });
  doc.path(pathOf(port), { stroke: COPPER2, width: 1.65, cap: 1, join: 1 });
  // legend inside the frame, bottom left
  const ly = y - h + 8;
  doc.line(px, ly + 2, px + 14, ly + 2, { color: COPPER2, width: 1.65 });
  doc.text(chart.legend[0], px + 18, ly, { font: 'light', size: 5.8, color: INK2 });
  const lw = doc.measure('light', chart.legend[0], 5.8);
  doc.line(px + 26 + lw, ly + 2, px + 40 + lw, ly + 2, { color: NEU, width: 0.8 });
  doc.text(chart.legend[1], px + 44 + lw, ly, { font: 'light', size: 5.8, color: INK2 });
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(1e-9, raw)));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
}

/** The fund sheet's key-value block: a titled row on grey, then label Bold / value Light on alternating bands. */
function drawKvBlock(doc, block, x, y, w) {
  const rh = 11;
  doc.rect(x, y - rh, w, rh, { fill: G100 });
  doc.textCenter(block.title, x + w / 2, y - rh + 3.3, { font: 'sans7', size: 6.6, color: INK });
  let cy = y - rh;
  block.rows.forEach(([label, value], i) => {
    if (i % 2 === 1) doc.rect(x, cy - rh, w, rh, { fill: G100 });
    doc.text(label, x + 5, cy - rh + 3.3, { font: 'sans7', size: 6.4, color: INK });
    doc.textRight(value, x + w - 5, cy - rh + 3.3, { font: 'light', size: 6.6, color: INK });
    cy -= rh;
  });
  return cy;
}

/** §08 F · the monthly-return matrix: months across, years down, negatives in red, a total column. */
function drawMatrix(doc, matrix, rows, x, y, w) {
  const yearW = 34; const totalW = 40; const mW = (w - yearW - totalW) / 12;
  const hh = 12; const rh = 11;
  doc.rect(x, y - hh, w, hh, { fill: G100 });
  matrix.months.forEach((m, i) => doc.textCenter(m, x + yearW + i * mW + mW / 2, y - hh + 3.6, { font: 'sans7', size: 5.8, color: INK }));
  doc.textCenter('Total', x + w - totalW / 2, y - hh + 3.6, { font: 'sans7', size: 5.8, color: INK });
  let cy = y - hh;
  for (const r of rows) {
    doc.rect(x, cy - rh, yearW, rh, { fill: G100 });
    doc.textCenter(r.year, x + yearW / 2, cy - rh + 3.3, { font: 'sans7', size: 6.2, color: INK });
    r.cells.forEach((c, i) => doc.textCenter(c, x + yearW + i * mW + mW / 2, cy - rh + 3.3, { font: 'sans', size: 5.8, color: signColor(r.values[i]) === POS ? CHARCOAL : signColor(r.values[i]) }));
    doc.textCenter(r.total, x + w - totalW / 2, cy - rh + 3.3, { font: 'sans7', size: 6, color: signColor(r.total_v) === POS ? INK : signColor(r.total_v) });
    doc.line(x, cy - rh, x + w, cy - rh, { color: RULE2, width: 0.4 });
    cy -= rh;
  }
  if (matrix.simulated) { doc.text('Retornos mensais anteriores à plataforma reconstruídos a partir dos extratos (simulados).', x, cy - 8, { font: 'light', size: 5.8, color: INK3 }); cy -= 10; }
  return cy;
}

/** §08 E · the composição table: copper class rows on grey, items in Light, a TOTAL row. */
function drawComposition(doc, classes, totalLabel, x, y, w) {
  let cy = headerBand(doc, x, y, w, 12, [{ x0: x, w: w - 44, label: 'Composição' }, { x0: x + w - 44, w: 44, label: '%', align: 'right' }]);
  for (const c of classes) {
    cy -= 4;
    doc.rect(x, cy - 12, w, 12, { fill: G200 });
    doc.text(fit(doc, `${c.label} | ${c.weight_label}`, 'sans7', 7, w - 60), x + 4, cy - 12 + 3.6, { font: 'sans7', size: 7, color: COPPER3 });
    doc.textRight(c.weight_label, x + w - 4, cy - 12 + 3.6, { font: 'sans7', size: 7, color: COPPER3 });
    cy -= 12;
    for (const it of c.shown) {
      doc.text(fit(doc, it.name, 'light', 6.6, w - 52), x + 4, cy - 9.5 + 2.8, { font: 'light', size: 6.6, color: INK });
      doc.textRight(it.weight_label, x + w - 4, cy - 9.5 + 2.8, { font: 'light', size: 6.6, color: INK });
      cy -= 9.5;
    }
    if (c.more) { doc.text(`+ ${c.more} ${c.more === 1 ? 'outra posição' : 'outras posições'}`, x + 4, cy - 9.5 + 2.8, { font: 'light', size: 6.2, color: INK3 }); cy -= 9.5; }
  }
  cy -= 4;
  doc.rect(x, cy - 12, w, 12, { fill: G250 });
  doc.text('TOTAL', x + 4, cy - 12 + 3.6, { font: 'sans7', size: 7, color: COPPER3 });
  doc.textRight(totalLabel, x + w - 4, cy - 12 + 3.6, { font: 'sans7', size: 7, color: COPPER3 });
  return cy - 12;
}

/** §08 A · the pie, twelve o'clock start, clockwise, with a direct legend. */
function drawPie(doc, slices, x, y, w, h) {
  const r = 32; const cx = x + r + 4; const cy = y - h / 2;
  let a = Math.PI / 2;
  const total = slices.reduce((s, p) => s + p.weight, 0) || 1;
  for (const s of slices) {
    const sweep = (s.weight / total) * Math.PI * 2;
    if (sweep <= 0) continue;
    doc.path(wedgeOps(cx, cy, r, a, a - sweep), { fill: s.color, stroke: '#FFFFFF', width: 0.5 });
    if (s.weight / total > 0.08) {
      const mid = a - sweep / 2;
      doc.textCenter(`${(s.weight * 100).toFixed(0)}%`, cx + r * 0.62 * Math.cos(mid), cy + r * 0.62 * Math.sin(mid) - 2.2, { font: 'sans7', size: 6, color: inkOn(s.color) });
    }
    a -= sweep;
  }
  let ly = y - 10;
  const lx = cx + r + 12;
  for (const s of slices.slice(0, 8)) {
    doc.rect(lx, ly - 5.5, 6, 6, { fill: s.color });
    doc.text(fit(doc, s.label, 'light', 6.4, w - (lx - x) - 44), lx + 9, ly - 4.6, { font: 'light', size: 6.4, color: INK });
    doc.textRight(`${(s.weight * 100).toFixed(1).replace('.', ',')}%`, x + w, ly - 4.6, { font: 'sans', size: 6.4, color: INK });
    ly -= 9.4;
  }
}

/** §07 the Comitê's allocation view: five columns from underweight to overweight, a dot per class, the month's change. */
function drawAllocView(doc, rows, x, y, w) {
  const labelW = Math.min(96, w * 0.42);
  const chgX = x + labelW + 6;
  const axisX = chgX + 16;
  const colsW = w - (axisX - x) - 6;
  const colX = (i) => axisX + (colsW / 5) * (i + 0.5);
  const symbols = ['--', '-', '=', '+', '++'];
  const hdr = { font: 'sans7', size: 4.2, color: INK, track: 0.15 };
  tracked(doc, 'Underweight', axisX + 2, y - 7, hdr);
  const nw = doc.measure('sans7', 'NEUTRO', 4.2) + 4.2 * 0.15 * 6;
  tracked(doc, 'Neutro', colX(2) - nw / 2, y - 7, hdr);
  trackedRight(doc, 'Overweight', x + w - 2, y - 7, hdr);
  symbols.forEach((s, i) => doc.textCenter(s, colX(i), y - 17, { font: 'sans7', size: 6.5, color: INK2 }));
  doc.textCenter('Mud.', chgX + 6, y - 17, { font: 'sans7', size: 5, color: INK2 });
  let cy = y - 24;
  doc.line(axisX, cy + 2, axisX, cy - rows.length * 12 + 2, { color: INK, width: 0.6 });
  for (const r of rows) {
    const mid = cy - 6;
    doc.line(axisX, mid, x + w, mid, { color: G200, width: 0.6 });
    doc.text(fit(doc, String(r.label).toUpperCase(), 'sans7', 5.6, labelW), x, mid - 2, { font: 'sans7', size: 5.6, color: INK2, charSpacing: 0.2 });
    // the change glyph: up, down, or a dash
    const gx = chgX + 6;
    if (r.change === 1) doc.path(`${(gx - 3.2).toFixed(2)} ${(mid - 2.2).toFixed(2)} m ${(gx + 3.2).toFixed(2)} ${(mid - 2.2).toFixed(2)} l ${gx.toFixed(2)} ${(mid + 2.4).toFixed(2)} l h`, { fill: OW, stroke: null });
    else if (r.change === -1) doc.path(`${(gx - 3.2).toFixed(2)} ${(mid + 2.2).toFixed(2)} m ${(gx + 3.2).toFixed(2)} ${(mid + 2.2).toFixed(2)} l ${gx.toFixed(2)} ${(mid - 2.4).toFixed(2)} l h`, { fill: DOWN, stroke: null });
    else doc.line(gx - 3.5, mid, gx + 3.5, mid, { color: NEU, width: 1.6 });
    const colour = r.position < 0 ? UW : r.position > 0 ? OW : NEU;
    doc.path(circleOps(colX(r.position + 2), mid, 3.4), { fill: colour, stroke: null });
    cy -= 12;
  }
  return cy;
}

/** §06 the decision callout: a slate label cell beside the text, a hairline below. */
function drawCallout(doc, r, x, y, w) {
  const labW = 66;
  doc.rect(x, y - r.h, labW, r.h, { fill: SLATE });
  const th = r.titleLines.length * 7.5;
  let ty = y - (r.h - th) / 2 - 5.4;
  for (const l of r.titleLines) { doc.textCenter(l, x + labW / 2, ty, { font: 'sans7', size: 5.8, color: '#FEFFFF', charSpacing: 0.2 }); ty -= 7.5; }
  const textH = r.lines.length * 11.2;
  let by = y - (r.h - textH) / 2 - 8.2;
  for (const l of r.lines) { doc.text(l, x + labW + 12, by, { font: 'light', size: 7.8, color: BAR }); by -= 11.2; }
  doc.line(x, y - r.h, x + w, y - r.h, { color: RULE, width: 0.75 });
  return y - r.h;
}
