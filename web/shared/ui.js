/**
 * Portal runtime: a DOM builder, the API client, the brand marks, the shell
 * (rail, masthead, theme) and the chart primitives.
 * No framework and no bundler — the product is dense tables and restrained
 * charts, and a hand-rolled renderer keeps the deployment to one Worker with
 * static assets.
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

// ── session ───────────────────────────────────────────────────────────────
// The session lives in sessionStorage, so it ends with the browser window. A new
// tab asks the open ones for it over a BroadcastChannel, so the portal is signed
// in wherever you already are and signed out wherever you are not. Activity is
// shared the same way, so an idle tab cannot end a session in use elsewhere.
// Idle for IDLE_MS, past the token's expiry, or signed out in any tab, and every
// tab signs out together.
const SESSION_KEY = 'ew_session';
const LEGACY_TOKEN_KEY = 'ew_token'; // earlier builds kept the token in localStorage, outliving the window
export const IDLE_MS = 15 * 60 * 1000;
export const IDLE_WARN_MS = 60 * 1000;
const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ew-session') : null;
const post = (msg) => { try { bus?.postMessage(msg); } catch { /* channel closed */ } };
try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* storage unavailable */ }

const readSession = () => { try { const raw = sessionStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } };
const writeSession = (s) => { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ } };
let lastActivity = Date.now();
const remote = { logout: null, session: null, any: null };
const isLoginPage = () => !/\/(advisor|client)\//.test(location.pathname);

bus?.addEventListener('message', (e) => {
  const m = e.data || {};
  const mine = readSession();
  if (m.type === 'who-has-session' && mine) post({ type: 'session', session: mine, lastActivity });
  else if (m.type === 'activity') lastActivity = Math.max(lastActivity, m.at || 0);
  else if (m.type === 'logout' && mine) { writeSession(null); remote.logout?.(); }
  else if (m.type === 'session' && m.session && mine && m.session.token !== mine.token) { writeSession(m.session); remote.session?.(); }
  remote.any?.(m);
});

export const auth = {
  get session() { return readSession(); },
  get token() { return readSession()?.token || null; },
  /** Adopt a session from a login response. Other open tabs follow. */
  start(s) {
    const session = { token: s.token, expires_at: s.expires_at || null, user: s.user || null };
    writeSession(session);
    lastActivity = Date.now();
    post({ type: 'session', session, lastActivity });
  },
  /** Forget the session in this tab and, unless told otherwise, in every other one. */
  clear({ broadcast = true } = {}) {
    writeSession(null);
    if (broadcast) post({ type: 'logout' });
  },
  /** End the session server-side and client-side, then go to the login page. */
  async logout({ reason = null, redirect = true } = {}) {
    if (auth.token) { try { await api('/api/auth/logout', {}); } catch { /* the token may already be dead */ } }
    auth.clear();
    if (redirect) location.href = loginUrl() + (reason ? `?reason=${reason}` : '');
  },
  /** The session in this tab, or one handed over by another open tab; null when nobody is signed in. */
  discover({ wait = 250 } = {}) {
    const mine = readSession();
    if (mine || !bus) return Promise.resolve(mine);
    return new Promise((resolve) => {
      let timer;
      const onMsg = (e) => {
        if (e.data?.type !== 'session' || !e.data.session) return;
        writeSession(e.data.session);
        lastActivity = Math.max(lastActivity, e.data.lastActivity || 0);
        done(e.data.session);
      };
      const done = (v) => { bus.removeEventListener('message', onMsg); clearTimeout(timer); resolve(v); };
      bus.addEventListener('message', onMsg);
      timer = setTimeout(() => done(null), wait);
      post({ type: 'who-has-session' });
    });
  },
  /** Observe session messages from other tabs (the login page uses this). */
  subscribe(fn) { remote.any = fn; },
};

/**
 * Idle and expiry guard for a signed-in page. Activity in any tab keeps the
 * session alive; a banner counts down the last minute; then every tab signs out.
 */
export function installSessionGuard({ idleMs = IDLE_MS, warnMs = IDLE_WARN_MS } = {}) {
  const banner = h('div.session-warn', { role: 'status', hidden: true });
  const count = h('b');
  mount(banner, h('span', {}, 'Sua sessão encerra em ', count, ' por inatividade.'),
    h('button.btn.sm', { type: 'button', text: 'continuar conectado', onclick: () => touch(true) }));
  document.body.append(banner);

  let lastPost = 0;
  let warned = false;
  function touch(force = false) {
    lastActivity = Date.now();
    if (warned) { warned = false; banner.hidden = true; }
    if (force || lastActivity - lastPost > 5000) { lastPost = lastActivity; post({ type: 'activity', at: lastActivity }); }
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(ev, () => touch(), { passive: true });

  function check() {
    const s = readSession();
    if (!s) return;
    const now = Date.now();
    if (s.expires_at && now > Date.parse(s.expires_at)) { stop(); auth.logout({ reason: 'expired' }); return; }
    const idle = now - lastActivity;
    if (idle >= idleMs) { stop(); auth.logout({ reason: 'idle' }); return; }
    if (idle >= idleMs - warnMs) {
      warned = true;
      count.textContent = `${Math.ceil((idleMs - idle) / 1000)} s`;
      banner.hidden = false;
    } else if (warned) { warned = false; banner.hidden = true; }
  }
  const ticker = setInterval(check, 1000);
  const stop = () => clearInterval(ticker);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  remote.logout = () => { stop(); location.href = `${loginUrl()}?reason=signed-out`; };
  remote.session = () => location.reload(); // another tab signed in as someone else
  return { stop };
}

// ── API ───────────────────────────────────────────────────────────────────
export async function api(path, body, method) {
  // Bearer rather than a cookie: the portal and the API are on different origins
  // when the site is served from GitHub Pages, and a cross-site cookie would need
  // SameSite=None on a third-party domain. A token held by the page is simpler and
  // does not depend on the browser's third-party cookie policy.
  const res = await fetch(`${API_BASE}${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    auth.clear();
    if (!isLoginPage()) location.href = `${loginUrl()}?reason=expired`;
    throw new Error('session expired');
  }
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

// ── theme ─────────────────────────────────────────────────────────────────
// The choice is stamped on <html data-theme> by a tiny inline script before the
// stylesheet loads (no flash); this module only reads and toggles it.
const THEME_KEY = 'ew_theme';
export const theme = {
  get effective() {
    const forced = document.documentElement.dataset.theme;
    if (forced === 'dark' || forced === 'light') return forced;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  },
  set(next) {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  },
  toggle() { theme.set(theme.effective === 'dark' ? 'light' : 'dark'); },
};

// ── brand marks (§6.1, drawn from the same path data as the PDF) ──────────
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
};
const SYMBOL_PATHS = ['M8 30 L8 8 L30 8', 'M92 70 L92 92 L70 92', 'M72 34 L72 56 L36 56', 'M48 44 L36 56 L48 68'];

/** The open bracket alone. Strokes follow `currentColor`, so it works on ink or paper. */
export function symbol({ size = 26, className = 'symbol' } = {}) {
  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: size, height: size, role: 'img', 'aria-label': 'Enter Asset Management', class: className });
  for (const d of SYMBOL_PATHS) svg.append(svgEl('path', { d }));
  return svg;
}

export function logo({ size = 26, descriptor = true } = {}) {
  return h('span.lockup', {}, symbol({ size }), h('span', { style: { display: 'flex', flexDirection: 'column' } },
    h('span.word', { text: 'enter', style: { fontSize: `${size * 0.8}px` } }),
    descriptor && h('span.desc', { text: 'Asset Management', style: { fontSize: `${size * 0.24}px` } })));
}

/** The return arrow drawing itself — the house loading indicator. */
export function loader() {
  const svg = svgEl('svg', { viewBox: '0 0 100 100', class: 'loader', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: SYMBOL_PATHS[0] }), svgEl('path', { d: SYMBOL_PATHS[1] }),
    svgEl('path', { d: 'M72 34 L72 56 L36 56 M48 44 L36 56 L48 68', class: 'arrow' }));
  return svg;
}

// ── icons (§11.1: 1.5px stroke on a 24px grid, square caps, monochrome) ──
const ICONS = {
  overview: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  signals: 'M3 16l5-6 4 4 6-9 3 3 M3 20h18',
  clients: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20a6 6 0 0 1 12 0 M16 5a3 3 0 0 1 0 6 M21 20a6 6 0 0 0-4-5.7',
  triggers: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 21h4',
  portfolio: 'M3 5h18v4H3z M3 10h13v4H3z M3 15h8v4H3z',
  month: 'M4 6h16v14H4z M4 10h16 M8 4v4 M16 4v4',
  matters: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  letter: 'M3 6h18v12H3z M3 7l9 6 9-6',
  documents: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  logout: 'M10 4H4v16h6 M14 8l4 4-4 4 M8 12h10',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  arrow: 'M4 12h16 M13 5l7 7-7 7',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4',
  check: 'M4 12l5 5L20 7',
  x: 'M5 5l14 14 M19 5L5 19',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 20h16',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  prep: 'M3 4h18v12H3z M8 21l4-5 4 5',
  back: 'M20 12H4 M11 5l-7 7 7 7',
};
export function icon(name, { size = 18 } = {}) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'ic', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: ICONS[name] || ICONS.overview }));
  return svg;
}

export const initials = (name = '') => name.trim().split(/\s+/).filter(Boolean).map((w) => w[0]).filter((_, i, a) => i === 0 || i === a.length - 1).join('').toUpperCase() || '·';
export const avatar = (name) => h('span.avatar', { text: initials(name), 'aria-hidden': 'true' });

// ── shell: the trail, the rail, the masthead ──────────────────────────────
/**
 * Where you are, as a path from the portal's root: every crumb but the last
 * links back up a level. `items`: [{ label, href }].
 */
export function crumbs(items) {
  const bar = document.getElementById('crumbs');
  if (!bar) return;
  const list = h('ol.crumbs', {}, items.flatMap((it, i) => {
    const last = i === items.length - 1;
    const node = last || !it.href
      ? h('li', { class: last ? 'cur' : '', 'aria-current': last ? 'page' : null, text: it.label })
      : h('li', {}, h('a', { href: it.href, text: it.label }));
    return i ? [h('li.sep', { 'aria-hidden': 'true', text: '/' }), node] : [node];
  }));
  mount(bar, list);
  list.scrollLeft = list.scrollWidth; // a deep trail on a narrow screen keeps the current page in view
}

export function railBrand(app) {
  return h('div.rail-brand', {}, h('a', { href: '#/', 'aria-label': 'Início' }, logo({ size: 26 })), app && h('div.app', { text: app }));
}

export function navItem({ href, icon: ic, label, count = null, person = false }) {
  return h('a', { href },
    person ? avatar(label) : icon(ic),
    h('span', { text: label }),
    count != null && count !== '' ? h('span.count', { text: String(count) }) : null);
}

export function railFoot({ name, sub, onLogout }) {
  return h('div.rail-foot', {},
    h('div.who', {}, avatar(name), h('div', {}, h('div.nm', { text: name }), sub && h('div.rl', { text: sub }))),
    h('div.rail-tools', {},
      themeToggle(),
      h('button.btn.sm', { type: 'button', title: 'Sair', onclick: onLogout }, icon('logout', { size: 15 }), h('span', { text: 'sair' }))));
}

export function themeToggle() {
  const btn = h('button.btn.sm', { type: 'button' });
  const paint = () => {
    const dark = theme.effective === 'dark';
    mount(btn, icon(dark ? 'sun' : 'moon', { size: 15 }), h('span', { text: dark ? 'claro' : 'escuro' }));
    btn.title = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
  };
  btn.addEventListener('click', () => { theme.toggle(); paint(); });
  paint();
  return btn;
}

export function pageHead({ kicker = null, title, sub = null, actions = null }) {
  return h('header.page-head', {},
    h('div', {},
      kicker && h('div.page-kicker', {}, kicker),
      h('h1.page-title', { text: title }),
      sub && h('div.page-sub', { text: sub })),
    actions && actions.filter?.(Boolean).length ? h('div.page-actions', {}, actions) : null);
}

/** Time-of-day greeting in Portuguese. */
export function greeting(hour = new Date().getHours()) {
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
}

/** "terça-feira, 8 de setembro de 2026" */
export function dateWithWeekday(iso, locale = 'pt-BR') {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  const wd = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale, { weekday: 'long' });
  return wd ? `${wd}, ${dateLong(iso, locale)}` : dateLong(iso, locale);
}

// ── figures ───────────────────────────────────────────────────────────────
export function stat(label, value, { tone = '', sub = null, small = false, hero = false } = {}) {
  return h('div.stat', { class: hero ? 'hero' : '' },
    h('span.lbl', { text: label }),
    h('span.val', { class: `${tone || ''} ${small ? 'sm' : ''}`.trim(), text: value }),
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
// Colour comes from CSS classes rather than inline fills so a theme change
// repaints every chart without a re-render. Categorical hues (§7.8) are
// theme-invariant and stay inline.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const text = (attrs, content) => { const t = svgEl('text', attrs); t.textContent = content; return t; };

/** Horizontal bars on a shared zero line, value labels outside, explicit signs. */
export function barChart(items, { title = null, caption = null, width = 560, rowHeight = 28, labelWidth = 160, locale = 'pt-BR', unit = 'pp' } = {}) {
  if (!items.length) return h('div.empty', { text: 'Sem dados para exibir.' });
  const bound = Math.max(1e-6, ...items.map((i) => Math.abs(i.value)));
  const height = items.length * rowHeight + 6;
  const valueWidth = 80;
  const plotW = width - labelWidth - valueWidth;
  const zeroX = labelWidth + plotW / 2;
  const scale = (plotW / 2) / bound;
  const barH = 14;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'chart' });
  items.forEach((it, i) => {
    const y = i * rowHeight + 3;
    const bw = Math.max(0.8, Math.abs(it.value) * scale);
    const bx = it.value >= 0 ? zeroX : zeroX - bw;
    const mid = y + (rowHeight - 6) / 2;
    svg.append(svgEl('rect', { x: bx.toFixed(1), y: (mid - barH / 2).toFixed(1), width: bw.toFixed(1), height: barH, class: `c-bar ${it.value >= 0 ? 'gain' : 'loss'}` }));
    svg.append(text({ x: labelWidth - 10, y: mid + 4, 'text-anchor': 'end', 'font-size': 12, class: 'c-lbl' }, it.label));
    // §10.1 value labels sit outside the bar. When the longest bar leaves no
    // room before the label column, the figure moves inside the bar in white
    // rather than overprinting the series name.
    const label = unit === 'pp' ? pp(it.value, { locale }) : percent(it.value, { locale });
    const approxW = label.length * 6.6;
    const inside = it.value < 0 && (zeroX - bw - 8 - approxW) < labelWidth;
    svg.append(text({
      x: it.value >= 0 ? zeroX + bw + 8 : inside ? zeroX - bw + 6 : zeroX - bw - 8,
      y: mid + 4, 'text-anchor': it.value >= 0 || inside ? 'start' : 'end', 'font-size': 12,
      class: `c-val ${inside ? 'inside' : it.value >= 0 ? 'gain' : 'loss'}`,
    }, label));
  });
  svg.append(svgEl('line', { x1: zeroX, y1: 0, x2: zeroX, y2: height - 3, class: 'c-zero', 'stroke-width': 1 }));

  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, caption && h('figcaption.chart-caption', { text: caption }));
}

/** Stacked allocation bar in the fixed categorical order. Never a doughnut. */
export function allocationBar(items, { title = null, caption = null, width = 560, height = 36, locale = 'pt-BR' } = {}) {
  const total = items.reduce((a, i) => a + i.weight, 0) || 1;
  const cats = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--cat-${i}`) || '#12314F');
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'allocation' });
  let x = 0;
  items.forEach((it, i) => {
    const w = (it.weight / total) * width;
    const r = svgEl('rect', { x: x.toFixed(1), y: 0, width: Math.max(0, w - (i < items.length - 1 ? 1 : 0)).toFixed(1), height, fill: it.color || cats[i % cats.length] });
    r.append(svgEl('title', {}));
    r.firstChild.textContent = `${it.label} · ${weight(it.weight, { locale, decimals: 1 })}`;
    svg.append(r);
    if (w > 44) svg.append(text({ x: (x + w / 2).toFixed(1), y: height / 2 + 4, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 500, fill: '#fff' }, weight(it.weight, { locale, decimals: 1 })));
    x += w;
  });
  const legend = h('div.alloc-legend', {}, items.map((it, i) => h('span.alloc-key', {},
    h('i', { style: { background: it.color || cats[i % cats.length] } }),
    `${it.label} `, h('b', { text: weight(it.weight, { locale, decimals: 1 }) }))));
  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, legend, caption && h('figcaption.chart-caption', { text: caption }));
}

/** Allocation against the permitted band. The band is the point of the chart. */
export function bandChart(rows, { title = null, caption = null, width = 560, rowHeight = 30, labelWidth = 176, locale = 'pt-BR' } = {}) {
  const usable = rows.filter((r) => r.range);
  if (!usable.length) return h('div.empty', { text: 'Sem faixas definidas na política.' });
  const maxBound = Math.max(0.3, ...usable.map((r) => Math.max(r.weight, r.range.max ?? 0)));
  const plotW = width - labelWidth - 72;
  const sx = (v) => labelWidth + (v / maxBound) * plotW;
  const height = usable.length * rowHeight + 6;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'bands' });
  usable.forEach((r, i) => {
    const y = i * rowHeight + 3;
    const mid = y + (rowHeight - 6) / 2;
    const inside = r.weight >= (r.range.min ?? 0) && r.weight <= (r.range.max ?? 1);
    svg.append(svgEl('rect', { x: sx(r.range.min ?? 0).toFixed(1), y: mid - 7, width: Math.max(1, sx(r.range.max ?? 0) - sx(r.range.min ?? 0)).toFixed(1), height: 14, class: 'c-band' }));
    if (r.range.target != null) svg.append(svgEl('line', { x1: sx(r.range.target).toFixed(1), y1: mid - 9, x2: sx(r.range.target).toFixed(1), y2: mid + 9, class: 'c-target', 'stroke-width': 1 }));
    svg.append(svgEl('rect', { x: (sx(r.weight) - 1.5).toFixed(1), y: mid - 10, width: 3, height: 20, class: `c-mark ${inside ? 'in' : 'out'}` }));
    svg.append(text({ x: labelWidth - 10, y: mid + 4, 'text-anchor': 'end', 'font-size': 12, class: 'c-lbl' }, r.asset_class));
    svg.append(text({ x: width - 2, y: mid + 4, 'text-anchor': 'end', 'font-size': 12, class: `c-val ${inside ? 'in' : 'out'}` }, weight(r.weight, { locale, decimals: 1 }) + (inside ? '' : ' !')));
  });
  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, caption && h('figcaption.chart-caption', { text: caption }));
}

/** Cumulative line: the firm's line is ink, the benchmark is blue dashed. Hover reads a month. */
export function lineChart(series, { title = null, caption = null, width = 560, height = 190, locale = 'pt-BR' } = {}) {
  const port = series.portfolio || [];
  if (port.length < 2) return h('div.empty', { text: 'Histórico insuficiente.' });
  const bench = series.benchmark || [];
  const pad = { l: 4, r: 68, t: 12, b: 22 };
  const all = [...port, ...bench].map((p) => p.value);
  const lo = Math.min(0, ...all); const hi = Math.max(0, ...all);
  const span = Math.max(1e-6, hi - lo);
  const plotW = width - pad.l - pad.r;
  const sx = (i, n) => pad.l + (i / Math.max(1, n - 1)) * plotW;
  const sy = (v) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const d = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i, pts.length).toFixed(1)},${sy(p.value).toFixed(1)}`).join(' ');

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': title || 'cumulative' });
  svg.append(svgEl('line', { x1: pad.l, y1: sy(0), x2: width - pad.r, y2: sy(0), class: 'c-rule', 'stroke-width': 1 }));
  if (bench.length > 1) svg.append(svgEl('path', { d: d(bench), class: 'c-line bench' }));
  svg.append(svgEl('path', { d: d(port), class: 'c-line port' }));

  const last = port[port.length - 1];
  const lastB = bench[bench.length - 1];
  svg.append(svgEl('rect', { x: (sx(port.length - 1, port.length) - 2.5).toFixed(1), y: (sy(last.value) - 2.5).toFixed(1), width: 5, height: 5, class: 'c-end port' }));
  svg.append(text({ x: width - pad.r + 8, y: sy(last.value) + 4, 'font-size': 11.5, class: 'c-tag port' }, percent(last.value, { locale })));
  if (lastB) {
    svg.append(svgEl('rect', { x: (sx(bench.length - 1, bench.length) - 2.5).toFixed(1), y: (sy(lastB.value) - 2.5).toFixed(1), width: 5, height: 5, class: 'c-end bench' }));
    // keep the two end labels from overprinting when the series finish close together
    let yB = sy(lastB.value) + 4;
    const yP = sy(last.value) + 4;
    if (Math.abs(yB - yP) < 13) yB = yB < yP ? yP - 13 : yP + 13;
    svg.append(text({ x: width - pad.r + 8, y: yB, 'font-size': 11.5, class: 'c-tag bench' }, percent(lastB.value, { locale })));
  }
  for (const [i, p] of [[0, port[0]], [port.length - 1, last]]) {
    svg.append(text({ x: sx(i, port.length), y: height - 5, 'text-anchor': i === 0 ? 'start' : 'end', 'font-size': 10.5, class: 'c-muted' }, monthLabel(p.label, locale) || p.label || ''));
  }

  // hover: a vertical rule and a reading of both series for that month
  const vline = svgEl('line', { y1: pad.t, y2: height - pad.b, class: 'c-hover', style: 'display:none' });
  const hit = svgEl('rect', { x: pad.l, y: 0, width: plotW, height, class: 'c-hit' });
  svg.append(vline, hit);
  const tip = h('div.chart-tip');
  const byLabel = new Map(bench.map((b) => [b.label, b]));
  const hide = () => { vline.style.display = 'none'; tip.style.display = 'none'; };
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const xv = ((e.clientX - r.left) / r.width) * width;
    const i = Math.max(0, Math.min(port.length - 1, Math.round(((xv - pad.l) / plotW) * (port.length - 1))));
    const p = port[i]; const b = byLabel.get(p.label);
    const x = sx(i, port.length);
    vline.setAttribute('x1', x); vline.setAttribute('x2', x); vline.style.display = '';
    tip.replaceChildren(h('b', { text: monthLabel(p.label, locale) }),
      h('span', { text: `Carteira ${percent(p.value, { locale })}` }),
      b ? h('br') : null, b ? h('span.b', { text: `Referência ${percent(b.value, { locale })}` }) : null);
    const px = (x / width) * r.width;
    const flip = px > r.width * 0.6;
    tip.style.display = 'block';
    tip.style.left = `${px}px`;
    tip.style.transform = flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)';
    tip.style.top = `${r.top - tip.parentElement.getBoundingClientRect().top}px`;
  });
  hit.addEventListener('mouseleave', hide);

  return h('figure', {}, title && h('figcaption.chart-title', { text: title }), svg, tip, caption && h('figcaption.chart-caption', { text: caption }));
}

/**
 * A sparkline: one price series in ink, a hairline at the window's opening close so
 * the eye reads above or below it, and a hover reading of date and close. The
 * variation itself is typeset next to it, so the line carries no colour (§7.1).
 * `points` are { date, close }; `format` renders a close for the tooltip.
 */
export function sparkline(points, { width = 100, height = 28, format = (v) => String(v), dateLabel = (d) => d } = {}) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.close);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const span = Math.max(1e-9, hi - lo);
  const pad = 2;
  const sx = (i) => (i / (points.length - 1)) * width;
  const sy = (v) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(2)},${sy(p.close).toFixed(2)}`).join(' ');

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true' });
  const y0 = sy(points[0].close).toFixed(2);
  svg.append(svgEl('line', { x1: 0, y1: y0, x2: width, y2: y0, class: 'spark-base', 'vector-effect': 'non-scaling-stroke' }));
  svg.append(svgEl('path', { d, class: 'spark-line', 'vector-effect': 'non-scaling-stroke' }));
  const cursor = svgEl('line', { y1: 0, y2: height, class: 'spark-cursor', 'vector-effect': 'non-scaling-stroke', style: 'display:none' });
  svg.append(cursor);

  const wrap = h('div.spark-wrap', {}, svg);
  const tip = h('div.chart-tip');
  wrap.append(tip);
  const hide = () => { cursor.style.display = 'none'; tip.style.display = 'none'; };
  wrap.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1))));
    const x = sx(i).toFixed(2);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.style.display = '';
    tip.replaceChildren(h('b', { text: dateLabel(points[i].date) }), h('span', { text: format(points[i].close) }));
    const px = (i / (points.length - 1)) * r.width;
    tip.style.display = 'block';
    tip.style.left = `${px}px`;
    tip.style.top = '-6px';
    tip.style.transform = px > r.width * 0.55 ? 'translate(calc(-100% - 8px), -100%)' : 'translate(8px, -100%)';
  });
  wrap.addEventListener('mouseleave', hide);
  return wrap;
}

// ── the daily agents: progress ────────────────────────────────────────────
export const DAILY_AGENTS = [
  { step: 1, key: 'dados', title: 'Agente 1 · Dados', what: 'indicadores, eventos e notícias, cada um com a fonte' },
  { step: 2, key: 'inferencia', title: 'Agente 2 · Inferência', what: 'o que importa hoje para as suas carteiras' },
  { step: 3, key: 'gatilhos', title: 'Agente 3 · Gatilhos', what: 'limiares de mercado e desvios de alocação' },
];

/** A progress ring. `set(p)` takes 0..100. */
export function donut({ size = 96 } = {}) {
  const r = 42; const c = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: '0 0 100 100', width: size, height: size, class: 'donut', 'aria-hidden': 'true' });
  const track = svgEl('circle', { cx: 50, cy: 50, r, class: 'track' });
  const arc = svgEl('circle', { cx: 50, cy: 50, r, class: 'arc', 'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': c.toFixed(2), transform: 'rotate(-90 50 50)' });
  const label = text({ x: 50, y: 50, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'pct' }, '0%');
  svg.append(track, arc, label);
  return {
    el: svg,
    set(p) {
      const v = Math.max(0, Math.min(100, Number(p) || 0));
      arc.setAttribute('stroke-dashoffset', (c * (1 - v / 100)).toFixed(2));
      label.textContent = `${Math.round(v)}%`;
    },
  };
}

/**
 * The card that pops up while the agents run. `update(run)` takes the run as
 * the API reports it; `onDone` fires when the person dismisses a finished run.
 */
export function progressCard({ title = 'Atualizando o panorama do dia', agents = DAILY_AGENTS, onDone = null } = {}) {
  const ring = donut({ size: 96 });
  const msg = h('div.pmsg', { text: 'Na fila…' });
  const state = h('div.pstate', { text: 'Os três agentes rodam em sequência. Com o modelo pesquisando o noticiário, isto leva de um a cinco minutos; a página pode ser fechada, a execução continua.' });
  const rows = agents.map((a) => h('li', { dataset: { step: a.step } },
    h('span.idx', {}, h('b', { text: String(a.step) }), icon('check', { size: 14 })),
    h('span', {}, h('b', { text: a.title }), h('small', { text: a.what }))));
  const foot = h('div.pfoot');
  const clock = h('span.mono.muted');
  const card = h('div.progress-card', { role: 'dialog', 'aria-live': 'polite', 'aria-label': title },
    h('div.phead', {}, ring.el, h('div', {}, h('h3', { text: title }), msg, state)),
    h('ol.agents', {}, rows), foot);
  const veil = h('div.veil', {}, card);
  document.body.append(veil);
  const t0 = Date.now();
  const timer = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 500);
  mount(foot, clock);

  const close = () => { clearInterval(timer); veil.remove(); };
  const finish = () => { close(); onDone?.(); };
  let finished = false;
  return {
    el: veil,
    close,
    update(run) {
      ring.set(run.progress ?? 0);
      msg.textContent = run.message || '';
      for (const li of rows) {
        const s = Number(li.dataset.step);
        li.className = run.status === 'completed' || s < run.step ? 'done' : s === run.step && run.status === 'running' ? 'active' : run.status === 'failed' && s === run.step ? 'failed' : '';
      }
      if (run.status === 'completed' && !finished) {
        finished = true;
        state.textContent = 'Concluído. O panorama abaixo já reflete esta execução.';
        mount(foot, clock, h('button.btn.primary', { type: 'button', onclick: finish }, h('span', { text: 'ver o panorama' }), icon('arrow', { size: 15 })));
        setTimeout(() => { if (veil.isConnected) finish(); }, 1400);
      } else if (run.status === 'failed' && !finished) {
        finished = true;
        state.textContent = `A execução falhou: ${run.error || 'erro desconhecido'}.`;
        mount(foot, clock, h('button.btn', { type: 'button', text: 'fechar', onclick: finish }));
      }
    },
  };
}

// ── bars for thresholds and drift ─────────────────────────────────────────
/** A bullet bar: how far a reading has travelled towards its trigger. The mark is the threshold. */
export function bulletBar({ proximity, status }) {
  const CAP = 1.3;
  const p = proximity == null ? 0 : Math.min(CAP, Math.max(0, proximity));
  return h('div.bullet', { class: String(status || '').toLowerCase() },
    h('div.track', {}, h('i.fill', { style: { width: `${((p / CAP) * 100).toFixed(1)}%` } }), h('i.mark', { style: { left: `${((1 / CAP) * 100).toFixed(1)}%` } })));
}

/** A diverging bar: a drift from target with the rebalance tolerance marked either side of zero. */
export function driftBar({ drift, tolerance, scale = null }) {
  const s = Math.max(scale || 0, tolerance * 2, Math.abs(drift) * 1.05) || 1;
  const pos = drift >= 0;
  const w = `${((Math.abs(drift) / s) * 50).toFixed(1)}%`;
  return h('div.diverge', {},
    h('div.track', {},
      h('i.tol', { style: { left: `${(50 - (tolerance / s) * 50).toFixed(1)}%` } }),
      h('i.tol', { style: { left: `${(50 + (tolerance / s) * 50).toFixed(1)}%` } }),
      h('i.fill', { class: pos ? 'pos' : 'neg', style: pos ? { left: '50%', width: w } : { right: '50%', width: w } }),
      h('i.zero')));
}

// ── correlation matrix ────────────────────────────────────────────────────
// A diverging ramp on the palette: benchmark blue for pairs that move together,
// drawdown red for pairs that move apart, paper at zero. Never green — green
// means a gain, and a correlation is a comparison (§7.5, §10.4). The value is
// printed in every cell; colour is redundant reinforcement (§7.10).
const hexRgb = (hex) => { const v = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
function corrColor(r) {
  const dark = theme.effective === 'dark';
  const pos = dark ? ['--paper-2', '--b-900', '--b-800', '--b-600', '--b-400'] : ['--paper-2', '--b-100', '--b-200', '--b-400', '--b-700'];
  const neg = dark ? ['--paper-2', '--r-900', '--r-800', '--r-600', '--r-400'] : ['--paper-2', '--r-100', '--r-200', '--r-400', '--r-700'];
  const ramp = (r >= 0 ? pos : neg).map((v) => hexRgb(cssVar(v) || '#ffffff'));
  const t = Math.min(1, Math.abs(r)) * (ramp.length - 1);
  const i = Math.floor(t); const f = t - i;
  const a = ramp[i]; const b = ramp[Math.min(ramp.length - 1, i + 1)];
  const mix = a.map((c, k) => Math.round(c + (b[k] - c) * f));
  return { bg: `rgb(${mix.join(',')})`, fg: Math.abs(r) >= 0.55 ? '#FFFFFF' : cssVar('--ink-950') };
}

/**
 * `data` is the /api/advisor/correlations payload. `short` names a column.
 * Repaints itself on a theme change while it is on the page.
 */
export function correlationMatrix(data, { locale = 'pt-BR', short = (x) => x.label } = {}) {
  const inds = data.indicators || [];
  if (inds.length < 2) return h('div.empty', { text: 'Séries insuficientes para uma matriz de correlação.' });
  const fmt = (r) => (r == null ? '—' : num(r, { locale, decimals: 2, signed: true }));
  const cells = [];
  const table = h('table.corr', {},
    h('thead', {}, h('tr', {}, h('th'), inds.map((ind, j) => h('th', { text: short(ind), title: ind.label, dataset: { col: j } })))),
    h('tbody', {}, inds.map((ri, i) => h('tr', {},
      h('th', { text: short(ri), title: ri.label }),
      inds.map((ci, j) => {
        const r = data.matrix[i][j];
        if (i === j) return h('td.self', { text: fmt(1), dataset: { col: j } });
        const td = h('td', {
          class: r == null ? 'na' : '', dataset: { col: j }, text: fmt(r),
          title: `${ri.label} × ${ci.label}: ${fmt(r)} · ${data.observations?.[i]?.[j] ?? '—'} observações`,
        });
        if (r != null) cells.push([td, r]);
        return td;
      })))));
  const paint = () => { for (const [td, r] of cells) { const c = corrColor(r); td.style.background = c.bg; td.style.color = c.fg; } };
  paint();

  // hover reads a row and a column at once
  const clear = () => { for (const el of table.querySelectorAll('.col-on')) el.classList.remove('col-on'); };
  table.addEventListener('mouseover', (e) => {
    const col = e.target.closest('td,th')?.dataset.col;
    clear();
    if (col != null) for (const el of table.querySelectorAll(`[data-col="${col}"]`)) el.classList.add('col-on');
  });
  table.addEventListener('mouseleave', clear);

  const steps = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
  const legend = h('div.corr-legend', {}, h('i', { text: '−1 movem em direções opostas' }),
    steps.map((v) => h('span', { title: fmt(v) })), h('i', { text: 'movem juntos +1' }));
  const swatches = [...legend.querySelectorAll('span')];
  const paintLegend = () => swatches.forEach((el, k) => { el.style.background = corrColor(steps[k]).bg; });
  paintLegend();

  const fig = h('figure', {}, h('div.tw', {}, table), legend);
  const onTheme = () => { if (!fig.isConnected) { window.removeEventListener('themechange', onTheme); return; } paint(); paintLegend(); };
  window.addEventListener('themechange', onTheme);
  return fig;
}

// ── scatter ───────────────────────────────────────────────────────────────
// Identity never rides on colour alone: every mark carries its name, each class
// has its own marker shape, and the legend shows both. Colour comes from the
// class token (--k-*) through CSS, so a theme change repaints without a render.
const SHAPES = ['circle', 'square', 'diamond', 'triangle'];
function marker(shape, cx, cy, r, attrs = {}) {
  const f = (v) => Number(v.toFixed(1));
  if (shape === 'square') return svgEl('rect', { x: f(cx - r), y: f(cy - r), width: f(2 * r), height: f(2 * r), ...attrs });
  if (shape === 'diamond') return svgEl('rect', { x: f(cx - r), y: f(cy - r), width: f(2 * r), height: f(2 * r), transform: `rotate(45 ${f(cx)} ${f(cy)})`, ...attrs });
  if (shape === 'triangle') return svgEl('path', { d: `M${f(cx)},${f(cy - r * 1.25)} L${f(cx + r * 1.2)},${f(cy + r * 0.85)} L${f(cx - r * 1.2)},${f(cy + r * 0.85)} Z`, ...attrs });
  return svgEl('circle', { cx: f(cx), cy: f(cy), r, ...attrs });
}

/** Round ticks that cover [lo, hi] in about `n` steps of 1, 2, 2.5 or 5 × 10^k. */
function niceTicks(lo, hi, n = 5) {
  const span = Math.max(1e-9, hi - lo);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/**
 * `items` are { key, label, x, y, cls }; `classes` are { key, label } in legend
 * order, which also fixes each class's marker shape and colour slot. `tip(item)`
 * returns the tooltip's children; `formatX` / `formatY` render the axis ticks.
 */
export function scatterChart(items, {
  classes = [], xLabel = '', yLabel = '', formatX = (v) => String(v), formatY = formatX,
  title = null, caption = null, width = 720, height = 400, tip: tipFor = null,
} = {}) {
  const pts = items.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return h('div.empty', { text: 'Séries insuficientes para o gráfico.' });
  const pad = { l: 60, r: 84, t: 30, b: 46 };
  const plotW = width - pad.l - pad.r; const plotH = height - pad.t - pad.b;
  const xTicks = niceTicks(0, Math.max(...pts.map((p) => p.x)) * 1.06, 5);
  const yTicks = niceTicks(Math.min(0, ...pts.map((p) => p.y)), Math.max(0, ...pts.map((p) => p.y)), 5);
  const x0 = xTicks[0]; const x1 = xTicks[xTicks.length - 1];
  const y0 = yTicks[0]; const y1 = yTicks[yTicks.length - 1];
  const sx = (v) => pad.l + ((v - x0) / (x1 - x0)) * plotW;
  const sy = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * plotH;
  const slot = (cls) => Math.max(0, classes.findIndex((c) => c.key === cls));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': title || `${yLabel} × ${xLabel}`, class: 'sc' });
  // grid: recessive rules at the ticks, the zero line in ink
  for (const v of yTicks) {
    svg.append(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: sy(v).toFixed(1), y2: sy(v).toFixed(1), class: v === 0 ? 'c-zero' : 'c-rule', 'stroke-width': 1 }));
    svg.append(text({ x: pad.l - 8, y: sy(v) + 3.5, 'text-anchor': 'end', 'font-size': 10.5, class: v === 0 ? 'c-lbl' : 'c-muted' }, formatY(v)));
  }
  for (const v of xTicks) {
    if (v !== x0) svg.append(svgEl('line', { x1: sx(v).toFixed(1), x2: sx(v).toFixed(1), y1: pad.t, y2: height - pad.b, class: 'c-rule', 'stroke-width': 1, 'stroke-dasharray': '2 4' }));
    svg.append(text({ x: sx(v), y: height - pad.b + 16, 'text-anchor': 'middle', 'font-size': 10.5, class: 'c-muted' }, formatX(v)));
  }
  svg.append(svgEl('line', { x1: pad.l, x2: pad.l, y1: pad.t, y2: height - pad.b, class: 'c-rule', 'stroke-width': 1 }));
  if (yLabel) svg.append(text({ x: pad.l - 8, y: pad.t - 12, 'text-anchor': 'start', 'font-size': 11, class: 'c-lbl strong' }, yLabel));
  if (xLabel) svg.append(text({ x: pad.l + plotW / 2, y: height - 6, 'text-anchor': 'middle', 'font-size': 11, class: 'c-lbl strong' }, xLabel));

  // labels: to the right of the mark, flipped left near the edge. In a dense
  // cluster a label steps down until it clears every label placed before it and
  // every other mark; a label that moved away from its mark gets a hairline back.
  const LINE = 12; const MR = 7;
  const labels = pts.map((p) => ({ p, w: String(p.label).length * 6.4, x: sx(p.x) + 10, y: sy(p.y) + 4, anchor: 'start' }));
  for (const l of labels) if (l.x + l.w > width - 2) { l.x = sx(l.p.x) - 10; l.anchor = 'end'; }
  labels.sort((a, b) => a.y - b.y);
  const left = (l) => (l.anchor === 'start' ? l.x : l.x - l.w);
  const boxOf = (l) => ({ x0: left(l), x1: left(l) + l.w, y0: l.y - 9, y1: l.y + 2 });
  const markBoxes = pts.map((p) => ({ p, x0: sx(p.x) - MR, x1: sx(p.x) + MR, y0: sy(p.y) - MR, y1: sy(p.y) + MR }));
  const hits = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (let i = 0; i < labels.length; i += 1) {
    const b = labels[i];
    for (let guard = 0; guard < 40; guard += 1) {
      const box = boxOf(b);
      const label = labels.slice(0, i).find((a) => hits(boxOf(a), box));
      if (label) { b.y = label.y + LINE; continue; }
      const mark = markBoxes.find((m) => m.p !== b.p && hits(m, box));
      if (mark) { b.y = mark.y1 + 9; continue; }
      break;
    }
  }

  const tip = h('div.chart-tip');
  const marks = svgEl('g');
  for (const l of labels) {
    const p = l.p; const cx = sx(p.x); const cy = sy(p.y);
    const k = slot(p.cls);
    const g = svgEl('g', { class: `sc-mark k-${p.cls}`, tabindex: 0, role: 'img', 'aria-label': `${p.label}: ${formatY(p.y)}, ${formatX(p.x)}` });
    if (l.y - 4 - cy > 8) {
      const lx = l.anchor === 'start' ? l.x - 3 : l.x + 3;
      g.append(svgEl('line', { x1: cx.toFixed(1), y1: (cy + MR).toFixed(1), x2: lx.toFixed(1), y2: (l.y - 4).toFixed(1), class: 'sc-leader' }));
    }
    g.append(marker(SHAPES[k % SHAPES.length], cx, cy, 5, { class: 'sc-dot' }));
    g.append(text({ x: l.x.toFixed(1), y: l.y.toFixed(1), 'text-anchor': l.anchor, 'font-size': 11, class: 'sc-lbl' }, p.label));
    g.append(svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 14, class: 'c-hit' }));
    const show = () => {
      g.classList.add('on');
      tip.replaceChildren(...(tipFor ? tipFor(p) : [h('b', { text: p.label }), h('span', { text: `${yLabel} ${formatY(p.y)}` }), h('br'), h('span', { text: `${xLabel} ${formatX(p.x)}` })]));
      const r = svg.getBoundingClientRect();
      const px = (cx / width) * r.width; const py = (cy / height) * r.height;
      const flip = px > r.width * 0.62;
      tip.style.display = 'block';
      tip.style.left = `${px}px`;
      tip.style.top = `${r.top - tip.parentElement.getBoundingClientRect().top + py}px`;
      tip.style.transform = flip ? 'translate(calc(-100% - 12px), -50%)' : 'translate(12px, -50%)';
    };
    const hide = () => { g.classList.remove('on'); tip.style.display = 'none'; };
    g.addEventListener('mouseenter', show); g.addEventListener('mouseleave', hide);
    g.addEventListener('focus', show); g.addEventListener('blur', hide);
    marks.append(g);
  }
  svg.append(marks);

  const legend = classes.length > 1 ? h('div.sc-legend', {}, classes.map((c, k) => {
    const sw = svgEl('svg', { viewBox: '0 0 16 16', width: 14, height: 14, class: `k-${c.key}`, 'aria-hidden': 'true' });
    sw.append(marker(SHAPES[k % SHAPES.length], 8, 8, 5, { class: 'sc-dot' }));
    return h('span.sc-key', {}, sw, h('span', { text: c.label }));
  })) : null;

  return h('figure.sc-fig', {}, title && h('figcaption.chart-title', { text: title }), legend, svg, tip, caption && h('figcaption.chart-caption', { text: caption }));
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
  const isMock = (s) => s.mocked || /simulated/i.test(s.provider || '');
  const simulated = sources.filter(isMock);
  return h('details.sources', {},
    h('summary', { text: `${label} (${sources.length})` }),
    simulated.length ? h('p.note', { style: { marginTop: '10px' } },
      h('span.chip.mock', { text: 'DADOS SIMULADOS' }), ` ${simulated.length} de ${sources.length} registros são de demonstração e estão marcados abaixo.`) : null,
    h('ul', {}, sources.map((s) => h('li', {}, sourceLine(s), isMock(s) ? ' ' : null, isMock(s) ? h('span.chip.mock', { text: 'MOCK' }) : null))));
}

// ── router ────────────────────────────────────────────────────────────────
export function router(routes, { root, notFound }) {
  let seq = 0;
  async function render() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const my = ++seq;
    for (const [pattern, handler] of routes) {
      const keys = [];
      const rx = new RegExp(`^${pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
      const m = hash.match(rx);
      if (!m) continue;
      const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      mount(root, h('div.loading', {}, loader(), h('span', { text: 'Carregando…' })));
      try {
        const view = await handler(params);
        if (my !== seq) return; // a newer navigation won
        mount(root, h('div.view', {}, view));
      } catch (err) {
        if (my !== seq) return;
        mount(root, h('div.view', {}, h('div.err', { text: err.message || String(err) })));
        console.error(err);
      }
      window.scrollTo(0, 0);
      return;
    }
    mount(root, h('div.view', {}, notFound ? notFound() : h('div.empty', { text: 'Página não encontrada.' })));
  }
  window.addEventListener('hashchange', render);
  render();
  return { render };
}

export function setActive(container, hash) {
  for (const a of container.querySelectorAll('a[href^="#"]')) {
    const href = a.getAttribute('href');
    a.classList.toggle('on', href === `#${hash}` || (hash.startsWith(href.slice(1)) && href !== '#/'));
  }
}
