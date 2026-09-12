/**
 * The client's two-page report, rendered programmatically.
 *
 * A letter in short pieces around the charts, in the Carteira XP Global
 * Strategies grammar inside the Carta's frame: the 69 pt #242424 header bar
 * with the tracked series title and the white symbol, the 27 pt copper footer,
 * a tracked "DADOS ATÉ" line, article titles in Roboto Bold copper, the framed
 * chart with the copper line, and the disclaimer as white Light text on the bar
 * colour (brand §05, §06, §08, §09).
 *
 * Page one greets the client by name, says what is happening in the world and
 * which events matter, then shows the performance: the figures, the cumulative
 * curve beside the risk-and-return of each asset held over twelve months. Page
 * two says what could improve the result and what could make it worse, shows
 * the portfolio as it stands, and closes with the advisor's sign-off.
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
const BAR = '#242424'; const COPPER = '#BB795E'; const COPPER2 = '#C57D5C';
const SAGE = '#A1A894'; const CHARCOAL = '#45484A'; const SLATE = '#2A3B43'; const HEADER_TEXT = '#DDDDDD';
const G100 = '#F2F2F2';
const POS = '#548235'; const NEG = '#A62900';
const FRAME = '#E0E5EB'; const AXIS = '#44546A'; const CHART_TITLE = '#3B3838';
const OW = '#385723'; const DOWN = '#C00000'; const NEU = '#7F7F7F';

const PAGE = { left: 30.2, right: 29.8, headerH: 69.3, footerH: 26.7 };
const X = PAGE.left;
const W = A4.width - PAGE.left - PAGE.right;
const H = A4.height;
const GUTTER = 14;
const TRACK = 0.3;

/** The reduction ladder: what is trimmed at each level when two pages are not enough, least important first. */
const LADDER = [
  {},
  { holdings: 6 },
  { events: 3 },
  { items: 3 },
  { narrativeSentences: 3 },
  { holdingsTable: false },
  { events: 2, items: 2 },
  { pie: false },
  { cumulative: false },
  { events: 1, scatterLabels: false },
  { narrativeSentences: 2, items: 1 },
];

function budget(level) {
  const b = { holdings: 10, holdingsTable: true, events: 4, items: 4, narrativeSentences: 4, pie: true, cumulative: true, scatterLabels: true, level };
  for (let i = 1; i <= level; i += 1) Object.assign(b, LADDER[i] || {});
  return b;
}

export async function renderReportPdf(model, { fonts, maxPages = 2 } = {}) {
  let best = null;
  for (let level = 0; level < LADDER.length; level += 1) {
    const doc = new PdfDocument({
      title: `Relatório mensal — ${model.client?.name} — ${model.data_until}`,
      author: `${model.advisor?.name} · XP Asset Management`,
      subject: 'Relatório mensal ao cliente',
      keywords: 'relatório mensal, carteira, XP Asset Management',
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
const pctLabel = (v) => `${(v * 100).toFixed(0).replace('-', '−')}%`;

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(1e-9, raw)));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
}

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

/** §06 the article title: Roboto Bold, capitals, copper. `y` is the block's top edge. */
function sectionTitle(doc, y, title, meta = null) {
  doc.text(String(title).toUpperCase(), X, y - 8, { font: 'sans7', size: 9.2, color: COPPER2, charSpacing: 0.25 });
  if (meta) doc.textRight(meta, X + W, y - 8, { font: 'light', size: 6.8, color: INK3 });
  return y - 22;
}

/** §08 a header band: charcoal with white capitals. */
function headerBand(doc, x, y, w, h, cells, { fill = CHARCOAL } = {}) {
  doc.rect(x, y - h, w, h, { fill });
  for (const c of cells) {
    const text = String(c.label).toUpperCase();
    const tw = doc.measure('sans', text, 6.0) + 0.45 * text.length;
    const tx = c.align === 'right' ? c.x0 + c.w - 4 - tw : c.align === 'center' ? c.x0 + (c.w - tw) / 2 : c.x0 + 4;
    doc.text(text, tx, y - h + (h - 6) / 2 + 0.6, { font: 'sans', size: 6.0, color: '#FFFFFF', charSpacing: 0.45 });
  }
  return y - h;
}

const BODY = { font: 'light', size: 9.2, leading: 14.6 };
const para = (doc, text, x, y, w, color = INK) => doc.paragraph(text, x, y, { ...BODY, maxWidth: w, color });
const paraH = (doc, text, w) => (text ? doc.paragraphHeight(text, { ...BODY, maxWidth: w }) : 0);

// ── blocks ─────────────────────────────────────────────────────────────────

function buildBlocks(doc, model, b) {
  const blocks = [];
  const sentences = (t) => firstSentences(t, b.narrativeSentences);

  // ── the greeting: "DADOS ATÉ", the meta line, the client's name, the opening ──
  {
    const opening = sentences(model.opening);
    const height = 22 + 22 + paraH(doc, opening, W);
    blocks.push({
      key: 'greeting', height, gap: 14,
      draw: (y) => {
        tracked(doc, model.data_until, X, y - 8, { font: 'light', size: 8.4, color: COPPER, track: 0.16 });
        doc.textRight(model.meta_line, X + W, y - 8, { font: 'light', size: 6.8, color: INK3 });
        doc.text(model.greeting, X, y - 34, { font: 'light', size: 13, color: INK });
        return opening ? para(doc, opening, X, y - 52, W) : y - 44;
      },
    });
  }

  // ── o que está acontecendo no mundo ──────────────────────────────────────
  {
    const text = sentences(model.world.text);
    const events = model.world.events.slice(0, b.events);
    const colW = (W - GUTTER) / 2;
    const cards = events.map((e) => {
      const lines = doc.wrap(e.text, { font: 'light', size: 7.6, maxWidth: colW - 12 });
      return { ...e, lines, h: 13 + lines.length * 10.2 + (e.source ? 9 : 2) + 6 };
    });
    const rowsH = [];
    for (let i = 0; i < cards.length; i += 2) rowsH.push(Math.max(cards[i].h, cards[i + 1]?.h ?? 0));
    const gridH = rowsH.reduce((a, h) => a + h, 0) + (rowsH.length ? 4 : 0);
    const height = 22 + paraH(doc, text, W) + (gridH ? 8 + gridH : 0);
    blocks.push({
      key: 'world', height, gap: 12,
      draw: (y) => {
        let cy = sectionTitle(doc, y, 'O que está acontecendo no mundo', model.world.date_label ? `Panorama de ${model.world.date_label}` : null);
        if (text) cy = para(doc, text, X, cy - 2, W);
        if (!cards.length) return cy;
        cy -= 8;
        for (let i = 0; i < cards.length; i += 2) {
          const rowH = rowsH[i / 2];
          for (const j of [0, 1]) {
            const c = cards[i + j]; if (!c) continue;
            const cx = X + j * (colW + GUTTER);
            drawEventCard(doc, c, cx, cy, colW);
          }
          cy -= rowH;
        }
        return cy - 4;
      },
    });
  }

  // ── sua performance: the figures, the comment, the two charts ────────────
  {
    const comment = sentences(model.performance.comment);
    const assetsComment = firstSentences(model.performance.assets_comment, 2);
    const chartH = 168;
    const height = 22 + 48 + paraH(doc, comment, W) + 10 + chartH + (assetsComment ? 8 + paraH(doc, assetsComment, W) : 0) + (model.performance.scatter.excluded_note ? 10 : 0);
    blocks.push({
      key: 'performance', height, gap: 12,
      draw: (y) => {
        let cy = sectionTitle(doc, y, 'Sua performance', 'Rentabilidade apurada até o fim do mês de referência');
        cy = drawFigureStrip(doc, model.performance.figures, X, cy, W);
        if (comment) cy = para(doc, comment, X, cy - 2, W);
        cy -= 10;
        const colW = (W - GUTTER) / 2;
        if (b.cumulative) {
          drawHistoryChart(doc, model.performance.chart, X, cy, colW, chartH);
          drawScatter(doc, model.performance.scatter, X + colW + GUTTER, cy, colW, chartH, b.scatterLabels);
        } else {
          drawScatter(doc, model.performance.scatter, X, cy, W, chartH, b.scatterLabels);
        }
        cy -= chartH;
        if (assetsComment) cy = para(doc, assetsComment, X, cy - 10, W);
        if (model.performance.scatter.excluded_note) { doc.text(fit(doc, model.performance.scatter.excluded_note, 'light', 6.2, W), X, cy - 8, { font: 'light', size: 6.2, color: INK3 }); cy -= 10; }
        return cy;
      },
    });
  }

  // ── o que pode melhorar, o que pode piorar ───────────────────────────────
  {
    const colW = (W - GUTTER) / 2;
    const prep = (list) => list.slice(0, b.items).map((d) => {
      const lines = doc.wrap(d.text, { font: 'light', size: 7.6, maxWidth: colW - 16 });
      return { ...d, lines, h: 12 + lines.length * 10.2 + 8 };
    });
    const improve = prep(model.outlook.improve);
    const worsen = prep(model.outlook.worsen);
    const colH = (items) => 14 + (items.length ? items.reduce((a, i) => a + i.h, 0) : 22);
    const height = 22 + Math.max(colH(improve), colH(worsen));
    blocks.push({
      key: 'outlook', height, gap: 14,
      draw: (y) => {
        const cy = sectionTitle(doc, y, 'O que pode melhorar e o que pode piorar');
        drawOutlookColumn(doc, 'O que pode melhorar', improve, X, cy, colW, OW, 'up', 'Nada a corrigir hoje: a carteira está alinhada à sua política.');
        drawOutlookColumn(doc, 'O que pode piorar', worsen, X + colW + GUTTER, cy, colW, DOWN, 'down', 'Nenhum risco fora do comum está tocando a sua carteira hoje.');
        return cy - Math.max(colH(improve), colH(worsen));
      },
    });
  }

  // ── sua carteira hoje ────────────────────────────────────────────────────
  {
    const comment = firstSentences(model.portfolio.comment, 2);
    const rows = model.portfolio.holdings.slice(0, b.holdings);
    const more = model.portfolio.holdings.length - rows.length;
    const pieW = b.pie ? 210 : 0;
    const tableW = b.holdingsTable ? W - (b.pie ? pieW + GUTTER : 0) : 0;
    const pieH = b.pie ? 96 : 0;
    const tableH = b.holdingsTable ? 12 + rows.length * 10.5 + (more > 0 ? 10.5 : 0) : 0;
    const bodyH = Math.max(pieH, tableH);
    const height = 22 + paraH(doc, comment, W) + (bodyH ? 6 + bodyH : 0);
    blocks.push({
      key: 'portfolio', height, gap: 14,
      draw: (y) => {
        let cy = sectionTitle(doc, y, 'Sua carteira hoje', `${model.portfolio.positions_count} posições · ${model.portfolio.total_label}`);
        if (comment) cy = para(doc, comment, X, cy - 2, W);
        cy -= 6;
        if (b.pie) drawPie(doc, model.portfolio.pie, X, cy, pieW, pieH);
        if (b.holdingsTable) drawHoldings(doc, rows, more, X + (b.pie ? pieW + GUTTER : 0), cy, tableW);
        return cy - bodyH;
      },
    });
  }

  // ── the closing ──────────────────────────────────────────────────────────
  {
    const closing = firstSentences(model.closing, 3);
    const height = paraH(doc, closing, W) + 40;
    blocks.push({
      key: 'closing', height, gap: 8,
      draw: (y) => {
        let cy = closing ? para(doc, closing, X, y - 8, W) : y - 4;
        cy -= 6;
        doc.text(model.sign_off, X, cy, { font: 'light', size: 9.2, color: INK });
        cy -= 13;
        doc.text(model.advisor.name, X, cy, { font: 'sans5', size: 8.6, color: INK });
        cy -= 10;
        tracked(doc, `XP Asset Management${model.advisor.code ? ` · ${model.advisor.code}` : ''}`, X, cy, { font: 'light', size: 6.4, color: SAGE });
        return cy - 4;
      },
    });
  }

  // ── fonte ────────────────────────────────────────────────────────────────
  blocks.push({
    key: 'sources', height: doc.paragraphHeight(model.sources_line, { font: 'light', size: 6.4, leading: 9.2, maxWidth: W }) + 4, gap: 4,
    draw: (y) => doc.paragraph(model.sources_line, X, y - 2, { font: 'light', size: 6.4, leading: 9.2, maxWidth: W, color: INK2 }),
  });

  return blocks;
}

// ── drawing ────────────────────────────────────────────────────────────────

/** An event: a copper rule, the title in Medium, the text in Light, the newsroom in sage. */
function drawEventCard(doc, c, x, y, w) {
  doc.line(x, y, x + 18, y, { color: COPPER, width: 1.2 });
  doc.text(fit(doc, c.title, 'sans5', 8, w - 4), x, y - 12, { font: 'sans5', size: 8, color: INK });
  let cy = y - 24;
  for (const l of c.lines) { doc.text(l, x, cy, { font: 'light', size: 7.6, color: INK2 }); cy -= 10.2; }
  if (c.source) { doc.text(fit(doc, `${c.region ? `${c.region} · ` : ''}${c.source}`, 'light', 6, w), x, cy - 1, { font: 'light', size: 6, color: SAGE }); }
}

/** The figure strip: tracked labels in sage, Light values, the month's return emphasised. */
function drawFigureStrip(doc, figures, x, y, w) {
  const figs = figures.slice(0, 4);
  const colW = w / figs.length;
  doc.line(x, y, x + w, y, { color: '#C8C8C8', width: 0.75 });
  figs.forEach((f, i) => {
    const cx = x + i * colW;
    doc.text(fit(doc, String(f.label).toUpperCase(), 'sans', 6, colW - 8 - 0.9 * f.label.length), cx, y - 11, { font: 'sans', size: 6, color: SAGE, charSpacing: 0.9 });
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
  doc.textCenter(chart.title, x + w / 2, y - 12, { font: 'sans7', size: 7.6, color: CHART_TITLE });
  const pad = { l: 30, r: 10, t: 22, b: 30 };
  const px = x + pad.l; const pw = w - pad.l - pad.r; const py = y - h + pad.b; const ph = h - pad.t - pad.b;
  const port = chart.portfolio || []; const bench = chart.benchmark || [];
  if (port.length < 2) { doc.textCenter('Histórico insuficiente', x + w / 2, y - h / 2, { font: 'light', size: 7, color: INK3 }); return; }
  const vals = [...port, ...bench].map((p) => p.value);
  const lo = Math.min(0, ...vals); const hi = Math.max(0, ...vals);
  const step = niceStep(Math.max(1e-6, hi - lo) / 4);
  const y0 = Math.floor(lo / step) * step; const y1 = Math.ceil(hi / step) * step;
  const sy = (v) => py + ((v - y0) / (y1 - y0)) * ph;
  const sx = (i, n) => px + (i / Math.max(1, n - 1)) * pw;
  for (let v = y0; v <= y1 + step / 2; v += step) {
    doc.line(px, sy(v), px + pw, sy(v), { color: FRAME, width: 0.6 });
    doc.textRight(pctLabel(v), px - 4, sy(v) - 2, { font: 'light', size: 5.5, color: AXIS });
  }
  const n = port.length;
  const every = n > 30 ? 6 : n > 18 ? 3 : 2;
  const MON = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  for (let i = 0; i < n; i += every) doc.textCenter(`${MON[Number(port[i].month.slice(5, 7)) - 1]}/${port[i].month.slice(2, 4)}`, sx(i, n), py - 9, { font: 'light', size: 5.5, color: AXIS });
  const pathOf = (pts) => pts.map((p, i) => `${sx(i, pts.length).toFixed(2)} ${sy(p.value).toFixed(2)} ${i ? 'l' : 'm'}`).join(' ');
  if (bench.length > 1) doc.path(pathOf(bench), { stroke: NEU, width: 0.8, cap: 1, join: 1 });
  doc.path(pathOf(port), { stroke: COPPER2, width: 1.65, cap: 1, join: 1 });
  const ly = y - h + 8;
  doc.line(px, ly + 2, px + 12, ly + 2, { color: COPPER2, width: 1.65 });
  doc.text(chart.legend[0], px + 15, ly, { font: 'light', size: 5.8, color: INK2 });
  const lw = doc.measure('light', chart.legend[0], 5.8);
  doc.line(px + 22 + lw, ly + 2, px + 34 + lw, ly + 2, { color: NEU, width: 0.8 });
  doc.text(fit(doc, chart.legend[1], 'light', 5.8, pw - 40 - lw), px + 37 + lw, ly, { font: 'light', size: 5.8, color: INK2 });
}

/**
 * The risk-and-return scatter of the client's own assets: volatility across,
 * twelve-month return up, a dot per asset in its class colour with its name, the
 * references as rings. Labels step aside from each other; the frame and the
 * grid follow the fund sheet's chart grammar.
 */
function drawScatter(doc, sc, x, y, w, h, withLabels) {
  doc.rect(x, y - h, w, h, { stroke: FRAME, lineWidth: 0.83 });
  doc.textCenter(sc.title, x + w / 2, y - 12, { font: 'sans7', size: 7.6, color: CHART_TITLE });
  const pts = sc.assets || []; const refs = sc.references || [];
  if (!pts.length) { doc.textCenter('Sem ativos com doze meses de histórico medidos', x + w / 2, y - h / 2, { font: 'light', size: 7, color: INK3 }); return; }
  const pad = { l: 34, r: 12, t: 24, b: 34 };
  const px = x + pad.l; const pw = w - pad.l - pad.r; const py = y - h + pad.b; const ph = h - pad.t - pad.b;
  const all = [...pts, ...refs];
  const xMax = Math.max(0.05, ...all.map((p) => p.x)) * 1.12;
  const yLo = Math.min(0, ...all.map((p) => p.y)); const yHi = Math.max(0, ...all.map((p) => p.y));
  const xs = niceStep(xMax / 4); const ys = niceStep(Math.max(1e-6, yHi - yLo) / 4);
  const x1 = Math.ceil(xMax / xs) * xs;
  const y0 = Math.floor((yLo - 0.01) / ys) * ys; const y1 = Math.ceil((yHi + 0.01) / ys) * ys;
  const sx = (v) => px + (v / x1) * pw;
  const sy = (v) => py + ((v - y0) / (y1 - y0)) * ph;
  for (let v = y0; v <= y1 + ys / 2; v += ys) {
    doc.line(px, sy(v), px + pw, sy(v), { color: Math.abs(v) < 1e-9 ? '#BFBFBF' : FRAME, width: Math.abs(v) < 1e-9 ? 0.8 : 0.6 });
    doc.textRight(pctLabel(v), px - 4, sy(v) - 2, { font: 'light', size: 5.5, color: AXIS });
  }
  for (let v = 0; v <= x1 + xs / 2; v += xs) {
    if (v > 0) doc.line(sx(v), py, sx(v), py + ph, { color: FRAME, width: 0.6 });
    doc.textCenter(pctLabel(v), sx(v), py - 9, { font: 'light', size: 5.5, color: AXIS });
  }
  doc.textCenter('Volatilidade anual', px + pw / 2, py - 18, { font: 'light', size: 5.8, color: AXIS });
  doc.text('Retorno em 12 meses', px, y - h + pad.b + ph + 3, { font: 'light', size: 5.8, color: AXIS });

  // labels: to the right of the dot, moved left near the edge, and stepped down when they would sit on another
  const placed = [];
  const place = (p, r, font, size) => {
    const tw = doc.measure(font, p.label, size);
    let lx = sx(p.x) + r + 2.5; let anchor = 'l';
    if (lx + tw > px + pw - 2) { lx = sx(p.x) - r - 2.5 - tw; anchor = 'r'; }
    let ly = sy(p.y) - 2;
    for (let guard = 0; guard < 12; guard += 1) {
      const hit = placed.find((q) => Math.abs(q.y - ly) < 6.5 && lx < q.x + q.w + 2 && lx + tw > q.x - 2);
      if (!hit) break;
      ly = hit.y - 6.8;
    }
    placed.push({ x: lx, y: ly, w: tw });
    return { lx, ly, anchor };
  };
  const ordered = pts.slice().sort((a, c) => c.y - a.y);
  for (const p of ordered) {
    const cx = sx(p.x); const cy = sy(p.y);
    doc.path(circleOps(cx, cy, 3), { fill: p.color, stroke: '#FFFFFF', width: 0.6 });
    if (withLabels) { const { lx, ly } = place(p, 3, 'light', 5.6); doc.text(p.label, lx, ly, { font: 'light', size: 5.6, color: INK }); }
  }
  for (const r of refs) {
    const cx = sx(r.x); const cy = sy(r.y);
    doc.path(circleOps(cx, cy, 3.2), { fill: null, stroke: INK, width: 0.9 });
    doc.path(circleOps(cx, cy, 1.2), { fill: INK, stroke: null });
    const { lx, ly } = place(r, 3.6, 'sans5', 5.6);
    doc.text(r.label, lx, ly, { font: 'sans5', size: 5.6, color: INK });
  }
  // legend inside the frame, bottom
  let lx = px;
  const ly = y - h + 7;
  for (const c of sc.classes || []) {
    doc.path(circleOps(lx + 3, ly + 2, 2.4), { fill: c.color, stroke: null });
    doc.text(c.label, lx + 8, ly, { font: 'light', size: 5.6, color: INK2 });
    lx += 12 + doc.measure('light', c.label, 5.6);
  }
  if (refs.length) {
    doc.path(circleOps(lx + 3, ly + 2, 2.4), { fill: null, stroke: INK, width: 0.8 });
    doc.text('referências', lx + 8, ly, { font: 'light', size: 5.6, color: INK2 });
  }
}

/** A column of points: a slate band with the glyph, then title in Medium and text in Light, hairlines between. */
function drawOutlookColumn(doc, title, items, x, y, w, glyphColor, dir, emptyText) {
  headerBand(doc, x, y, w, 14, [{ x0: x + 12, w: w - 12, label: title }], { fill: SLATE });
  const gx = x + 7; const gy = y - 7;
  if (dir === 'up') doc.path(`${(gx - 3).toFixed(2)} ${(gy - 2.4).toFixed(2)} m ${(gx + 3).toFixed(2)} ${(gy - 2.4).toFixed(2)} l ${gx.toFixed(2)} ${(gy + 2.6).toFixed(2)} l h`, { fill: '#FFFFFF', stroke: null });
  else doc.path(`${(gx - 3).toFixed(2)} ${(gy + 2.4).toFixed(2)} m ${(gx + 3).toFixed(2)} ${(gy + 2.4).toFixed(2)} l ${gx.toFixed(2)} ${(gy - 2.6).toFixed(2)} l h`, { fill: '#FFFFFF', stroke: null });
  let cy = y - 14;
  if (!items.length) { doc.paragraph(emptyText, x + 8, cy - 12, { font: 'light', size: 7.6, leading: 10.2, maxWidth: w - 16, color: INK2 }); return cy - 22; }
  for (const it of items) {
    doc.path(dir === 'up'
      ? `${(x + 3).toFixed(2)} ${(cy - 12).toFixed(2)} m ${(x + 8).toFixed(2)} ${(cy - 12).toFixed(2)} l ${(x + 5.5).toFixed(2)} ${(cy - 8).toFixed(2)} l h`
      : `${(x + 3).toFixed(2)} ${(cy - 8).toFixed(2)} m ${(x + 8).toFixed(2)} ${(cy - 8).toFixed(2)} l ${(x + 5.5).toFixed(2)} ${(cy - 12).toFixed(2)} l h`, { fill: glyphColor, stroke: null });
    doc.text(fit(doc, it.title, 'sans5', 7.8, w - 16), x + 12, cy - 12, { font: 'sans5', size: 7.8, color: INK });
    let ty = cy - 23;
    for (const l of it.lines) { doc.text(l, x + 12, ty, { font: 'light', size: 7.6, color: INK2 }); ty -= 10.2; }
    cy -= it.h;
    doc.line(x, cy, x + w, cy, { color: RULE2, width: 0.5 });
  }
  return cy;
}

/** §08 the pie, twelve o'clock start, clockwise, with a direct legend. */
function drawPie(doc, slices, x, y, w, h) {
  const r = 38; const cx = x + r + 4; const cy = y - h / 2;
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
  let ly = y - 8;
  const lx = cx + r + 12;
  for (const s of slices.slice(0, 8)) {
    doc.rect(lx, ly - 5.5, 6, 6, { fill: s.color });
    doc.text(fit(doc, s.label, 'light', 6.4, w - (lx - x) - 34), lx + 9, ly - 4.6, { font: 'light', size: 6.4, color: INK });
    doc.textRight(`${(s.weight * 100).toFixed(1).replace('.', ',')}%`, x + w, ly - 4.6, { font: 'sans', size: 6.4, color: INK });
    ly -= 9.4;
  }
}

/** The client's positions, largest first: a charcoal band, Light rows, hairlines. */
function drawHoldings(doc, rows, more, x, y, w) {
  const cols = [w - 150, 100, 50];
  let cy = headerBand(doc, x, y, w, 12, [
    { x0: x, w: cols[0], label: 'Ativo' }, { x0: x + cols[0], w: cols[1], label: 'Classe' }, { x0: x + cols[0] + cols[1], w: cols[2], label: 'Peso', align: 'right' },
  ]);
  for (const r of rows) {
    doc.text(fit(doc, r.name, 'light', 6.8, cols[0] - 8), x + 4, cy - 10.5 + 3, { font: 'light', size: 6.8, color: INK });
    doc.text(fit(doc, r.class_label, 'light', 6.4, cols[1] - 8), x + cols[0] + 4, cy - 10.5 + 3, { font: 'light', size: 6.4, color: INK2 });
    doc.textRight(r.weight_label, x + w - 4, cy - 10.5 + 3, { font: 'sans', size: 6.8, color: INK });
    cy -= 10.5;
    doc.line(x, cy, x + w, cy, { color: RULE2, width: 0.4 });
  }
  if (more > 0) { doc.text(`+ ${more} ${more === 1 ? 'outra posição' : 'outras posições'}`, x + 4, cy - 10.5 + 3, { font: 'light', size: 6.4, color: INK3 }); cy -= 10.5; }
  return cy;
}
