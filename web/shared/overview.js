/**
 * The two sections of the World Overview both portals show: the day's
 * briefing, and the monitored indicators over a window the reader picks.
 * The advisor's page renders them with the workflow status and the refresh
 * button around them; the client's page renders them read-only, from the
 * client-scoped routes that carry nothing about other clients.
 */
import { h, mount, frag, api, sourceLine, sourcesBlock, sparkline, toneClass, percent, pp, dateLong, monthLabel } from './ui.js';

const L = 'pt-BR';
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Indicator groups come from the data model in English. */
export const GROUP_PT = {
  equities: 'Ações', 'rates & credit': 'Juros e crédito', 'rates and credit': 'Juros e crédito',
  'fx & commodities': 'Câmbio e commodities', 'fx and commodities': 'Câmbio e commodities',
  'digital assets': 'Ativos digitais', crypto: 'Ativos digitais', other: 'Outros', outros: 'Outros',
};
export const groupPt = (g) => GROUP_PT[String(g || '').toLowerCase()] || g || 'Outros';

// ── indicators over a window ──────────────────────────────────────────────
// The strip reads the daily histories the Worker keeps in R2 (Yahoo Finance);
// the level of each indicator comes from the overview run until the series
// arrives, then the close at the end of the window takes over.
export const INDICATOR_WINDOWS = [
  ['5d', '5D', 'as últimas 5 sessões'], ['30d', '30D', 'os últimos 30 dias'], ['ytd', 'YTD', 'desde o último fechamento do ano passado'],
  ['1y', '1A', 'os últimos 12 meses'], ['5y', '5A', 'os últimos 5 anos'], ['custom', 'Período', 'escolher as datas'],
];
export const EARLIEST_SERIES = '1990-01-01';
export const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '—');
export const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

export function formatIndicator(i) {
  if (i.price == null) return '—';
  if (['%', '% a.a.', '% a.m.'].includes(i.unit)) return `${num(i.price, 2)}%`;
  if (i.unit === 'USD' || i.unit === 'USD/oz') return `US$ ${num(i.price, i.price < 10 ? 4 : 0)}`;
  if (i.unit === 'USD/bbl' || i.unit === 'USD/lb') return `US$ ${num(i.price, 2)}`;
  if (i.unit === 'BRL') return `R$ ${num(i.price, 4)}`;
  return num(i.price, i.price > 1000 ? 0 : 2);
}

export function levelLine(i) {
  const l = i.level;
  if (l.kind === 'policy_rate') return l.prev_value == null ? `sem mudança desde ${dmy(l.since)}` : `${pp(l.delta / 100, { locale: L })} em ${dmy(l.since)} · antes ${num(l.prev_value, 2)}%`;
  return `${monthLabel(l.period, L)}${l.prev_value != null ? ` · ${monthLabel(l.prev_period, L)}: ${num(l.prev_value, 2)}%` : ''}`;
}

/** Where the day's news came from, said in full: the newspaper feed first, the web scan second. */
export function newsNote(news) {
  if (!news) return null;
  const parts = [];
  const hl = news.headlines;
  if (hl) {
    if (hl.mode === 'feed') {
      const byProvider = (hl.providers || []).map((p) => (p.regions ? `${p.items} do ${p.name} (${p.regions.br} Brasil, ${p.regions.intl} internacional)` : `${p.items} do ${p.name}`)).join(' e ');
      const cov = hl.top_story?.coverage;
      parts.push(`${hl.items} manchetes nas últimas ${hl.window_hours || 48} horas${byProvider ? `: ${byProvider}` : ` do ${hl.provider}`}; ${hl.kept} ${hl.kept === 1 ? 'entrou' : 'entraram'} na análise, ${hl.classified_by === 'model' ? 'classificadas pelo modelo' : 'classificadas por regra, sem modelo'}${hl.top_story ? `. Notícia do dia: “${hl.top_story.title}”${cov ? `, ${cov} manchetes` : ''}${hl.top_story.provider ? ` (${hl.top_story.provider})` : ''}` : ''}.`);
    } else {
      parts.push(`As manchetes do ${hl.provider} não puderam ser lidas nesta execução: ${hl.reason}.`);
    }
  }
  if (news.mode === 'model') parts.push(`Imprensa internacional: ${news.kept} ${news.kept === 1 ? 'notícia' : 'notícias'} com fonte verificada em ${news.searches} buscas.`);
  else if (news.mode === 'failed') parts.push(`A varredura da imprensa internacional falhou nesta execução: ${news.reason}.`);
  else parts.push(`A varredura da imprensa internacional está desligada: ${news.reason}.`);
  return h('span.muted', { text: parts.join(' ') });
}

/** The figure's caption says plainly when the morning ran without any news. */
export function newsHealth(news, modelWrote) {
  const feedOk = news?.headlines?.mode === 'feed' && news.headlines.kept > 0;
  const webOk = news?.mode === 'model' && news.kept > 0;
  if (news && !feedOk && !webOk) return { tone: 'caution', sub: 'sem noticiário nesta execução — só indicadores e eventos curados' };
  return { sub: modelWrote ? 'selecionados pelo agente de inferência' : 'ordenados por relevância e exposição' };
}

/**
 * The briefing: the headline, the summary, the five blocks and the note that
 * says where the numbers came from. `workflowStatus` adds the approved/draft
 * chip the advisor sees; a client sees the text without the workflow.
 */
export function briefingSection(o, { workflowStatus = true } = {}) {
  const wv = o.world_view;
  const view = wv?.briefing || {};           // the run's payload: headline, summary, blocks, stances
  const briefing = view.briefing || {};
  const blocks = [
    ['Ações', briefing.equities_pt || briefing.equities],
    ['Juros e crédito', briefing.rates_credit_pt || briefing.rates_credit],
    ['Câmbio e commodities', briefing.fx_commodities_pt || briefing.fx_commodities],
    ['Macro e política', briefing.macro_political_pt || briefing.macro_political],
    ['Principal risco ou oportunidade', briefing.main_risk_or_opportunity_pt || briefing.main_risk_or_opportunity, 'key'],
  ].filter(([, v]) => v);
  const modelWrote = o.inference?.mode === 'model';
  return h('section.section', {},
    h('div.section-h', {}, h('h2', { text: 'Resumo do dia' }),
      h('span.meta', {},
        o.date ? `${dateLong(o.date, L)} · ` : '',
        modelWrote ? `escrito por ${o.inference.model}` : 'sem modelo de linguagem — texto determinístico',
        workflowStatus ? frag(' · ', h('span', { class: wv?.approval_status === 'approved' ? 'gain' : 'caution', text: wv?.approval_status === 'approved' ? 'aprovado' : 'rascunho' })) : null)),
    h('div.card', {},
      wv?.generated_summary ? h('p.pull', { text: wv.generated_summary }) : null,
      view.summary_pt ? h('p.reading', { style: { margin: '14px 0 24px', color: 'var(--ink-700)' }, text: view.summary_pt }) : null,
      h('div.brief-blocks', {}, blocks.map(([k, v, key]) => h('div.brief-block', { class: key ? 'key' : '' },
        h('h4', { text: k }),
        h('p', { text: v })))),
      h('div.brief-foot', {},
        h('p.note', {},
          'Este resumo é construído a partir dos dados recuperados pelos agentes, não da memória de um modelo. ',
          'Cada número acima vem de um provedor identificado abaixo. ', newsNote(o.news)),
        sourcesBlock(o.sources, 'Ver fontes'))));
}

export function indicatorsSection(o, { seriesPath = '/api/advisor/indicators/series' } = {}) {
  const groups = {};
  for (const i of o.indicators) (groups[i.group || 'Outros'] ||= []).push(i);
  const todayIso = new Date().toISOString().slice(0, 10);

  const meta = h('span.meta', { text: 'variação no período' });
  const strips = h('div');
  const foot = h('div');
  const rangeErr = h('span.err', { style: { display: 'none' } });
  const fromIn = h('input', { type: 'date', min: EARLIEST_SERIES, max: todayIso, 'aria-label': 'data inicial' });
  const toIn = h('input', { type: 'date', min: EARLIEST_SERIES, max: todayIso, 'aria-label': 'data final' });
  const onEnter = (e) => { if (e.key === 'Enter') load('custom'); };
  fromIn.addEventListener('keydown', onEnter); toIn.addEventListener('keydown', onEnter);
  const range = h('div.range', { style: { display: 'none' } },
    h('span', { text: 'de' }), fromIn, h('span', { text: 'até' }), toIn,
    h('button.btn.sm', { text: 'aplicar', onclick: () => load('custom') }), rangeErr);
  const buttons = h('div.win', { role: 'group', 'aria-label': 'janela de variação' },
    INDICATOR_WINDOWS.map(([k, label, title]) => h('button.btn.sm', { dataset: { k }, text: label, title, onclick: () => (k === 'custom' ? openRange() : load(k)) })));

  let data = null;       // the last series response
  let loading = false;
  let seq = 0;

  const fmtFor = (i) => (v) => formatIndicator({ ...i, price: v });

  function cell(i, s) {
    const later = !s && data?.excluded?.find((x) => x.key === i.key && x.first); // a series that begins after the window
    if (later) {
      return h('div.cell', { title: later.reason },
        h('span.k', { text: i.label }), h('span.v', { text: '—' }),
        h('span.c.muted', { text: `série começa em ${dmy(later.first)}` }),
        h('span.src', { text: `Yahoo Finance · ${later.symbol}` }));
    }
    const src = s?.source || i.source;
    const title = src ? sourceLine(src) : '';
    if (!s && i.unavailable) {
      return h('div.cell.na', { title }, h('span.k', { text: i.label }), h('span.v', { text: 'DATA UNAVAILABLE' }), h('span.c.muted', { text: i.reason?.slice(0, 40) || '' }));
    }
    const fmt = fmtFor(i);
    let c;
    if (s) {
      const windowLabel = s.partial ? `desde ${dmy(s.start.date)}` : data.window.key === 'custom' ? `${dmy(s.start.date)} a ${dmy(s.end.date)}` : data.window.label;
      c = h('span.c', { class: toneClass(s.change_pct), text: `${percent(s.change_pct, { locale: L, decimals: 1 })} · ${windowLabel}` });
    } else if (i.level) c = h('span.c.muted', { text: levelLine(i) });
    else if (loading && !data) c = h('span.c.muted', { text: 'carregando a série…' });
    else if (data) c = h('span.c.muted', { text: 'sem série diária' });
    else c = h('span.c.muted', { text: i.asOf ? dmy(i.asOf) : '' });
    return h('div.cell', { title },
      h('span.k', { text: i.label }),
      h('span.v', { text: fmt(s ? s.end.close : i.price) }),
      c,
      s ? sparkline(s.points, { format: fmt, dateLabel: dmy }) : null,
      src ? h('span.src', { text: `${src.provider} · ${src.identifier} · até ${dmy(s ? s.end.date : i.asOf)}${s?.end.provisional ? ' · sessão em curso' : ''}` }) : null);
  }

  function paint() {
    const byKey = new Map((data?.indicators || []).map((s) => [s.key, s]));
    mount(strips, Object.entries(groups).map(([group, items]) => h('div.strip-group', {},
      h('div.kicker', { text: groupPt(group) }),
      h('div.strip', { class: loading ? 'busy' : '' }, items.map((i) => cell(i, byKey.get(i.key)))))));
  }

  function paintFoot(d) {
    const noSeries = (d.excluded || []).filter((x) => !x.first);
    const later = (d.excluded || []).filter((x) => x.first);
    const excluded = (noSeries.length ? ` · sem série diária: ${noSeries.map((x) => x.label).join(', ')}` : '')
      + (later.length ? ` · começam depois do período: ${later.map((x) => `${x.label} (${dmy(x.first)})`).join(', ')}` : '');
    mount(foot,
      h('p.chart-caption', {},
        `${d.basis[0].toUpperCase()}${d.basis.slice(1)}. `,
        `Fonte: Yahoo Finance, fechamentos diários; séries mantidas em R2 pelo Worker (${d.store.objects} indicadores, atualizadas em ${dmy(d.store.refreshed_at)} às ${hhmm(d.store.refreshed_at)})`,
        d.indicators.some((s) => s.end.provisional) ? ' · "sessão em curso" marca o preço corrente de um pregão ainda aberto, substituído pelo fechamento na próxima atualização' : '',
        excluded, '. Passe o mouse sobre a linha para ler um fechamento.'),
      sourcesBlock(d.sources, 'Ver fontes das séries'));
  }

  function openRange() {
    for (const b of buttons.querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === 'custom');
    const first = data?.indicators?.reduce((a, s) => (a && a < s.start.date ? a : s.start.date), null);
    if (!fromIn.value) fromIn.value = data?.window.key === 'custom' ? data.window.from : first || todayIso.replace(/^\d{4}/, (y) => String(Number(y) - 1));
    if (!toIn.value) toIn.value = data?.window.key === 'custom' ? data.window.to : todayIso;
    range.style.display = '';
    fromIn.focus();
  }

  async function load(k) {
    const my = ++seq;
    let query = `window=${k}`;
    if (k === 'custom') {
      const from = fromIn.value; const to = toIn.value;
      const problem = !from || !to ? 'informe as duas datas'
        : from < EARLIEST_SERIES ? `a série começa, no máximo, em ${dmy(EARLIEST_SERIES)}`
          : from >= to ? 'a data inicial precisa ser anterior à final' : null;
      rangeErr.textContent = problem || '';
      rangeErr.style.display = problem ? '' : 'none';
      if (problem) return;
      query += `&from=${from}&to=${to}`;
    } else {
      range.style.display = 'none';
      rangeErr.style.display = 'none';
    }
    for (const b of buttons.querySelectorAll('button')) { b.classList.toggle('on', b.dataset.k === k); b.disabled = true; }
    loading = true;
    paint();
    try {
      const d = await api(`${seriesPath}?${query}`);
      if (my !== seq) return;
      data = d;
      const first = d.indicators.reduce((a, s) => (a && a < s.start.date ? a : s.start.date), null);
      mount(meta, d.indicators.length ? `${dateLong(first, L)} a ${dateLong(d.as_of, L)}` : 'sem séries no período');
      paintFoot(d);
    } catch (err) {
      if (my !== seq) return;
      if (k === 'custom') { rangeErr.textContent = err.message; rangeErr.style.display = ''; }
      else mount(foot, h('div.err', { text: `Não foi possível carregar as séries: ${err.message}` }));
    } finally {
      if (my === seq) {
        loading = false;
        for (const b of buttons.querySelectorAll('button')) b.disabled = false;
        paint();
      }
    }
  }

  paint();
  load('30d');
  return h('section.section', {},
    h('div.section-h', {}, h('h2', { text: 'Indicadores monitorados' }), h('div.split', {}, meta, buttons)),
    range, strips, foot);
}
