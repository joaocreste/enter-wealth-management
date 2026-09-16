/**
 * Advisor portal.
 *
 * The landing page answers the advisor's first question of the day: what
 * matters in markets, and which of my clients could be affected. Everything
 * else hangs off a client.
 */
import {
  h, mount, frag, api, auth, stat, table, router, setActive,
  pageHead, railBrand, navItem, railFoot, icon, greeting, installSessionGuard, crumbs, loader, correlationMatrix,
  progressCard, dialog, apiUpload, bulletBar, driftBar, DAILY_AGENTS, dateWithWeekday, donut,
  money, percent, pp, weight, dateLong, shortDate, monthLabel, toneClass, MINUS,
  barChart, allocationBar, bandChart, lineChart, sparkline, scatterChart, sourcesBlock, sourceLine,
  apiUrl, loginUrl, clientUrl,
} from '../shared/ui.js';
import { briefingSection, indicatorsSection, newsNote, newsHealth, formatIndicator, levelLine, groupPt, dmy, hhmm } from '../shared/overview.js';

const root = document.getElementById('root');
const rail = document.getElementById('rail');
const L = 'pt-BR';
let ME = null;
let CLIENTS = [];
let ROUTER = null;

const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
/** A bare ratio — a Sharpe, not a percentage — with the brand's true minus (§8.3). */
const ratio = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? MINUS : ''}${num(Math.abs(v), d)}`);

/** Asset-class keys are English in the data model; the portal reads Portuguese. */
const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
  Other: 'Outros',
};
const cls = (k) => CLASS_PT[k] || k || '';


// ═══ chrome ════════════════════════════════════════════════════════════════
function renderRail() {
  const alerts = CLIENTS.reduce((a, c) => a + (c.alerts?.length || 0), 0);
  const logout = () => auth.logout();
  mount(rail,
    railBrand('Portal do assessor'),
    h('nav.rail-nav', {},
      navItem({ href: '#/', icon: 'overview', label: 'Panorama do dia' }),
      navItem({ href: '#/signals', icon: 'signals', label: 'Sinais de mercado' }),
      navItem({ href: '#/clients', icon: 'clients', label: 'Clientes', count: CLIENTS.length }),
      navItem({ href: '#/triggers', icon: 'triggers', label: 'Gatilhos' })),
    CLIENTS.length ? h('div.rail-group.people', {},
      h('div.rail-h', {}, h('span', { text: 'Carteira de clientes' }), alerts ? h('em', { text: `${alerts} alertas` }) : null),
      h('nav.rail-nav.people', {}, CLIENTS.map((c) => navItem({ href: `#/client/${c.id}`, person: true, label: c.name, count: c.alerts?.length || null })))) : null,
    railFoot({ name: ME?.user?.name || '', sub: ME?.user?.email || '', onLogout: logout }));
  setActive(rail, location.hash.replace(/^#/, '') || '/');
}

const sep = () => h('span.sep', { text: '·' });
function head(title, sub, actions, kicker) {
  return pageHead({ title, sub, actions, kicker });
}

/** The trail for a route. `extra` lets a view name what the route only identifies. */
function crumbsFor(hash, extra = {}) {
  const root = { label: 'Portal do assessor', href: '#/' };
  const top = { '/': 'Panorama do dia', '/signals': 'Sinais de mercado', '/triggers': 'Gatilhos', '/clients': 'Clientes' };
  if (top[hash]) return [root, { label: top[hash] }];
  const m = hash.match(/^\/client\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return [root, { label: 'Página não encontrada' }];
  const [, id, tab] = m;
  const name = extra.clientName || CLIENTS.find((c) => c.id === id)?.name || 'Cliente';
  const trail = [root, { label: 'Clientes', href: '#/clients' }, { label: name, href: `#/client/${id}` }];
  if (!tab || tab === 'overview') trail.push({ label: 'Visão geral' });
  else if (tab === 'prep') trail.push({ label: 'Preparação de reunião' });
  else if (tab === 'editor') trail.push({ label: 'Editor de carteira' });
  else if (tab === 'carta') trail.push({ label: 'Cartas', href: `#/client/${id}/reports` }, { label: 'Nova carta mensal' });
  else if (tab === 'report') trail.push({ label: 'Cartas', href: `#/client/${id}/reports` }, { label: extra.report || 'Carta' });
  else trail.push({ label: Object.fromEntries(CLIENT_TABS)[tab] || tab });
  return trail;
}
const currentHash = () => location.hash.replace(/^#/, '') || '/';

// ═══ world overview ════════════════════════════════════════════════════════
async function viewOverview() {
  const o = await api('/api/advisor/overview');
  if (o.pending) return pendingOverview(o);

  const indicatorGroups = {};
  for (const i of o.indicators) (indicatorGroups[i.group || 'Outros'] ||= []).push(i);
  const breached = o.triggers.filter((t) => t.status === 'BREACHED').length;
  const modelWrote = o.inference?.mode === 'model';
  const maxDrift = Math.max(0.01, ...o.drift_alerts.map((d) => Math.abs(d.drift)));
  const driftGroups = groupDrift(o.drift_alerts);
  const byRegion = { br: o.what_matters.filter((r) => regionOf(r) === 'br'), intl: o.what_matters.filter((r) => regionOf(r) !== 'br') };

  return frag(
    head(`${greeting()}, ${(ME?.user?.name || '').split(' ')[0]}`,
      `${o.clients_count} clientes sob sua responsabilidade. O que aconteceu nos mercados, e quais carteiras isso toca.`,
      [refreshButton()],
      [h('b', { text: 'Panorama do dia' }), sep(), dateWithWeekday(o.date, L), sep(), h('span', { text: runSummary(o.run) })]),

    h('div.grid.g4', { style: { marginBottom: '48px' } },
      stat('Sob assessoria', money(CLIENTS.reduce((a, c) => a + (c.portfolio_value || 0), 0), { locale: L }), { sub: `${o.clients_count} carteiras` }),
      stat('Eventos que importam hoje', String(o.what_matters.length), { ...newsHealth(o.news, modelWrote) }),
      stat('Gatilhos acionados', String(breached), { tone: breached ? 'caution' : '', sub: `de ${o.triggers.length} limiares monitorados` }),
      stat('Desvios de alocação', String(o.drift_alerts.length), { tone: o.drift_alerts.length ? 'caution' : '', sub: 'além do gatilho de rebalanceamento' })),

    briefingSection(o, { workflowStatus: true }),

    // ── what matters, Brazil first, then the rest of the world ──────────
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'O que importa hoje' }),
        h('span.meta', {}, `${o.what_matters.length} eventos · ${byRegion.br.length} Brasil · ${byRegion.intl.length} internacional · impacto mapeado sobre ${o.clients_count} carteiras${modelWrote ? ' · inferido pelo modelo' : ''}`)),
      o.what_matters.length ? frag(
        mattersRegion('Brasil', 'manchetes das últimas 48 horas no Valor Econômico e no Google News, indicadores e eventos do mercado local', byRegion.br, o),
        mattersRegion('Internacional', 'manchetes das últimas 48 horas no Google News, imprensa internacional com fonte citada, indicadores e eventos dos mercados globais', byRegion.intl, o),
        h('p.note', { style: { marginTop: '14px' }, text: 'Cada linha é um ponto de conversa, não uma ordem. Nenhuma operação é executada a partir desta tela.' }))
        : h('div.empty', { text: 'Nenhum evento do período toca as carteiras sob sua responsabilidade.' })),

    // ── indicators, over the window the advisor picks ───────────────────
    indicatorsSection(o),

    // ── market triggers, as bars ────────────────────────────────────────
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Gatilhos de mercado' }),
        h('span.meta', { text: `${breached} ${breached === 1 ? 'gatilho acionado' : 'gatilhos acionados'} de ${o.triggers.length} limiares monitorados · a barra mede a distância até o limiar; a marca é o limiar` })),
      h('div.card.bars-wide', {},
        h('div', {}, o.triggers.slice().sort(triggerOrder).map((t) => h('div.trg.bars', {},
          h('span', { class: `dot ${t.status}` }),
          h('div', {},
            h('div.lab', {}, t.label,
              t.status === 'BREACHED' ? h('span.chip.warn', { text: 'acionado · ação devida' })
                : t.status === 'APPROACHING' ? h('span.chip', { text: 'aproximando' }) : null),
            t.status === 'BREACHED'
              ? h('div.det.due', {}, h('b', { text: 'Ação: ' }), t.action_pt || t.action || '',
                t.affected_clients?.length ? h('span.muted', { text: ` — ${t.affected_clients.length} cliente(s) expostos: ${t.affected_clients.slice(0, 3).map((c) => c.client_name.split(' ')[0]).join(', ')}${t.affected_clients.length > 3 ? ` +${t.affected_clients.length - 3}` : ''}` }) : null)
              : h('div.det', { text: t.status === 'NO_DATA' ? (t.reason || 'indicador indisponível') : (t.affected_clients?.length ? `${t.affected_clients.length} cliente(s) expostos · ${t.action_pt || t.action || ''}` : (t.action_pt || t.action || '')) })),
          h('div.barcol', {},
            t.status === 'NO_DATA' ? h('div.bullet', {}, h('div.track')) : bulletBar({ proximity: t.proximity, status: t.status }),
            h('span.vals', {},
              h('span', { class: t.status === 'BREACHED' ? 'caution' : '', text: t.observed == null ? 'sem leitura' : fmtLevel(t.observed, t.unit) }),
              h('span', { text: `limiar ${fmtLevel(t.threshold, t.unit)}` })))))))),

    // ── allocation drift, per client ────────────────────────────────────
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Desvios de alocação' }),
        h('span.meta', { text: `${o.drift_alerts.length} ${o.drift_alerts.length === 1 ? 'desvio' : 'desvios'} em ${driftGroups.length} ${driftGroups.length === 1 ? 'carteira' : 'carteiras'} além do gatilho de rebalanceamento · contra a política aprovada; as marcas são a tolerância` })),
      h('div.card.bars-wide', {},
        driftGroups.length
          ? h('div', {}, driftGroups.map((g) => h('div.trg-group', {},
            h('div.trg.bars.group', {},
              h('span.dot.BREACHED'),
              h('div.lab', {}, h('a', { href: `#/client/${g.client_id}`, text: g.client_name }),
                h('span.chip.warn', { text: `${g.items.length} ${g.items.length === 1 ? 'desvio' : 'desvios'} · ação devida` }))),
            g.items.map((d) => h('div.trg.bars.sub', {},
              h('span'),
              h('div', {},
                h('div.lab', { text: cls(d.asset_classes?.[0]) || d.label_pt || d.label }),
                h('div.det.due', {}, h('b', { text: 'Ação: ' }), d.action_pt || d.action)),
              h('div.barcol', {},
                driftBar({ drift: d.drift, tolerance: d.threshold_pp ?? 0.05, scale: maxDrift }),
                h('span.vals', {},
                  h('span', { class: toneClass(d.drift), text: pp(d.drift, { locale: L }) }),
                  h('span', { text: `atual ${weight(d.observed, { locale: L, decimals: 1 })} · alvo ${weight(d.threshold, { locale: L, decimals: 0 })}` }))))))))
          : h('div.empty', { text: 'Nenhuma carteira fora do gatilho de rebalanceamento.' }))),

    // ── correlations ────────────────────────────────────────────────────
    correlationSection(),
  );
}

// ── the agents, from the portal ────────────────────────────────────────────
function refreshButton() {
  return h('button.btn', {
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { followRun((await api('/api/advisor/refresh', {})).run); } catch (err) { b.disabled = false; alert(`Não foi possível iniciar a atualização: ${err.message}`); }
    },
  }, icon('refresh', { size: 15 }), h('span', { text: 'atualizar dados de mercado' }));
}

/** Show the progress card for a run and follow it until it ends; then re-render the page. */
function followRun(run) {
  const card = progressCard({ agents: run.agents || DAILY_AGENTS, onDone: () => ROUTER?.render() });
  card.update(run);
  const tick = async () => {
    let r;
    try { r = (await api(`/api/advisor/refresh/${run.id}`)).run; } catch (err) { card.update({ status: 'failed', error: err.message, step: run.step, progress: run.progress }); return; }
    card.update(r);
    if (r.status === 'running') setTimeout(tick, 1000);
  };
  setTimeout(tick, 500);
}

function pendingOverview(o) {
  followRun(o.run);
  return frag(
    head(`${greeting()}, ${(ME?.user?.name || '').split(' ')[0]}`,
      'Os agentes estão montando o panorama de hoje pela primeira vez. Isto leva cerca de um minuto.',
      null, [h('b', { text: 'Panorama do dia' }), sep(), dateWithWeekday(o.date, L)]),
    h('div.empty', { text: 'Aguardando a primeira execução dos agentes…' }));
}

const TRIGGER_PT = { cron: 'pelo agente diário', manual: 'a pedido', bootstrap: 'na primeira visita' };
function runSummary(run) {
  if (!run?.finished_at) return 'ainda não atualizado';
  const at = new Date(run.finished_at);
  const time = at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const sameDay = run.finished_at.slice(0, 10) === new Date().toISOString().slice(0, 10);
  return `atualizado ${sameDay ? `às ${time}` : `em ${dateLong(run.finished_at.slice(0, 10), L)} às ${time}`} ${TRIGGER_PT[run.trigger] || ''} · automático todos os dias às 07:00`;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/**
 * Every row names where it came from — provider, date, and the article when
 * there is one. A headline also lists the other lines the newsroom ran on
 * the same story, each with its own link.
 */
/** The Worker tags every row; a row from before the split is classified the same way here. */
const BR_INDICATORS = new Set(['ibovespa', 'selic', 'ipca', 'usdbrl']);
function regionOf(r) {
  if (r.region === 'br' || r.region === 'intl') return r.region;
  if (r.kind === 'headline') return 'br';
  if (r.kind === 'news') return 'intl';
  if (r.indicator_key) return BR_INDICATORS.has(r.indicator_key) ? 'br' : 'intl';
  const classes = r.exposure_summary?.asset_classes || [];
  if (classes.includes('Equities BR') && !classes.includes('Equities Global')) return 'br';
  return ['Equities Global', 'Commodities', 'Digital Assets'].some((k) => classes.includes(k)) ? 'intl' : 'br';
}

/** One region of the table: a card with its own count, or a quiet line when nothing landed there. */
function mattersRegion(title, sub, rows, o) {
  const affected = new Set(rows.flatMap((r) => r.per_client.map((c) => c.client_id))).size;
  return h('div.card.matters-region', {},
    h('div.card-h', {}, h('h3', { text: title }),
      h('span.meta', { text: rows.length ? `${rows.length} ${rows.length === 1 ? 'evento' : 'eventos'} · ${affected} de ${o.clients_count} carteiras tocadas` : sub })),
    rows.length ? mattersTable(rows) : h('div.empty', { text: `Nenhum evento ${title === 'Brasil' ? 'do mercado brasileiro' : 'internacional'} toca as carteiras hoje.` }));
}

function mattersTable(rows) {
  return table(['Evento', 'Movimento', 'Por que importa', 'Exposição na sua carteira', 'Conversa sugerida'],
    rows.map((r) => h('tr', {},
      h('td', { style: { minWidth: '220px', maxWidth: '300px' } },
        h('span.name', { text: r.event_pt || r.event }),
        sourceCell(r),
        attentionPills(r)),
      h('td', {}, r.current_move ? moveCell(r.current_move) : h('span.muted', { text: '—' })),
      h('td.why', { style: { minWidth: '240px', maxWidth: '360px' }, text: r.why_it_matters_pt || r.why_it_matters }),
      h('td', { style: { minWidth: '150px' } },
        h('span.move', { text: r.exposure_summary.max_exposure ? weight(r.exposure_summary.max_exposure, { locale: L, decimals: 1 }) : '—' }),
        h('span.sub', { text: r.per_client.slice(0, 3).map((c) => c.client_name.split(' ')[0]).join(', ') + (r.per_client.length > 3 ? ` +${r.per_client.length - 3}` : '') })),
      h('td.talk', { style: { minWidth: '240px', maxWidth: '340px' }, text: r.advisor_action_pt || r.advisor_action }))),
    { className: 'matters' });
}

function sourceCell(r) {
  const provider = r.source_provider || (r.source_label ? r.source_label.replace(/:/, ' · ') : null) || 'fonte não registrada';
  const stamp = r.published_at && hhmm(r.published_at) ? `${r.date} ${hhmm(r.published_at)}` : r.date;
  const label = r.kind === 'headline' ? `${provider} · manchete` : r.kind === 'news' ? `${provider} · notícia` : provider;
  const link = r.source_url ? h('span.sub', {}, h('a.src-link', { href: r.source_url, target: '_blank', rel: 'noopener', title: r.source_url },
    h('span', { text: r.kind === 'headline' ? `abrir no ${provider}` : (r.source_title || hostOf(r.source_url)) }), icon('external', { size: 12 }))) : null;
  const related = r.related?.length ? h('details.related', {},
    h('summary', { text: `+${r.related.length} ${r.related.length === 1 ? 'manchete relacionada' : 'manchetes relacionadas'}` }),
    h('ul', {}, r.related.map((x) => h('li', {}, h('a.src-link', { href: x.url, target: '_blank', rel: 'noopener' }, h('span', { text: x.title }), icon('external', { size: 11 })),
      h('span.muted', { text: ` ${[x.provider, x.published ? hhmm(x.published) : null].filter(Boolean).join(' · ')}` }))))) : null;
  return frag(h('span.sub', { text: `${stamp} · ${label}` }), link, related);
}
const fmtLevel = (v, unit) => (v == null ? '—' : unit === 'mtd' ? percent(v, { locale: L, decimals: 1 }) : `${num(v, Math.abs(v) >= 1000 ? 0 : 2)}${unit && !['index', 'price', 'mtd'].includes(unit) ? ` ${unit}` : ''}`);

/** Pills mark what deserves a second look; the numbers carry the direction. */
function attentionPills(r) {
  const pills = [];
  if (r.market_wide) pills.push(h('span.chip.warn', { text: r.coverage ? `notícia do dia · ${r.coverage} manchetes` : 'notícia do dia' }));
  if (r.kind === 'headline') pills.push(h('span.chip', { text: `manchete · ${r.source_provider || 'Valor Econômico'}` }));
  if (r.kind === 'news') pills.push(h('span.chip', { text: 'notícia · fonte citada' }));
  if (r.importance === 'high') pills.push(h('span.chip.warn', { text: 'alta relevância' }));
  const day = r.current_move?.changePct;
  const longer = r.current_move?.notable;
  if (Number.isFinite(day) && Math.abs(day) >= 0.02) pills.push(h('span.chip', { text: 'movimento forte no dia' }));
  else if (longer && Math.abs(longer.pct) >= (longer.key === '5d' ? 0.06 : 0.10)) pills.push(h('span.chip', { text: `movimento forte ${longer.label_pt}` }));
  if ((r.exposure_summary?.max_exposure ?? 0) >= 0.4) pills.push(h('span.chip.warn', { text: 'exposição alta' }));
  return pills.length ? h('div.pills', {}, pills) : null;
}

/** Short names for the matrix columns; the full label sits in the tooltip. */
const SHORT = {
  sp500: 'S&P 500', nasdaq: 'Nasdaq', ibovespa: 'Ibovespa', vix: 'VIX', us10y: 'US 10a', hy_etf: 'HYG', ig_etf: 'LQD',
  usdbrl: 'USD/BRL', eurusd: 'EUR/USD', dxy: 'DXY', gold: 'Ouro', brent: 'Brent', wti: 'WTI', copper: 'Cobre', btc: 'Bitcoin', eth: 'Ether',
};
const WINDOWS = [['1y', '1A', 'os últimos 12 meses'], ['2y', '2A', 'os últimos 2 anos'], ['5y', '5A', 'os últimos 5 anos']];


/** The matrix loads after the page: sixteen daily series take a few seconds cold. */
/** The four broad classes of the risk/return chart, in the order the Worker lists them. */
const RISK_CLASS_PT = { equity: 'Renda variável', debt: 'Renda fixa e crédito', fx_commodities: 'Câmbio e commodities', crypto_other: 'Cripto e outros' };

/** A fund or bond name short enough to sit beside a mark: the words before the dash, minus the vehicle jargon. */
function shortAssetName(name) {
  const stop = /^(FIC|FIM|FIA|FIRF|FI|S\.A\.|Advisory|Banco|Institucional|Plus|REF|DI|CP|Simples|Fundo|de|Índice|Long|Bias(ed)?|ST|Hedge|Global|Foods|Company|Consignado|Pactual)$/i;
  const words = String(name || '').split(' — ')[0].split(/\s+/).filter((w) => w && !stop.test(w));
  return words.slice(0, 2).join(' ') || name;
}

/**
 * Every mapped asset over the last twelve months: return up, annualised
 * volatility across, in reais, with the Ibovespa, the S&P 500 in reais and
 * the CDI as references and the empirical efficient frontier over the top.
 * What cannot be measured is named under the chart with the reason.
 */
function assetRiskReturnSection() {
  const box = h('div.card');
  const meta = h('span.meta');
  const pct1 = (v) => percent(v, { locale: L, decimals: 1 });
  const vol = (v) => percent(v, { locale: L, decimals: 1, signed: false });
  const tickDecimals = (v) => (Math.round(Math.abs(v) * 1000) % 10 ? 1 : 0);
  const tickY = (v) => (v === 0 ? '0%' : percent(v, { locale: L, decimals: tickDecimals(v) }));
  const tickX = (v) => percent(v, { locale: L, decimals: tickDecimals(v), signed: false });
  const groupByReason = (list) => {
    const byReason = new Map();
    for (const x of list) (byReason.get(x.reason) || byReason.set(x.reason, []).get(x.reason)).push(x.ticker || x.label || x.name);
    return [...byReason].map(([reason, names]) => `${names.join(', ')} (${reason})`).join('; ');
  };
  async function load() {
    mount(box, h('div.loading', {}, loader(), h('span', { text: 'Calculando retorno e volatilidade de cada ativo…' })));
    try {
      const d = await api('/api/advisor/assets/risk-return');
      mount(meta, `${dateLong(d.window.from, L)} a ${dateLong(d.window.to, L)} · em reais`);
      const classes = d.classes.map((c) => ({ key: c.key, label: RISK_CLASS_PT[c.key] || c.label }));
      const className = (k) => classes.find((c) => c.key === k)?.label || k;
      const items = [
        ...d.assets.map((a) => ({ key: a.id, label: a.ticker || shortAssetName(a.name), x: a.volatility, y: a.total_return, cls: a.risk_class, row: a })),
        ...d.references.map((r) => ({ key: r.key, label: r.label, x: r.volatility, y: r.total_return, cls: 'ref', ring: true, row: r })),
      ];
      const simulated = d.assets.filter((a) => a.simulated);
      const partial = [...d.assets, ...d.references].filter((a) => a.partial);
      const legend = [
        { label: 'Referências: Ibovespa, S&P 500 em reais, CDI', cls: 'ref', ring: true },
        ...classes.map((c) => ({ label: c.label, cls: c.key })),
        { label: 'Fronteira eficiente (empírica)', dash: true },
      ];
      const rows = [...d.assets.map((a) => ({ ...a, label: a.ticker || a.name, kind: className(a.risk_class) })), ...d.references.map((r) => ({ ...r, id: r.key, label: r.label, kind: 'Referência', name: r.symbol || '' }))]
        .sort((a, b) => b.total_return - a.total_return)
        .map((a) => h('tr', {},
          h('td.name', {}, a.label, h('span.sub', { text: `${a.kind}${a.name && a.name !== a.label ? ` · ${a.name}` : ''}` })),
          h('td.num', { class: toneClass(a.total_return), text: pct1(a.total_return) }),
          h('td.num', { text: vol(a.volatility) }),
          h('td.num', { text: `${a.observations} de ${d.window.months.length}` }),
          h('td', { text: `${a.basis || ''}${a.simulated ? ' · cotas simuladas para a demonstração' : ''}` })));
      mount(box,
        scatterChart(items, {
          classes, legend, shapes: false, height: 540,
          kicker: 'Retorno vs volatilidade · 12 meses',
          subtitle: `Últimos 12 meses · ${d.assets.length} ativos mapeados e ${d.references.length} referências · em reais`,
          xLabel: 'Volatilidade 12 meses', yLabel: 'Retorno 12 meses', formatX: tickX, formatY: tickY,
          frontier: { keys: d.frontier, label: 'fronteira eficiente' },
          tip: (p) => [
            h('b', { text: `${p.row.ticker ? `${p.row.ticker} · ` : ''}${p.row.name || p.row.label}` }),
            h('span', { text: `${p.ring ? 'Referência' : className(p.cls)} · retorno ${pct1(p.y)} · volatilidade ${vol(p.x)}` }), h('br'),
            h('span', { text: `${p.row.observations} de ${d.window.months.length} meses · ${p.row.basis || ''}${p.row.simulated ? ' · cotas simuladas' : ''}` }),
          ],
        }),
        h('p.chart-caption', {},
          'Retorno composto dos doze retornos mensais; volatilidade é o desvio-padrão desses retornos anualizado por √12. Amostrado nos fins de mês, em reais (ativos em dólar pela PTAX). A fronteira eficiente é empírica: a envoltória superior dos pontos.',
          simulated.length ? ` Cotas simuladas para a demonstração: ${simulated.map((a) => a.ticker || shortAssetName(a.name)).join(', ')}.` : '',
          partial.length ? ` Série incompleta na janela: ${partial.map((a) => a.ticker || a.label || shortAssetName(a.name)).join(', ')}.` : '',
          d.excluded?.length ? ` ${d.excluded.length} ${d.excluded.length === 1 ? 'linha fica' : 'linhas ficam'} fora do gráfico, com o motivo na tabela.` : '',
          ' Fonte: Yahoo Finance (fechamentos e dividendos), Banco Central do Brasil (PTAX, CDI, IPCA) e cotas do custodiante.'),
        h('details.sc-table', {}, h('summary', { text: `Ver tabela (${d.assets.length + d.references.length} no gráfico${d.excluded?.length ? `, ${d.excluded.length} fora` : ''})` }),
          table(['Ativo', { label: 'Retorno 12m', num: true }, { label: 'Volatilidade', num: true }, { label: 'Meses', num: true }, 'Base de cálculo'], rows),
          d.excluded?.length ? h('div', { style: { marginTop: '16px' } },
            h('div.rail-h', { text: 'Fora do gráfico' }),
            table(['Ativo', 'Motivo'], d.excluded.map((x) => h('tr', {},
              h('td.name', {}, x.ticker || x.label, x.name && x.name !== (x.ticker || x.label) ? h('span.sub', { text: x.name }) : null),
              h('td', { text: x.reason }))))) : null),
        sourcesBlock(d.sources, 'Ver fontes das séries'));
    } catch (err) {
      mount(box, h('div.err', { text: `Não foi possível calcular retorno e volatilidade: ${err.message}` }));
    }
  }
  load();
  return h('section.section', { style: { marginBottom: '32px' } },
    h('div.section-h', {}, h('h2', { text: 'Retorno e risco por ativo' }), meta),
    box);
}

function correlationSection() {
  const box = h('div.card');
  const meta = h('span.meta');
  const buttons = h('div.win', {}, WINDOWS.map(([k, label, title]) => h('button.btn.sm', { dataset: { k }, text: label, title, onclick: () => load(k) })));
  async function load(k) {
    for (const b of buttons.querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === k);
    mount(box, h('div.loading', {}, loader(), h('span', { text: 'Calculando correlações…' })));
    try {
      const d = await api(`/api/advisor/correlations?window=${k}`);
      const obs = d.pair_observations;
      mount(meta, `${dateLong(d.window.from, L)} a ${dateLong(d.window.to, L)}`);
      mount(box,
        correlationMatrix(d, { locale: L, short: (i) => SHORT[i.key] || i.label }),
        h('p.chart-caption', {}, `Correlação de Pearson entre retornos diários (logarítmicos), cada par medido nas datas que ambas as séries observaram`,
          obs ? ` · ${obs.min === obs.max ? obs.min : `${obs.min} a ${obs.max}`} observações por par` : '',
          d.excluded?.length ? ` · fora da matriz: ${d.excluded.map((x) => x.label).join(', ')} — ${d.excluded[0].reason}` : '',
          ' · fonte: Yahoo Finance, fechamentos diários ajustados, das séries mantidas em R2.'),
        sourcesBlock(d.sources, 'Ver fontes das séries'));
    } catch (err) {
      mount(box, h('div.err', { text: `Não foi possível calcular as correlações: ${err.message}` }));
    }
  }
  load('1y');
  return h('section.section', {},
    h('div.section-h', {}, h('h2', { text: 'Correlações entre os indicadores' }), h('div.split', {}, meta, buttons)),
    box);
}

/** Drift alerts by client: the portfolio with the widest deviation first, and within it the widest first. */
function groupDrift(alerts) {
  const byClient = new Map();
  for (const d of alerts) {
    if (!byClient.has(d.client_id)) byClient.set(d.client_id, { client_id: d.client_id, client_name: d.client_name, items: [] });
    byClient.get(d.client_id).items.push(d);
  }
  const groups = [...byClient.values()];
  for (const g of groups) g.items.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  return groups.sort((a, b) => Math.abs(b.items[0].drift) - Math.abs(a.items[0].drift));
}

function triggerOrder(a, b) {
  const rank = { BREACHED: 0, APPROACHING: 1, ARMED: 2, NO_DATA: 3 };
  return rank[a.status] - rank[b.status];
}

/**
 * The move is the day's move, named as such. A longer window appears only
 * when the Worker found it notable (5 sessions at 3%+, else 30 days at 5%+),
 * and then with its timeframe written out — never a bare percentage.
 */
function moveCell(m) {
  if (m.label) return frag(h('span.move', { class: /−/.test(m.label) ? 'loss' : /\+/.test(m.label) ? 'gain' : '', text: m.label.replace(/\bMTD$/, 'no mês até aqui').replace(/\b5D$/, 'em 5 sessões').replace(/\b30D$/, 'em 30 dias') }));
  if (m.unavailable) return h('span.muted', { text: 'DATA UNAVAILABLE' });
  if (m.level) return levelCell(m);
  const day = m.changePct;
  const longer = m.notable;
  const level = `${m.value != null ? num(m.value, m.value > 1000 ? 0 : 2) : '—'}${m.unit && !['index', 'price'].includes(m.unit) ? ` ${m.unit}` : ''}${m.asOf ? ` · ${m.asOf}` : ''}`;
  return h('div', {},
    day != null
      ? h('span.move', { class: toneClass(day) }, percent(day, { locale: L, decimals: 1 }), h('small', { text: ' no dia' }))
      : h('span.move.muted', { text: 'sem variação diária' }),
    longer ? h('span.move.longer', { class: toneClass(longer.pct), title: longer.from ? `desde o fechamento de ${longer.from}` : '' },
      percent(longer.pct, { locale: L, decimals: 1 }), h('small', { text: ` ${longer.label_pt}` })) : null,
    h('span.sub', { text: level }));
}

/**
 * A policy rate or a monthly index has no day move. The Selic shows its
 * last change and the level before it; the IPCA shows the month it refers
 * to and the month before. Never a percentage of a percentage.
 */
function levelCell(m) {
  const l = m.level;
  const lvl = fmtLevel(m.value, m.unit);
  if (l.kind === 'policy_rate') {
    return h('div', {},
      l.prev_value == null
        ? h('span.move.muted', { text: `sem mudança desde ${dmy(l.since)}` })
        : h('span.move', {}, pp(l.delta / 100, { locale: L }), h('small', { text: ` em ${dmy(l.since)}` })),
      h('span.sub', { text: `${lvl}${l.prev_value != null ? ` · antes ${fmtLevel(l.prev_value, m.unit)}` : ''}` }));
  }
  return h('div', {},
    h('span.move', {}, lvl, h('small', { text: ` em ${monthLabel(l.period, L)}` })),
    l.prev_value != null ? h('span.sub', { text: `${monthLabel(l.prev_period, L)}: ${fmtLevel(l.prev_value, m.unit)}` }) : null);
}
/** The same, in one line, for the indicator strip. */
// ═══ signals dashboard ═════════════════════════════════════════════════════
async function viewSignals() {
  const d = await api('/api/advisor/signals');
  const rows = d.signals;
  const conflicts = rows.filter((r) => r.conflict);
  const noCoverage = rows.filter((r) => r.analyst.unavailable);

  const body = (list) => list.map((r) => h('tr', { class: r.conflict ? 'conflict-row' : '' },
    h('td', {}, h('span.name', { text: r.ticker || r.name }), h('span.sub', { text: `${cls(r.asset_class)}${r.held_by_book ? ' · em carteira' : ''}` })),
    h('td', {}, r.technical.signal
      ? h('div.sig-pair', {}, h('b', { text: r.technical.signal }),
        h('span.muted', { text: `MM ${r.technical.weekly ? `${r.technical.weekly} (1S)` : '—'} · RSI ${r.technical.rsi ? num(r.technical.rsi, 1) : '—'}` }))
      : h('span.sig-na', { text: 'sem cobertura técnica' })),
    h('td', {}, r.analyst.consensus
      ? h('div.sig-pair', {}, h('b', { text: r.analyst.consensus }),
        h('span.muted', { text: `${r.analyst.count} analistas · ${r.analyst.buy ?? '—'}/${r.analyst.hold ?? '—'}/${r.analyst.sell ?? '—'}` }))
      : h('span.sig-na', { text: 'No analyst consensus available' })),
    h('td.num', { text: r.analyst.target ? num(r.analyst.target, 2) : '—' }),
    h('td.num', { class: toneClass(r.analyst.upside), text: r.analyst.upside == null ? '—' : percent(r.analyst.upside, { locale: L, decimals: 1 }) }),
    h('td', {}, r.conflict ? h('span.chip.warn', { text: 'sinais divergentes' }) : h('span.muted', { text: '—' }))));

  const headers = ['Ativo', 'Técnico (TradingView)', 'Consenso de analistas', { label: 'Preço-alvo', num: true }, { label: 'Potencial', num: true }, ''];

  return frag(
    head('Sinais de mercado', `Leitura técnica e consenso de analistas, capturados de forma independente para ${rows.length} instrumentos.`, null,
      [h('b', { text: 'Mercado' }), sep(), `TradingView · capturado em ${d.captured_at ? d.captured_at.slice(0, 16).replace('T', ' ') : '—'} UTC`]),
    h('div.grid.g4', { style: { marginBottom: '24px' } },
      stat('Instrumentos cobertos', String(rows.length)),
      stat('Com sinal técnico', String(rows.filter((r) => r.technical.signal).length)),
      stat('Com consenso de analistas', String(rows.length - noCoverage.length)),
      stat('Sinais divergentes', String(conflicts.length), { tone: conflicts.length ? 'caution' : 'flat' })),

    assetRiskReturnSection(),

    h('div.hint', { style: { marginBottom: '20px' } },
      'As duas famílias de sinal são capturadas de forma independente e nunca combinadas. ',
      'Um técnico de venda ao lado de um consenso de compra é uma discordância real e é exatamente o que vale levar para a reunião. ',
      'Onde não existe cobertura de analistas, o campo diz isso — o sinal técnico nunca é usado para inferir sentimento de analistas.'),

    conflicts.length ? h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Divergências entre as duas famílias' }), h('span.meta', { text: 'prioridade de conversa' })),
      table(headers, body(conflicts))) : null,

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Universo e Sinais monitorados' })),
      table(headers, body(rows))),
  );
}

// ═══ triggers configuration ════════════════════════════════════════════════
async function viewTriggers() {
  const d = await api('/api/advisor/triggers');
  return frag(
    head('Gatilhos', 'Limiares configuráveis. Alterar um limite é uma mudança de dado, não de código.', null,
      [h('b', { text: 'Configuração' }), sep(), `${d.triggers.length} limiares`]),
    table(['Gatilho', 'Indicador', 'Condição', { label: 'Limite', num: true }, 'Classes afetadas', 'Ação sugerida'],
      d.triggers.map((t) => h('tr', {},
        h('td', {}, h('span.name', { text: t.label })),
        h('td.mono', { style: { fontSize: '11px' }, text: t.indicator_key }),
        h('td.mono', { style: { fontSize: '11px' }, text: t.comparator }),
        h('td.num', { text: `${num(t.threshold, 2)} ${t.unit || ''}` }),
        h('td', { text: (t.asset_classes || []).join(', ') || '—' }),
        h('td', { style: { maxWidth: '320px' }, text: t.action_pt || t.action || '—' })))),
    h('p.note', { style: { marginTop: '14px' }, text: 'Persistência, razão de aproximação e classes afetadas são colunas da tabela market_triggers. Um novo gatilho é uma linha, não um deploy.' }),
  );
}

// ═══ client list ═══════════════════════════════════════════════════════════
async function viewClients() {
  const d = await api('/api/advisor/clients');
  const total = d.clients.reduce((a, c) => a + c.portfolio_value, 0);
  return frag(
    head('Clientes', `${d.clients.length} carteiras · ${money(total, { locale: L })} sob assessoria`, null,
      [h('b', { text: 'Carteira de clientes' }), sep(), `referência ${monthLabel(d.month, L)}`]),
    table(
      ['Cliente', 'Perfil', { label: 'Patrimônio', num: true }, { label: 'Último mês', num: true }, { label: 'Referência', num: true }, 'Última reunião', 'Próxima revisão', 'Carta', 'Alertas'],
      d.clients.map((c) => h('tr.clickable', { onclick: () => { location.hash = `#/client/${c.id}`; } },
        h('td', {}, h('span.name', { text: c.name }), h('span.sub', { text: c.segment || '' })),
        h('td', { text: c.risk_profile }),
        h('td.num', {}, money(c.portfolio_value, { locale: L })),
        h('td.num', { class: toneClass(c.last_month?.portfolio_return) }, c.last_month ? percent(c.last_month.portfolio_return, { locale: L }) : '—'),
        h('td.num.bench', {}, c.last_month?.benchmark_return != null ? percent(c.last_month.benchmark_return, { locale: L }) : '—'),
        h('td', { text: c.last_meeting ? shortDate(c.last_meeting) : '—' }),
        h('td', { text: c.next_review ? shortDate(c.next_review) : '—' }),
        h('td', {}, reportChip(c.report_status)),
        h('td', {}, c.alerts.length
          ? h('span', { class: `chip ${c.alerts.some((a) => a.severity === 'high') ? 'warn' : ''}`, text: `${c.alerts.length}` })
          : h('span.muted', { text: '—' }))))),
    h('div.grid.g2', { style: { marginTop: '24px' } }, d.clients.filter((c) => c.alerts.length).map((c) => h('div.card', {},
      h('div.card-h', {}, h('h3', {}, h('a', { href: `#/client/${c.id}`, text: c.name })), h('span.meta', { text: `${c.alerts.length} pontos` })),
      h('div', {}, c.alerts.map((a) => h('div.trg', {},
        h('span', { class: `dot ${a.severity === 'high' ? 'BREACHED' : 'APPROACHING'}` }),
        h('div.lab', { style: { fontWeight: 400 }, text: a.message }),
        h('span.obs.muted', { text: a.kind }))))))),
  );
}

function reportChip(status) {
  const map = {
    not_generated: ['', 'não gerada'],
    draft: ['proposed', 'rascunho'],
    pending_approval: ['warn', 'aguardando aprovação'],
    approved: ['approved', 'aprovada'],
    published: ['approved', 'publicada'],
  };
  const [cls, label] = map[status] || ['', status];
  return h('span', { class: `chip ${cls}`, text: label });
}

// ═══ client detail ═════════════════════════════════════════════════════════
const CLIENT_TABS = [
  ['overview', 'Visão geral'], ['performance', 'Rentabilidade'], ['risk', 'Risco'], ['portfolio', 'Alocação'],
  ['holdings', 'Posições'], ['recommendations', 'Recomendações'], ['policy', 'Política'],
  ['meetings', 'Reuniões'], ['reports', 'Cartas'], ['audit', 'Auditoria'],
];

async function viewClient({ id, tab = 'overview' }) {
  const d = await api(`/api/clients/${id}`);
  const c = d.client;
  const tabsEl = h('nav.tabs', {}, CLIENT_TABS.map(([k, label]) => h('a', {
    href: `#/client/${id}/${k}`, class: k === tab ? 'on' : '', text: label,
  })));

  const body = await renderClientTab(tab, id, d);
  crumbs(crumbsFor(currentHash(), { clientName: c.name }));
  const sub = [
    `${money(d.total_value, { locale: L })} sob assessoria`,
    `política v${d.policy?.version} de ${dateLong(d.policy?.effective_date, L)}`,
    c.next_review_at ? `próxima revisão ${shortDate(c.next_review_at)}` : null,
    valuationLine(d),
  ].filter(Boolean).join(' · ');
  return frag(
    head(c.name, sub, [
      // the client's own data first: the numbers every other action reads
      clientRefreshButton(id),
      // opens its own tab: the letter agent runs there and the carta lands there
      h('a.btn', { href: `#/client/${id}/carta`, target: '_blank', rel: 'noopener' }, icon('letter', { size: 15 }), h('span', { text: 'criar carta mensal' })),
      h('a.btn', { href: `#/client/${id}/prep` }, icon('prep', { size: 15 }), h('span', { text: 'preparar reunião' })),
      h('a.btn.primary', { href: `#/client/${id}/editor` }, icon('edit', { size: 15 }), h('span', { text: 'editar carteira' })),
      // the signed policy, over the page: reading it should not cost the tab
      policyDocButton(id),
    ], [h('b', { text: 'Cliente' }), sep(), `perfil ${c.risk_profile}`, c.segment ? sep() : null, c.segment || null]),
    tabsEl,
    body);
}

/**
 * How old the numbers on this page are, and who priced them. Every figure the
 * advisor reads here is a market figure, so the provider is named where the
 * total is (§29); before any refresh has run it is the approved snapshot's own
 * date, with no provider claimed.
 */
function valuationLine(d) {
  const r = d.last_refresh;
  const date = r?.effective_date || d.snapshot?.effective_date;
  if (!date) return null;
  const who = r?.providers?.length ? ` (${r.providers.join(', ')})` : '';
  return `valores de ${dateLong(date, L)}${who}`;
}

// ── this client's data, brought to today's prices ──────────────────────────
// The daily agents refresh the market the letter is written against; this
// refreshes what the client actually holds. Half an hour before a meeting the
// advisor needs the second one without waiting on the first.
const REFRESH_AGENTS = [
  { step: 1, key: 'precos', title: 'Atualização · Preços', what: 'cada posição remarcada no provedor que a precifica' },
  { step: 2, key: 'carteira', title: 'Atualização · Carteira', what: 'um novo retrato da carteira, com os valores e os pesos de hoje' },
  { step: 3, key: 'leitura', title: 'Atualização · Leitura', what: 'a alocação contra a política e o que saiu da faixa' },
];

function clientRefreshButton(clientId) {
  return h('button.btn', {
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { followClientRefresh(clientId, (await api(`/api/clients/${clientId}/refresh`, {})).run); }
      catch (err) { b.disabled = false; alert(`Não foi possível atualizar os dados: ${err.message}`); }
    },
  }, icon('refresh', { size: 15 }), h('span', { text: 'atualizar dados' }));
}

/** Show the progress card for a refresh and follow it until it ends; then re-render. */
function followClientRefresh(clientId, run) {
  const card = progressCard({
    title: 'Atualizando os dados do cliente',
    agents: run.agents || REFRESH_AGENTS,
    waitingText: 'Cada posição é remarcada no provedor que a precifica e a carteira é regravada com os valores de hoje. Leva alguns segundos.',
    doneText: refreshDoneText,
    doneLabel: 'ver a carteira',
    onDone: () => ROUTER?.render(),
  });
  card.update(run);
  const tick = async () => {
    let r;
    try { r = (await api(`/api/clients/${clientId}/refresh/${run.id}`)).run; }
    catch (err) { card.update({ status: 'failed', error: err.message, step: run.step, progress: run.progress }); return; }
    card.update(r);
    if (r.status === 'running') setTimeout(tick, 1000);
  };
  setTimeout(tick, 600);
}

/** What the finished refresh actually did, in one line: the new total, what it moved, who priced it. */
function refreshDoneText(r) {
  const s = r.result;
  if (!s) return 'Concluído. A carteira abaixo já reflete esta atualização.';
  const move = s.change_pct == null ? '' : ` · ${percent(s.change_pct, { locale: L })} sobre ${money(s.previous_total, { locale: L })} de ${dmy(s.from)}`;
  const kept = s.counts?.kept ? `, ${s.counts.kept} mantiveram o preço que já tinham` : '';
  const fontes = (s.providers || []).join(', ') || 'nenhuma fonte externa respondeu';
  const stale = s.overview?.stale
    ? ` O panorama do dia é de ${dmy(s.overview.date)}: atualize-o na visão geral antes de gerar a carta.`
    : '';
  return `${money(s.total_value, { locale: L })} em ${dmy(s.to)}${move}. ${s.counts?.priced} de ${s.counts?.total} posições remarcadas${kept} · ${fontes}.${stale}`;
}

// ── the investment policy, as the document it was signed in ────────────────
// The Política tab shows the parameters the engine measures against. What an
// advisor opens in a meeting and replaces when a new one is signed is the file
// itself, so it lives here: over the page, because looking at it or swapping it
// should not cost the advisor the place they were reading.
function policyDocButton(clientId) {
  return h('button.btn', { type: 'button', onclick: () => openPolicyDoc(clientId) },
    icon('documents', { size: 15 }), h('span', { text: 'ver PI' }));
}

const fileSize = (n) => (n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const sentWhen = (iso) => `${dateLong(iso, L)}${hhmm(iso) ? ` às ${hhmm(iso)}` : ''}`;

async function openPolicyDoc(clientId) {
  const dlg = dialog({
    title: 'Política de investimento',
    sub: 'O documento assinado: abrir, baixar, ou substituir quando uma versão nova for assinada.',
  });
  // One hidden picker for the life of the dialog; the handler is swapped rather
  // than the element, so re-rendering the body never loses the open file dialog.
  const pick = h('input', { type: 'file', accept: '.pdf,.doc,.docx', hidden: true });
  dlg.card.append(pick);
  pick.addEventListener('change', () => {
    const file = pick.files?.[0];
    pick.value = '';
    if (file) upload(file);
  });

  const upload = async (file) => {
    mount(dlg.foot, h('div.grow', { text: `Enviando ${file.name}…` }));
    try {
      const r = await apiUpload(`/api/clients/${clientId}/policy-document`, file);
      await render(r.unchanged
        ? 'Este arquivo é idêntico ao que já estava guardado; nada foi trocado.'
        : r.replaced
          ? `Versão ${r.document.version} guardada. A v${r.replaced} continua no histórico.`
          : 'Documento guardado.');
    } catch (err) {
      await render(`Não foi possível enviar: ${err.message}`, 'caution');
    }
  };

  const render = async (message = null, tone = '') => {
    mount(dlg.body, loader());
    mount(dlg.foot);
    let d;
    try { d = await api(`/api/clients/${clientId}/policy-document`); } catch (err) {
      mount(dlg.body, h('div.empty', { text: `Não foi possível ler o documento: ${err.message}` }));
      return;
    }
    const c = d.current;
    mount(dlg.body, c ? policyDocCurrent(c, d.versions) : h('div.empty', {},
      'Nenhum documento guardado para este cliente ainda. Envie o PDF da política assinada e ele fica a um clique daqui.'));
    mount(dlg.foot,
      h('div.grow', { class: tone },
        message || `Aceita PDF, DOC ou DOCX até ${Math.round(d.max_bytes / 1048576)} MB. Substituir não apaga: a versão anterior fica no histórico.`),
      c ? h('a.btn', { href: apiUrl(c.links.view), target: '_blank', rel: 'noopener' }, icon('external', { size: 15 }), h('span', { text: 'abrir' })) : null,
      c ? h('a.btn', { href: apiUrl(c.links.download) }, icon('download', { size: 15 }), h('span', { text: 'baixar' })) : null,
      h('button.btn.primary', { type: 'button', onclick: () => pick.click() },
        icon('refresh', { size: 15 }), h('span', { text: c ? 'atualizar' : 'enviar arquivo' })));
  };

  await render();
}

function policyDocCurrent(c, versions) {
  const older = (versions || []).filter((v) => v.id !== c.id);
  return frag(
    h('div.doc', {},
      icon('documents', { size: 30 }),
      h('div', {},
        h('div.doc-name', { text: c.filename }),
        h('div.doc-meta', {
          text: [
            `versão ${c.version}`,
            c.policy_version ? `documenta a política v${c.policy_version}` : null,
            fileSize(c.size_bytes),
            `enviado ${sentWhen(c.uploaded_at)}`,
            c.uploaded_by ? `por ${c.uploaded_by}` : null,
          ].filter(Boolean).join(' · '),
        }),
        c.note ? h('div.doc-note', {}, h('b', { text: 'Nota: ' }), c.note) : null)),
    older.length ? h('div.doc-old', {},
      h('div.lab', { text: 'versões anteriores' }),
      h('ul', {}, older.map((v) => h('li', {},
        h('span.nm', {}, h('span.v', { text: `v${v.version}` }), ' ', v.filename),
        h('span.rt', {},
          h('span.v', { text: `${dateLong(v.uploaded_at, L)} · ${fileSize(v.size_bytes)}` }),
          h('a.btn.sm', { href: apiUrl(v.links.download), 'aria-label': `Baixar a versão ${v.version}` }, icon('download', { size: 13 }))))))) : null,
  );
}

async function renderClientTab(tab, id, d) {
  switch (tab) {
    case 'performance': return tabPerformance(id, d);
    case 'risk': return tabRisk(id);
    case 'portfolio': return tabPortfolio(id, d);
    case 'holdings': return tabHoldings(id, d);
    case 'recommendations': return tabRecommendations(id, d);
    case 'policy': return tabPolicy(id, d);
    case 'meetings': return tabMeetings(id, d);
    case 'reports': return tabReports(id, d);
    case 'audit': return tabAudit(id, d);
    default: return tabOverview(id, d);
  }
}

function cumulativeSeries(returns) {
  let p = 1; let b = 1;
  const portfolio = []; const benchmark = [];
  for (const r of returns) {
    if (Number.isFinite(r.portfolio)) { p *= 1 + r.portfolio; portfolio.push({ label: r.month, value: p - 1 }); }
    if (Number.isFinite(r.benchmark)) { b *= 1 + r.benchmark; benchmark.push({ label: r.month, value: b - 1 }); }
  }
  return { portfolio, benchmark };
}

// ── how much risk the portfolio has been taking ───────────────────────────
// Trailing twelve months, from the monthly returns actually apurados, against
// the CDI published for each of those months. The Sharpe ratio is printed
// beside the two figures it is made of — a ratio without its return and its
// risk-free leg is a number nobody can check.
const vol12 = (v) => (v == null ? 'indisponível' : weight(v, { locale: L, decimals: 1 }));
const sharpe12 = (v) => (v == null ? 'indisponível' : ratio(v));

function riskRow(r, { small = true } = {}) {
  const cur = r?.current || null;
  const rf = r?.risk_free || null;
  const window = cur ? `${monthLabel(cur.from, L)} a ${monthLabel(cur.month, L)}` : (r?.reason || 'histórico insuficiente');
  return [
    stat('Volatilidade 12m', vol12(cur?.volatility), { small, sub: cur?.volatility == null ? r?.reason || 'sem janela de 12 meses fechada' : `anualizada · ${window}` }),
    stat('Índice de Sharpe 12m', sharpe12(cur?.sharpe), {
      small,
      tone: cur?.sharpe == null ? '' : toneClass(cur.sharpe),
      sub: cur?.sharpe == null ? (rf?.reason || 'CDI indisponível para a janela') : 'retorno acima do CDI por unidade de risco',
    }),
    stat('Retorno 12m', cur?.total_return == null ? 'indisponível' : percent(cur.total_return, { locale: L }), { small, tone: toneClass(cur?.total_return), sub: 'retorno composto da carteira na janela' }),
    stat('CDI 12m', cur?.risk_free_return == null ? 'indisponível' : percent(cur.risk_free_return, { locale: L }), { small, tone: 'bench', sub: 'acumulado no período · Banco Central' }),
  ];
}

/** The risk half of the client payload, never fatal: the overview renders without it. */
async function loadPortfolioRisk(id) {
  try { return await api(`/api/clients/${id}/risk`); }
  catch { return null; }
}

async function tabOverview(id, d) {
  const last = d.returns[d.returns.length - 1];
  const series = cumulativeSeries(d.returns);
  const risk = await loadPortfolioRisk(id);
  return frag(
    h('div.grid.g4', { style: { marginBottom: '24px' } },
      stat('Patrimônio', money(d.total_value, { locale: L })),
      stat(`Rentabilidade em ${last ? monthLabel(last.month, L) : '—'}`, last ? percent(last.portfolio, { locale: L }) : '—', { tone: toneClass(last?.portfolio) }),
      stat('Carteira de referência', last?.benchmark != null ? percent(last.benchmark, { locale: L }) : '—', { tone: 'bench' }),
      stat('Perfil de risco', d.client.risk_profile, { small: true, sub: `próxima revisão ${d.client.next_review_at ? shortDate(d.client.next_review_at) : '—'}` })),
    h('div.grid.g4', { style: { marginBottom: '24px' } }, risk
      ? riskRow(risk)
      : [stat('Volatilidade 12m', 'indisponível', { small: true, sub: 'a medida de risco não pôde ser calculada' }),
        stat('Índice de Sharpe 12m', 'indisponível', { small: true, sub: 'a medida de risco não pôde ser calculada' })]),
    h('p.note', { style: { margin: '-12px 0 24px' }, text: 'Volatilidade anualizada e índice de Sharpe contra o CDI, medidos nos últimos doze meses de retornos apurados. São medidas históricas, não expectativas. O detalhe está na aba Risco.' }),
    h('div.grid.g2', {},
      h('div.card', {}, lineChart(series, {
        title: 'Retorno acumulado desde o início do histórico',
        caption: `Base: retornos mensais compostos · moeda ${d.client.base_currency} · a linha da carteira é a escura; a referência é pontilhada em cobre`,
      })),
      h('div.card', {}, allocationBar(d.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })), {
        title: 'Alocação atual por classe de ativo',
        caption: `Snapshot aprovado em ${dateLong(d.snapshot?.effective_date, L)}`,
      }))),
    h('div.card', { style: { marginTop: '24px' } }, bandChart(d.allocation.map((a) => ({ ...a, asset_class: cls(a.asset_class) })), { title: 'Alocação contra as faixas permitidas na política' })),
  );
}

async function tabPerformance(id, d) {
  const p = await api(`/api/clients/${id}/performance`);
  const perf = p.performance;
  const at = p.attribution || perf?.attribution;
  const bench = p.benchmark;
  const metrics = p.metrics;
  if (!perf) return h('div.empty', { text: 'Sem cálculo de rentabilidade para o período.' });

  const classItems = (at?.by_asset_class || []).map((r) => ({ label: cls(r.asset_class), value: r.contribution }));
  if (at?.residual && Math.abs(at.residual.contribution) > 0.0002) classItems.push({ label: at.residual.label, value: at.residual.contribution });
  const posItems = [...(at?.top_negative || []), ...(at?.top_positive || [])]
    .map((r) => ({ label: r.ticker || r.name, value: r.contribution }))
    .sort((a, b) => b.value - a.value);

  const benchValue = bench?.value ?? bench?.comparison?.benchmark_return;
  const excess = perf.monthly_return != null && benchValue != null ? perf.monthly_return - benchValue : null;

  return frag(
    h('div.grid.g4', { style: { marginBottom: '20px' } },
      stat(`Rentabilidade em ${monthLabel(p.month, L)}`, percent(perf.monthly_return, { locale: L }), { tone: toneClass(perf.monthly_return) }),
      stat('Resultado', money(perf.absolute_pnl, { locale: L, signed: true }), { tone: toneClass(perf.absolute_pnl) }),
      stat('Carteira de referência', benchValue == null ? 'indisponível' : percent(benchValue, { locale: L }), { tone: 'bench' }),
      stat('Diferença', excess == null ? '—' : pp(excess, { locale: L }), { tone: toneClass(excess) })),

    h('div.grid.g4', { style: { marginBottom: '24px' } },
      stat('Valor inicial', money(perf.beginning_market_value, { locale: L }), { small: true }),
      stat('Valor final', money(perf.ending_market_value, { locale: L }), { small: true }),
      stat('Aportes e resgates', money(perf.net_flows, { locale: L, signed: true }), { small: true }),
      stat('Efeito do câmbio', at?.fx_contribution == null ? '—' : pp(at.fx_contribution, { locale: L }), { small: true, tone: toneClass(at?.fx_contribution) })),

    h('div.hint', { style: { marginBottom: '20px' } },
      h('b', { text: 'Método: ' }), perf.method_note?.pt || perf.method,
      at?.reconciles === false ? h('div.err', { style: { marginTop: '8px' }, text: 'A atribuição não fecha com o retorno reportado.' }) : null),

    h('div.grid.g2', {},
      h('div.card', {}, barChart(classItems, {
        title: 'Contribuição por classe de ativo',
        caption: `Período ${perf.period?.start || `${p.month}-01`} a ${perf.period?.end || 'fim do mês'} · em pontos percentuais do retorno da carteira · moeda ${d.client.base_currency}`,
      })),
      h('div.card', {}, barChart(posItems, {
        title: 'Maiores contribuições individuais',
        caption: 'Três melhores e três piores posições, em pontos percentuais da carteira',
      }))),

    h('section.section', { style: { marginTop: '24px' } },
      h('div.section-h', {}, h('h2', { text: 'Atribuição posição a posição' })),
      table(['Ativo', 'Classe', { label: 'Valor inicial', num: true }, { label: 'Valor final', num: true }, { label: 'Retorno', num: true }, { label: 'Câmbio', num: true }, { label: 'Contribuição', num: true }],
        (at?.by_position || []).map((r) => h('tr', {},
          h('td', {}, h('span.name', { text: r.ticker || r.name }), h('span.sub', { text: r.name })),
          h('td', { text: cls(r.asset_class) }),
          h('td.num', { text: money(r.bmv, { locale: L }) }),
          h('td.num', { text: money(r.emv, { locale: L }) }),
          h('td.num', { class: toneClass(r.total_return), text: r.total_return == null ? '—' : percent(r.total_return, { locale: L }) }),
          h('td.num', { class: toneClass(r.fx_return), text: r.fx_return ? percent(r.fx_return, { locale: L }) : '—' }),
          h('td.num', { class: toneClass(r.contribution), text: pp(r.contribution, { locale: L }) }))))),

    (perf.coverage?.excluded || []).length ? h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Posições sem preço no período' }), h('span.meta', { text: 'contribuíram zero para o retorno' })),
      table(['Ativo', 'Classe', { label: 'Valor', num: true }, 'Motivo', 'Provedores tentados'],
        perf.coverage.excluded.map((e) => h('tr', {},
          h('td', {}, h('span.name', { text: e.ticker || e.name })),
          h('td', { text: cls(e.asset_class) || '—' }),
          h('td.num', { text: e.market_value == null ? '—' : money(e.market_value, { locale: L }) }),
          h('td', { text: e.reason }),
          h('td.mono', { style: { fontSize: '10.5px' }, text: (e.providers_attempted || []).join(', ') || '—' }))))) : null,

    metrics?.available ? h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Medidas históricas' }), h('span.meta', { text: `${metrics.observations} observações mensais · ${metrics.period?.from} a ${metrics.period?.to}` })),
      h('div.grid.g4', {},
        stat('Retorno anualizado', percent(metrics.annualised_return, { locale: L }), { small: true, tone: toneClass(metrics.annualised_return) }),
        stat('Volatilidade anualizada', weight(metrics.annualised_volatility, { locale: L }), { small: true }),
        stat('Índice de Sharpe', metrics.sharpe_ratio == null ? 'indisponível' : ratio(metrics.sharpe_ratio), { small: true, sub: metrics.risk_free?.name ? `contra o ${metrics.risk_free.name}` : metrics.risk_free?.reason }),
        stat('Máximo drawdown', percent(metrics.max_drawdown, { locale: L }), { small: true, tone: 'loss', sub: metrics.max_drawdown_window ? `${metrics.max_drawdown_window.peak_month} → ${metrics.max_drawdown_window.trough_month}` : null }),
        stat('Retorno em 3 anos', metrics.three_year_available ? percent(metrics.three_year_return, { locale: L }) : 'histórico insuficiente', { small: true, sub: metrics.three_year_note })),
      h('p.note', { style: { marginTop: '12px' }, text: 'Estas são medidas históricas calculadas a partir do histórico de retornos. Não são expectativas nem projeções, e não devem ser apresentadas ao cliente como tal.' })) : null,

    sourcesBlock(p.sources || perf.sources, 'Ver fontes desta apuração'),
  );
}

/**
 * Risco — how much risk this portfolio has been taking, and where it sits.
 *
 * Three readings, in the order an advisor asks them. How unstable has the book
 * been, and is that rising or falling. Was the instability paid for, against
 * the CDI actually published month by month. And which lines are carrying it:
 * every position with its own trailing-twelve-month volatility, most volatile
 * first. A position that cannot be measured is listed with the reason rather
 * than left off the page (§30).
 *
 * The portfolio's own risk draws at once. The per-asset list waits on the
 * desk-wide engine, which reaches every provider in the book on a cold run, so
 * it loads into its own section instead of holding the tab.
 */
async function tabRisk(id) {
  const r = await api(`/api/clients/${id}/risk`);
  const cur = r.current;
  const pts = (rows, k) => (rows || []).filter((p) => p[k] != null).map((p) => ({ label: p.month, value: p[k] }));
  const volSeries = { portfolio: pts(r.series, 'volatility'), benchmark: pts(r.benchmark_series, 'volatility') };
  const shSeries = { portfolio: pts(r.series, 'sharpe'), benchmark: pts(r.benchmark_series, 'sharpe') };
  const historyLine = `${r.window.history.months} meses de retornos apurados${r.window.history.from ? `, de ${monthLabel(r.window.history.from, L)} a ${monthLabel(r.window.history.to, L)}` : ''}`;
  const life = r.lifetime?.available ? r.lifetime : null;
  const bench = r.benchmark_current;

  return frag(
    h('div.grid.g4', { style: { marginBottom: '20px' } }, riskRow(r, { small: false })),

    h('div.hint', { style: { marginBottom: '24px' } },
      h('b', { text: 'Método: ' }), r.method.pt,
      ` A volatilidade é o ${r.method.volatility}. O índice de Sharpe toma o ${r.method.sharpe}.`,
      life ? ` Na história inteira da carteira (${historyLine}), a volatilidade anualizada é ${vol12(life.annualised_volatility)} e o índice de Sharpe, ${sharpe12(life.sharpe_ratio)}.` : '',
      h('div.note', { style: { marginTop: '8px' }, text: 'Todas as medidas desta página são históricas, calculadas a partir dos retornos já apurados. Não são expectativas nem projeções e não devem ser apresentadas ao cliente como tal.' })),

    h('div.grid.g2', {},
      h('div.card', {}, volSeries.portfolio.length > 1
        ? lineChart(volSeries, {
          title: 'Volatilidade anualizada · janela móvel de 12 meses',
          caption: `Cada ponto mede os doze meses encerrados naquele mês. A linha cheia é a carteira; a pontilhada em cobre é a carteira de referência. A escala é a faixa dos próprios dados — uma volatilidade não tem zero que sirva de leitura. ${historyLine}.`,
          format: (v) => weight(v, { locale: L, decimals: 1 }),
          baseline: null,
        })
        : h('div.empty', { text: `Sem volatilidade em janela de 12 meses: ${r.reason || 'histórico insuficiente'}.` })),
      h('div.card', {}, shSeries.portfolio.length > 1
        ? lineChart(shSeries, {
          title: 'Índice de Sharpe · janela móvel de 12 meses',
          caption: 'Retorno acima do CDI por unidade de risco, nos doze meses encerrados em cada ponto. Acima da linha do zero a carteira foi paga pelo risco que correu; abaixo dela, não. CDI do Banco Central, mês a mês.',
          format: (v) => ratio(v),
          baseline: 0,
        })
        : h('div.empty', { text: `Sem índice de Sharpe: ${r.risk_free?.reason || r.reason || 'histórico insuficiente'}.` }))),

    cur && bench?.volatility != null ? h('p.note', { style: { marginTop: '16px' } },
      `Nos doze meses até ${monthLabel(cur.month, L)} a carteira oscilou ${vol12(cur.volatility)} ao ano contra ${vol12(bench.volatility)} da carteira de referência`,
      cur.total_return != null ? `, e rendeu ${percent(cur.total_return, { locale: L })} contra ${percent(cur.risk_free_return, { locale: L })} do CDI` : '',
      '. ',
      cur.sharpe == null ? '' : cur.sharpe < 0
        ? 'Um Sharpe negativo diz que o risco corrido no período não foi pago: o CDI entregou mais, sem oscilação.'
        : 'Um Sharpe positivo diz que o excesso sobre o CDI compensou a oscilação do período.') : null,

    sourcesBlock(r.sources, 'Ver fontes destas medidas'),

    assetVolatilitySection(id, cur),
  );
}

/**
 * Every position with its own trailing-twelve-month volatility, most volatile
 * first — the same measure, from the same engine, as the desk's risk/return
 * chart. Loads after the page: a cold run touches every provider in the book.
 */
function assetVolatilitySection(id, portfolioCurrent) {
  const nameOf = (a) => a.ticker || shortAssetName(a.name);
  const box = h('div');
  const meta = h('span.meta', { text: 'janela de 12 meses' });

  async function load() {
    mount(box, h('div.loading', {}, loader(), h('span', { text: 'Medindo a volatilidade de cada posição…' })));
    let r;
    try { r = await api(`/api/clients/${id}/risk/assets`); }
    catch (err) { mount(box, h('div.err', { text: `Não foi possível medir a volatilidade das posições: ${err.message}` })); return; }

    mount(meta, r.window
      ? `${r.assets.length} ${r.assets.length === 1 ? 'posição medida' : 'posições medidas'} · ${dateLong(r.window.from, L)} a ${dateLong(r.window.to, L)} · em reais`
      : 'janela de 12 meses');

    // the list is ordered by volatility, so the order should be legible without
    // reading every figure; the bar is scaled to the most volatile line on it
    const scale = Math.max(...r.assets.map((a) => a.volatility || 0), ...r.references.map((x) => x.volatility || 0), 1e-6);
    const volCell = (v) => h('td.num', {},
      h('span', { text: weight(v, { locale: L, decimals: 1 }) }),
      h('span.vbar', {}, h('i', { style: { width: `${Math.min(100, (v / scale) * 100).toFixed(1)}%` } })));

    const simulated = r.assets.filter((a) => a.simulated);
    const partial = r.assets.filter((a) => a.partial);

    mount(box,
      r.assets.length
        ? table(['Ativo', { label: 'Peso', num: true }, { label: 'Valor', num: true }, { label: 'Volatilidade 12m', num: true }, { label: 'Retorno 12m', num: true }, { label: 'Meses', num: true }, 'Base de cálculo'],
          r.assets.map((a) => h('tr', {},
            h('td.name', {}, nameOf(a), h('span.sub', { text: [cls(a.asset_class), a.name === nameOf(a) ? null : a.name].filter(Boolean).join(' · ') })),
            h('td.num', { text: weight(a.weight, { locale: L }) }),
            h('td.num', { text: money(a.market_value, { locale: L }) }),
            volCell(a.volatility),
            h('td.num', { class: toneClass(a.total_return), text: percent(a.total_return, { locale: L, decimals: 1 }) }),
            h('td.num', { text: `${a.observations} de ${a.months}` }),
            h('td', { text: [a.basis, a.simulated ? 'cotas simuladas para a demonstração' : null, a.note].filter(Boolean).join(' · ') }))))
        : h('div.empty', { text: `Nenhuma posição desta carteira pôde ser medida nesta janela${r.error ? `: ${r.error}` : '.'}` }),

      h('p.chart-caption', {},
        'Ordenado da posição mais volátil para a menos volátil. A volatilidade é o desvio-padrão dos doze retornos mensais do ativo, anualizado por √12, amostrado nos fins de mês e medido em reais — a mesma medida do gráfico de retorno e risco da mesa. ',
        portfolioCurrent?.volatility != null
          ? `A carteira inteira oscilou ${vol12(portfolioCurrent.volatility)} no mesmo período: menos do que a média ponderada destas linhas, porque elas não se movem juntas. É a diversificação aparecendo no número. `
          : '',
        simulated.length ? `Cotas simuladas para a demonstração: ${simulated.map((a) => a.ticker || shortAssetName(a.name)).join(', ')}. ` : '',
        partial.length ? `Série incompleta na janela: ${partial.map((a) => a.ticker || shortAssetName(a.name)).join(', ')}.` : ''),

      r.references?.length ? h('div', { style: { marginTop: '28px' } },
        h('div.rail-h', { text: 'Referências de mercado, na mesma janela' }),
        table(['Referência', { label: 'Volatilidade 12m', num: true }, { label: 'Retorno 12m', num: true }, { label: 'Meses', num: true }, 'Base de cálculo'],
          [...r.references].sort((a, b) => b.volatility - a.volatility).map((x) => h('tr', {},
            h('td.name', { text: x.label }),
            volCell(x.volatility),
            h('td.num', { class: toneClass(x.total_return), text: percent(x.total_return, { locale: L, decimals: 1 }) }),
            h('td.num', { text: `${x.observations} de ${x.months}` }),
            h('td', { text: x.basis || '' }))))) : null,

      r.excluded?.length ? h('div', { style: { marginTop: '28px' } },
        h('div.rail-h', { text: 'Posições sem medida de risco' }),
        table(['Ativo', 'Classe', { label: 'Valor', num: true }, { label: 'Peso', num: true }, 'Motivo'],
          r.excluded.map((e) => h('tr', {},
            h('td.name', {}, nameOf(e), e.name === nameOf(e) ? null : h('span.sub', { text: e.name })),
            h('td', { text: cls(e.asset_class) || '—' }),
            h('td.num', { text: money(e.market_value, { locale: L }) }),
            h('td.num', { text: weight(e.weight, { locale: L }) }),
            h('td', { text: e.reason })))),
        h('p.chart-caption', { text: 'Ficam fora da lista acima com o motivo. Uma posição que não pôde ser medida não entra na conta como volatilidade zero.' })) : null,

      sourcesBlock(r.sources, 'Ver fontes das séries'));
  }

  load();
  return h('section.section', { style: { marginTop: '32px' } },
    h('div.section-h', {}, h('h2', { text: 'Volatilidade por ativo' }), meta),
    box);
}


async function tabPortfolio(id, d) {
  return frag(
    h('div.grid.g2', {},
      h('div.card', {}, allocationBar(d.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })), { title: 'Composição atual' })),
      h('div.card', {}, bandChart(d.allocation.map((a) => ({ ...a, asset_class: cls(a.asset_class) })), { title: 'Enquadramento nas faixas da política' }))),
    h('section.section', { style: { marginTop: '24px' } },
      h('div.section-h', {}, h('h2', { text: 'Alocação por classe' }), h('span.meta', {}, `snapshot ${d.snapshot?.id} · ${dateLong(d.snapshot?.effective_date, L)}`)),
      table(['Classe', { label: 'Valor', num: true }, { label: 'Peso', num: true }, { label: 'Alvo', num: true }, { label: 'Desvio', num: true }, 'Faixa permitida', 'Enquadramento'],
        d.allocation.map((a) => h('tr', {},
          h('td.name', { text: cls(a.asset_class) }),
          h('td.num', { text: money(a.value, { locale: L }) }),
          h('td.num', { text: weight(a.weight, { locale: L }) }),
          h('td.num.muted', { text: a.target == null ? '—' : weight(a.target, { locale: L, decimals: 0 }) }),
          h('td.num', { class: toneClass(a.target == null ? null : -(Math.abs(a.weight - a.target) > 0.05 ? 1 : 0)), text: a.target == null ? '—' : pp(a.weight - a.target, { locale: L }) }),
          h('td.num.muted', { text: a.range ? `${weight(a.range.min, { locale: L, decimals: 0 })}–${weight(a.range.max, { locale: L, decimals: 0 })}` : '—' }),
          h('td', {}, a.inside_band ? h('span.chip', { text: 'dentro' }) : h('span.chip.warn', { text: 'fora da faixa' })))))),
  );
}

async function tabHoldings(id) {
  const d = await api(`/api/clients/${id}/holdings`);
  return frag(
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Posições' }), h('span.meta', {}, `${d.holdings.length} linhas · total ${money(d.total_value, { locale: L })}`)),
      table(['Ativo', 'Classe', { label: 'Quantidade', num: true }, { label: 'Preço', num: true }, { label: 'Valor', num: true }, { label: 'Peso', num: true }, { label: 'Resultado', num: true }, 'Precificação', 'Liquidez'],
        d.holdings.map((p) => h('tr', {},
          h('td', {}, h('span.name', { text: p.ticker || p.name }),
            h('span.sub', { text: p.ticker ? p.name : (p.isin || '') }),
            p.corporate_action ? h('span.sub.caution', { text: p.corporate_action }) : null,
            p.notes ? h('span.sub', { text: p.notes }) : null),
          h('td', { text: cls(p.asset_class) }),
          h('td.num', { text: p.quantity == null ? '—' : num(p.quantity, p.quantity < 100 ? 4 : 0) }),
          h('td.num', {}, p.price == null ? '—' : num(p.price, 2)),
          h('td.num', { text: money(p.market_value, { locale: L }) }),
          h('td.num', { text: weight(p.weight, { locale: L }) }),
          h('td.num', { class: toneClass(p.unrealised), text: p.unrealised == null ? '—' : money(p.unrealised, { locale: L, signed: true }) }),
          h('td', {}, h('span', { class: `chip ${p.pricing_mode === 'market' ? 'live' : 'mock'}`, text: pricingLabel(p.pricing_mode) })),
          h('td.num.muted', { text: p.liquidity_days == null ? '—' : `D+${p.liquidity_days}` }))))),
    h('p.note', { text: 'Precificação "mercado" vem de um provedor externo. "Extrato" significa que o valor da cota é fornecido pelo custodiante, porque não existe cotação pública para o veículo. "Acúmulo" é calculado a partir do índice oficial mais o spread contratado.' }),
  );
}

const pricingLabel = (m) => ({ market: 'mercado', nav: 'extrato', accrual: 'acúmulo', cash: 'caixa' }[m] || m);

async function tabRecommendations(id) {
  const d = await api(`/api/clients/${id}/recommendations`);
  if (!d.recommendations.length) {
    return h('div.empty', {}, 'Nenhum conjunto de recomendações gerado ainda. ',
      h('a', { href: '#/', text: 'Rode o workflow' }), ' para este cliente com npm run run:report.');
  }
  const assets = await api(`/api/clients/${id}/holdings`);
  const byId = new Map(assets.holdings.map((x) => [x.asset_id, x]));

  const decide = async (recId, status, btn) => {
    btn.disabled = true;
    await api(`/api/clients/${id}/recommendations/${recId}/decision`, { status });
    location.reload();
  };

  const rows = d.recommendations
    .slice()
    .sort((a, b) => (b.signal_conflict - a.signal_conflict) || (a.suitability_result === 'PASS') - (b.suitability_result === 'PASS'))
    .map((r) => {
      const asset = byId.get(r.asset_id) || { ticker: r.ticker, name: r.name, asset_class: r.asset_class };
      const st = r.statement || {};
      return frag(
        h('tr', { class: r.signal_conflict ? 'conflict-row' : '' },
          h('td', {}, h('span.name', { text: asset?.ticker || asset?.name || r.name || r.asset_id }),
            h('span.sub', { text: `${cls(asset?.asset_class || r.asset_class)} · ${r.current_weight ? `${weight(r.current_weight, { locale: L })} da carteira` : 'candidato — fora da carteira hoje'}` })),
          h('td', {}, h('span', { class: `chip ${String(r.final_action).toLowerCase()}`, text: actionLabel(r.final_action) }),
            r.final_action !== r.proposed_action ? h('span.sub.caution', { text: `motor sugeriu ${actionLabel(r.proposed_action)}` }) : null),
          h('td', { style: { maxWidth: '300px' } },
            h('div.sig-pair', {}, h('b', { text: 'Mercado' }), h('span', { text: st.market_signal || '—' })),
            h('div.sig-pair', { style: { marginTop: '6px' } }, h('b', { text: 'Enquadramento' }),
              h('span', { class: r.suitability_result === 'PASS' ? '' : 'caution', text: st.client_suitability || r.suitability_result }))),
          h('td.num', { text: r.conviction == null ? '—' : num(r.conviction, 2) }),
          h('td', {}, h('span', { class: `chip ${r.advisor_status}`, text: statusLabel(r.advisor_status) })),
          h('td', {}, h('div.split', {},
            h('button.btn.sm.approve', { text: 'aprovar', disabled: r.advisor_status === 'approved', onclick: (e) => decide(r.id, 'approved', e.target) }),
            h('button.btn.sm.reject', { text: 'rejeitar', disabled: r.advisor_status === 'rejected', onclick: (e) => decide(r.id, 'rejected', e.target) })))),
        h('tr', {}, h('td', { colspan: 6, style: { paddingTop: 0 } },
          h('div', { style: { display: 'grid', gap: '4px' } },
            (r.factors || []).filter((f) => f.direction !== 0 || f.unavailable).map((f) => h('div.note', {},
              h('b', { text: `${familyLabel(f.family)}: ` }), f.label_pt || f.label,
              (f.detail_pt || f.detail) ? h('span.muted', { text: ` — ${f.detail_pt || f.detail}` }) : null)),
            (r.flags || []).map((f) => h('div.note', { class: f.severity === 'high' ? 'caution' : '' },
              h('b', { text: `${flagLabel(f.code)}: ` }), f.message_pt || f.message))))));
    });

  const approved = d.recommendations.filter((r) => r.advisor_status === 'approved').length;
  return frag(
    h('div.grid.g4', { style: { marginBottom: '20px' } },
      stat('Propostas', String(d.recommendations.length)),
      stat('Sinais divergentes', String(d.recommendations.filter((r) => r.signal_conflict).length), { tone: 'caution' }),
      stat('Ajustadas pelo enquadramento', String(d.recommendations.filter((r) => r.final_action !== r.proposed_action).length), { tone: 'caution' }),
      stat('Aprovadas por você', String(approved), { tone: approved ? 'gain' : 'flat' })),
    h('div.hint', { style: { marginBottom: '18px' } },
      'Nada aqui é executado. A carta ao cliente só imprime os itens que você aprovar; os demais permanecem apenas nesta tela.'),
    table(['Ativo', 'Sugestão final', 'Sinal de mercado e enquadramento', { label: 'Convicção', num: true }, 'Status', 'Decisão'], rows),
  );
}

// The advisor's queue keeps the engine's own words, because "encerrar" and
// "discutir" are decisions they take. The client's three verbs are in the letter.
const actionLabel = (a) => ({ ADD: 'Aumentar', HOLD: 'Manter', REDUCE: 'Reduzir', EXIT: 'Encerrar', DISCUSS: 'Discutir' }[a] || a);
const clientActionLabel = (a) => ({ ADD: 'Aumentar', HOLD: 'Manter', REDUCE: 'Reduzir', EXIT: 'Reduzir', DISCUSS: 'Manter' }[a] || a);
const LEGACY_BREACH = new Set(['RESTRICTED_INSTRUMENT', 'RISK_GRADE_ABOVE_PROFILE', 'CLASS_AT_OR_ABOVE_MAX', 'CLASS_BELOW_MIN', 'CONCENTRATION_BREACH']);
const withinPolicy = (r) => {
  if (typeof r?.within_policy === 'boolean') return r.within_policy;
  const flags = r?.flags || [];
  if (flags.some((f) => f.breach === true)) return false;
  return !flags.some((f) => f.breach === undefined && LEGACY_BREACH.has(f.code));
};
const policyFitPt = (r) => (withinPolicy(r) ? 'Dentro da política' : 'Fora da política');
const statusLabel = (s) => ({ proposed: 'proposta', approved: 'aprovada', rejected: 'rejeitada', edited: 'editada' }[s] || s);
const suitabilityLabel = (s) => ({
  PASS: 'Dentro da política', DISCUSS_ONLY: 'Somente discussão', DO_NOT_ADD: 'Não aumentar',
  REDUCE_REQUIRED: 'Redução necessária', BLOCKED: 'Vedado pela política',
}[s] || s);

const flagLabel = (c) => ({
  RESTRICTED_INSTRUMENT: 'Instrumento vedado',
  RISK_GRADE_ABOVE_PROFILE: 'Grau de risco acima do perfil',
  CLASS_AT_OR_ABOVE_MAX: 'Classe no teto da política',
  CLASS_NEAR_MAX: 'Classe próxima do teto',
  CLASS_BELOW_MIN: 'Classe abaixo do mínimo',
  CONCENTRATION_BREACH: 'Concentração acima do teto',
  FX_EXPOSURE_AT_CAP: 'Exposição cambial no limite',
  FX_EXPOSURE_ABOVE_LIMIT: 'Exposição cambial acima do limite',
  CURRENCY_MISMATCH: 'Moeda diferente da base',
  LIQUIDITY_MISMATCH: 'Liquidez incompatível',
  POLICY_DRIFT: 'Desvio da política',
  DATA_INTEGRITY: 'Integridade de dados',
}[c] || c);

const familyLabel = (f) => ({
  tradingview_technical: 'Técnico', tradingview_analyst: 'Analistas', policy_band: 'Faixa da política',
  concentration: 'Concentração', advisor_world_view: 'Sua visão de mercado', data_integrity: 'Integridade de dados',
}[f] || f);

async function tabPolicy(id, d) {
  const hist = await api(`/api/clients/${id}/policy/history`);
  const p = d.policy;
  return frag(
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: `Política de investimentos — versão ${p.version}` }), h('span.meta', { text: `vigente desde ${dateLong(p.effective_date, L)}` })),
      h('div.grid.g2', {},
        h('div.card', {},
          h('div.card-h', {}, h('h3', { text: 'Parâmetros' })),
          table(['Item', 'Definição'], [
            ['Perfil de risco', p.risk_profile],
            ['Horizonte', p.investment_horizon],
            ['Liquidez', p.liquidity_requirements],
            ['Necessidade de liquidez', `${p.liquidity_requirement_days} dias`],
            ['Objetivos', p.objectives],
            ['Moeda base', p.base_currency],
            ['Teto por emissor', weight(p.single_name_cap, { locale: L, decimals: 0 })],
            ['Exposição cambial sem hedge', p.max_unhedged_fx == null ? '—' : weight(p.max_unhedged_fx, { locale: L, decimals: 0 })],
            ['Gatilho de rebalanceamento', pp(p.rebalance_trigger, { locale: L, signed: false })],
          ].map(([k, v]) => h('tr', {}, h('td.name', { text: k }), h('td', { text: v ?? '—' }))))),
        h('div.card', {},
          h('div.card-h', {}, h('h3', { text: 'Faixas permitidas' })),
          table(['Classe', { label: 'Alvo', num: true }, { label: 'Mínimo', num: true }, { label: 'Máximo', num: true }],
            Object.entries(p.permitted_ranges || {}).map(([k, r]) => h('tr', {},
              h('td.name', { text: cls(k) }),
              h('td.num', { text: weight(r.target ?? p.target_allocation?.[k] ?? 0, { locale: L, decimals: 0 }) }),
              h('td.num.muted', { text: weight(r.min, { locale: L, decimals: 0 }) }),
              h('td.num.muted', { text: weight(r.max, { locale: L, decimals: 0 }) })))))),
      (p.restrictions || []).length ? h('div.card', { style: { marginTop: '16px' } },
        h('div.card-h', {}, h('h3', { text: 'Restrições' })),
        h('div', {}, p.restrictions.map((r) => h('div.trg', {},
          h('span.dot.BREACHED'), h('div.lab', { style: { fontWeight: 400 }, text: r.label }), h('span.obs.mono', { text: r.type }))))) : null,
      p.notes ? h('p.note', { style: { marginTop: '14px' } }, h('b', { text: 'Nota do assessor: ' }), p.notes) : null),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Histórico de versões' }), h('span.meta', { text: 'nenhuma versão é sobrescrita' })),
      table(['Versão', 'Vigência', 'Status', 'Perfil', 'Aprovada por', 'Nota'],
        hist.versions.map((v) => h('tr', {},
          h('td.name', { text: `v${v.version}` }),
          h('td', { text: dateLong(v.effective_date, L) }),
          h('td', {}, h('span', { class: `chip ${v.status === 'approved' ? 'approved' : 'proposed'}`, text: v.status })),
          h('td', { text: v.risk_profile }),
          h('td', { text: v.approved_by || '—' }),
          h('td', { style: { maxWidth: '420px' }, text: v.notes || '—' }))))),
  );
}

async function tabMeetings(id) {
  const d = await api(`/api/clients/${id}/meetings`);
  return frag(
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Reuniões' }),
        h('a.btn.sm', { href: `#/client/${id}/prep`, text: 'preparar a próxima' })),
      table(['Data', 'Status', 'Notas'],
        d.meetings.map((m) => h('tr', {},
          h('td.name', { text: dateLong(m.date, L) }),
          h('td', {}, h('span', { class: `chip ${m.status === 'held' ? 'approved' : 'proposed'}`, text: m.status })),
          h('td', { style: { maxWidth: '620px' }, text: m.notes || '—' }))))),
  );
}

const newLetterButton = (id, { small = false } = {}) => h(`a.btn${small ? '.sm' : ''}`, {
  href: `#/client/${id}/carta`, target: '_blank', rel: 'noopener',
}, icon('letter', { size: small ? 13 : 15 }), h('span', { text: 'criar carta mensal' }));

async function tabReports(id) {
  const d = await api(`/api/clients/${id}/reports`);
  if (!d.reports.length) {
    return h('div.empty', {},
      h('p', { text: 'Nenhuma carta escrita para este cliente ainda.' }),
      h('div.split', { style: { marginTop: '12px', justifyContent: 'center' } }, newLetterButton(id)));
  }
  return frag(
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Cartas mensais' }), newLetterButton(id, { small: true })),
      table(['Mês', 'Status', { label: 'Páginas', num: true }, 'Aprovada', 'Publicada', 'Formatos'],
        d.reports.map((r) => h('tr', {},
          h('td.name', {}, h('a', { href: `#/client/${id}/report/${r.id}`, text: monthLabel(r.reporting_month, L) })),
          h('td', {}, reportChip(r.status)),
          h('td.num', { text: r.page_count ?? '—' }),
          h('td', { text: r.approved_at ? shortDate(r.approved_at) : '—' }),
          h('td', {}, r.published_at ? shortDate(r.published_at) : '—'),
          h('td', {}, h('div.split', {},
            h('a.btn.sm', { href: `#/client/${id}/report/${r.id}`, text: 'pré-visualizar' }),
            h('a.btn.sm', { href: apiUrl(r.links?.pdf || `/api/reports/${r.id}/pdf`), target: '_blank', text: 'pdf' }))))))),
  );
}

async function tabAudit(id) {
  const d = await api(`/api/clients/${id}/audit`);
  return frag(
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Execuções do workflow' })),
      d.graph_runs.length ? table(['Execução', 'Grafo', 'Início', 'Fim', 'Status', 'Versão do prompt'],
        d.graph_runs.map((r) => h('tr', {},
          h('td.mono', { style: { fontSize: '11px' }, text: r.id }),
          h('td', { text: r.graph_name }),
          h('td.mono', { style: { fontSize: '11px' }, text: r.started_at?.slice(0, 19).replace('T', ' ') }),
          h('td.mono', { style: { fontSize: '11px' }, text: r.finished_at?.slice(0, 19).replace('T', ' ') || '—' }),
          h('td', {}, h('span', { class: `chip ${r.status === 'completed' ? 'approved' : 'proposed'}`, text: r.status })),
          h('td.mono', { style: { fontSize: '11px' }, text: r.prompt_version || '—' })))) : h('div.empty', { text: 'Nenhuma execução registrada.' })),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Registro de fontes' }), h('span.meta', { text: `${d.sources.length} observações usadas em cartas publicadas` })),
      d.sources.length ? table(['Provedor', 'Instrumento', 'Identificador', 'Intervalo', 'Última observação', 'Obtido em', 'Origem'],
        d.sources.slice(0, 60).map((s) => h('tr', {},
          h('td.name', { text: s.provider }),
          h('td', { text: s.instrument || '—' }),
          h('td.mono', { style: { fontSize: '11px' }, text: s.identifier || '—' }),
          h('td.mono', { style: { fontSize: '11px' }, text: s.requested_range || '—' }),
          h('td.mono', { style: { fontSize: '11px' }, text: s.last_observation || '—' }),
          h('td.mono', { style: { fontSize: '11px' }, text: s.retrieval_timestamp?.slice(0, 16).replace('T', ' ') }),
          h('td', {}, s.mocked ? h('span.chip.mock', { text: 'SIMULADO' })
            : s.fallback_for ? h('span.chip.warn', { text: `fallback de ${s.fallback_for}` })
              : h('span.chip.live', { text: 'PROVEDOR' }))))) : h('div.empty', { text: 'Sem fontes registradas ainda.' })),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Trilha de auditoria' })),
      table(['Quando', 'Entidade', 'Ação', 'Detalhe'],
        d.audit.slice(0, 60).map((a) => h('tr', {},
          h('td.mono', { style: { fontSize: '11px' }, text: a.created_at }),
          h('td', { text: a.entity }),
          h('td', {}, h('span.chip', { text: a.action })),
          h('td.mono', { style: { fontSize: '10.5px', maxWidth: '520px', wordBreak: 'break-all' }, text: a.detail ? JSON.stringify(a.detail).slice(0, 220) : '—' }))))),
  );
}

// ═══ meeting preparation ═══════════════════════════════════════════════════
async function viewMeetingPrep({ id }) {
  const [p, held] = await Promise.all([api(`/api/clients/${id}/meeting-prep`), api(`/api/clients/${id}/holdings`)]);
  const series = cumulativeSeries(p.returns_history);
  // Recommendations carry only the asset id; the holdings give the instrument
  // its name. A candidate outside the book falls back to its code.
  const byAsset = new Map((held.holdings || []).map((x) => [x.asset_id, x]));
  const instrument = (r) => byAsset.get(r.asset_id) || { ticker: String(r.asset_id || '').replace(/^ast_/, '').toUpperCase(), name: null };
  const bySeverity = { high: [], medium: [], low: [] };
  for (const o of p.discussion_opportunities) (bySeverity[o.severity] ||= []).push(o);

  return frag(
    head('Preparação de reunião',
      `${p.next_meeting ? `Próxima reunião ${dateLong(p.next_meeting.date, L)}` : 'Sem reunião marcada'} · referência ${monthLabel(p.month, L)}`,
      [h('a.btn', { href: `#/client/${id}/overview` }, icon('back', { size: 15 }), h('span', { text: 'voltar ao cliente' })),
        h('a.btn.primary', { href: `#/client/${id}/editor` }, icon('edit', { size: 15 }), h('span', { text: 'editar carteira' }))],
      [h('b', { text: p.client.name }), sep(), 'Reunião']),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Pontos de discussão levantados automaticamente' }),
        h('span.meta', { text: `${p.discussion_opportunities.length} itens` })),
      p.discussion_opportunities.length ? h('div.card', {},
        ['high', 'medium', 'low'].flatMap((sev) => (bySeverity[sev] || []).map((o) => h('div.trg', {},
          h('span', { class: `dot ${sev === 'high' ? 'BREACHED' : 'APPROACHING'}` }),
          h('div', {}, h('div.lab', { style: { fontWeight: 400 }, text: o.message }),
            h('div.det', { text: `${o.kind}${o.asset_class ? ` · ${cls(o.asset_class)}` : ''}` })),
          h('span.obs', { class: sev === 'high' ? 'caution' : 'muted', text: sev })))))
        : h('div.empty', { text: 'Nada fora do enquadramento. A conversa pode ser sobre objetivos, não sobre correções.' })),

    h('div.grid.g2', {},
      h('div.card', {}, h('div.card-h', {}, h('h3', { text: 'Posição atual' }), h('span.meta', {}, money(p.total_value, { locale: L }))),
        allocationBar(p.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })))),
      h('div.card', {}, h('div.card-h', {}, h('h3', { text: 'Enquadramento' })),
        bandChart(p.allocation.map((a) => ({ ...a, asset_class: cls(a.asset_class) }))))),

    h('section.section', { style: { marginTop: '24px' } },
      h('div.section-h', {}, h('h2', { text: 'Histórico de retorno' })),
      h('div.card', {}, lineChart(series, { caption: 'Retorno acumulado da carteira contra a referência da política' }))),

    p.recommendations.length ? h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Recomendações a decidir' }),
        h('a.btn.sm', { href: `#/client/${id}/recommendations`, text: 'abrir a tela de decisão' })),
      table(['Ativo', 'Sugestão', 'Enquadramento', 'Status'],
        p.recommendations.map((r) => h('tr', { class: r.signal_conflict ? 'conflict-row' : '' },
          h('td', {}, h('span.name', { text: instrument(r).ticker || instrument(r).name }), instrument(r).ticker && instrument(r).name ? h('span.sub', { text: instrument(r).name }) : null),
          h('td', {}, h('span', { class: `chip ${String(r.final_action).toLowerCase()}`, text: actionLabel(r.final_action) })),
          h('td', { class: r.suitability_result === 'PASS' ? '' : 'caution', text: suitabilityLabel(r.suitability_result) }),
          h('td', {}, h('span', { class: `chip ${r.advisor_status}`, text: statusLabel(r.advisor_status) })))))) : null,
  );
}

// ═══ portfolio editor ══════════════════════════════════════════════════════
async function viewEditor({ id }) {
  const [d, holdings] = await Promise.all([api(`/api/clients/${id}`), api(`/api/clients/${id}/holdings`)]);
  const proposed = holdings.holdings.map((p) => ({ ...p, proposed_value: p.market_value }));
  const total = () => proposed.reduce((a, p) => a + Number(p.proposed_value || 0), 0);

  const out = h('div');
  const summary = h('div.grid.g4', { style: { marginBottom: '20px' } });
  const classTable = h('div');
  const commentary = h('textarea', { rows: 3, style: { width: '100%' }, placeholder: 'Comentário do assessor sobre esta alocação (fica gravado no snapshot).' });

  function classTotals(key) {
    const m = new Map();
    for (const p of proposed) m.set(p.asset_class, (m.get(p.asset_class) ?? 0) + Number(p[key] || 0));
    return m;
  }

  function refresh() {
    const t = total();
    const before = classTotals('market_value');
    const after = classTotals('proposed_value');
    const beforeTotal = holdings.total_value || 1;
    const diff = Math.round((t - beforeTotal) * 100) / 100;

    mount(summary,
      stat('Valor atual', money(beforeTotal, { locale: L }), { small: true }),
      stat('Valor proposto', money(t, { locale: L }), { small: true, tone: toneClass(diff) }),
      stat('Diferença', money(diff, { locale: L, signed: true }), { small: true, tone: toneClass(diff) }),
      stat('Classes fora da faixa', String([...after.keys()].filter((k) => {
        const r = d.policy?.permitted_ranges?.[k];
        if (!r) return false;
        const w = (after.get(k) || 0) / (t || 1);
        return w < r.min || w > r.max;
      }).length), { small: true, tone: 'caution' }));

    const classes = [...new Set([...before.keys(), ...after.keys()])];
    mount(classTable,
      table(['Classe', { label: 'Antes', num: true }, { label: 'Peso antes', num: true }, { label: 'Depois', num: true }, { label: 'Peso depois', num: true }, { label: 'Variação', num: true }, 'Faixa', 'Enquadramento'],
        classes.map((k) => {
          const wb = (before.get(k) || 0) / beforeTotal;
          const wa = (after.get(k) || 0) / (t || 1);
          const r = d.policy?.permitted_ranges?.[k];
          const inside = !r || (wa >= r.min && wa <= r.max);
          return h('tr', {},
            h('td.name', { text: cls(k) }),
            h('td.num', { text: money(before.get(k) || 0, { locale: L }) }),
            h('td.num.muted', { text: weight(wb, { locale: L }) }),
            h('td.num', { text: money(after.get(k) || 0, { locale: L }) }),
            h('td.num', { class: inside ? '' : 'caution', text: weight(wa, { locale: L }) }),
            h('td.num', { class: toneClass(wa - wb), text: pp(wa - wb, { locale: L }) }),
            h('td.num.muted', { text: r ? `${weight(r.min, { locale: L, decimals: 0 })}–${weight(r.max, { locale: L, decimals: 0 })}` : '—' }),
            h('td', {}, inside ? h('span.chip', { text: 'dentro' }) : h('span.chip.warn', { text: 'fora da faixa' })));
        })));
  }

  const rows = proposed.map((p, i) => {
    const input = h('input', {
      type: 'number', step: '0.01', value: p.proposed_value?.toFixed(2), style: { width: '130px', textAlign: 'right' },
      oninput: (e) => { proposed[i].proposed_value = Number(e.target.value); refresh(); },
    });
    return h('tr', {},
      h('td', {}, h('span.name', { text: p.ticker || p.name }), h('span.sub', { text: cls(p.asset_class) })),
      h('td.num', { text: money(p.market_value, { locale: L }) }),
      h('td.num', {}, input),
      h('td.num', {}, h('span', { class: 'muted', text: pricingLabel(p.pricing_mode) })));
  });

  async function save() {
    const t = total();
    const payload = {
      effective_date: new Date().toISOString().slice(0, 10),
      commentary: commentary.value || null,
      cash_balance: proposed.filter((p) => p.asset_class === 'Cash').reduce((a, p) => a + Number(p.proposed_value || 0), 0),
      positions: proposed.filter((p) => Number(p.proposed_value) > 0).map((p) => ({
        asset_id: p.asset_id, quantity: p.quantity, cost_basis: p.cost_basis, price: p.price,
        market_value: Number(p.proposed_value), acquired_at: p.acquired_at, notes: p.notes,
      })),
    };
    await api(`/api/clients/${id}/snapshots`, payload);
    location.hash = `#/client/${id}/portfolio`;
  }

  refresh();
  mount(out,
    head('Editor de carteira', 'Salvar cria um novo snapshot versionado. O anterior é marcado como substituído e permanece consultável.', [
      h('a.btn', { href: `#/client/${id}/portfolio`, text: 'cancelar' }),
      h('button.btn.primary', { onclick: save }, icon('check', { size: 15 }), h('span', { text: 'aprovar e criar snapshot' })),
    ], [h('b', { text: d.client.name }), sep(), 'Nova versão da carteira']),
    summary,
    h('div.grid.g2', {},
      h('div.card', {}, h('div.card-h', {}, h('h3', { text: 'Posições' })),
        table(['Ativo', { label: 'Valor atual', num: true }, { label: 'Valor proposto', num: true }, 'Precificação'], rows)),
      h('div.card', {}, h('div.card-h', {}, h('h3', { text: 'Antes e depois por classe' })), classTable)),
    h('div.card', { style: { marginTop: '20px' } },
      h('div.card-h', {}, h('h3', { text: 'Comentário do assessor' })), commentary));
  return out;
}

// ═══ report preview ════════════════════════════════════════════════════════
async function viewReport({ id, reportId }) {
  const d = await api(`/api/clients/${id}/reports/${reportId}`);
  const r = d.report;
  const c = r.canonical;
  const mode = h('div.split', { style: { marginBottom: '16px' } });
  const stage = h('div');

  const links = d.report.links || {};
  const views = {
    letter: () => renderCanonicalSummary(c),
    email: () => h('iframe.doc', { src: apiUrl(links.html || `/api/reports/${reportId}/html`), title: 'E-mail', style: { height: '1400px' } }),
    pdf: () => h('iframe.doc', { src: apiUrl(links.pdf || `/api/reports/${reportId}/pdf`), title: 'PDF', style: { height: '1100px' } }),
    json: () => h('pre.json', { text: JSON.stringify(c, null, 2) }),
  };
  const labels = { letter: 'carta (dados)', email: 'e-mail html', pdf: 'pdf', json: 'objeto canônico' };
  let current = 'letter';
  function show(k) {
    current = k;
    mount(stage, views[k]());
    for (const b of mode.querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === k);
  }
  mount(mode, Object.keys(views).map((k) => h('button.btn.sm', { dataset: { k }, text: labels[k], onclick: () => show(k) })));

  const approve = async (action) => {
    await api(`/api/clients/${id}/reports/${reportId}/${action}`);
    location.reload();
  };

  crumbs(crumbsFor(currentHash(), { clientName: c.client?.name, report: `Carta de ${monthLabel(r.reporting_month, L)}` }));
  const el = frag(
    head(`Carta de ${monthLabel(r.reporting_month, L)}`,
      `${r.page_count} páginas · gerada em ${r.created_at} · execução ${r.graph_run_id || '—'} · narrativa: ${c.provenance?.narrative_mode}`,
      [
        reportChip(r.status),
        r.status === 'pending_approval' ? h('button.btn.primary', { onclick: () => approve('approve') }, icon('check', { size: 15 }), h('span', { text: 'aprovar carta' })) : null,
        r.status === 'approved' ? h('button.btn.primary', { onclick: () => approve('publish') }, icon('arrow', { size: 15 }), h('span', { text: 'publicar para o cliente' })) : null,
        h('a.btn', { href: apiUrl(links.pdf || `/api/reports/${reportId}/pdf`), target: '_blank' }, icon('download', { size: 15 }), h('span', { text: 'abrir pdf' })),
      ].filter(Boolean),
      [h('b', { text: c.client?.name || '' }), sep(), 'Carta mensal']),
    mode, stage);
  show('letter');
  return el;
}

function renderCanonicalSummary(c) {
  const letter = c.letter || {};
  return frag(
    h('div.grid.g2', {},
      h('div.card', {},
        h('div.card-h', {}, h('h3', { text: 'Texto da carta' }),
          h('span.meta', { text: `${(letter.paragraphs || []).length} parágrafos · ${c.locale}` })),
        // The advisor reads what the client will read, in the order they will
        // read it. A field-by-field dump is how the letter stopped being one.
        h('div.letter', { style: { fontSize: '15px' } },
          letter.title ? h('h2.letter-title', { text: letter.title }) : null,
          h('p.greeting', { text: letter.greeting || '' }),
          (letter.paragraphs || []).map((x) => h('p', { text: x })),
          letter.sign_off ? h('p', { text: letter.sign_off }) : null,
          h('div.sig', {}, h('b', { text: c.advisor?.name || '' }),
            h('span', { text: `XP Asset Management${c.advisor?.code ? ` · ${c.advisor.code}` : ''}` })))),
      h('div', {},
        h('div.card', { style: { marginBottom: '16px' } },
          h('div.card-h', {}, h('h3', { text: 'Números da carta' })),
          h('div.grid.g2', {},
            stat('Rentabilidade', percent(c.portfolio_performance?.monthly_return, { locale: L }), { small: true, tone: toneClass(c.portfolio_performance?.monthly_return) }),
            stat('Resultado', money(c.portfolio_performance?.absolute_pnl, { locale: L, signed: true }), { small: true, tone: toneClass(c.portfolio_performance?.absolute_pnl) }),
            stat('Referência', c.benchmark?.value == null ? '—' : percent(c.benchmark.value, { locale: L }), { small: true, tone: 'bench' }),
            stat('Método', c.portfolio_performance?.method, { small: true }))),
        h('div.card', {},
          h('div.card-h', {}, h('h3', { text: 'Recomendações publicadas' }), h('span.meta', { text: `${(c.recommendations || []).length} itens aprovados` })),
          // This panel shows what the client received, so it uses the client's
          // words: three verbs and a policy answer with two values. The engine's
          // five-value vocabulary stays in the advisor's own decision queue.
          table(['Ativo', 'Sugestão', 'Enquadramento'],
            (c.recommendations || []).map((r) => h('tr', {},
              h('td.name', { text: r.ticker || r.name }),
              h('td', {}, h('span', { class: `chip ${String(r.final_action).toLowerCase()}`, text: clientActionLabel(r.final_action) })),
              h('td', { class: withinPolicy(r) ? '' : 'caution', text: policyFitPt(r) }))))))),
    (c.data_quality?.unavailable || []).length ? h('div.card', { style: { marginTop: '16px' } },
      h('div.card-h', {}, h('h3', { text: 'Dados indisponíveis divulgados na carta' })),
      table(['Item', 'Motivo'], c.data_quality.unavailable.map((u) => h('tr', {}, h('td.name', { text: u.item }), h('td', { text: u.reason }))))) : null,
    h('div.card', { style: { marginTop: '16px' } }, sourcesBlock(c.sources, 'Fontes usadas nesta carta')),
    h('div.disclosure', {}, (c.disclosures || []).map((x) => h('p', { text: x }))),
  );
}

// ═══ the letter agent: the month's carta, in its own tab ═══════════════════
/**
 * Opened from the client page in a new tab. Without a run id it starts one and
 * moves to that run's address; with one it follows the four steps as the Worker
 * reports them and shows the letter when the last step ends.
 *
 * What comes out is a carta waiting for approval, not a published one: the
 * advisor reads it here, and the page that approves and publishes it is the
 * letter's own page, which this one hands over to.
 */
async function viewMonthlyLetter({ id, runId = null }) {
  const d = await api(`/api/clients/${id}`);
  const c = d.client;
  crumbs(crumbsFor(currentHash(), { clientName: c.name }));

  if (!runId) {
    const started = await api(`/api/clients/${id}/letters`, {});
    location.replace(`#/client/${id}/carta/${started.run.id}`);
    return h('div.loading', {}, loader(), h('span', { text: 'Iniciando o agente de cartas…' }));
  }

  const runBox = h('div');
  const letterBox = h('div');
  const history = h('div');
  const start = async (e, body = {}) => {
    e.currentTarget.disabled = true;
    const started = await api(`/api/clients/${id}/letters`, body);
    location.hash = `#/client/${id}/carta/${started.run.id}`;
  };
  const again = h('button.btn', { type: 'button', onclick: (e) => start(e) },
    icon('refresh', { size: 15 }), h('span', { text: 'escrever de novo' }));

  const ring = donut({ size: 96 });
  const msg = h('div.pmsg');
  const state = h('div.pstate', { text: 'Quatro etapas rodam em sequência: dados, análise, redação e diagramação. Com o modelo escrevendo, isto leva de um a dois minutos; a aba pode ficar aberta.' });
  const clock = h('span.mono.muted');
  const rows = [];
  const agentsList = h('ol.agents');
  const foot = h('div.pfoot', {}, clock);
  const panel = h('div.progress-card.inline', { role: 'status', 'aria-live': 'polite' },
    h('div.phead', {}, ring.el, h('div', {}, h('h3', { text: 'Escrevendo a carta mensal' }), msg, state)),
    agentsList, foot);
  mount(runBox, panel);

  const t0 = Date.now();
  const timer = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 500);

  const paintAgents = (run) => {
    if (!rows.length) {
      for (const a of run.agents || []) {
        const li = h('li', { dataset: { step: a.step } }, h('span.idx', {}, h('b', { text: String(a.step) }), icon('check', { size: 14 })), h('span', {}, h('b', { text: a.title }), h('small', { text: a.what })));
        rows.push(li); agentsList.append(li);
      }
    }
    for (const li of rows) {
      const s = Number(li.dataset.step);
      li.className = run.status === 'completed' || s < run.step ? 'done' : s === run.step && run.status === 'running' ? 'active' : run.status === 'failed' && s === run.step ? 'failed' : '';
    }
  };

  // The letter as the client will read it, and the one button that matters next:
  // a carta sitting at pending_approval is not a finished job until it is approved.
  const showLetter = (run) => {
    const src = apiUrl(run.links.portal);
    mount(letterBox,
      h('div.split', { style: { margin: '20px 0 12px' } },
        h('a.btn.primary', { href: `#/client/${id}/report/${run.report_id}` }, icon('check', { size: 15 }), h('span', { text: 'ver e aprovar a carta' })),
        h('a.btn', { href: apiUrl(run.links.pdf), target: '_blank' }, icon('download', { size: 15 }), h('span', { text: 'abrir o pdf' })),
        again,
        h('span.note', {}, `${run.page_count} ${run.page_count === 1 ? 'página' : 'páginas'} · redação ${run.narrative_mode === 'model' ? 'pelo modelo' : 'determinística, sem modelo de linguagem'} · aguardando a sua aprovação; o cliente só a vê depois de publicada`)),
      h('iframe.doc', { src, title: 'Carta mensal', style: { height: '1120px' } }));
  };

  const paintHistory = async () => {
    const list = await api(`/api/clients/${id}/letters`);
    const done = list.runs.filter((r) => r.status === 'completed' && r.id !== runId);
    mount(history, done.length ? h('section.section', { style: { marginTop: '32px' } },
      h('div.section-h', {}, h('h2', { text: 'Execuções anteriores' }), h('span.meta', { text: `${done.length} ${done.length === 1 ? 'carta escrita' : 'cartas escritas'}` })),
      table(['Escrita em', 'Mês de referência', { label: 'Páginas', num: true }, 'Redação', ''],
        done.map((r) => h('tr', {},
          h('td.name', { text: r.finished_at ? `${shortDate(r.finished_at)} ${String(r.finished_at).slice(11, 16)}` : '—' }),
          h('td', { text: r.reporting_month ? monthLabel(r.reporting_month, L) : '—' }),
          h('td.num', { text: r.page_count ?? '—' }),
          h('td', { text: r.narrative_mode === 'model' ? 'modelo' : 'determinística' }),
          h('td', {}, h('div.split', {},
            r.report_id ? h('a.btn.sm', { href: `#/client/${id}/report/${r.report_id}`, text: 'ver' }) : null,
            r.links?.pdf ? h('a.btn.sm', { href: apiUrl(r.links.pdf), target: '_blank', text: 'pdf' }) : null)))))) : null);
  };

  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    let run;
    try { run = (await api(`/api/clients/${id}/letters/${runId}`)).run; } catch (err) { msg.textContent = err.message; return; }
    ring.set(run.progress ?? 0);
    msg.textContent = run.message || '';
    paintAgents(run);
    if (run.status === 'completed') {
      stopped = true; clearInterval(timer);
      state.textContent = 'A carta está abaixo. Ela ainda não foi publicada: aprove-a para que o cliente possa lê-la.';
      showLetter(run);
      return;
    }
    if (run.status === 'failed') {
      stopped = true; clearInterval(timer);
      // A month already published is not a failure to retry: it is a decision.
      // The button says what it replaces, and asks once before replacing it.
      if (run.blocked_by === 'published') {
        state.textContent = run.error || '';
        mount(letterBox, h('div.split', { style: { marginTop: '16px' } },
          h('button.btn', { type: 'button', onclick: (e) => {
            if (!confirm(`Reescrever a carta de ${monthLabel(run.reporting_month, L)}?\n\nA carta publicada será substituída pela nova, que volta a aguardar a sua aprovação. O cliente deixa de ver a que leu até você publicar esta.`)) return;
            start(e, { reissue: true });
          } }, icon('edit', { size: 15 }), h('span', { text: 'reescrever mesmo assim' })),
          h('a.btn', { href: `#/client/${id}/reports` }, icon('letter', { size: 15 }), h('span', { text: 'ver a carta publicada' }))));
        return;
      }
      state.textContent = `A execução falhou: ${run.error || 'erro desconhecido'}.`;
      mount(letterBox, h('div.split', { style: { marginTop: '16px' } }, again));
      return;
    }
    setTimeout(poll, 1500);
  };
  poll();
  paintHistory();

  return frag(
    head('Carta mensal', `${c.name} · perfil ${c.risk_profile} · ${money(d.total_value, { locale: L })} sob assessoria. O mês, o que aconteceu nos mercados e o que isso significa para esta carteira, em duas páginas.`,
      [h('a.btn', { href: `#/client/${id}` }, icon('back', { size: 15 }), h('span', { text: 'voltar ao cliente' }))],
      [h('b', { text: c.name }), sep(), 'Agente de cartas']),
    runBox, letterBox, history,
  );
}

// ═══ boot ══════════════════════════════════════════════════════════════════
(async function boot() {
  if (!(await auth.discover())) { location.href = loginUrl(); return; }
  try {
    ME = await api('/api/auth/me');
  } catch { location.href = loginUrl(); return; }
  if (ME.user.role === 'client') { location.href = clientUrl(); return; }
  try { CLIENTS = (await api('/api/advisor/clients')).clients; } catch { CLIENTS = []; }
  installSessionGuard();
  renderRail();

  ROUTER = router([
    ['/', viewOverview],
    ['/signals', viewSignals],
    ['/triggers', viewTriggers],
    ['/clients', viewClients],
    ['/client/:id', (p) => viewClient({ ...p, tab: 'overview' })],
    ['/client/:id/prep', viewMeetingPrep],
    ['/client/:id/editor', viewEditor],
    ['/client/:id/report/:reportId', viewReport],
    ['/client/:id/carta', viewMonthlyLetter],
    ['/client/:id/carta/:runId', viewMonthlyLetter],
    ['/client/:id/:tab', viewClient],
  ], { root });

  const syncNav = () => { setActive(rail, currentHash()); crumbs(crumbsFor(currentHash())); };
  window.addEventListener('hashchange', syncNav);
  syncNav();
})();
