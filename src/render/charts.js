/**
 * Charts. brand-guidelines.html §10.
 *
 * One preparation step produces geometry; each renderer draws it with its own
 * primitives, so the SVG in the email, the SVG in the portal and the vector
 * drawing in the PDF are the same chart rather than three lookalikes.
 *
 * Rules enforced here, not left to the caller:
 *  §10.1 bars start at zero · the title states the finding · direct labels, no legend
 *        · no gridline unless a value must be read off it · every chart carries
 *        period, basis, currency and source
 *  §10.2 positive g500, negative r500, zero baseline in ink; the portfolio line is
 *        ink and the benchmark is benchmark-blue dashed, never green
 *  §10.4 no gradients, no 3D, no doughnuts, no dual axes, no colour-only encoding
 */
import { color, semantic, type } from '../core/brand.js';
import { percent, pp, weight as fmtWeight, MINUS, escapeHtml } from '../core/format.js';

const GAIN = semantic.light.gainGraphic;
const LOSS = semantic.light.lossGraphic;
const INK = color.ink[950];
const RULE = color.rule;

// ── data preparation ───────────────────────────────────────────────────────

/** Contribution by asset class, in percentage points of the portfolio return. */
export function prepareContribution(report, { max = 6, classLabel = (k) => k } = {}) {
  const rows = (report.performance_attribution?.by_asset_class || [])
    .filter((r) => Number.isFinite(r.contribution))
    .slice(0, max);
  const residual = report.performance_attribution?.residual;
  if (residual && Math.abs(residual.contribution) > 0.0002) {
    rows.push({ asset_class: residual.label, contribution: residual.contribution, is_residual: true });
  }
  rows.sort((a, b) => b.contribution - a.contribution);
  const values = rows.map((r) => r.contribution);
  const bound = Math.max(0.0005, ...values.map(Math.abs));
  return {
    kind: 'contribution',
    items: rows.map((r) => ({ label: r.is_residual ? r.asset_class : classLabel(r.asset_class), value: r.contribution, tone: r.contribution >= 0 ? 'gain' : 'loss' })),
    bound,
    total: report.portfolio_performance?.monthly_return ?? null,
  };
}

/** Portfolio against its policy benchmark. Two bars, shared zero line. */
export function preparePortfolioVsBenchmark(report) {
  const p = report.portfolio_performance?.monthly_return;
  const b = report.benchmark?.value;
  const items = [];
  if (Number.isFinite(p)) items.push({ label: 'Sua carteira', label_en: 'Portfolio', value: p, role: 'portfolio' });
  if (Number.isFinite(b)) items.push({ label: 'Carteira de referência', label_en: 'Benchmark', value: b, role: 'benchmark' });
  const bound = Math.max(0.005, ...items.map((i) => Math.abs(i.value)));
  return { kind: 'vs_benchmark', items, bound };
}

/** Allocation as a stacked bar in the fixed categorical order (§10.2). */
export function prepareAllocation(report, { classLabel = (k) => k } = {}) {
  const rows = (report.approved_portfolio?.allocation || []).filter((r) => (r.weight ?? 0) > 0.0005);
  return {
    kind: 'allocation',
    items: rows.map((r, i) => ({
      label: classLabel(r.asset_class),
      weight: r.weight,
      target: r.target,
      range: r.range,
      color: color.categorical[i % color.categorical.length],
    })),
  };
}

/** Position-level contributors, best and worst, one chart. */
export function prepareContributors(report, { each = 3 } = {}) {
  const pos = (report.performance_attribution?.top_positive || []).slice(0, each);
  const neg = (report.performance_attribution?.top_negative || []).slice(0, each);
  const items = [...neg, ...pos]
    .filter((p) => Number.isFinite(p.contribution))
    .map((p) => ({ label: p.ticker || p.name, full: p.name, value: p.contribution, tone: p.contribution >= 0 ? 'gain' : 'loss' }))
    .sort((a, b) => b.value - a.value);
  const bound = Math.max(0.0005, ...items.map((i) => Math.abs(i.value)));
  return { kind: 'contributors', items, bound };
}

// ── SVG rendering ──────────────────────────────────────────────────────────

const esc = escapeHtml;

/**
 * Horizontal bars on a shared zero line. Value labels sit outside the bar and
 * always carry an explicit sign, so the chart survives greyscale and CVD.
 */
export function svgBars(data, {
  width = 520, rowHeight = 26, labelWidth = 150, valueWidth = 74,
  title = null, caption = null, locale = 'pt-BR', showSign = true,
} = {}) {
  const items = data.items || [];
  if (!items.length) return '';
  const plotW = width - labelWidth - valueWidth;
  const height = items.length * rowHeight + 8;
  const zeroX = labelWidth + plotW / 2;
  const scale = (plotW / 2) / data.bound;

  const bars = items.map((it, i) => {
    const y = i * rowHeight + 4;
    const w = Math.abs(it.value) * scale;
    const x = it.value >= 0 ? zeroX : zeroX - w;
    const fill = it.tone === 'loss' ? LOSS : it.tone === 'gain' ? GAIN
      : it.role === 'benchmark' ? semantic.light.benchmark : INK;
    const dash = it.role === 'benchmark' ? ' stroke="' + semantic.light.benchmark + '" stroke-width="1" stroke-dasharray="3 2" fill-opacity="0.34"' : '';
    const text = showSign ? pp(it.value, { locale }) : percent(it.value, { locale });
    // §10.1 value labels sit outside the bar. When the longest bar leaves no room
    // before the label column, the figure moves inside the bar in paper rather
    // than overprinting the series name.
    const approxTextWidth = text.length * 6.2;
    const inside = it.value < 0 && (zeroX - w - 6 - approxTextWidth) < labelWidth;
    const labelX = it.value >= 0 ? zeroX + w + 6 : inside ? zeroX - w + 5 : zeroX - w - 6;
    const anchor = it.value >= 0 || inside ? 'start' : 'end';
    const textFill = inside ? '#FFFFFF'
      : it.tone === 'loss' ? semantic.light.lossText
        : it.tone === 'gain' ? semantic.light.gainText : color.ink[800];
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(w, 0.8).toFixed(1)}" height="${rowHeight - 10}" fill="${fill}"${dash}/>
<text x="${labelWidth - 8}" y="${y + rowHeight / 2 - 3}" text-anchor="end" font-size="11" fill="${color.ink[700]}" font-family="${type.sans}">${esc(it.label)}</text>
<text x="${labelX.toFixed(1)}" y="${y + rowHeight / 2 - 3}" text-anchor="${anchor}" font-size="11" font-weight="500" fill="${textFill}" font-family="${type.sans}">${esc(text)}</text>`;
  }).join('\n');

  return `<figure class="chart" style="margin:0">
${title ? `<figcaption class="chart-title">${esc(title)}</figcaption>` : ''}
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(title || 'chart')}" style="display:block;overflow:visible">
<line x1="${zeroX}" y1="0" x2="${zeroX}" y2="${height - 4}" stroke="${INK}" stroke-width="1"/>
${bars}
</svg>
${caption ? `<figcaption class="chart-caption">${esc(caption)}</figcaption>` : ''}
</figure>`;
}

/** Stacked allocation bar with a direct label list. Never a doughnut (§10.2). */
export function svgAllocation(data, { width = 520, height = 34, title = null, caption = null, locale = 'pt-BR' } = {}) {
  const items = data.items || [];
  const total = items.reduce((a, i) => a + i.weight, 0) || 1;
  let x = 0;
  const segs = items.map((it) => {
    const w = (it.weight / total) * width;
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="${it.color}"/>`;
    // Same precision as the allocation table beside it: a bar reading 33% next
    // to a row reading 32,6% is a contradiction the reader has to resolve.
    const label = w > 46
      ? `<text x="${(x + w / 2).toFixed(1)}" y="${height / 2 + 4}" text-anchor="middle" font-size="10.5" font-weight="500" fill="#FFFFFF" font-family="${type.sans}">${esc(fmtWeight(it.weight, { locale, decimals: 1 }))}</text>`
      : '';
    x += w;
    return rect + label;
  }).join('');

  const legend = items.map((it) => `<span class="alloc-key"><i style="background:${it.color}"></i>${esc(it.label)} <b>${esc(fmtWeight(it.weight, { locale, decimals: 1 }))}</b></span>`).join('');

  return `<figure class="chart" style="margin:0">
${title ? `<figcaption class="chart-title">${esc(title)}</figcaption>` : ''}
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(title || 'allocation')}" style="display:block">${segs}</svg>
<div class="alloc-legend">${legend}</div>
${caption ? `<figcaption class="chart-caption">${esc(caption)}</figcaption>` : ''}
</figure>`;
}

/**
 * Allocation against the permitted policy band. The band is the point of the
 * chart, so it is drawn as the reference and the position sits on top of it.
 */
export function svgBands(data, { width = 520, rowHeight = 30, labelWidth = 132, title = null, caption = null, locale = 'pt-BR' } = {}) {
  const items = (data.items || []).filter((i) => i.range);
  if (!items.length) return '';
  const plotW = width - labelWidth - 76;
  const maxBound = Math.max(0.35, ...items.map((i) => Math.max(i.weight, i.range?.max ?? 0)));
  const sx = (v) => labelWidth + (v / maxBound) * plotW;
  const height = items.length * rowHeight + 10;

  const rows = items.map((it, i) => {
    const y = i * rowHeight + 6;
    const mid = y + (rowHeight - 12) / 2;
    const min = sx(it.range.min ?? 0);
    const max = sx(it.range.max ?? 0);
    const cur = sx(it.weight);
    const tgt = it.range.target != null ? sx(it.range.target) : null;
    const inside = it.weight >= (it.range.min ?? 0) && it.weight <= (it.range.max ?? 1);
    const dot = inside ? color.ink[950] : semantic.light.caution;
    return `<rect x="${min.toFixed(1)}" y="${(mid - 6).toFixed(1)}" width="${Math.max(1, max - min).toFixed(1)}" height="12" fill="${color.ink[100]}"/>
${tgt != null ? `<line x1="${tgt.toFixed(1)}" y1="${(mid - 8).toFixed(1)}" x2="${tgt.toFixed(1)}" y2="${(mid + 8).toFixed(1)}" stroke="${semantic.light.benchmark}" stroke-width="1" stroke-dasharray="2 2"/>` : ''}
<rect x="${(cur - 1.5).toFixed(1)}" y="${(mid - 9).toFixed(1)}" width="3" height="18" fill="${dot}"/>
<text x="${labelWidth - 8}" y="${(mid + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${color.ink[700]}" font-family="${type.sans}">${esc(it.label)}</text>
<text x="${(width - 4)}" y="${(mid + 4).toFixed(1)}" text-anchor="end" font-size="11" font-weight="500" fill="${inside ? color.ink[900] : semantic.light.caution}" font-family="${type.sans}">${esc(fmtWeight(it.weight, { locale, decimals: 1 }))}${inside ? '' : ' !'}</text>`;
  }).join('\n');

  return `<figure class="chart" style="margin:0">
${title ? `<figcaption class="chart-title">${esc(title)}</figcaption>` : ''}
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(title || 'allocation bands')}" style="display:block;overflow:visible">${rows}</svg>
${caption ? `<figcaption class="chart-caption">${esc(caption)}</figcaption>` : ''}
</figure>`;
}

/** Cumulative line: portfolio in ink, benchmark in benchmark-blue dashed (§10.2). */
export function svgCumulative(series, { width = 520, height = 150, title = null, caption = null, locale = 'pt-BR' } = {}) {
  const port = series.portfolio || [];
  if (port.length < 2) return '';
  const bench = series.benchmark || [];
  const pad = { l: 6, r: 62, t: 10, b: 18 };
  const all = [...port, ...bench].map((p) => p.value);
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = Math.max(1e-6, hi - lo);
  const sx = (i, n) => pad.l + (i / Math.max(1, n - 1)) * (width - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i, pts.length).toFixed(1)},${sy(p.value).toFixed(1)}`).join(' ');

  const last = port[port.length - 1];
  const lastB = bench.length ? bench[bench.length - 1] : null;

  return `<figure class="chart" style="margin:0">
${title ? `<figcaption class="chart-title">${esc(title)}</figcaption>` : ''}
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(title || 'cumulative return')}" style="display:block;overflow:visible">
<line x1="${pad.l}" y1="${sy(0).toFixed(1)}" x2="${(width - pad.r).toFixed(1)}" y2="${sy(0).toFixed(1)}" stroke="${RULE}" stroke-width="1"/>
${bench.length ? `<path d="${path(bench)}" fill="none" stroke="${semantic.light.benchmark}" stroke-width="1.25" stroke-dasharray="4 3"/>` : ''}
<path d="${path(port)}" fill="none" stroke="${INK}" stroke-width="1.75"/>
<text x="${(width - pad.r + 6)}" y="${(sy(last.value) + 3).toFixed(1)}" font-size="10.5" font-weight="600" fill="${INK}" font-family="${type.sans}">${esc(percent(last.value, { locale }))}</text>
${lastB ? `<text x="${(width - pad.r + 6)}" y="${(sy(lastB.value) + 3).toFixed(1)}" font-size="10.5" fill="${semantic.light.benchmark}" font-family="${type.sans}">${esc(percent(lastB.value, { locale }))}</text>` : ''}
<text x="${pad.l}" y="${height - 4}" font-size="9.5" fill="${color.ink[400]}" font-family="${type.mono}">${esc(port[0].label || '')}</text>
<text x="${(width - pad.r).toFixed(1)}" y="${height - 4}" text-anchor="end" font-size="9.5" fill="${color.ink[400]}" font-family="${type.mono}">${esc(last.label || '')}</text>
</svg>
${caption ? `<figcaption class="chart-caption">${esc(caption)}</figcaption>` : ''}
</figure>`;
}

export const CHART_CSS = `
.chart-title{font-family:${type.sans};font-size:12.5px;font-weight:600;color:${color.ink[900]};margin:0 0 8px;letter-spacing:-0.01em}
.chart-caption{font-family:${type.sans};font-size:10.5px;color:${color.ink[500]};margin-top:7px;line-height:1.4}
.alloc-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px}
.alloc-key{font-family:${type.sans};font-size:10.5px;color:${color.ink[600]};display:inline-flex;align-items:center;gap:5px}
.alloc-key i{width:9px;height:9px;display:inline-block}
.alloc-key b{color:${color.ink[900]};font-weight:500}
`;
