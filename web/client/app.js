/**
 * Client portal.
 *
 * Read-only by construction: the API refuses any write from a client session,
 * and this app never offers one. It shows exactly the content of the approved
 * letter, rendered from the same canonical report object, so the portal and
 * the PDF can never disagree.
 */
import {
  h, mount, frag, api, auth, stat, table, router, setActive,
  pageHead, railBrand, navItem, railFoot, icon, greeting, installSessionGuard, crumbs,
  money, percent, pp, weight, dateLong, shortDate, monthLabel, toneClass,
  barChart, allocationBar, bandChart, lineChart, sourcesBlock,
  apiUrl, loginUrl, advisorUrl,
} from '../shared/ui.js';
import { briefingSection, indicatorsSection } from '../shared/overview.js';

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
  const adv = SUMMARY?.advisor;
  const logout = () => auth.logout();
  mount(rail,
    railBrand('Meus investimentos'),
    h('nav.rail-nav', {},
      navItem({ href: '#/', icon: 'portfolio', label: 'Minha carteira' }),
      navItem({ href: '#/month', icon: 'month', label: 'Último mês' }),
      navItem({ href: '#/matters', icon: 'matters', label: 'O que importa' }),
      navItem({ href: '#/letter', icon: 'letter', label: 'Carta do assessor' }),
      navItem({ href: '#/documents', icon: 'documents', label: 'Documentos' })),
    railFoot({ name: ME?.user?.name || '', sub: adv ? `assessor ${adv.name || adv.code}` : '', onLogout: logout }));
  setActive(rail, location.hash.replace(/^#/, '') || '/');
}

const sep = () => h('span.sep', { text: '·' });
function head(title, sub, actions, kicker) {
  return pageHead({ title, sub, actions, kicker });
}

const PAGES = { '/': 'Minha carteira', '/month': 'Último mês', '/matters': 'O que importa', '/letter': 'Carta do assessor', '/documents': 'Documentos' };
const currentHash = () => location.hash.replace(/^#/, '') || '/';
const crumbsFor = (hash) => [{ label: 'Meus investimentos', href: '#/' }, { label: PAGES[hash] || 'Página não encontrada' }];

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
  // The day's briefing and the indicators are the advisor's, read here as they
  // were produced: the client cannot start a run or generate a document.
  const [holdings, ov] = await Promise.all([api(`/api/clients/${CLIENT_ID}/holdings`), api(`/api/clients/${CLIENT_ID}/overview`)]);
  const last = d.returns[d.returns.length - 1];

  return frag(
    head(`${greeting()}, ${(d.client.name || '').split(' ')[0]}`,
      `Perfil ${d.client.risk_profile} · política de investimentos versão ${d.policy?.version}${SUMMARY?.advisor?.name ? ` · seu assessor é ${SUMMARY.advisor.name}` : ''}`,
      null, [h('b', { text: 'Minha carteira' }), sep(), `posição em ${dateLong(d.snapshot?.effective_date, L)}`]),

    h('div.grid.g3', { style: { marginBottom: '32px' } },
      stat('Patrimônio', money(d.total_value, { locale: L }), { hero: true }),
      stat(last ? `Rentabilidade em ${monthLabel(last.month, L)}` : 'Rentabilidade', last ? percent(last.portfolio, { locale: L }) : '—', { hero: true, tone: toneClass(last?.portfolio) }),
      stat('Carteira de referência', last?.benchmark != null ? percent(last.benchmark, { locale: L }) : '—', { hero: true, tone: 'bench', sub: 'a referência da sua política, no mesmo mês' })),

    h('div.grid.g2', {},
      h('div.card', {}, allocationBar(d.allocation.map((a) => ({ label: cls(a.asset_class), weight: a.weight })), {
        title: 'Como sua carteira está distribuída hoje',
        caption: `Composição aprovada na reunião de ${dateLong(d.snapshot?.effective_date, L)}`,
      })),
      h('div.card', {}, lineChart(cumulative(d.returns), {
        title: 'Retorno acumulado da sua carteira',
        caption: 'A linha escura é a sua carteira; a linha tracejada é a carteira de referência da sua política',
      }))),

    // ── the day's briefing, as the advisor's agents wrote it ──────────────
    h('div', { style: { marginTop: '32px' } },
      ov.pending
        ? h('section.section', {},
          h('div.section-h', {}, h('h2', { text: 'Resumo do dia' })),
          h('div.empty', { text: 'O panorama do dia ainda não foi montado pelo seu assessor. Ele aparece aqui assim que os agentes rodarem.' }))
        : briefingSection(ov, { workflowStatus: false })),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Suas posições' }), h('span.meta', { text: `${holdings.holdings.length} ativos` })),
      table(['Ativo', 'Classe', { label: 'Valor', num: true }, { label: 'Peso', num: true }],
        holdings.holdings.map((p) => h('tr', {},
          h('td', {}, h('span.name', { text: p.name }), p.ticker ? h('span.sub', { text: p.ticker }) : null),
          h('td', { text: cls(p.asset_class) }),
          h('td.num', {}, money(p.market_value, { locale: L })),
          h('td.num', { text: weight(p.weight, { locale: L }) }))))),

    h('section.section', {},
      h('div.section-h', {}, h('h2', { text: 'Sua política de investimentos' }), h('span.meta', { text: `vigente desde ${dateLong(d.policy?.effective_date, L)}` })),
      h('div.card', {},
        h('div.grid.g2', {},
          h('div', {}, h('div.rail-h', { text: 'Objetivos' }), h('p.note', { text: d.policy?.objectives })),
          h('div', {}, h('div.rail-h', { text: 'Horizonte e liquidez' }), h('p.note', { text: `${d.policy?.investment_horizon}. ${d.policy?.liquidity_requirements}` }))),
        // the same bars the advisor reads: the band is the agreed range, the
        // dotted mark the target, the solid mark where the class stands today;
        // a mark in copper is outside the band
        h('div', { style: { marginTop: '20px' } },
          h('div.rail-h', { text: 'Faixas acordadas por classe de ativo' }),
          bandChart(d.allocation.map((a) => ({ ...a, asset_class: cls(a.asset_class) })), {
            caption: 'A faixa cinza é o intervalo combinado na sua política; o traço pontilhado é o alvo; a marca é onde a classe está hoje. Uma marca em cobre, com "!", está fora da faixa.',
          }),
          d.allocation.some((a) => !a.inside_band)
            ? h('p.note', { style: { marginTop: '8px' } }, h('b', { text: 'Fora da faixa: ' }), d.allocation.filter((a) => !a.inside_band).map((a) => `${cls(a.asset_class)} (${weight(a.weight, { locale: L, decimals: 1 })}${a.range ? `, faixa de ${weight(a.range.min, { locale: L, decimals: 0 })} a ${weight(a.range.max, { locale: L, decimals: 0 })}` : ''})`).join(' · '))
            : h('p.note', { style: { marginTop: '8px' }, text: 'Todas as classes estão dentro das faixas combinadas.' }))),
      h('p.note', { style: { marginTop: '12px' }, text: 'Alterações na carteira e na política acontecem apenas em reunião com o seu assessor. Nada muda automaticamente por causa de um movimento de mercado.' })),

    // ── the monitored indicators, over the window the client picks ─────────
    ov.pending ? null : indicatorsSection(ov, { seriesPath: `/api/clients/${CLIENT_ID}/indicators/series` }),
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
    head(`Seu mês em ${monthLabel(c.reporting_period?.month, L)}`, `Apurado em ${dateLong(c.reporting_period?.end, L)} · moeda ${c.client?.base_currency}`,
      null, [h('b', { text: 'Último mês' }), sep(), `${c.reporting_period?.start} a ${c.reporting_period?.end}`]),

    h('div.grid.g4', { style: { marginBottom: '20px' } },
      stat('Rentabilidade', percent(perf?.monthly_return, { locale: L }), { tone: toneClass(perf?.monthly_return) }),
      stat('Resultado', money(perf?.absolute_pnl, { locale: L, signed: true }), { tone: toneClass(perf?.absolute_pnl) }),
      stat('Carteira de referência', bench?.value == null ? '—' : percent(bench.value, { locale: L }), { tone: 'bench' }),
      stat('Diferença', excess == null ? '—' : pp(excess, { locale: L }), { tone: toneClass(excess) })),

    h('div.card', { style: { marginBottom: '24px' } },
      h('p.pull', { text: c.letter?.performance || '' })),

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
    head('O que importa para a sua carteira', `Eventos do período de ${monthLabel(c.reporting_period?.month, L)} com efeito sobre o que você tem hoje`,
      null, [h('b', { text: 'O que importa' }), sep(), monthLabel(c.reporting_period?.month, L)]),
    h('div.card', { style: { marginBottom: '24px' } },
      h('p.pull', { text: c.letter?.markets || '' }),
      h('p.reading', { style: { marginTop: '16px', color: 'var(--ink-700)' }, text: c.letter?.meaning || '' })),

    impacts.length ? h('div.stack', {}, impacts.map((i) => h('div.card', {},
      h('div.card-h', {},
        h('h3', { text: i.title_pt || i.title }),
        h('span.meta', { text: i.exposure?.total_exposure ? `exposição ${weight(i.exposure.total_exposure, { locale: L, decimals: 1 })}` : '' })),
      h('p.note', { text: i.potential_impact_pt || i.potential_impact }),
      i.exposure?.asset_classes?.length ? h('div.split', { style: { marginTop: '10px' } },
        i.exposure.asset_classes.map((a) => h('span.chip', { text: `${cls(a.asset_class)} ${weight(a.weight, { locale: L, decimals: 1 })}` }))) : null,
      sourceNote(i, c.sources))))
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
    head(`Carta de ${monthLabel(c.reporting_period?.month, L)}`, `Escrita por ${c.advisor?.name} e publicada em ${shortDate(r.meta.published_at)}. Este é o documento exato que foi aprovado; ele não muda depois de publicado.`,
      [h('a.btn.primary', { href: apiUrl(r.links.pdf || `/api/reports/${r.meta.id}/pdf`), target: '_blank' }, icon('download', { size: 15 }), h('span', { text: 'baixar em pdf' })),
        h('a.btn', { href: apiUrl(r.links.portal || `/api/reports/${r.meta.id}/portal`), target: '_blank' }, icon('external', { size: 15 }), h('span', { text: 'ver a carta formatada' }))],
      [h('b', { text: 'Carta do assessor' }), sep(), monthLabel(c.reporting_period?.month, L)]),

    h('article.card.letter-card', {},
      h('div.letter-mast', {},
        h('span', {}, h('b', { text: 'Carta mensal' }), ` · ${monthLabel(c.reporting_period?.month, L)}`),
        h('span', {}, 'Para ', h('b', { text: c.client?.name || '' })),
        h('span', {}, 'De ', h('b', { text: c.advisor?.name || '' }))),
      h('div.letter', {},
      h('p.greeting', { text: letter.greeting || '' }),
      ['opening', 'performance', 'markets', 'meaning'].map((k) => letter[k] && h('p', { text: letter[k] })),
      recs.length ? frag(
        h('h3', { text: 'O que sugiro discutirmos' }),
        h('p', { text: letter.recommendations_intro || '' }),
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
        h('p.note', { style: { margin: '12px 0 28px' }, text: 'São pontos para conversarmos na próxima reunião. Nenhuma operação é executada automaticamente.' })) : null,
      letter.closing ? h('p', { text: letter.closing }) : null,
      h('p', { text: letter.sign_off || '' }),
      h('div.sig', {},
        h('b', { text: c.advisor?.name || '' }),
        h('span', { text: `XP Asset Management${c.advisor?.code ? ` · ${c.advisor.code}` : ''}` })))),

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
    head('Documentos', 'Suas cartas mensais. Cada uma é o documento exato que foi publicado, sem alterações posteriores.',
      null, [h('b', { text: 'Documentos' }), sep(), `${published.length} ${published.length === 1 ? 'carta publicada' : 'cartas publicadas'}`]),
    published.length
      ? table(['Mês', 'Publicada em', { label: 'Páginas', num: true }, 'Formatos'],
        published.map((r) => h('tr', {},
          h('td.name', { text: monthLabel(r.reporting_month, L) }),
          h('td', {}, shortDate(r.published_at)),
          h('td.num', { text: r.page_count ?? '—' }),
          h('td', {}, h('div.split', {},
            h('a.btn.sm', { href: apiUrl(r.links?.pdf || `/api/reports/${r.id}/pdf`), target: '_blank' }, icon('download', { size: 13 }), h('span', { text: 'pdf' })),
            h('a.btn.sm', { href: apiUrl(r.links?.portal || `/api/reports/${r.id}/portal`), target: '_blank' }, icon('external', { size: 13 }), h('span', { text: 'carta' })))))))
      : h('div.empty', { text: 'Nenhuma carta publicada ainda.' }),
  );
}

/** Every event names its source on the card itself, not only in the ledger at the foot of the page. */
function sourceNote(i, sources) {
  const src = (sources || []).find((s) => s.id === i.source_id) || null;
  const provider = src?.provider || i.source_label || null;
  const url = src?.reference || i.source_url || null;
  const upto = src?.last_observation ? ` · dados até ${src.last_observation}` : '';
  return h('p.note.src', { style: { marginTop: '10px' } }, 'Fonte: ',
    provider
      ? (url && /^https?:/.test(url) ? h('a.src-link', { href: url, target: '_blank', rel: 'noopener' }, h('span', { text: provider }), icon('external', { size: 12 })) : provider)
      : 'não registrada',
    upto);
}

function notPublished() {
  return h('div.empty', {},
    h('p', { text: 'Sua carta deste mês ainda não foi publicada pelo seu assessor.' }),
    h('p.note', { text: 'Assim que ele revisar e aprovar o conteúdo, ela aparece aqui e no seu e-mail.' }));
}

// ═══ boot ══════════════════════════════════════════════════════════════════
(async function boot() {
  if (!(await auth.discover())) { location.href = loginUrl(); return; }
  try { ME = await api('/api/auth/me'); } catch { location.href = loginUrl(); return; }
  if (ME.user.role !== 'client') { location.href = advisorUrl(); return; }
  CLIENT_ID = ME.client_id;
  SUMMARY = await api(`/api/clients/${CLIENT_ID}`);
  installSessionGuard();
  renderRail();

  router([
    ['/', viewPortfolio],
    ['/month', viewMonth],
    ['/matters', viewMatters],
    ['/letter', viewLetter],
    ['/documents', viewDocuments],
  ], { root });

  const syncNav = () => { setActive(rail, currentHash()); crumbs(crumbsFor(currentHash())); };
  window.addEventListener('hashchange', syncNav);
  syncNav();
})();
