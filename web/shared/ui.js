/**
 * Portal runtime: a DOM builder, the API client, and the chart primitives.
 * No framework and no bundler — the product is dense tables and restrained
 * charts, and a hand-rolled 200-line renderer keeps the deployment to one
 * Worker with static assets.
 */
import { money, percent, pp, weight, num, dateLong, shortDate, monthLabel, arrow, toneOf, MINUS } from './vendor/format.js';
import { API_BASE, SITE_BASE, advisorUrl, clientUrl, loginUrl, apiUrl } from './config.js';

export { money, percent, pp, weight, num, dateLong, shortDate, monthLabel, arrow, toneOf, MINUS };
export { API_BASE, SITE_BASE, advisorUrl, clientUrl, loginUrl, apiUrl };

// ── DOM ───────────────────────────────────────────────────────────────────
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = String(tag).split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(4)) if (c != null && c !== false) f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return f;
};

export function mount(root, ...children) {
  root.replaceChildren(...children.flat(4).filter((c) => c != null && c !== false));
  return root;
}

// ── API ───────────────────────────────────────────────────────────────────
const TOKEN_KEY = 'ew_token';
export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  clear() { localStorage.removeItem(TOKEN_KEY); },
};

export async function api(path, body, method) {
  // Bearer rather than a cookie: the portal and the API are on different origins
  // when the site is served from GitHub Pages, and a cross-site cookie would need
  // SameSite=None on a third-party domain. A token in localStorage is simpler and
  // does not depend on the browser's third-party cookie policy.
  const res = await fetch(`${API_BASE}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { auth.clear(); location.href = loginUrl(); throw new Error('session expired'); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

// ── brand mark (§6.1, drawn from the same path data as the PDF) ───────────
const SYMBOL_PATHS = ['M8 30 L8 8 L30 8', 'M92 70 L92 92 L70 92', 'M72 34 L72 56 L36 56', 'M48 44 L36 56 L48 68'];

export function logo({ size = 26, descriptor = true } = {}) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Enter Asset Management');
  for (const d of SYMBOL_PATHS) {
    const p = document.createElementNS(svgNs, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-width', '7');
    p.setAttribute('stroke-linecap', 'square');
    p.setAttribute('stroke-linejoin', 'miter');
    svg.append(p);
  }
  return h('span.lockup', {}, svg, h('span', { style: { display: 'flex', flexDirection: 'column' } },
    h('span.word', { text: 'enter', style: { fontSize: `${size * 0.8}px` } }),
    descriptor && h('span.desc', { text: 'Asset Management', style: { fontSize: `${size * 0.24}px` } })));
}

// ── figures ───────────────────────────────────────────────────────────────
export function stat(label, value, { tone = 'flat', sub = null, small = false } = {}) {
  return h('div.stat', {},
    h('span.lbl', { text: label }),
    h('span.val', { class: `${tone} ${small ? 'sm' : ''}`.trim(), text: value }),
    sub && h('span.sub', { text: sub }));
}

export function signed(value, kind = 'percent', locale = 'pt-BR') {
  if (value == null || !Number.isFinite(value)) return 'DATA UNAVAILABLE';
  if (kind === 'pp') return pp(value, { locale });
  if (kind === 'money') return money(value, { locale, signed: true });
  return percent(value, { locale });
}

export const toneClass = (v) => (v == null || !Number.isFinite(v) ? 'flat' : v > 0 ? 'gain' : v < 0 ? 'loss' : 'flat');

// ── tables ────────────────────────────────────────────────────────────────
export function table(headers, rows, { className = '' } = {}) {
  return h('div.tw', {},
    h(`table.d${className ? `.${className}` : ''}`, {},
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.num ? 'num' : '', text: x.label ?? x })))),
      h('tbody', {}, rows)));
}

// ── charts (§10) ──────────────────────────────────────────────────────────
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Horizontal bars on a shared zero line, value labels outside, explicit signs. */
export function barChart(items, { title = null, caption = null, width = 560, rowHeight = 24, labelWidth = 150, locale = 'pt-BR', unit = 'pp' } = {}) {
  if (!items.length) return h('div.empty', { text: 'Sem dados para exibir.' });
  const bound = Math.max(1e-6, ...items.map((i) => Math.abs(i.value)));
  const height = items.length * rowHeight + 6;
  const valueWidth = 76;
  const plotW = width - labelWidth - valueWidth;
  const zeroX = labelWidth + plotW / 2;
  const scale = (plotW / 2) / bound;
  const gain = cssVar('--gain-graphic') || '#438E60';
  const loss = cssVar('--loss-graphic') || '#AE4F48';
  const gainT = cssVar('--gain-text') || '#285E3F';
  const lossT = cssVar('--loss-text') || '#943A34';
  const ink = cssVar('--ink-950') || '#0B0D0E';
  const ink7 = cssVar('--ink-700') || '#2E3439';

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'chart' });
  svg.style.display = 'block';
  svg.style.overflow = 'visible';

  items.forEach((it, i) => {
    const y = i * rowHeight + 3;
    const bw = Math.max(0.8, Math.abs(it.value) * scale);
    const bx = it.value >= 0 ? zeroX : zeroX - bw;
    svg.append(svgEl('rect', { x: bx.toFixed(1), y, width: bw.toFixed(1), height: rowHeight - 10, fill: it.value >= 0 ? gain : loss }));
    const lab = svgEl('text', { x: labelWidth - 8, y: y + rowHeight / 2 - 2, 'text-anchor': 'end', 'font-size': 11, fill: ink7 });
    lab.textContent = it.label;
    svg.append(lab);
    // §10.1 value labels sit outside the bar. When the longest bar leaves no
    // room before the label column, the figure moves inside the bar in white
    // rather than overprinting the series name.
    const label = unit === 'pp' ? pp(it.value, { locale }) : percent(it.value, { locale });
    const approxW = label.length * 6.2;
    const inside = it.value < 0 && (zeroX - bw - 6 - approxW) < labelWidth;
    const txt = svgEl('text', {
      x: it.value >= 0 ? zeroX + bw + 6 : inside ? zeroX - bw + 5 : zeroX - bw - 6,
      y: y + rowHeight / 2 - 2,
      'text-anchor': it.value >= 0 || inside ? 'start' : 'end',
      'font-size': 11, 'font-weight': 500, fill: inside ? '#FFFFFF' : (it.value >= 0 ? gainT : lossT),
    });
    txt.textContent = label;
    svg.append(txt);
  });
  svg.append(svgEl('line', { x1: zeroX, y1: 0, x2: zeroX, y2: height - 3, stroke: ink, 'stroke-width': 1 }));

  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, caption && h('figcaption.chart-caption', { text: caption }));
}

/** Stacked allocation bar in the fixed categorical order. Never a doughnut. */
export function allocationBar(items, { title = null, caption = null, width = 560, height = 30, locale = 'pt-BR' } = {}) {
  const total = items.reduce((a, i) => a + i.weight, 0) || 1;
  const cats = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--cat-${i}`) || '#12314F');
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'allocation' });
  svg.style.display = 'block';
  let x = 0;
  items.forEach((it, i) => {
    const w = (it.weight / total) * width;
    svg.append(svgEl('rect', { x: x.toFixed(1), y: 0, width: w.toFixed(1), height, fill: it.color || cats[i % cats.length] }));
    if (w > 40) {
      const t = svgEl('text', { x: (x + w / 2).toFixed(1), y: height / 2 + 4, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 500, fill: '#fff' });
      t.textContent = weight(it.weight, { locale, decimals: 1 });
      svg.append(t);
    }
    x += w;
  });
  const legend = h('div.alloc-legend', {}, items.map((it, i) => h('span.alloc-key', {},
    h('i', { style: { background: it.color || cats[i % cats.length] } }),
    `${it.label} `, h('b', { text: weight(it.weight, { locale, decimals: 1 }) }))));
  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, legend, caption && h('figcaption.chart-caption', { text: caption }));
}

/** Allocation against the permitted band. The band is the point of the chart. */
export function bandChart(rows, { title = null, width = 560, rowHeight = 26, labelWidth = 168, locale = 'pt-BR' } = {}) {
  const usable = rows.filter((r) => r.range);
  if (!usable.length) return h('div.empty', { text: 'Sem faixas definidas na política.' });
  const maxBound = Math.max(0.3, ...usable.map((r) => Math.max(r.weight, r.range.max ?? 0)));
  const plotW = width - labelWidth - 70;
  const sx = (v) => labelWidth + (v / maxBound) * plotW;
  const height = usable.length * rowHeight + 6;
  const ink = cssVar('--ink-950'); const ink7 = cssVar('--ink-700');
  const band = cssVar('--ink-100'); const bench = cssVar('--benchmark'); const caution = cssVar('--caution');

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'bands' });
  svg.style.display = 'block'; svg.style.overflow = 'visible';
  usable.forEach((r, i) => {
    const y = i * rowHeight + 3;
    const mid = y + (rowHeight - 10) / 2;
    const inside = r.weight >= (r.range.min ?? 0) && r.weight <= (r.range.max ?? 1);
    svg.append(svgEl('rect', { x: sx(r.range.min ?? 0).toFixed(1), y: mid - 6, width: Math.max(1, sx(r.range.max ?? 0) - sx(r.range.min ?? 0)).toFixed(1), height: 12, fill: band }));
    if (r.range.target != null) svg.append(svgEl('line', { x1: sx(r.range.target).toFixed(1), y1: mid - 8, x2: sx(r.range.target).toFixed(1), y2: mid + 8, stroke: bench, 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    svg.append(svgEl('rect', { x: (sx(r.weight) - 1.5).toFixed(1), y: mid - 9, width: 3, height: 18, fill: inside ? ink : caution }));
    const lab = svgEl('text', { x: labelWidth - 8, y: mid + 4, 'text-anchor': 'end', 'font-size': 11, fill: ink7 });
    lab.textContent = r.asset_class;
    svg.append(lab);
    const val = svgEl('text', { x: width - 2, y: mid + 4, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 500, fill: inside ? ink : caution });
    val.textContent = weight(r.weight, { locale, decimals: 1 }) + (inside ? '' : ' !');
    svg.append(val);
  });
  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg);
}

/** Cumulative line: the firm's line is ink, the benchmark is blue dashed. */
export function lineChart(series, { title = null, caption = null, width = 560, height = 160, locale = 'pt-BR' } = {}) {
  const port = series.portfolio || [];
  if (port.length < 2) return h('div.empty', { text: 'Histórico insuficiente.' });
  const bench = series.benchmark || [];
  const pad = { l: 4, r: 64, t: 10, b: 20 };
  const all = [...port, ...bench].map((p) => p.value);
  const lo = Math.min(0, ...all); const hi = Math.max(0, ...all);
  const span = Math.max(1e-6, hi - lo);
  const sx = (i, n) => pad.l + (i / Math.max(1, n - 1)) * (width - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const d = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i, pts.length).toFixed(1)},${sy(p.value).toFixed(1)}`).join(' ');
  const ink = cssVar('--ink-950'); const bcol = cssVar('--benchmark'); const rule = cssVar('--rule'); const ink4 = cssVar('--ink-400');

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'cumulative' });
  svg.style.display = 'block'; svg.style.overflow = 'visible';
  svg.append(svgEl('line', { x1: pad.l, y1: sy(0), x2: width - pad.r, y2: sy(0), stroke: rule, 'stroke-width': 1 }));
  if (bench.length > 1) svg.append(svgEl('path', { d: d(bench), fill: 'none', stroke: bcol, 'stroke-width': 1.25, 'stroke-dasharray': '4 3' }));
  svg.append(svgEl('path', { d: d(port), fill: 'none', stroke: ink, 'stroke-width': 1.75 }));

  const last = port[port.length - 1];
  const t1 = svgEl('text', { x: width - pad.r + 6, y: sy(last.value) + 3, 'font-size': 10.5, 'font-weight': 600, fill: ink });
  t1.textContent = percent(last.value, { locale });
  svg.append(t1);
  if (bench.length) {
    const lb = bench[bench.length - 1];
    const t2 = svgEl('text', { x: width - pad.r + 6, y: sy(lb.value) + 3, 'font-size': 10.5, fill: bcol });
    t2.textContent = percent(lb.value, { locale });
    svg.append(t2);
  }
  for (const [i, p] of [[0, port[0]], [port.length - 1, last]]) {
    const t = svgEl('text', { x: sx(i, port.length), y: height - 5, 'text-anchor': i === 0 ? 'start' : 'end', 'font-size': 9.5, fill: ink4 });
    t.textContent = p.label || '';
    svg.append(t);
  }
  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, caption && h('figcaption.chart-caption', { text: caption }));
}

// ── source provenance (§29) ───────────────────────────────────────────────
export function sourceLine(s) {
  const bits = [s.provider];
  if (s.identifier) bits.push(s.identifier);
  if (s.last_observation) bits.push(`dados até ${s.last_observation}`);
  else if (s.requested_range) bits.push(s.requested_range);
  if (s.retrieval_timestamp) bits.push(`obtido ${String(s.retrieval_timestamp).slice(0, 16).replace('T', ' ')}Z`);
  if (s.fallback_for) bits.push(`fallback de ${s.fallback_for}`);
  return `${s.instrument ? `${s.instrument}: ` : ''}${bits.join(' · ')}`;
}

export function sourcesBlock(sources, label = 'Ver fontes') {
  if (!sources?.length) return null;
  const simulated = sources.filter((s) => s.mocked || /simulated/i.test(s.provider || ''));
  return h('details.sources', {},
    h('summary', { text: `${label} (${sources.length})` }),
    simulated.length ? h('p.note', { style: { marginTop: '8px' } },
      h('span.chip.mock', { text: 'DADOS SIMULADOS' }), ` ${simulated.length} de ${sources.length} registros são de demonstração e estão marcados abaixo.`) : null,
    h('ul', {}, sources.map((s) => h('li', {},
      sourceLine(s),
      (s.mocked || /simulated/i.test(s.provider || '')) ? ' ' : null,
      (s.mocked || /simulated/i.test(s.provider || '')) ? h('span.chip.mock', { text: 'MOCK' }) : null))));
}

// ── router ────────────────────────────────────────────────────────────────
export function router(routes, { root, notFound }) {
  async function render() {
    const hash = location.hash.replace(/^#/, '') || '/';
    for (const [pattern, handler] of routes) {
      const keys = [];
      const rx = new RegExp(`^${pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
      const m = hash.match(rx);
      if (!m) continue;
      const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      mount(root, h('div.loading', { text: 'Carregando…' }));
      try {
        const view = await handler(params);
        mount(root, view);
      } catch (err) {
        mount(root, h('div.err', { text: err.message || String(err) }));
        console.error(err);
      }
      window.scrollTo(0, 0);
      return;
    }
    mount(root, notFound ? notFound() : h('div.empty', { text: 'Página não encontrada.' }));
  }
  window.addEventListener('hashchange', render);
  render();
  return { render };
}

export function setActive(container, hash) {
  for (const a of container.querySelectorAll('a[href^="#"]')) {
    a.classList.toggle('on', a.getAttribute('href') === `#${hash}` || (hash.startsWith(a.getAttribute('href').slice(1)) && a.getAttribute('href') !== '#/'));
  }
}
