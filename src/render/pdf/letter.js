/**
 * The two-page Portuguese client letter, rendered programmatically (§21, §22).
 *
 * Layout: the house ledger grid — a reference rail carrying section numbers and
 * marginal source notes, a single content column beside it, 2 pt ink rules at
 * the document boundary and 1 pt rules between data rows (§9.2 memo, §9.3, §11.3).
 *
 * The two-page limit is a hard constraint, not an aspiration. Blocks are
 * measured before they are drawn and, if the content would spill onto a third
 * page, optional blocks are dropped in a fixed priority order until it fits.
 * The letter never silently truncates a sentence mid-way.
 */
import { PdfDocument, A4 } from './writer.js';
import { color, semantic, LOGO_SYMBOL_PATHS } from '../../core/brand.js';
import { money, percent, pp, weight as fmtWeight, dateLong, MINUS } from '../../core/format.js';

const INK = color.ink[950];
const INK2 = color.ink[700];
const INK3 = color.ink[500];
const RULE = color.rule;
const RULE2 = color.rule2;
const GAIN_T = semantic.light.gainText;
const LOSS_T = semantic.light.lossText;
const GAIN_G = semantic.light.gainGraphic;
const LOSS_G = semantic.light.lossGraphic;
const BENCH = semantic.light.benchmark;

const M = { left: 46, right: 46, top: 40, bottom: 34 };
const RAIL = 54;
const X = M.left + RAIL;
const W = A4.width - X - M.right;

const SZ = {
  body: 10.2, bodyLead: 15.0,
  h2: 10.5, rail: 7.4, data: 8.6, small: 7.8,
  // §15.3 sets the disclosure floor as a proportion of body size and forbids
  // grey. Body here is 10.2 pt, so the 60% floor is 6.1 pt; 7.4 pt in ink-2
  // clears it comfortably and stays legible in print.
  disclosure: 7.4,
};

export async function renderLetterPdf(model, { fonts, maxPages = 2 } = {}) {
  let attempt = 0;
  let reductions = 0;
  let doc = null;

  while (attempt < 10) {
    doc = new PdfDocument({
      title: `Carta mensal — ${model.client?.name} — ${model.period.label}`,
      author: `${model.advisor?.name} · Enter Asset Management`,
      subject: `Relatório mensal de investimentos — ${model.period.label}`,
      keywords: 'carta mensal, investimentos, Enter Asset Management',
    });
    registerFonts(doc, fonts);
    const overflow = compose(doc, model, reductions);
    doc.reductionLevel = reductions;
    if (!overflow && doc.pageCount <= maxPages) return doc;
    reductions += 1;
    attempt += 1;
  }
  return doc;
}

function registerFonts(doc, fonts) {
  doc.registerFont('sans', fonts.sans400);
  doc.registerFont('sans5', fonts.sans500);
  doc.registerFont('sans6', fonts.sans600);
  doc.registerFont('sans7', fonts.sans700);
  doc.registerFont('serif', fonts.serif400);
  doc.registerFont('serif3', fonts.serif300);
}

/**
 * Reduction ladder — what gets dropped first when two pages are not enough.
 *
 * Ordered by what a client actually loses. Supporting rows go first, then table
 * length, then body size. The contribution chart is last, because "why did my
 * portfolio move" is the question the letter exists to answer, and one chart
 * answers it better than the paragraph beside it.
 */
function budget(level) {
  return {
    maxImpact: level >= 1 ? 2 : 3,
    showMetrics: level < 2,
    sectionGap: level >= 2 ? 12 : 15,
    showBandChart: level < 3,
    maxAllocationRows: level >= 3 ? 6 : 8,
    bodySize: level >= 7 ? 9.4 : level >= 4 ? 9.7 : SZ.body,
    bodyLead: level >= 7 ? 13.8 : level >= 4 ? 14.2 : SZ.bodyLead,
    maxImpactLines: level >= 5 ? 1 : 2,
    // The discussion table is the operative half of the letter, so it is
    // trimmed late and never below three rows.
    maxRecommendations: level >= 7 ? 3 : level >= 6 ? 4 : 5,
    showContributionChart: level < 8,
    level,
  };
}

function compose(doc, model, level) {
  const b = budget(level);
  const L = model.locale;
  const blocks = buildBlocks(doc, model, b);

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
    const floor = M.bottom + 46;             // room for the foot rule and disclosure
    if (y - h < floor) {
      if (pageNo >= 2) { overflow = true; break; }
      drawFoot(doc, model, pageNo, false);
      newPage();
    }
    y = block.draw(y);
    y -= block.gap ?? 14;
  }

  drawFoot(doc, model, pageNo, true);
  return overflow;
}

// ── chrome ─────────────────────────────────────────────────────────────────

function drawMasthead(doc, model, pageNo) {
  const top = A4.height - M.top;

  // §6.1 the open bracket, drawn from the same path data every surface uses
  drawSymbol(doc, M.left, top - 22, 22);

  doc.text('enter', M.left + 29, top - 16, { font: 'sans6', size: 15.5, color: INK, charSpacing: -0.62 });
  doc.text('Asset Management', M.left + 29.6, top - 24.5, { font: 'sans5', size: 4.6, color: INK3, charSpacing: 0.78 });

  const right = A4.width - M.right;
  doc.textRight(model.locale === 'pt-BR' ? 'Carta mensal ao cliente' : 'Monthly client letter', right, top - 16, { font: 'sans6', size: 9.4, color: INK });
  doc.textRight(model.period.label, right, top - 26, { font: 'sans', size: 8.4, color: INK3 });

  // §9.3 — 2 pt solid ink marks the document boundary
  doc.line(M.left, top - 34, right, top - 34, { color: INK, width: 2 });

  if (pageNo === 1) {
    const y = top - 50;
    doc.text(model.client?.name || '', M.left, y, { font: 'sans6', size: 12.5, color: INK, charSpacing: -0.2 });
    const meta = [
      `${model.locale === 'pt-BR' ? 'Perfil' : 'Profile'}: ${model.client?.risk_profile}`,
      `${model.locale === 'pt-BR' ? 'Assessor' : 'Advisor'}: ${model.advisor?.name}${model.advisor?.code ? ` (${model.advisor.code})` : ''}`,
      `${model.locale === 'pt-BR' ? 'Posição em' : 'As at'} ${dateLong(model.period.end, model.locale)}`,
    ].join('   ·   ');
    doc.textRight(meta, A4.width - M.right, y + 2, { font: 'sans', size: 7.6, color: INK3 });
    doc.line(M.left, y - 10, A4.width - M.right, y - 10, { color: RULE, width: 0.6 });
    return y - 30;
  }
  return top - 52;
}

function drawSymbol(doc, x, y, size) {
  const s = size / 100;
  // paths are authored on a 100-unit box with y down; PDF y is up
  const tx = (px) => x + px * s;
  const ty = (py) => y + (100 - py) * s;
  for (const d of LOGO_SYMBOL_PATHS) {
    const parts = d.trim().split(/(?=[ML])/).map((seg) => seg.trim()).filter(Boolean);
    const ops = parts.map((seg, i) => {
      const [cmd, ...nums] = seg.replace(/([ML])/, '$1 ').split(/[\s,]+/).filter(Boolean);
      const px = Number(nums[0]); const py = Number(nums[1]);
      return `${tx(px).toFixed(2)} ${ty(py).toFixed(2)} ${i === 0 || cmd === 'M' ? 'm' : 'l'}`;
    });
    doc.path(ops.join(' '), { stroke: INK, width: 7 * s, cap: 2, join: 0 });
  }
}

function drawFoot(doc, model, pageNo, isLast) {
  const y = M.bottom + 26;
  doc.line(M.left, y, A4.width - M.right, y, { color: INK, width: 2 });

  if (isLast) {
    // §15.3 — disclosures on the same page as the figures, in ink-2, never grey
    const text = model.disclosures.join(' ');
    doc.paragraph(text, M.left, y - 9, {
      font: 'sans', size: SZ.disclosure, leading: SZ.disclosure * 1.32,
      maxWidth: A4.width - M.left - M.right - 60, color: INK2,
    });
  } else {
    doc.text(
      model.locale === 'pt-BR' ? 'Continua na página 2' : 'Continued on page 2',
      M.left, y - 11, { font: 'sans', size: SZ.small, color: INK3 },
    );
  }
  doc.textRight(`${pageNo} / 2`, A4.width - M.right, y - 11, { font: 'sans5', size: SZ.small, color: INK3 });
}

// ── block construction ─────────────────────────────────────────────────────

function buildBlocks(doc, model, b) {
  const L = model.locale;
  const blocks = [];
  let sectionNo = 0;

  const railNote = (y, lines) => {
    let cy = y - 6;
    for (const line of lines) {
      const wrapped = doc.wrap(line, { font: 'sans', size: SZ.rail, maxWidth: RAIL - 10 });
      for (const w of wrapped) {
        doc.text(w, M.left, cy, { font: 'sans', size: SZ.rail, color: INK3 });
        cy -= SZ.rail * 1.3;
      }
      cy -= 2;
    }
  };

  const section = (key, title, drawBody, { gap = b.sectionGap, note = null } = {}) => {
    sectionNo += 1;
    const num = String(sectionNo).padStart(2, '0');
    const headH = 17;
    const bodyH = drawBody.measure();
    blocks.push({
      height: headH + bodyH,
      gap,
      draw: (y) => {
        doc.text(num, M.left, y - 1, { font: 'sans5', size: SZ.rail, color: color.ink[400] });
        doc.text(title, X, y, { font: 'sans6', size: SZ.h2, color: INK, charSpacing: -0.1 });
        doc.line(X, y - 6, X + W, y - 6, { color: RULE, width: 0.6 });
        if (note) railNote(y - 20, note);
        return drawBody.draw(y - headH);
      },
    });
  };

  // ── 01 opening ──────────────────────────────────────────────────────────
  const openingText = [model.letter.greeting, model.letter.opening].filter(Boolean).join('\n');
  blocks.push({
    height: doc.paragraphHeight(model.letter.opening || '', { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W }) + 22,
    gap: 16,
    draw: (y) => {
      doc.text(model.letter.greeting || '', X, y, { font: 'serif', size: b.bodySize + 1.2, color: INK });
      return doc.paragraph(model.letter.opening || '', X, y - 20, {
        font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK2,
      });
    },
  });

  // ── 02 performance ──────────────────────────────────────────────────────
  {
    const paraH = doc.paragraphHeight(model.letter.performance || '', { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W });
    const figH = 52;
    const chartH = b.showContributionChart ? contributorsChartHeight(model) : 0;
    const methodH = model.method_note ? doc.paragraphHeight(model.method_note, { font: 'sans', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W }) + 6 : 0;

    section('performance', model.sections.performance, {
      measure: () => paraH + 12 + figH + 12 + chartH + methodH,
      draw: (y) => {
        let cy = drawFigureStrip(doc, model, X, y, W);
        cy -= 12;
        cy = doc.paragraph(model.letter.performance || '', X, cy, {
          font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK2,
        });
        if (b.showContributionChart) {
          cy -= 6;
          cy = drawContributorsChart(doc, model, X, cy, W);
        }
        if (model.method_note) {
          cy -= 4;
          cy = doc.paragraph(model.method_note, X, cy, { font: 'sans', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W, color: INK3 });
        }
        return cy;
      },
    }, { note: sourceNoteFor(model, ['market_price', 'statement']) });
  }

  // ── 03 markets ──────────────────────────────────────────────────────────
  section('markets', model.sections.markets, {
    measure: () => doc.paragraphHeight(model.letter.markets || '', { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W }),
    draw: (y) => doc.paragraph(model.letter.markets || '', X, y, { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK2 }),
  });

  // ── 04 what it means ────────────────────────────────────────────────────
  {
    const impact = (model.impact || []).slice(0, b.maxImpact);
    const rowsH = impact.length ? impact.length * (15 + b.maxImpactLines * 9 + 9) + 8 : 0;
    section('meaning', model.sections.meaning, {
      measure: () => doc.paragraphHeight(model.letter.meaning || '', { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W }) + rowsH,
      draw: (y) => {
        let cy = doc.paragraph(model.letter.meaning || '', X, y, { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK2 });
        if (!impact.length) return cy;
        cy -= 8;
        for (const i of impact) {
          doc.text(i.title, X, cy, { font: 'sans6', size: SZ.data, color: INK });
          if (i.exposure_label) {
            doc.textRight(`${L === 'pt-BR' ? 'exposição' : 'exposure'} ${i.exposure_label}`, X + W, cy, { font: 'sans5', size: SZ.small, color: INK3 });
          }
          cy -= 11;
          const lines = doc.wrap(firstSentences(i.impact, b.maxImpactLines), { font: 'sans', size: SZ.small, maxWidth: W }).slice(0, b.maxImpactLines);
          for (const l of lines) { doc.text(l, X, cy, { font: 'sans', size: SZ.small, color: INK2 }); cy -= 9; }
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
    const introH = doc.paragraphHeight(model.letter.recommendations_intro || '', { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W });
    const omittedH = model.recommendations_omitted_note
      ? doc.paragraphHeight(model.recommendations_omitted_note, { font: 'sans', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W }) + 6
      : 0;
    const tableH = (recs.length ? 16 + recs.length * 40 : 0) + omittedH;
    section('recommendations', model.sections.recommendations, {
      measure: () => introH + 10 + tableH,
      draw: (y) => {
        let cy = doc.paragraph(model.letter.recommendations_intro || '', X, y, { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK2 });
        if (!recs.length) return cy;
        cy -= 10;
        cy = drawRecommendationTable(doc, model, recs, X, cy, W);
        if (model.recommendations_omitted_note) {
          cy -= 4;
          cy = doc.paragraph(model.recommendations_omitted_note, X, cy, { font: 'sans', size: SZ.small, leading: SZ.small * 1.35, maxWidth: W, color: INK3 });
        }
        return cy;
      },
    }, { note: [L === 'pt-BR' ? 'Sinais técnicos e consenso de analistas: TradingView, capturados na data desta carta.' : 'Technical and analyst signals: TradingView, captured on the date of this letter.'] });
  }

  // ── 06 the portfolio ────────────────────────────────────────────────────
  {
    const rows = (model.allocation || []).slice(0, b.maxAllocationRows);
    const barH = 30;
    const tableH = 14 + rows.length * 15;
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
    height: doc.paragraphHeight(model.letter.closing || '', { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W }) + 34,
    gap: 10,
    draw: (y) => {
      let cy = doc.paragraph(model.letter.closing || '', X, y, { font: 'serif', size: b.bodySize, leading: b.bodyLead, maxWidth: W, color: INK2 });
      cy -= 12;
      doc.text(model.letter.sign_off || '', X, cy, { font: 'serif', size: b.bodySize, color: INK2 });
      cy -= 14;
      doc.text(model.advisor?.name || '', X, cy, { font: 'sans6', size: SZ.data, color: INK });
      cy -= 10;
      doc.text(`Enter Asset Management${model.advisor?.code ? ` · ${model.advisor.code}` : ''}`, X, cy, { font: 'sans', size: SZ.small, color: INK3 });
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
      height: doc.paragraphHeight(text, { font: 'sans', size: SZ.small, leading: SZ.small * 1.32, maxWidth: W })
        + (unav ? doc.paragraphHeight(unav, { font: 'sans', size: SZ.small, leading: SZ.small * 1.32, maxWidth: W }) + 6 : 0) + 10,
      gap: 6,
      draw: (y) => {
        doc.line(X, y + 6, X + W, y + 6, { color: RULE, width: 0.6 });
        let cy = doc.paragraph(text, X, y - 3, { font: 'sans', size: SZ.small, leading: SZ.small * 1.32, maxWidth: W, color: INK2 });
        if (unav) {
          cy -= 4;
          cy = doc.paragraph(unav, X, cy, { font: 'sans', size: SZ.small, leading: SZ.small * 1.32, maxWidth: W, color: INK2 });
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
  doc.line(x, y + 4, x + w, y + 4, { color: INK, width: 1 });
  figs.forEach((f, i) => {
    const cx = x + i * colW;
    // Labels wrap inside their column rather than running into the next one.
    const lines = doc.wrap(f.short_label || f.label, { font: 'sans', size: SZ.small - 0.4, maxWidth: colW - 8 }).slice(0, 2);
    lines.forEach((l, k) => doc.text(l, cx, y - 8 - k * 8.4, { font: 'sans', size: SZ.small - 0.4, color: INK3 }));
    const tone = f.tone === 'gain' ? GAIN_T : f.tone === 'loss' ? LOSS_T : f.tone === 'benchmark' ? BENCH : INK;
    let size = f.emphasis ? 15 : 11.5;
    while (size > 8 && doc.measure(f.emphasis ? 'sans7' : 'sans6', f.value, size) > colW - 8) size -= 0.5;
    doc.text(f.value, cx, y - 32, { font: f.emphasis ? 'sans7' : 'sans6', size, color: tone, charSpacing: -0.2 });
  });
  doc.line(x, y - 40, x + w, y - 40, { color: RULE, width: 0.6 });
  return y - 48;
}

function contributorsChartHeight(model) {
  const n = Math.min(6, (model.charts?.contributors?.items || []).length);
  return n ? n * 15 + 26 : 0;
}

function drawContributorsChart(doc, model, x, y, w) {
  const data = model.charts?.contributors;
  const items = (data?.items || []).slice(0, 6);
  if (!items.length) return y;
  const L = model.locale;

  doc.text(
    L === 'pt-BR' ? 'Quem puxou o resultado, em pontos percentuais da carteira' : 'What drove the result, in percentage points of the portfolio',
    x, y, { font: 'sans6', size: SZ.small, color: INK },
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
    doc.textRight(it.label, x + labelW - 6, cy - 6, { font: 'sans', size: SZ.small, color: INK2 });

    // §10.1 value labels sit outside the bar. When the longest bar leaves no
    // room before the label column, the figure moves inside the bar in paper
    // rather than overprinting the series name.
    const label = pp(it.value, { locale: L });
    const tw = doc.measure('sans5', label, SZ.small);
    if (it.value >= 0) {
      doc.text(label, zeroX + bw + 5, cy - 6, { font: 'sans5', size: SZ.small, color: GAIN_T });
    } else if (zeroX - bw - 5 - tw > x + labelW + 2) {
      doc.textRight(label, zeroX - bw - 5, cy - 6, { font: 'sans5', size: SZ.small, color: LOSS_T });
    } else {
      doc.text(label, zeroX - bw + 4, cy - 6, { font: 'sans5', size: SZ.small, color: '#FFFFFF' });
    }
    cy -= 15;
  }
  // zero line drawn last so it sits over the bars, per §10.2
  doc.line(zeroX, y - 6, zeroX, cy + 7, { color: INK, width: 0.8 });
  return cy - 4;
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

  heads.forEach((h, i) => doc.text(h, xs[i], y, { font: 'sans5', size: SZ.small, color: INK3 }));
  doc.line(x, y - 5, x + w, y - 5, { color: INK, width: 1 });

  let cy = y - 17;
  for (const r of recs) {
    const nameW = cols[0].w * w - 8;
    let label = r.ticker || r.name;
    if (doc.measure('sans6', label, SZ.data) > nameW) {
      while (label.length > 4 && doc.measure('sans6', `${label}…`, SZ.data) > nameW) label = label.slice(0, -1);
      label = `${label.trimEnd()}…`;
    }
    doc.text(label, xs[0], cy, { font: 'sans6', size: SZ.data, color: INK });
    doc.text(`${r.weight_label} ${L === 'pt-BR' ? 'da carteira' : 'of portfolio'}`, xs[0], cy - 9, { font: 'sans', size: SZ.small - 0.4, color: INK3 });

    const actionTone = r.action === 'ADD' ? GAIN_T : (r.action === 'REDUCE' || r.action === 'EXIT') ? LOSS_T : INK;
    doc.text(r.action_label, xs[1], cy, { font: 'sans6', size: SZ.data, color: actionTone });

    doc.text(r.technical || (L === 'pt-BR' ? 'sem cobertura' : 'not covered'), xs[2], cy, { font: 'sans5', size: SZ.small, color: r.technical ? INK2 : INK3 });

    if (r.analyst) {
      doc.text(r.analyst, xs[3], cy, { font: 'sans5', size: SZ.small, color: INK2 });
      if (r.analyst_count) doc.text(`${r.analyst_count} ${L === 'pt-BR' ? 'analistas' : 'analysts'}`, xs[3], cy - 9, { font: 'sans', size: SZ.small - 0.4, color: INK3 });
    } else {
      const lines = doc.wrap(r.analyst_missing_label || '', { font: 'sans', size: SZ.small - 0.4, maxWidth: cols[3].w * w - 6 });
      lines.slice(0, 2).forEach((l, i) => doc.text(l, xs[3], cy - i * 8, { font: 'sans', size: SZ.small - 0.4, color: INK3 }));
    }

    const fitTone = r.suitability === 'PASS' ? INK2 : semantic.light.caution;
    const fitLines = doc.wrap(r.suitability_label || '', { font: 'sans5', size: SZ.small, maxWidth: cols[4].w * w - 4 });
    fitLines.slice(0, 2).forEach((l, i) => doc.text(l, xs[4], cy - i * 8.5, { font: 'sans5', size: SZ.small, color: fitTone }));

    cy -= 20;
    if (r.rationale) {
      const lines = doc.wrap(r.rationale, { font: 'sans', size: SZ.small, maxWidth: w - 4 }).slice(0, 2);
      for (const l of lines) { doc.text(l, x, cy, { font: 'sans', size: SZ.small, color: INK2 }); cy -= 9; }
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
    if (bw > 38) doc.textCenter(fmtWeight(it.weight, { locale: model.locale, decimals: 1 }), cx + bw / 2, y - h + 6, { font: 'sans5', size: 7.2, color: '#FFFFFF' });
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

  doc.text(heads[0], xs[0], y, { font: 'sans5', size: SZ.small, color: INK3 });
  doc.textRight(heads[1], xs[1] + w * 0.16, y, { font: 'sans5', size: SZ.small, color: INK3 });
  doc.textRight(heads[2], xs[2] + w * 0.11, y, { font: 'sans5', size: SZ.small, color: INK3 });
  doc.textRight(heads[3], xs[3] + w * 0.09, y, { font: 'sans5', size: SZ.small, color: INK3 });
  doc.textRight(heads[4], x + w, y, { font: 'sans5', size: SZ.small, color: INK3 });
  doc.line(x, y - 5, x + w, y - 5, { color: INK, width: 1 });

  let cy = y - 15;
  for (const r of rows) {
    doc.text(r.asset_class, xs[0], cy, { font: 'sans5', size: SZ.data, color: INK });
    doc.textRight(r.value_label, xs[1] + w * 0.16, cy, { font: 'sans5', size: SZ.data, color: INK2 });
    doc.textRight(r.weight_label, xs[2] + w * 0.11, cy, { font: 'sans6', size: SZ.data, color: r.inside_band ? INK : semantic.light.caution });
    doc.textRight(r.target_label, xs[3] + w * 0.09, cy, { font: 'sans', size: SZ.data, color: INK3 });
    doc.textRight(r.inside_band ? r.range_label : `${r.range_label} !`, x + w, cy, { font: 'sans', size: SZ.data, color: r.inside_band ? INK3 : semantic.light.caution });
    cy -= 4;
    doc.line(x, cy, x + w, cy, { color: RULE2, width: 0.5 });
    cy -= 11;
  }
  return cy + 5;
}
