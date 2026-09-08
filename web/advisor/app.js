/**
 * Advisor portal.
 *
 * The landing page answers the advisor's first question of the day: what
 * matters in markets, and which of my clients could be affected. Everything
 * else hangs off a client.
 */
import {
  h, mount, frag, api, auth, stat, table, router, setActive,
  pageHead, railBrand, navItem, railFoot, icon, greeting, installSessionGuard, dateWithWeekday,
  money, percent, pp, weight, dateLong, shortDate, monthLabel, toneClass,
  barChart, allocationBar, bandChart, lineChart, sourcesBlock, sourceLine,
  apiUrl, loginUrl, clientUrl,
} from '../shared/ui.js';

const root = document.getElementById('root');
const rail = document.getElementById('rail');
const L = 'pt-BR';
let ME = null;
let CLIENTS = [];

const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Asset-class keys are English in the data model; the portal reads Portuguese. */
const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
  Other: 'Outros',
};
const cls = (k) => CLASS_PT[k] || k || '';

/** Indicator groups come from the data model in English. */
const GROUP_PT = {
  equities: 'Ações', 'rates & credit': 'Juros e crédito', 'rates and credit': 'Juros e crédito',
  'fx & commodities': 'Câmbio e commodities', 'fx and commodities': 'Câmbio e commodities',
  'digital assets': 'Ativos digitais', crypto: 'Ativos digitais', other: 'Outros', outros: 'Outros',
};
const groupPt = (g) => GROUP_PT[String(g || '').toLowerCase()] || g || 'Outros';

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

// ═══ world overview ════════════════════════════════════════════════════════
async function viewOverview() {
  const o = await api('/api/advisor/overview');
  const wv = o.world_view;
  const briefing = wv?.briefing?.briefing || {};
  const stance = wv?.stance || {};
  const generatedByModel = wv?.briefing?.mode === 'model';

  const briefingBlocks = [
    ['Ações', briefing.equities],
    ['Juros e crédito', briefing.rates_credit],
    ['Câmbio e commodities', briefing.fx_commodities],
    ['Macro e política', briefing.macro_political],
    ['Principal risco ou oportunidade', briefing.main_risk_or_opportunity],
  ].filter(([, v]) => v);

  const indicatorGroups = {};
  for (const i of o.indicators) (indicatorGroups[i.group || 'Outros'] ||= []).push(i);
  const breached = o.triggers.filter((t) => t.status === 'BREACHED').length;

  return frag(
    head(`${greeting()}, ${(ME?.user?.name || '').split(' ')[0]}`,
      `${o.clients_count} clientes sob sua responsabilidade. O que aconteceu nos mercados, e quais carteiras isso toca.`,
      [h('button.btn', { onclick: async (e) => { const b = e.currentTarget; b.disabled = true; b.lastChild.textContent = 'atualizando…'; await api('/api/advisor/overview?refresh=1'); location.reload(); } },
        icon('refresh', { size: 15 }), h('span', { text: 'atualizar dados de mercado' }))],
      [h('b', { text: 'Panorama do dia' }), sep(), dateWithWeekday(o.date, L)]),

    h('div.grid.g4', { style: { marginBottom: '48px' } },
      stat('Sob assessoria', money(CLIENTS.reduce((a, c) => a + (c.portfolio_value || 0), 0), { locale: L }), { sub: `${o.clients_count} carteiras` }),
      stat('Eventos que importam hoje', String(o.what_matters.length), { sub: 'com impacto mapeado sobre as carteiras' }),
      stat('Gatilhos acionados', String(breached), { tone: breached ? 'caution' : '', sub: `de ${o.triggers.length} limiares monitorados` }),
      stat('Desvios de alocação', String(o.drift_alerts.length), { tone: o.drift_alerts.length ? 'caution' : '', sub: 'contra a política aprovada' })),

    // ── the briefing ────────────────────────────────────────────────────
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Resumo do dia' }),
        h('span.meta', {}, generatedByModel ? `gerado por ${wv.briefing.model}` : 'gerado sem modelo de linguagem — texto determinístico', ' · ',
          h('span', { class: wv?.approval_status === 'approved' ? 'gain' : 'caution', text: wv?.approval_status === 'approved' ? 'aprovado' : 'rascunho' }))),
      h('div.card', {},
        wv?.generated_summary ? h('p.pull', { style: { marginBottom: '24px' }, text: wv.generated_summary }) : null,
        h('div.grid.g2', {}, briefingBlocks.map(([k, v]) => h('div', {},
          h('div.rail-h', { text: k }),
          h('p.note', { text: v })))),
        h('p.note', { style: { marginTop: '14px' } },
          'Este resumo é construído a partir dos dados recuperados agora, não da memória de um modelo. ',
          'Cada número acima vem de um provedor identificado abaixo.'),
        sourcesBlock(o.sources, 'Ver fontes dos indicadores'))),

    // ── indicators ──────────────────────────────────────────────────────
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Indicadores monitorados' }), h('span.meta', { text: 'variação no mês corrente' })),
      Object.entries(indicatorGroups).map(([group, items]) => h('div.strip-group', {},
        h('div.kicker', { text: groupPt(group) }),
        h('div.strip', {}, items.map((i) => i.unavailable
          ? h('div.cell.na', {}, h('span.k', { text: i.label }), h('span.v', { text: 'DATA UNAVAILABLE' }), h('span.c.muted', { text: i.reason?.slice(0, 40) || '' }))
          : h('div.cell', { title: i.source ? sourceLine(i.source) : '' },
            h('span.k', { text: i.label }),
            h('span.v', { text: formatIndicator(i) }),
            h('span.c', { class: toneClass(i.mtdPct), text: i.mtdPct == null ? (i.asOf || '') : `${percent(i.mtdPct, { locale: L, decimals: 1 })} no mês` }))))))),

    // ── what matters ────────────────────────────────────────────────────
    h('section.section', {},
      h('div.board', {},
        h('div.board-h', {}, h('h2', { text: 'O que importa hoje' }),
          h('span.meta', { text: `${o.what_matters.length} eventos · impacto mapeado sobre ${o.clients_count} carteiras` })),
        h('div.tw', {},
          h('table', {},
            h('thead', {}, h('tr', {}, ['Evento', 'Movimento', 'Por que importa', 'Exposição na sua carteira', 'Conversa sugerida'].map((t) => h('th', { text: t })))),
            h('tbody', {}, o.what_matters.map((r) => h('tr', {},
              h('td', { style: { minWidth: '210px' } },
                h('span.ev', {}, h('i', { class: `imp ${r.importance}` }), r.event_pt || r.event),
                h('span.src', { text: `${r.date}${r.source_label ? ` · ${r.source_label}` : ''}` })),
              h('td', {}, r.current_move ? moveCell(r.current_move) : h('span.muted', { text: '—' })),
              h('td', { style: { minWidth: '260px', maxWidth: '360px' }, text: r.why_it_matters_pt || r.why_it_matters }),
              h('td', { style: { minWidth: '160px' } },
                h('span.exposure', { text: r.exposure_summary.max_exposure ? weight(r.exposure_summary.max_exposure, { locale: L, decimals: 1 }) : '—' }),
                h('span.clients', { text: r.per_client.slice(0, 3).map((c) => c.client_name.split(' ')[0]).join(', ') + (r.per_client.length > 3 ? ` +${r.per_client.length - 3}` : '') })),
              h('td.action', { style: { minWidth: '240px', maxWidth: '320px' }, text: r.advisor_action_pt || r.advisor_action }))))))),
      h('p.note', { style: { marginTop: '10px' }, text: 'Cada linha é um ponto de conversa, não uma ordem. Nenhuma operação é executada a partir desta tela.' })),

    // ── triggers + drift ────────────────────────────────────────────────
    h('div.grid.g2', {},
      h('section.card', {},
        h('div.card-h', {}, h('h3', { text: 'Gatilhos de mercado' }),
          h('span.meta', { text: `${o.triggers.filter((t) => t.status === 'BREACHED').length} acionados` })),
        h('div', {}, o.triggers.slice().sort(triggerOrder).map((t) => h('div.trg', {},
          h('span', { class: `dot ${t.status}` }),
          h('div', {},
            h('div.lab', { text: t.label }),
            h('div.det', { text: t.status === 'NO_DATA' ? (t.reason || 'indicador indisponível') : (t.affected_clients?.length ? `${t.affected_clients.length} cliente(s) expostos · ${t.action_pt || t.action || ''}` : (t.action_pt || t.action || '')) })),
          h('span.obs', { class: t.status === 'BREACHED' ? 'caution' : '', text: t.observed == null ? '—' : `${num(t.observed, 2)} / ${num(t.threshold, 2)}` }))))),

      h('section.card', {},
        h('div.card-h', {}, h('h3', { text: 'Desvios de alocação' }), h('span.meta', { text: 'contra a política aprovada' })),
        o.drift_alerts.length
          ? h('div', {}, o.drift_alerts.map((d) => h('div.trg', {},
            h('span.dot.BREACHED'),
            h('div', {}, h('div.lab', {}, h('a', { href: `#/client/${d.client_id}`, text: d.client_name })), h('div.det', { text: d.action_pt || d.action })),
            h('span.obs.caution', { text: pp(d.drift, { locale: L }) }))))
          : h('div.empty', { text: 'Nenhuma carteira fora do gatilho de rebalanceamento.' }))),
  );
}

function triggerOrder(a, b) {
  const rank = { BREACHED: 0, APPROACHING: 1, ARMED: 2, NO_DATA: 3 };
  return rank[a.status] - rank[b.status];
}

function formatIndicator(i) {
  if (i.price == null) return '—';
  if (['%', '% a.a.', '% a.m.'].includes(i.unit)) return `${num(i.price, 2)}%`;
  if (i.unit === 'USD' || i.unit === 'USD/oz') return `US$ ${num(i.price, 0)}`;
  if (i.unit === 'USD/bbl' || i.unit === 'USD/lb') return `US$ ${num(i.price, 2)}`;
  if (i.unit === 'BRL') return `R$ ${num(i.price, 4)}`;
  return num(i.price, i.price > 1000 ? 0 : 2);
}

function moveCell(m) {
  if (m.label) return h('span.move', { text: m.label });
  if (m.unavailable) return h('span.muted', { text: 'DATA UNAVAILABLE' });
  const pctv = m.mtdPct ?? m.changePct;
  return h('div', {},
    h('span', { class: `move ${pctv > 0 ? 'up' : pctv < 0 ? 'down' : ''}`, text: pctv == null ? '—' : percent(pctv, { locale: L, decimals: 1 }) }),
    h('span.lvl', { text: `${m.value != null ? num(m.value, m.value > 1000 ? 0 : 2) : '—'}${m.unit && !['index', 'price'].includes(m.unit) ? ` ${m.unit}` : ''}${m.asOf ? ` · ${m.asOf}` : ''}` }));
}

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

    h('div.hint', { style: { marginBottom: '20px' } },
      'As duas famílias de sinal são capturadas de forma independente e nunca combinadas. ',
      'Um técnico de venda ao lado de um consenso de compra é uma discordância real e é exatamente o que vale levar para a reunião. ',
      'Onde não existe cobertura de analistas, o campo diz isso — o sinal técnico nunca é usado para inferir sentimento de analistas.'),

    conflicts.length ? h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Divergências entre as duas famílias' }), h('span.meta', { text: 'prioridade de conversa' })),
      table(headers, body(conflicts))) : null,

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Universo monitorado' })),
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
        h('td.num', { text: money(c.portfolio_value, { locale: L }) }),
        h('td.num', { class: toneClass(c.last_month?.portfolio_return), text: c.last_month ? percent(c.last_month.portfolio_return, { locale: L }) : '—' }),
        h('td.num.bench', { text: c.last_month?.benchmark_return != null ? percent(c.last_month.benchmark_return, { locale: L }) : '—' }),
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
  ['overview', 'Visão geral'], ['performance', 'Rentabilidade'], ['portfolio', 'Alocação'],
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
  return frag(
    head(c.name, `${money(d.total_value, { locale: L })} sob assessoria · política v${d.policy?.version} de ${dateLong(d.policy?.effective_date, L)}${c.next_review_at ? ` · próxima revisão ${shortDate(c.next_review_at)}` : ''}`, [
      h('a.btn', { href: `#/client/${id}/prep` }, icon('prep', { size: 15 }), h('span', { text: 'preparar reunião' })),
      h('a.btn.primary', { href: `#/client/${id}/editor` }, icon('edit', { size: 15 }), h('span', { text: 'editar carteira' })),
    ], [h('b', { text: 'Cliente' }), sep(), `perfil ${c.risk_profile}`, c.segment ? sep() : null, c.segment || null]),
    tabsEl,
    body);
}

async function renderClientTab(tab, id, d) {
  switch (tab) {
    case 'performance': return tabPerformance(id, d);
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

async function tabOverview(id, d) {
  const last = d.returns[d.returns.length - 1];
  const series = cumulativeSeries(d.returns);
  return frag(
    h('div.grid.g4', { style: { marginBottom: '24px' } },
      stat('Patrimônio', money(d.total_value, { locale: L })),
      stat(`Rentabilidade em ${last ? monthLabel(last.month, L) : '—'}`, last ? percent(last.portfolio, { locale: L }) : '—', { tone: toneClass(last?.portfolio) }),
      stat('Carteira de referência', last?.benchmark != null ? percent(last.benchmark, { locale: L }) : '—', { tone: 'bench' }),
      stat('Perfil de risco', d.client.risk_profile, { small: true, sub: `próxima revisão ${d.client.next_review_at ? shortDate(d.client.next_review_at) : '—'}` })),
    h('div.grid.g2', {},
      h('div.card', {}, lineChart(series, {
        title: 'Retorno acumulado desde o início do histórico',
        caption: `Base: retornos mensais compostos · moeda ${d.client.base_currency} · a linha da carteira é a mais escura; a referência é tracejada em azul`,
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
        stat('Índice de Sharpe', metrics.sharpe_ratio == null ? 'indisponível' : num(metrics.sharpe_ratio, 2), { small: true, sub: metrics.risk_free?.name ? `contra o ${metrics.risk_free.name}` : metrics.risk_free?.reason }),
        stat('Máximo drawdown', percent(metrics.max_drawdown, { locale: L }), { small: true, tone: 'loss', sub: metrics.max_drawdown_window ? `${metrics.max_drawdown_window.peak_month} → ${metrics.max_drawdown_window.trough_month}` : null }),
        stat('Retorno em 3 anos', metrics.three_year_available ? percent(metrics.three_year_return, { locale: L }) : 'histórico insuficiente', { small: true, sub: metrics.three_year_note })),
      h('p.note', { style: { marginTop: '12px' }, text: 'Estas são medidas históricas calculadas a partir do histórico de retornos. Não são expectativas nem projeções, e não devem ser apresentadas ao cliente como tal.' })) : null,

    sourcesBlock(p.sources || perf.sources, 'Ver fontes desta apuração'),
  );
}

async function tabPortfolio(id, d) {
  return frag(
    h('div.grid.g2', {},
      h('div.card', {}, allocationBar(d.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })), { title: 'Composição atual' })),
      h('div.card', {}, bandChart(d.allocation.map((a) => ({ ...a, asset_class: cls(a.asset_class) })), { title: 'Enquadramento nas faixas da política' }))),
    h('section.section', { style: { marginTop: '24px' } },
      h('div.section-h', {}, h('h2', { text: 'Alocação por classe' }), h('span.meta', { text: `snapshot ${d.snapshot?.id} · ${dateLong(d.snapshot?.effective_date, L)}` })),
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
      h('div.section-h', {}, h('h2', { text: 'Posições' }), h('span.meta', { text: `${d.holdings.length} linhas · total ${money(d.total_value, { locale: L })}` })),
      table(['Ativo', 'Classe', { label: 'Quantidade', num: true }, { label: 'Preço', num: true }, { label: 'Valor', num: true }, { label: 'Peso', num: true }, { label: 'Resultado', num: true }, 'Precificação', 'Liquidez'],
        d.holdings.map((p) => h('tr', {},
          h('td', {}, h('span.name', { text: p.ticker || p.name }),
            h('span.sub', { text: p.ticker ? p.name : (p.isin || '') }),
            p.corporate_action ? h('span.sub.caution', { text: p.corporate_action }) : null,
            p.notes ? h('span.sub', { text: p.notes }) : null),
          h('td', { text: cls(p.asset_class) }),
          h('td.num', { text: p.quantity == null ? '—' : num(p.quantity, p.quantity < 100 ? 4 : 0) }),
          h('td.num', { text: p.price == null ? '—' : num(p.price, 2) }),
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

const actionLabel = (a) => ({ ADD: 'Aumentar', HOLD: 'Manter', REDUCE: 'Reduzir', EXIT: 'Encerrar', DISCUSS: 'Discutir' }[a] || a);
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

async function tabReports(id) {
  const d = await api(`/api/clients/${id}/reports`);
  if (!d.reports.length) return h('div.empty', { text: 'Nenhuma carta gerada. Rode o workflow Rivet para este cliente.' });
  return frag(
    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Cartas mensais' })),
      table(['Mês', 'Status', { label: 'Páginas', num: true }, 'Aprovada', 'Publicada', 'Formatos'],
        d.reports.map((r) => h('tr', {},
          h('td.name', {}, h('a', { href: `#/client/${id}/report/${r.id}`, text: monthLabel(r.reporting_month, L) })),
          h('td', {}, reportChip(r.status)),
          h('td.num', { text: r.page_count ?? '—' }),
          h('td', { text: r.approved_at ? shortDate(r.approved_at) : '—' }),
          h('td', { text: r.published_at ? shortDate(r.published_at) : '—' }),
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
      h('div.card', {}, h('div.card-h', {}, h('h3', { text: 'Posição atual' }), h('span.meta', { text: money(p.total_value, { locale: L }) })),
        allocationBar(p.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })), {})),
      h('div.card', {}, h('div.card-h', {}, h('h3', { text: 'Enquadramento' })),
        bandChart(p.allocation.map((a) => ({ ...a, asset_class: cls(a.asset_class) })), {}))),

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
    await api(`/api/clients/${id}/reports/${reportId}/${action}`, {});
    location.reload();
  };

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
        h('div.card-h', {}, h('h3', { text: 'Texto da carta' }), h('span.meta', { text: c.locale })),
        Object.entries(letter).filter(([k]) => k !== 'language').map(([k, v]) => h('div', { style: { marginBottom: '12px' } },
          h('div.rail-h', { text: k.replace(/_/g, ' ') }),
          h('p.serif', { style: { fontSize: '15px', color: 'var(--ink-700)' }, text: v })))),
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
          table(['Ativo', 'Ação', 'Enquadramento'],
            (c.recommendations || []).map((r) => h('tr', {},
              h('td.name', { text: r.ticker || r.name }),
              h('td', {}, h('span', { class: `chip ${String(r.final_action).toLowerCase()}`, text: actionLabel(r.final_action) })),
              h('td', { class: r.suitability_result === 'PASS' ? '' : 'caution', text: suitabilityLabel(r.suitability_result) }))))))),
    (c.data_quality?.unavailable || []).length ? h('div.card', { style: { marginTop: '16px' } },
      h('div.card-h', {}, h('h3', { text: 'Dados indisponíveis divulgados na carta' })),
      table(['Item', 'Motivo'], c.data_quality.unavailable.map((u) => h('tr', {}, h('td.name', { text: u.item }), h('td', { text: u.reason }))))) : null,
    h('div.card', { style: { marginTop: '16px' } }, sourcesBlock(c.sources, 'Fontes usadas nesta carta')),
    h('div.disclosure', {}, (c.disclosures || []).map((x) => h('p', { text: x }))),
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

  router([
    ['/', viewOverview],
    ['/signals', viewSignals],
    ['/triggers', viewTriggers],
    ['/clients', viewClients],
    ['/client/:id', (p) => viewClient({ ...p, tab: 'overview' })],
    ['/client/:id/prep', viewMeetingPrep],
    ['/client/:id/editor', viewEditor],
    ['/client/:id/report/:reportId', viewReport],
    ['/client/:id/:tab', viewClient],
  ], { root });

  window.addEventListener('hashchange', () => setActive(rail, location.hash.replace(/^#/, '') || '/'));
})();
