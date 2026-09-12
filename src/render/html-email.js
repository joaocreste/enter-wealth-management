/**
 * HTML email and portal rendering of the monthly letter.
 *
 * Both variants are produced from the same letter model as the PDF, so the
 * three outputs cannot disagree. The email variant uses a table skeleton and
 * inline styles because email clients still require it; the portal variant uses
 * the same markup with the modern stylesheet.
 *
 * Brand: the Carta ao Investidor line of the XP Advisory brand system — a
 * #242424 header bar with a tracked title and the white symbol, article titles
 * in Roboto Bold copper, Roboto Light body with generous leading, tables with a
 * charcoal header band and no black rules, a dark disclaimer block and the
 * copper footer bar (§04, §06, §08).
 */
import { color, semantic, type, inkOn, LOGO_SYMBOL_PATH, LOGO_SYMBOL_VIEWBOX, LOGO_SYMBOL_ASPECT } from '../core/brand.js';
import { escapeHtml, percent, pp, money, weight as fmtWeight } from '../core/format.js';
import { svgBars, svgAllocation, svgBands, CHART_CSS } from './charts.js';

const e = escapeHtml;
const INK = color.ink[950];
const INK2 = color.ink[600];
const INK3 = color.ink[400];
const RULE = color.rule;
const RULE2 = color.rule2;
const BAR = color.bar;
const COPPER = color.copper[500];
const COPPER2 = color.copper[400];
const SAGE = color.sage;
const CHARCOAL = color.charcoal;
const SLATE = color.slate[600];

const toneColor = (t) => (t === 'gain' ? semantic.light.gainText : t === 'loss' ? semantic.light.lossText : t === 'benchmark' ? semantic.light.benchmark : INK);

const symbolSvg = (height, fill) => `<svg viewBox="${LOGO_SYMBOL_VIEWBOX}" width="${(height * LOGO_SYMBOL_ASPECT).toFixed(1)}" height="${height}" role="img" aria-label="XP Asset Management" fill="${fill}" fill-rule="evenodd" style="display:block"><path d="${LOGO_SYMBOL_PATH}"/></svg>`;

export function renderLetterHtml(model, { variant = 'email', pdfUrl = null, portalUrl = null } = {}) {
  const L = model.locale;
  const isEmail = variant === 'email';
  const maxW = isEmail ? 640 : 780;

  const body = `
${byline(model)}
${clientRow(model)}
${greeting(model)}
${figureStrip(model, isEmail)}
${section(model, '01', model.sections.performance, performanceBody(model, isEmail))}
${section(model, '02', model.sections.markets, `<p class="reading">${e(model.letter.markets || '')}</p>`)}
${section(model, '03', model.sections.meaning, meaningBody(model))}
${section(model, '04', model.sections.recommendations, recommendationsBody(model, isEmail))}
${section(model, '05', model.sections.portfolio, portfolioBody(model, isEmail))}
${closing(model)}
${sources(model)}
${(pdfUrl || portalUrl) ? actions(model, pdfUrl, portalUrl) : ''}
`;

  return `<!DOCTYPE html>
<html lang="${L}" ${isEmail ? '' : 'data-variant="portal"'}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(`${L === 'pt-BR' ? 'Carta mensal' : 'Monthly letter'} — ${model.client?.name} — ${model.period.label}`)}</title>
${isEmail ? '' : '<link href="https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,300&family=Hanken+Grotesk:wght@300;400&display=swap" rel="stylesheet">'}
<style>
${baseCss(maxW, isEmail)}
${CHART_CSS}
</style>
</head>
<body>
<div class="preheader">${e(preheaderText(model))}</div>
<table role="presentation" class="shell" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center">
<table role="presentation" class="doc" width="${maxW}" cellpadding="0" cellspacing="0" border="0">
<tr><td class="bar">${masthead(model)}</td></tr>
<tr><td class="pad">${body}</td></tr>
<tr><td class="disc">${disclosures(model)}</td></tr>
<tr><td class="foot">${footer(model)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function preheaderText(model) {
  const r = model.figures.find((f) => f.key === 'monthly_return');
  return `${model.period.label} · ${r ? r.value : ''} · ${model.client?.name}`;
}

function baseCss(maxW, isEmail) {
  return `
:root{color-scheme:light}
body{margin:0;padding:0;background:${color.paper3};color:${INK};font-family:${type.sans};font-weight:300;font-size:15px;line-height:1.6;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.preheader{display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all}
.shell{background:${color.paper3};padding:${isEmail ? '24px 12px' : '32px 16px'}}
.doc{max-width:${maxW}px;width:100%;background:${color.paper2}}
.pad{padding:${isEmail ? '22px 26px 24px' : '30px 44px 34px'}}
h1,h2,h3{margin:0;font-weight:400;line-height:1.2}
p{margin:0 0 0.85em}
p:last-child{margin-bottom:0}
b,strong{font-weight:500}
.reading{font-weight:300;font-size:${isEmail ? 14.5 : 15.5}px;line-height:1.8;color:${INK};max-width:72ch}
.mono{font-family:${type.mono}}
.track{font-weight:300;letter-spacing:.3em;text-transform:uppercase}

.bar{background:${BAR};color:${color.headerText};padding:0 20px 0 ${isEmail ? 26 : 31}px;height:60px;vertical-align:middle}
.bar table{width:100%}
.bar .title{font-size:13px;letter-spacing:.32em;text-transform:uppercase;font-weight:300;white-space:nowrap;color:${color.headerText}}
.bar .title b{font-weight:700}
.bar .sep{color:${COPPER};font-size:8px;margin:0 12px 0 14px;font-weight:300}
.bar .date{font-size:8px;letter-spacing:.32em;text-transform:uppercase;color:${SAGE};font-weight:300;white-space:nowrap}
.byline{font-size:9px;letter-spacing:.3em;text-transform:uppercase;font-weight:300;color:${INK};margin:0 0 14px}
.byline b{font-weight:400}
.client-row{display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid ${RULE};padding-bottom:10px;margin-bottom:22px}
.client-name{font-size:19px;font-weight:400;color:${INK}}
.client-meta{font-size:11px;color:${INK3}}

.sec{margin:26px 0 0}
.sec-head{display:flex;gap:12px;align-items:baseline;margin-bottom:10px}
.sec-num{font-family:${type.mono};font-size:10px;color:${COPPER};letter-spacing:.12em;min-width:22px}
.sec-title{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${COPPER2}}

.figs{width:100%;border-collapse:collapse;border-top:1px solid ${color.rule3};border-bottom:1px solid ${RULE};margin:4px 0 20px}
.figs td{padding:12px 10px 12px 0;vertical-align:top}
.figs .lbl{display:block;font-size:8.5px;letter-spacing:.2em;text-transform:uppercase;color:${SAGE};margin-bottom:6px;line-height:1.3;font-weight:400}
.figs .val{display:block;font-size:18px;font-weight:300;letter-spacing:0}
.figs .val.big{font-size:26px;font-weight:400}
.figs .arrow{font-size:12px;margin-right:2px}

table.data{width:100%;border-collapse:collapse;font-size:12.5px;margin:10px 0 4px}
table.data th{text-align:left;font-weight:500;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${CHARCOAL};padding:7px 8px;white-space:nowrap;vertical-align:bottom}
table.data td{padding:9px 8px;border-bottom:1px solid ${RULE2};vertical-align:top;color:${INK};font-weight:300}
table.data tr:last-child td{border-bottom:1px solid ${RULE}}
table.data .num{text-align:right;font-weight:400;color:${INK};white-space:nowrap}
table.data .name{font-weight:500;color:${INK}}
table.data .sub{display:block;font-size:10.5px;color:${INK3};font-weight:300;margin-top:2px}

.chip{display:inline-block;padding:2px 9px;font-size:10.5px;font-weight:400;line-height:1.5;border-radius:999px;background:${color.ink[50]};color:${color.ink[900]}}
.chip.add{color:${semantic.light.gainText};background:${semantic.light.gainFill}}
.chip.reduce,.chip.exit{color:${semantic.light.lossText};background:${semantic.light.lossFill}}
.chip.hold{color:${color.ink[700]};background:${color.ink[50]}}
.chip.discuss{color:${semantic.light.caution};background:${semantic.light.cautionWash}}
.chip.conflict{color:${semantic.light.caution};background:${semantic.light.cautionWash}}

.signal-pair{font-size:10.5px;line-height:1.5;color:${INK2}}
.signal-pair b{font-weight:500;color:${INK}}
.signal-pair .na{color:${INK3}}
.fit{font-size:10.5px;font-weight:500;line-height:1.4}
.fit.pass{color:${INK2}}
.fit.flag{color:${semantic.light.caution}}
.rationale{font-size:11.5px;color:${INK2};padding:0 8px 10px;border-bottom:1px solid ${RULE2};margin-top:-2px;font-weight:300}

.impact{border-left:2px solid ${SLATE};padding-left:14px;margin:12px 0}
.impact-item{margin-bottom:12px}
.impact-item:last-child{margin-bottom:0}
.impact-title{font-size:12.5px;font-weight:500;color:${INK}}
.impact-exp{font-size:10.5px;color:${INK3};margin-left:6px;font-weight:400}
.impact-body{font-size:12px;color:${INK2};margin-top:3px;font-weight:300}

.note{font-size:11px;color:${INK3};line-height:1.5;margin-top:8px;font-weight:300}
.sign{margin-top:22px}
.sign .name{font-size:13px;font-weight:500;color:${INK}}
.sign .org{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:${SAGE};margin-top:4px;font-weight:300}

.sources{border-top:1px solid ${RULE};margin-top:24px;padding-top:12px;font-size:10.5px;color:${INK2};line-height:1.5;font-weight:300}
.sources b{font-weight:400;color:${INK};display:block;margin-bottom:4px}
.unavail{margin-top:7px;color:${INK2}}
.unavail b{display:inline;color:${semantic.light.caution}}

.actions{margin:22px 0 6px}
.btn{display:inline-block;padding:9px 16px;border:1px solid ${color.rule3};border-radius:3px;font-size:12px;font-weight:400;color:${INK};text-decoration:none;margin-right:8px}
.btn.primary{background:${SLATE};border-color:${SLATE};color:#fff}

.disc{background:${BAR};color:#fff;padding:${isEmail ? '22px 26px 24px' : '26px 44px 28px'}}
.disc .disc-title{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:${COPPER};font-weight:400;margin:0 0 10px}
.disc p{margin:0 0 6px;font-size:10.5px;line-height:1.8;color:#fff;font-weight:300}
.foot{background:${COPPER};color:${INK};padding:0 ${isEmail ? 26 : 31}px;height:27px;vertical-align:middle}
.foot table{width:100%}
.foot .brand{font-size:8px;letter-spacing:.32em;text-transform:uppercase;font-weight:300;color:${INK};white-space:nowrap}
.foot .pg{font-size:8.8px;color:#fff;font-weight:400;text-align:right}

@media (max-width:620px){
  .pad{padding:18px 16px}
  .figs td{display:block;width:100%!important;border-bottom:1px solid ${RULE2};padding:9px 0}
  .figs .val.big{font-size:20px}
  table.data th:nth-child(3),table.data td:nth-child(3){display:none}
  .client-row{flex-direction:column}
  .bar .date{display:none}
}
`;
}

function masthead(model) {
  const L = model.locale;
  const [first, ...rest] = (L === 'pt-BR' ? 'Carta mensal' : 'Monthly letter').split(' ');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle"><span class="title">${e(first)} <b>${e(rest.join(' '))}</b></span><span class="sep">l</span><span class="date">${e(model.period.label)}</span></td>
<td align="right" valign="middle" width="40">${symbolSvg(26, '#FFFFFF')}</td>
</tr></table>`;
}

function byline(model) {
  const L = model.locale;
  return `<p class="byline">${e(L === 'pt-BR' ? 'Por' : 'By')} <b>${e(model.advisor?.name || '')}</b>, XP Asset Management</p>`;
}

function clientRow(model) {
  const L = model.locale;
  return `<div class="client-row">
<div class="client-name">${e(model.client?.name || '')}</div>
<div class="client-meta">${e(`${L === 'pt-BR' ? 'Perfil' : 'Profile'}: ${model.client?.risk_profile} · ${L === 'pt-BR' ? 'Assessor' : 'Advisor'}: ${model.advisor?.name}${model.advisor?.code ? ` (${model.advisor.code})` : ''}`)}</div>
</div>`;
}

function greeting(model) {
  return `<p class="reading" style="font-size:17px;margin-bottom:0.7em">${e(model.letter.greeting || '')}</p>
<p class="reading">${e(model.letter.opening || '')}</p>`;
}

function figureStrip(model, isEmail) {
  const figs = model.figures.slice(0, 5);
  const w = (100 / figs.length).toFixed(2);
  const cells = figs.map((f) => `<td width="${w}%" style="width:${w}%">
<span class="lbl">${e(f.label)}</span>
<span class="val${f.emphasis ? ' big' : ''}" style="color:${toneColor(f.tone)}">${f.arrow && f.tone !== 'flat' ? `<span class="arrow" aria-hidden="true">${f.arrow}</span>` : ''}${e(f.value)}</span>
</td>`).join('');
  return `<table role="presentation" class="figs" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
}

function section(model, num, title, inner) {
  return `<div class="sec"><div class="sec-head"><span class="sec-num">${num}</span><span class="sec-title">${e(title)}</span></div>${inner}</div>`;
}

function performanceBody(model, isEmail) {
  const L = model.locale;
  const chart = svgBars(model.charts.contributors, {
    width: isEmail ? 560 : 660,
    title: L === 'pt-BR' ? 'Quem puxou o resultado, em pontos percentuais da carteira' : 'What drove the result, in percentage points of the portfolio',
    caption: buildChartCaption(model),
    locale: L,
  });
  return `<p class="reading">${e(model.letter.performance || '')}</p>
${chart}
${model.method_note ? `<p class="note">${e(model.method_note)}</p>` : ''}
${model.coverage_note ? `<p class="note">${e(model.coverage_note)}</p>` : ''}`;
}

function buildChartCaption(model) {
  const L = model.locale;
  const providers = [...new Set((model.sources || []).filter((s) => s.kind === 'market_price').map((s) => s.provider))];
  return L === 'pt-BR'
    ? `Período: ${model.period.start} a ${model.period.end} · Moeda: ${model.currency} · Base: contribuição para o retorno da carteira${providers.length ? ` · Fontes: ${providers.join(', ')}` : ''}`
    : `Period: ${model.period.start} to ${model.period.end} · Currency: ${model.currency} · Basis: contribution to portfolio return${providers.length ? ` · Sources: ${providers.join(', ')}` : ''}`;
}

function meaningBody(model) {
  const items = (model.impact || []).map((i) => `<div class="impact-item">
<div><span class="impact-title">${e(i.title)}</span>${i.exposure_label ? `<span class="impact-exp">${e(model.locale === 'pt-BR' ? 'exposição' : 'exposure')} ${e(i.exposure_label)}</span>` : ''}</div>
<div class="impact-body">${e(i.impact || '')}</div>
</div>`).join('');
  return `<p class="reading">${e(model.letter.meaning || '')}</p>
${items ? `<div class="impact">${items}</div>` : ''}`;
}

function recommendationsBody(model, isEmail) {
  const L = model.locale;
  const recs = model.recommendations || [];
  if (!recs.length) {
    return `<p class="reading">${e(model.letter.recommendations_intro || '')}</p>`;
  }
  const heads = L === 'pt-BR'
    ? ['Ativo', 'Sugestão', 'Sinais de mercado', 'Enquadramento na sua política']
    : ['Asset', 'Suggestion', 'Market signals', 'Fit with your policy'];

  const rows = recs.map((r) => `<tr>
<td><span class="name">${e(r.ticker || r.name)}</span><span class="sub">${e(r.asset_class)} · ${e(r.weight_label)}</span></td>
<td><span class="chip ${r.action.toLowerCase()}">${e(r.action_label)}</span>${r.conflict ? `<br><span class="chip conflict" style="margin-top:4px">${e(L === 'pt-BR' ? 'sinais divergentes' : 'signals disagree')}</span>` : ''}</td>
<td><div class="signal-pair">
<b>${e(L === 'pt-BR' ? 'Técnico' : 'Technical')}:</b> ${r.technical ? e(r.technical) : `<span class="na">${e(L === 'pt-BR' ? 'sem cobertura' : 'not covered')}</span>`}<br>
<b>${e(L === 'pt-BR' ? 'Analistas' : 'Analyst')}:</b> ${r.analyst ? `${e(r.analyst)}${r.analyst_count ? ` <span class="na">(${r.analyst_count})</span>` : ''}` : `<span class="na">${e(r.analyst_missing_label || '')}</span>`}
</div></td>
<td><span class="fit ${r.suitability === 'PASS' ? 'pass' : 'flag'}">${e(r.suitability_label)}</span></td>
</tr>
${r.rationale ? `<tr><td colspan="4" class="rationale">${e(r.rationale)}</td></tr>` : ''}`).join('');

  return `<p class="reading">${e(model.letter.recommendations_intro || '')}</p>
<table class="data"><thead><tr>${heads.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<p class="note">${e(L === 'pt-BR'
    ? 'Estas são sugestões para discussão na próxima reunião. Nenhuma operação é executada automaticamente.'
    : 'These are discussion points for the next meeting. No transaction is executed automatically.')}${model.recommendations_omitted_note ? ` ${e(model.recommendations_omitted_note)}` : ''}</p>`;
}

function portfolioBody(model, isEmail) {
  const L = model.locale;
  const bar = svgAllocation(model.charts.allocation, {
    width: isEmail ? 560 : 660,
    caption: L === 'pt-BR'
      ? `Composição em ${model.period.end}${model.policy_version ? ` · faixas conforme a política de investimentos versão ${model.policy_version}` : ''}`
      : `Composition at ${model.period.end}${model.policy_version ? ` · ranges per investment policy version ${model.policy_version}` : ''}`,
    locale: L,
  });
  const heads = L === 'pt-BR'
    ? ['Classe de ativo', 'Valor', 'Peso', 'Alvo', 'Faixa permitida']
    : ['Asset class', 'Value', 'Weight', 'Target', 'Permitted range'];
  const rows = (model.allocation || []).map((a) => `<tr>
<td class="name">${e(a.asset_class)}</td>
<td class="num">${e(a.value_label)}</td>
<td class="num" style="color:${a.inside_band ? INK : semantic.light.caution}">${e(a.weight_label)}</td>
<td class="num" style="font-weight:300;color:${INK3}">${e(a.target_label)}</td>
<td class="num" style="font-weight:300;color:${a.inside_band ? INK3 : semantic.light.caution}">${e(a.range_label)}${a.inside_band ? '' : ' !'}</td>
</tr>`).join('');
  return `${bar}
<table class="data"><thead><tr>${heads.map((h) => `<th${h === heads[0] ? '' : ' style="text-align:right"'}>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function closing(model) {
  return `<div class="sec"><p class="reading">${e(model.letter.closing || '')}</p>
<div class="sign"><p class="reading" style="margin-bottom:0.5em">${e(model.letter.sign_off || '')}</p>
<div class="name">${e(model.advisor?.name || '')}</div>
<div class="org">XP Asset Management${model.advisor?.code ? ` · ${e(model.advisor.code)}` : ''}</div></div></div>`;
}

function sources(model) {
  const L = model.locale;
  const unav = (model.unavailable || []).length
    ? `<div class="unavail"><b>${e(L === 'pt-BR' ? 'Sem dado disponível' : 'Data unavailable')}:</b> ${e(model.unavailable.map((u) => `${u.item} — ${u.reason}`).join('; '))}</div>`
    : '';
  return `<div class="sources"><b>${e(L === 'pt-BR' ? 'Fontes' : 'Sources')}</b>${e((model.source_lines || []).join(' · '))}${unav}</div>`;
}

function actions(model, pdfUrl, portalUrl) {
  const L = model.locale;
  return `<div class="actions">
${pdfUrl ? `<a class="btn primary" href="${e(pdfUrl)}">${e(L === 'pt-BR' ? 'baixar a carta em pdf' : 'download the pdf')}</a>` : ''}
${portalUrl ? `<a class="btn" href="${e(portalUrl)}">${e(L === 'pt-BR' ? 'abrir no portal' : 'open in the portal')}</a>` : ''}
</div>`;
}

/** The Carta's disclaimer page: white Light text on the bar colour, the title tracked in copper. */
function disclosures(model) {
  return `<p class="disc-title">Disclaimer</p>${(model.disclosures || []).map((d) => `<p>${e(d)}</p>`).join('')}`;
}

/** The Carta's copper footer bar: the house tracked at the left, the page number at the right. */
function footer(model) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle"><span class="brand">XP Asset Management</span></td>
<td align="right" valign="middle"><span class="pg">${e(model.period.label)}</span></td>
</tr></table>`;
}

/** The portal view — the same content, the modern stylesheet, no email shell. */
export function renderPortalLetter(model, opts = {}) {
  return renderLetterHtml(model, { ...opts, variant: 'portal' });
}
