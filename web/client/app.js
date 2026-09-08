/**
 * Client portal.
 *
 * Read-only by construction: the API refuses any write from a client session,
 * and this app never offers one. It shows exactly the content of the approved
 * letter, rendered from the same canonical report object, so the portal and
 * the PDF can never disagree.
 */
import {
  h, mount, frag, api, auth, logo, stat, table, router, setActive,
  money, percent, pp, weight, dateLong, shortDate, monthLabel, toneClass,
  barChart, allocationBar, lineChart, sourcesBlock,
  apiUrl, loginUrl, advisorUrl,
} from '../shared/ui.js';

const root = document.getElementById('root');
const rail = document.getElementById('rail');
const L = 'pt-BR';
let ME = null;
let CLIENT_ID = null;
let SUMMARY = null;

const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));

const CLASS_PT = {
  Cash: 'Caixa', 'Fixed Income': 'Renda fixa', 'Equities BR': 'Renda variável Brasil',
  'Equities Global': 'Renda variável global', Alternatives: 'Multimercado e alternativos',
  'Real Estate': 'Imobiliário listado', Commodities: 'Commodities', 'Digital Assets': 'Ativos digitais',
};
const cls = (k) => CLASS_PT[k] || k || '';

function renderRail() {
  mount(rail,
    h('a', { href: '#/' }, logo({ size: 24 })),
    h('nav.rail-nav', {},
      h('a', { href: '#/' }, h('span', { text: 'Minha carteira' })),
      h('a', { href: '#/month' }, h('span', { text: 'Último mês' })),
      h('a', { href: '#/matters' }, h('span', { text: 'O que importa' })),
      h('a', { href: '#/letter' }, h('span', { text: 'Carta do assessor' })),
      h('a', { href: '#/documents' }, h('span', { text: 'Documentos' }))),
    h('div.rail-foot', {},
      h('div', { text: ME?.user?.name || '' }),
      h('div', { style: { fontSize: '10.5px' }, text: SUMMARY?.advisor ? `assessor ${SUMMARY.advisor.code}` : '' }),
      h('button.btn.sm', { text: 'sair', onclick: async () => { await api('/api/auth/logout', {}); auth.clear(); location.href = loginUrl(); } })));
  setActive(rail, location.hash.replace(/^#/, '') || '/');
}

function head(title, sub) {
  return h('header.page-head', {}, h('div', {}, h('h1.page-title', { text: title }), sub && h('div.page-sub', { text: sub })));
}

async function latestPublished() {
  const list = await api(`/api/clients/${CLIENT_ID}/reports`);
  const published = list.reports.filter((r) => r.status === 'published');
  if (!published.length) return null;
  const full = await api(`/api/clients/${CLIENT_ID}/reports/${published[0].id}`);
  return { meta: published[0], canonical: full.report.canonical, links: full.report.links || published[0].links || {}, all: published };
}

function cumulative(returns) {
  let p = 1; let b = 1;
  const portfolio = []; const benchmark = [];
  for (const r of returns) {
    if (Number.isFinite(r.portfolio)) { p *= 1 + r.portfolio; portfolio.push({ label: r.month, value: p - 1 }); }
    if (Number.isFinite(r.benchmark)) { b *= 1 + r.benchmark; benchmark.push({ label: r.month, value: b - 1 }); }
  }
  return { portfolio, benchmark };
}

// ═══ my portfolio ══════════════════════════════════════════════════════════
async function viewPortfolio() {
  const d = SUMMARY;
  const holdings = await api(`/api/clients/${CLIENT_ID}/holdings`);
  const last = d.returns[d.returns.length - 1];

  return frag(
    head(`Olá, ${(d.client.name || '').split(' ')[0]}`,
      `Posição em ${dateLong(d.snapshot?.effective_date, L)} · perfil ${d.client.risk_profile} · política de investimentos versão ${d.policy?.version}`),

    h('div.grid.g3', { style: { marginBottom: '24px' } },
      stat('Patrimônio', money(d.total_value, { locale: L })),
      stat(last ? `Rentabilidade em ${monthLabel(last.month, L)}` : 'Rentabilidade', last ? percent(last.portfolio, { locale: L }) : '—', { tone: toneClass(last?.portfolio) }),
      stat('Carteira de referência', last?.benchmark != null ? percent(last.benchmark, { locale: L }) : '—', { tone: 'bench' })),

    h('div.grid.g2', {},
      h('div.card', {}, allocationBar(d.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })), {
        title: 'Como sua carteira está distribuída hoje',
        caption: `Composição aprovada na reunião de ${dateLong(d.snapshot?.effective_date, L)}`,
      })),
      h('div.card', {}, lineChart(cumulative(d.returns), {
        title: 'Retorno acumulado da sua carteira',
        caption: 'A linha escura é a sua carteira; a linha tracejada é a carteira de referência da sua política',
      }))),

    h('section.section', { style: { marginTop: '24px' } },
      h('div.section-h', {}, h('h2', { text: 'Suas posições' }), h('span.meta', { text: `${holdings.holdings.length} ativos` })),
      table(['Ativo', 'Classe', { label: 'Valor', num: true }, { label: 'Peso', num: true }],
        holdings.holdings.map((p) => h('tr', {},
          h('td', {}, h('span.name', { text: p.name }), p.ticker ? h('span.sub', { text: p.ticker }) : null),
          h('td', { text: cls(p.asset_class) }),
          h('td.num', { text: money(p.market_value, { locale: L }) }),
          h('td.num', { text: weight(p.weight, { locale: L }) }))))),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Sua política de investimentos' }), h('span.meta', { text: `vigente desde ${dateLong(d.policy?.effective_date, L)}` })),
      h('div.card', {},
        h('div.grid.g2', {},
          h('div', {}, h('div.rail-h', { text: 'Objetivos' }), h('p.note', { text: d.policy?.objectives })),
          h('div', {}, h('div.rail-h', { text: 'Horizonte e liquidez' }), h('p.note', { text: `${d.policy?.investment_horizon}. ${d.policy?.liquidity_requirements}` }))),
        h('div', { style: { marginTop: '16px' } },
          h('div.rail-h', { text: 'Faixas acordadas por classe de ativo' }),
          table(['Classe', { label: 'Peso atual', num: true }, { label: 'Alvo', num: true }, 'Faixa acordada', ''],
            d.allocation.map((a) => h('tr', {},
              h('td.name', { text: cls(a.asset_class) }),
              h('td.num', { text: weight(a.weight, { locale: L }) }),
              h('td.num.muted', { text: a.target == null ? '—' : weight(a.target, { locale: L, decimals: 0 }) }),
              h('td.muted', { text: a.range ? `${weight(a.range.min, { locale: L, decimals: 0 })} a ${weight(a.range.max, { locale: L, decimals: 0 })}` : '—' }),
              h('td', {}, a.inside_band ? h('span.chip', { text: 'dentro da faixa' }) : h('span.chip.warn', { text: 'fora da faixa' }))))))),
      h('p.note', { style: { marginTop: '12px' }, text: 'Alterações na carteira e na política acontecem apenas em reunião com o seu assessor. Nada muda automaticamente por causa de um movimento de mercado.' })),
  );
}

// ═══ last month ════════════════════════════════════════════════════════════
async function viewMonth() {
  const r = await latestPublished();
  if (!r) return notPublished();
  const c = r.canonical;
  const perf = c.portfolio_performance;
  const at = c.performance_attribution;
  const bench = c.benchmark;
  const excess = bench?.comparison?.excess_return;

  const classItems = (at?.by_asset_class || []).map((x) => ({ label: cls(x.asset_class), value: x.contribution }));
  const posItems = [...(at?.top_negative || []), ...(at?.top_positive || [])]
    .map((x) => ({ label: x.ticker || x.name, value: x.contribution }))
    .sort((a, b) => b.value - a.value);

  return frag(
    head(`Seu mês em ${monthLabel(c.reporting_period?.month, L)}`, `Apurado em ${dateLong(c.reporting_period?.end, L)} · moeda ${c.client?.base_currency}`),

    h('div.grid.g4', { style: { marginBottom: '20px' } },
      stat('Rentabilidade', percent(perf?.monthly_return, { locale: L }), { tone: toneClass(perf?.monthly_return) }),
      stat('Resultado', money(perf?.absolute_pnl, { locale: L, signed: true }), { tone: toneClass(perf?.absolute_pnl) }),
      stat('Carteira de referência', bench?.value == null ? '—' : percent(bench.value, { locale: L }), { tone: 'bench' }),
      stat('Diferença', excess == null ? '—' : pp(excess, { locale: L }), { tone: toneClass(excess) })),

    h('div.card', { style: { marginBottom: '20px' } },
      h('p.serif', { style: { fontSize: '16px' }, text: c.letter?.performance || '' })),

    h('div.grid.g2', {},
      h('div.card', {}, barChart(classItems, {
        title: 'De onde veio o resultado, por classe de ativo',
        caption: `Em pontos percentuais do retorno da carteira · período ${c.reporting_period?.start} a ${c.reporting_period?.end}`,
      })),
      h('div.card', {}, barChart(posItems, {
        title: 'Ativos que mais influenciaram o mês',
        caption: 'Três maiores contribuições positivas e negativas',
      }))),

    at?.fx_contribution ? h('div.hint', { style: { marginTop: '20px' } },
      h('b', { text: 'Efeito do câmbio: ' }),
      `${pp(at.fx_contribution, { locale: L })} do resultado do mês veio da variação do dólar sobre as posições no exterior, e não do desempenho dos ativos em si.`) : null,

    h('div.hint', { style: { marginTop: '16px' } }, h('b', { text: 'Como calculamos: ' }), perf?.method_note?.pt || ''),

    (c.data_quality?.unavailable || []).length ? h('div.card', { style: { marginTop: '20px' } },
      h('div.card-h', {}, h('h3', { text: 'Informações que não pudemos apurar' })),
      table(['Item', 'Motivo'], c.data_quality.unavailable.map((u) => h('tr', {}, h('td.name', { text: u.item }), h('td', { text: u.reason })))),
      h('p.note', { style: { marginTop: '10px' }, text: 'Preferimos dizer que um dado não estava disponível a estimar um número.' })) : null,

    h('div.card', { style: { marginTop: '20px' } }, sourcesBlock(c.sources, 'De onde vêm estes números')),
  );
}

// ═══ what matters ══════════════════════════════════════════════════════════
async function viewMatters() {
  const r = await latestPublished();
  if (!r) return notPublished();
  const c = r.canonical;
  const impacts = (c.portfolio_impact || []).filter((i) => i.relevance === 'high' || i.relevance === 'medium');

  return frag(
    head('O que importa para a sua carteira', `Eventos do período de ${monthLabel(c.reporting_period?.month, L)} com efeito sobre o que você tem hoje`),
    h('div.card', { style: { marginBottom: '20px' } },
      h('p.serif', { style: { fontSize: '16px' }, text: c.letter?.markets || '' }),
      h('p.serif', { style: { fontSize: '16px', marginTop: '12px' }, text: c.letter?.meaning || '' })),

    impacts.length ? h('div.stack', {}, impacts.map((i) => h('div.card', {},
      h('div.card-h', {},
        h('h3', { text: i.title_pt || i.title }),
        h('span.meta', { text: i.exposure?.total_exposure ? `exposição ${weight(i.exposure.total_exposure, { locale: L, decimals: 1 })}` : '' })),
      h('p.note', { text: i.potential_impact_pt || i.potential_impact }),
      i.exposure?.asset_classes?.length ? h('div.split', { style: { marginTop: '10px' } },
        i.exposure.asset_classes.map((a) => h('span.chip', { text: `${cls(a.asset_class)} ${weight(a.weight, { locale: L, decimals: 1 })}` }))) : null)))
      : h('div.empty', { text: 'Nenhum evento do período teve efeito material sobre as classes de ativo da sua carteira.' }),

    h('p.note', { style: { marginTop: '18px' }, text: 'Esta seção descreve o que aconteceu no mercado e como isso se relaciona com a sua carteira. Ela não é uma recomendação de compra ou venda.' }),
  );
}

// ═══ advisor letter ════════════════════════════════════════════════════════
async function viewLetter() {
  const r = await latestPublished();
  if (!r) return notPublished();
  const c = r.canonical;
  const letter = c.letter || {};
  const recs = c.recommendations || [];

  return frag(
    head(`Carta de ${monthLabel(c.reporting_period?.month, L)}`, `De ${c.advisor?.name} · publicada em ${shortDate(r.meta.published_at)}`),
    h('div.page-actions', { style: { marginBottom: '20px' } },
      h('a.btn.primary', { href: apiUrl(r.links.pdf || `/api/reports/${r.meta.id}/pdf`), target: '_blank', text: 'baixar em pdf' }),
      h('a.btn', { href: apiUrl(r.links.portal || `/api/reports/${r.meta.id}/portal`), target: '_blank', text: 'ver a carta formatada' })),

    h('article.card', {},
      h('p.serif', { style: { fontSize: '17px' }, text: letter.greeting || '' }),
      ['opening', 'performance', 'markets', 'meaning'].map((k) => letter[k] && h('p.serif', { style: { fontSize: '16px' }, text: letter[k] })),
      recs.length ? frag(
        h('h3', { style: { margin: '22px 0 10px' }, text: 'O que sugiro discutirmos' }),
        h('p.serif', { style: { fontSize: '16px' }, text: letter.recommendations_intro || '' }),
        table(['Ativo', 'Sugestão', 'Sinais de mercado', 'Enquadramento na sua política'],
          recs.map((x) => h('tr', {},
            h('td', {}, h('span.name', { text: x.ticker || x.name }), h('span.sub', { text: `${cls(x.asset_class)} · ${weight(x.current_weight, { locale: L, decimals: 1 })} da carteira` })),
            h('td', {}, h('span', { class: `chip ${String(x.final_action).toLowerCase()}`, text: actionLabel(x.final_action) })),
            h('td', {}, h('div.sig-pair', {},
              h('span', {}, h('b', { text: 'Técnico: ' }), x.technical_signal ? signalPt(x.technical_signal) : h('span.sig-na', { text: 'sem cobertura' })),
              h('span', {}, h('b', { text: 'Analistas: ' }), x.analyst_signal ? `${signalPt(x.analyst_signal)} (${x.analyst_count})` : h('span.sig-na', { text: 'sem consenso disponível' })))),
            h('td', { class: x.suitability_result === 'PASS' ? '' : 'caution', text: suitabilityPt(x.suitability_result) })))),
        recs.some((x) => x.rationale_pt) ? h('div', { style: { marginTop: '12px' } },
          recs.filter((x) => x.rationale_pt).map((x) => h('p.note', {}, h('b', { text: `${x.ticker || x.name}: ` }), x.rationale_pt))) : null,
        h('p.note', { style: { marginTop: '12px' }, text: 'São pontos para conversarmos na próxima reunião. Nenhuma operação é executada automaticamente.' })) : null,
      letter.closing ? h('p.serif', { style: { fontSize: '16px', marginTop: '20px' }, text: letter.closing }) : null,
      h('p.serif', { style: { fontSize: '16px', marginTop: '16px' }, text: letter.sign_off || '' }),
      h('div', { style: { marginTop: '8px' } },
        h('div', { style: { fontWeight: 600 }, text: c.advisor?.name || '' }),
        h('div.note', { text: `Enter Asset Management${c.advisor?.code ? ` · ${c.advisor.code}` : ''}` }))),

    h('div.card', { style: { marginTop: '20px' } }, sourcesBlock(c.sources, 'Fontes usadas nesta carta')),
    h('div.disclosure', {}, (c.disclosures || []).map((x) => h('p', { text: x }))),
  );
}

const actionLabel = (a) => ({ ADD: 'Aumentar', HOLD: 'Manter', REDUCE: 'Reduzir', EXIT: 'Encerrar', DISCUSS: 'Discutir' }[a] || a);
const signalPt = (s) => ({ 'Strong Buy': 'Compra forte', Buy: 'Compra', Neutral: 'Neutro', Sell: 'Venda', 'Strong Sell': 'Venda forte' }[s] || s);
const suitabilityPt = (s) => ({
  PASS: 'Dentro da política', DISCUSS_ONLY: 'Somente discussão', DO_NOT_ADD: 'Não aumentar',
  REDUCE_REQUIRED: 'Redução necessária', BLOCKED: 'Vedado pela política',
}[s] || s);

// ═══ documents ═════════════════════════════════════════════════════════════
async function viewDocuments() {
  const list = await api(`/api/clients/${CLIENT_ID}/reports`);
  const published = list.reports.filter((r) => r.status === 'published');
  return frag(
    head('Documentos', 'Suas cartas mensais. Cada uma é o documento exato que foi publicado, sem alterações posteriores.'),
    published.length
      ? table(['Mês', 'Publicada em', { label: 'Páginas', num: true }, 'Formatos'],
        published.map((r) => h('tr', {},
          h('td.name', { text: monthLabel(r.reporting_month, L) }),
          h('td', { text: shortDate(r.published_at) }),
          h('td.num', { text: r.page_count ?? '—' }),
          h('td', {}, h('div.split', {},
            h('a.btn.sm', { href: apiUrl(r.links?.pdf || `/api/reports/${r.id}/pdf`), target: '_blank', text: 'pdf' }),
            h('a.btn.sm', { href: apiUrl(r.links?.portal || `/api/reports/${r.id}/portal`), target: '_blank', text: 'carta' }))))))
      : h('div.empty', { text: 'Nenhuma carta publicada ainda.' }),
  );
}

function notPublished() {
  return h('div.empty', {},
    h('p', { text: 'Sua carta deste mês ainda não foi publicada pelo seu assessor.' }),
    h('p.note', { text: 'Assim que ele revisar e aprovar o conteúdo, ela aparece aqui e no seu e-mail.' }));
}

// ═══ boot ══════════════════════════════════════════════════════════════════
(async function boot() {
  try { ME = await api('/api/auth/me'); } catch { location.href = loginUrl(); return; }
  if (ME.user.role !== 'client') { location.href = advisorUrl(); return; }
  CLIENT_ID = ME.client_id;
  SUMMARY = await api(`/api/clients/${CLIENT_ID}`);
  renderRail();

  router([
    ['/', viewPortfolio],
    ['/month', viewMonth],
    ['/matters', viewMatters],
    ['/letter', viewLetter],
    ['/documents', viewDocuments],
  ], { root });

  window.addEventListener('hashchange', () => setActive(rail, location.hash.replace(/^#/, '') || '/'));
})();
