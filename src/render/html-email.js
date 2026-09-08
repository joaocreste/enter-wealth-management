/**
 * HTML email and portal rendering of the monthly letter (§22 A and C).
 *
 * Both variants are produced from the same letter model as the PDF, so the
 * three outputs cannot disagree. The email variant uses a table skeleton and
 * inline styles because email clients still require it; the portal variant uses
 * the same markup with the modern stylesheet.
 *
 * Brand: tokens from brand-guidelines.html §16, tables per §10.3, radius 0 on
 * anything holding data and no shadows (§9.4), disclosures in ink-2 (§15.3).
 */
import { color, semantic, type, logoSvg } from '../core/brand.js';
import { escapeHtml, percent, pp, money, weight as fmtWeight } from '../core/format.js';
import { svgBars, svgAllocation, svgBands, CHART_CSS } from './charts.js';

const e = escapeHtml;
const INK = color.ink[950];
const INK2 = color.ink[700];
const INK3 = color.ink[500];
const RULE = color.rule;
const RULE2 = color.rule2;

const toneColor = (t) => (t === 'gain' ? semantic.light.gainText : t === 'loss' ? semantic.light.lossText : t === 'benchmark' ? semantic.light.benchmark : color.ink[900]);

export function renderLetterHtml(model, { variant = 'email', pdfUrl = null, portalUrl = null } = {}) {
  const L = model.locale;
  const isEmail = variant === 'email';
  const maxW = isEmail ? 640 : 780;

  const body = `
${masthead(model, isEmail)}
${greeting(model)}
${figureStrip(model, isEmail)}
${section(model, '01', model.sections.performance, performanceBody(model, isEmail))}
${section(model, '02', model.sections.markets, `<p class="serif">${e(model.letter.markets || '')}</p>`)}
${section(model, '03', model.sections.meaning, meaningBody(model))}
${section(model, '04', model.sections.recommendations, recommendationsBody(model, isEmail))}
${section(model, '05', model.sections.portfolio, portfolioBody(model, isEmail))}
${closing(model)}
${sources(model)}
${(pdfUrl || portalUrl) ? actions(model, pdfUrl, portalUrl) : ''}
${disclosures(model)}
`;

  return `<!DOCTYPE html>
<html lang="${L}" ${isEmail ? '' : 'data-variant="portal"'}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(`${L === 'pt-BR' ? 'Carta mensal' : 'Monthly letter'} — ${model.client?.name} — ${model.period.label}`)}</title>
${isEmail ? '' : '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,300;6..72,400&display=swap" rel="stylesheet">'}
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
<tr><td class="pad">${body}</td></tr>
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
body{margin:0;padding:0;background:${color.paper};color:${INK};font-family:${type.sans};font-size:15px;line-height:1.55;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.preheader{display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all}
.shell{background:${color.paper};padding:${isEmail ? '24px 12px' : '32px 16px'}}
.doc{max-width:${maxW}px;width:100%;background:${color.paper2};border:1px solid ${RULE}}
.pad{padding:${isEmail ? '28px 26px 24px' : '40px 44px 34px'}}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-0.02em;line-height:1.14}
p{margin:0 0 0.85em}
p:last-child{margin-bottom:0}
.serif{font-family:${type.serif};font-size:${isEmail ? 15 : 16.5}px;line-height:1.62;color:${INK2};max-width:72ch}
.mono{font-family:${type.mono}}

.masthead{border-bottom:2px solid ${INK};padding-bottom:14px;margin-bottom:18px}
.masthead-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.masthead .doctype{font-size:13px;font-weight:600;color:${INK};text-align:right}
.masthead .period{font-size:12px;color:${INK3};text-align:right;margin-top:2px}
.client-row{display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid ${RULE};padding-bottom:10px;margin-bottom:20px}
.client-name{font-size:20px;font-weight:600;letter-spacing:-0.02em}
.client-meta{font-size:11.5px;color:${INK3}}

.sec{margin:22px 0 0}
.sec-head{display:flex;gap:12px;align-items:baseline;border-bottom:1px solid ${RULE};padding-bottom:6px;margin-bottom:12px}
.sec-num{font-family:${type.mono};font-size:10.5px;color:${color.ink[400]};min-width:20px}
.sec-title{font-size:14px;font-weight:600;letter-spacing:-0.01em}

.figs{width:100%;border-collapse:collapse;border-top:1px solid ${INK};border-bottom:1px solid ${RULE};margin:4px 0 18px}
.figs td{padding:12px 10px 12px 0;vertical-align:top}
.figs .lbl{display:block;font-size:10.5px;color:${INK3};margin-bottom:5px;line-height:1.3}
.figs .val{display:block;font-size:17px;font-weight:600;letter-spacing:-0.02em}
.figs .val.big{font-size:24px;font-weight:700}
.figs .arrow{font-size:12px;margin-right:2px}

table.data{width:100%;border-collapse:collapse;font-size:12.5px;margin:10px 0 4px}
table.data th{text-align:left;font-weight:600;font-size:10.5px;letter-spacing:.03em;color:${INK3};border-bottom:1px solid ${INK};padding:0 10px 6px 0;white-space:nowrap;vertical-align:bottom}
table.data td{padding:9px 10px 9px 0;border-bottom:1px solid ${RULE2};vertical-align:top;color:${INK2}}
table.data td:first-child,table.data th:first-child{padding-left:0}
table.data tr:last-child td{border-bottom:1px solid ${RULE}}
table.data .num{text-align:right;font-weight:500;color:${color.ink[900]};white-space:nowrap}
table.data .name{font-weight:600;color:${INK}}
table.data .sub{display:block;font-size:10.5px;color:${INK3};font-weight:400;margin-top:2px}

.chip{display:inline-block;padding:2px 7px;font-size:10.5px;font-weight:600;line-height:1.5;border:1px solid}
.chip.add{color:${semantic.light.gainText};border-color:${color.yield[200]};background:${semantic.light.gainFill}}
.chip.reduce,.chip.exit{color:${semantic.light.lossText};border-color:${color.drawdown[200]};background:${semantic.light.lossFill}}
.chip.hold{color:${INK2};border-color:${RULE};background:${color.paper3}}
.chip.discuss{color:${semantic.light.caution};border-color:${color.amber[200]};background:${color.amber[50]}}
.chip.conflict{color:${semantic.light.caution};border-color:${color.amber[300]};background:${color.amber[50]}}

.signal-pair{font-size:10.5px;line-height:1.5;color:${INK2}}
.signal-pair b{font-weight:600;color:${INK}}
.signal-pair .na{color:${INK3}}
.fit{font-size:10.5px;font-weight:600;line-height:1.4}
.fit.pass{color:${INK2}}
.fit.flag{color:${semantic.light.caution}}
.rationale{font-size:11.5px;color:${INK2};padding:0 0 10px;border-bottom:1px solid ${RULE2};margin-top:-2px}

.impact{border-left:2px solid ${RULE};padding-left:14px;margin:12px 0}
.impact-item{margin-bottom:12px}
.impact-item:last-child{margin-bottom:0}
.impact-title{font-size:12.5px;font-weight:600;color:${INK}}
.impact-exp{font-size:10.5px;color:${INK3};margin-left:6px;font-weight:500}
.impact-body{font-size:12px;color:${INK2};margin-top:3px}

.note{font-size:11px;color:${INK3};line-height:1.45;margin-top:8px}
.sign{margin-top:22px}
.sign .name{font-size:13px;font-weight:600;color:${INK}}
.sign .org{font-size:11px;color:${INK3};margin-top:2px}

.sources{border-top:1px solid ${RULE};margin-top:24px;padding-top:12px;font-size:10.5px;color:${INK2};line-height:1.5}
.sources b{font-weight:600;color:${INK};display:block;margin-bottom:4px}
.unavail{margin-top:7px;color:${INK2}}
.unavail b{display:inline;color:${semantic.light.caution}}

.actions{margin:22px 0 6px}
.btn{display:inline-block;padding:9px 16px;border:1px solid ${INK};border-radius:2px;font-size:12px;font-weight:500;color:${INK};text-decoration:none;margin-right:8px}
.btn.primary{background:${INK};color:${color.paper2}}

.disc{border-top:2px solid ${INK};margin-top:26px;padding-top:12px;font-size:11px;line-height:1.45;color:${INK2}}
.disc p{margin:0 0 5px}

@media (max-width:620px){
  .pad{padding:20px 16px}
  .figs td{display:block;width:100%!important;border-bottom:1px solid ${RULE2};padding:9px 0}
  .figs .val.big{font-size:20px}
  table.data th:nth-child(3),table.data td:nth-child(3){display:none}
  .masthead-row{flex-direction:column}
  .masthead .doctype,.masthead .period{text-align:left}
}
`;
}

function masthead(model, isEmail) {
  const L = model.locale;
  return `<div class="masthead"><div class="masthead-row">
${logoSvg({ variant: 'ink', height: 26 })}
<div><div class="doctype">${e(L === 'pt-BR' ? 'Carta mensal ao cliente' : 'Monthly client letter')}</div>
<div class="period">${e(model.period.label)}</div></div>
</div></div>
<div class="client-row">
<div class="client-name">${e(model.client?.name || '')}</div>
<div class="client-meta">${e(`${L === 'pt-BR' ? 'Perfil' : 'Profile'}: ${model.client?.risk_profile} · ${L === 'pt-BR' ? 'Assessor' : 'Advisor'}: ${model.advisor?.name}${model.advisor?.code ? ` (${model.advisor.code})` : ''}`)}</div>
</div>`;
}

function greeting(model) {
  return `<p class="serif" style="font-size:16px;margin-bottom:0.7em">${e(model.letter.greeting || '')}</p>
<p class="serif">${e(model.letter.opening || '')}</p>`;
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
  return `<p class="serif">${e(model.letter.performance || '')}</p>
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
  return `<p class="serif">${e(model.letter.meaning || '')}</p>
${items ? `<div class="impact">${items}</div>` : ''}`;
}

function recommendationsBody(model, isEmail) {
  const L = model.locale;
  const recs = model.recommendations || [];
  if (!recs.length) {
    return `<p class="serif">${e(model.letter.recommendations_intro || '')}</p>`;
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

  return `<p class="serif">${e(model.letter.recommendations_intro || '')}</p>
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
<td class="num" style="color:${a.inside_band ? color.ink[900] : semantic.light.caution}">${e(a.weight_label)}</td>
<td class="num" style="font-weight:400;color:${INK3}">${e(a.target_label)}</td>
<td class="num" style="font-weight:400;color:${a.inside_band ? INK3 : semantic.light.caution}">${e(a.range_label)}${a.inside_band ? '' : ' !'}</td>
</tr>`).join('');
  return `${bar}
<table class="data"><thead><tr>${heads.map((h) => `<th${h === heads[0] ? '' : ' style="text-align:right"'}>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function closing(model) {
  return `<div class="sec"><p class="serif">${e(model.letter.closing || '')}</p>
<div class="sign"><p class="serif" style="margin-bottom:0.5em">${e(model.letter.sign_off || '')}</p>
<div class="name">${e(model.advisor?.name || '')}</div>
<div class="org">Enter Asset Management${model.advisor?.code ? ` · ${e(model.advisor.code)}` : ''}</div></div></div>`;
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

function disclosures(model) {
  return `<div class="disc">${(model.disclosures || []).map((d) => `<p>${e(d)}</p>`).join('')}</div>`;
}

/** The portal view — the same content, the modern stylesheet, no email shell. */
export function renderPortalLetter(model, opts = {}) {
  return renderLetterHtml(model, { ...opts, variant: 'portal' });
}
