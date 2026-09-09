/**
 * Language-model gateway.
 *
 * Provider order: Anthropic, then OpenAI, then a deterministic template.
 *
 * The template path is not a toy. It renders the same canonical facts into
 * correct Portuguese without a model, which means the product degrades to
 * "less fluent" rather than to "broken" when a key is missing or a provider is
 * down — and the report records which path was taken, so nobody has to guess
 * whether a given letter was written by a model (§30, §31).
 */
import { renderPrompt, PROMPT_VERSION } from '../../src/llm/prompts.js';
import { money, percent, pp, monthLabel, dateLong, MINUS } from '../../src/core/format.js';

export function llmAvailable(env) {
  return !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
}

/**
 * One Messages API request over HTTP. The Worker has no npm SDK on purpose:
 * it keeps the bundle to one file and the call is a single POST. Claude Opus 5
 * runs adaptive thinking by default and rejects sampling parameters, so none
 * are sent.
 */
async function anthropicMessages(env, body, { timeoutMs = 120000 } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error(`Anthropic declined the request${data.stop_details?.category ? ` (${data.stop_details.category})` : ''}`);
  return data;
}

const textOf = (data) => (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');

export async function complete(env, { system, user, maxTokens = 2000 }) {
  if (env.ANTHROPIC_API_KEY) {
    const model = env.ANTHROPIC_MODEL || 'claude-opus-5';
    const data = await anthropicMessages(env, { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    return { text: textOf(data), model, provider: 'anthropic', usage: data.usage };
  }

  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_MODEL || 'gpt-4o';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || '', model, provider: 'openai' };
  }

  throw new Error('NO_LLM_PROVIDER');
}

/** Models wrap JSON in prose often enough that this is worth doing properly. */
export function parseJsonBlock(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i += 1) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function runPrompt(env, promptKey, facts, { maxTokens = 2400 } = {}) {
  const p = renderPrompt(promptKey, facts);
  const out = await complete(env, { system: p.system, user: p.user, maxTokens });
  const parsed = parseJsonBlock(out.text);
  if (!parsed) throw new Error(`model returned no parsable JSON for ${promptKey}`);
  return { data: parsed, model: out.model, provider: out.provider, prompt_version: p.prompt_version, usage: out.usage };
}

/**
 * Daily agent 1 — the news scan. Claude searches the web (server-side tool),
 * returns items each pointing at a URL, and the code keeps only the items whose
 * URL was actually among the search results or citations: an uncited claim
 * never reaches the advisor. Requires the Anthropic API; there is no fallback
 * because a news item without a verifiable source is worse than no news.
 */
export async function scanNews(env, facts, { maxSearches = 6 } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('the news scan needs the Anthropic API');
  const p = renderPrompt('daily_news_scan', facts);
  const model = env.ANTHROPIC_MODEL || 'claude-opus-5';
  const tools = [{
    type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches,
    user_location: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' },
  }];
  let messages = [{ role: 'user', content: p.user }];
  const found = new Map(); // url → { title, page_age }
  let data = null; let searches = 0;
  // A search-heavy turn can pause; resend the assistant content unchanged to resume.
  for (let turn = 0; turn < 4; turn += 1) {
    data = await anthropicMessages(env, { model, max_tokens: 8000, system: p.system, messages, tools }, { timeoutMs: 180000 });
    for (const block of data.content || []) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === 'web_search_result' && r.url) found.set(normaliseUrl(r.url), { url: r.url, title: r.title, page_age: r.page_age });
      }
      if (block.type === 'text') for (const c of block.citations || []) if (c.url) found.set(normaliseUrl(c.url), { url: c.url, title: c.title, cited_text: c.cited_text });
    }
    searches += data.usage?.server_tool_use?.web_search_requests || 0;
    if (data.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: data.content }];
  }
  const parsed = parseJsonBlock(textOf(data));
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [];
  const kept = []; const dropped = [];
  for (const it of items) {
    const key = it?.source_url ? normaliseUrl(it.source_url) : null;
    const hit = key ? found.get(key) : null;
    if (!hit) { dropped.push({ title: it?.title || '(sem título)', reason: 'fonte não verificável entre os resultados da busca' }); continue; }
    kept.push({ ...it, source_url: hit.url, source_title: it.source_title || hit.title || hit.url });
  }
  return { items: kept, dropped, searches, model, urls: [...found.values()].map((f) => f.url), usage: data.usage };
}

function normaliseUrl(u) {
  try {
    const url = new URL(String(u).trim());
    url.hash = ''; url.search = '';
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch { return String(u).trim().toLowerCase(); }
}

/**
 * Daily agent 1, Brazil — the model classifies headlines the code already
 * fetched from Valor Econômico. No search, no tool: a plain completion over
 * FACTS.headlines. An answer that names a headline id the code did not hand
 * over is dropped, the same discipline as the URL check above.
 */
export async function classifyHeadlines(env, facts, { maxTokens = 5000 } = {}) {
  const r = await runPrompt(env, 'daily_headlines_classify', facts, { maxTokens });
  const items = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.items) ? r.data.items : [];
  const known = new Map((facts.headlines || []).map((h) => [h.id, h]));
  const kept = []; const dropped = [];
  for (const it of items) {
    const h = it && known.get(it.headline_id);
    if (!h) { dropped.push({ title: it?.summary_pt?.slice(0, 80) || it?.headline_id || '(sem id)', reason: 'id de manchete não consta do feed' }); continue; }
    if (kept.some((k) => k.headline_id === it.headline_id)) continue;
    kept.push(it);
  }
  return { items: kept, dropped, model: r.model, prompt_version: r.prompt_version, usage: r.usage };
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministic fallbacks
// ───────────────────────────────────────────────────────────────────────────

const L = 'pt-BR';

export function deterministicLetter(facts) {
  const f = facts;
  const name = (f.client?.name || '').split(' ')[0];
  const ret = f.performance?.monthly_return;
  const pnl = f.performance?.absolute_pnl;
  const bench = f.benchmark?.value;
  const excess = f.benchmark?.excess_return;
  const worst = f.attribution?.worst_contributor;
  const best = f.attribution?.best_contributor;
  const fx = f.attribution?.fx_contribution;
  const month = monthLabel(f.reporting_period?.month, L);

  const performance = [];
  if (ret == null) {
    performance.push(`Não foi possível apurar a rentabilidade consolidada de ${month} com os dados disponíveis.`);
    if (f.performance?.unavailable_reason) performance.push(f.performance.unavailable_reason);
  } else {
    // House style: the loss is described before the gain.
    if (worst) {
      performance.push(`Começo pelo que pesou negativamente. ${worst.name} foi o maior detrator do mês, com contribuição de ${pp(worst.contribution, { locale: L })} sobre o resultado da carteira.`);
    }
    if (best) {
      performance.push(`Do lado positivo, ${best.name} contribuiu com ${pp(best.contribution, { locale: L })}.`);
    }
    performance.push(`No agregado, a carteira registrou ${percent(ret, { locale: L })} em ${month}, o equivalente a ${money(pnl, { currency: f.client?.base_currency || 'BRL', locale: L, signed: true })} sobre o patrimônio.`);
    if (bench != null) {
      performance.push(excess >= 0
        ? `A carteira de referência da sua política rendeu ${percent(bench, { locale: L })} no mesmo período, portanto ficamos ${pp(Math.abs(excess), { locale: L, signed: false })} acima dela.`
        : `A carteira de referência da sua política rendeu ${percent(bench, { locale: L })} no mesmo período, portanto ficamos ${pp(Math.abs(excess), { locale: L, signed: false })} abaixo dela.`);
    }
    if (fx != null && Math.abs(fx) > 0.001) {
      performance.push(fx > 0
        ? `A variação do câmbio somou ${pp(fx, { locale: L })} ao resultado, por conta das posições no exterior sem proteção cambial.`
        : `A variação do câmbio subtraiu ${pp(Math.abs(fx), { locale: L, signed: false })} do resultado, por conta das posições no exterior sem proteção cambial.`);
    }
    // The method assumption is printed once, as a note beneath the figures.
    // Repeating it inside the paragraph made the letter read like a footnote.
  }

  const events = (f.events || []).slice(0, 3);
  const markets = events.length
    ? events.map((e) => `${e.title_pt || e.title}. ${e.why_it_matters_pt || e.why_it_matters || ''}`.trim()).join(' ')
    : 'Não houve, no período, eventos de mercado com efeito material sobre as classes de ativos presentes na sua carteira.';

  // The specifics are printed as rows under this paragraph, so the paragraph
  // synthesises rather than repeating them.
  const impacts = (f.impact || []).filter((i) => i.relevance === 'high' || i.relevance === 'medium');
  const topExposure = impacts.length ? impacts[0] : null;
  const meaning = impacts.length
    ? `Nenhum desses movimentos exige uma ação imediata na sua carteira. ${topExposure?.potential_impact_pt || topExposure?.potential_impact || ''} Abaixo, os pontos com efeito mais direto sobre o que você tem hoje.`.replace(/\s+/g, ' ').trim()
    : 'A composição atual da carteira permanece dentro das faixas aprovadas na sua política de investimentos, e nenhum desses movimentos exige ação imediata.';

  const forLetter = f.letter_recommendations || (f.recommendations || []).filter((r) => r.advisor_status === 'approved');
  const conflicts = forLetter.filter((r) => r.signal_conflict).length;
  const recIntro = forLetter.length
    ? `Separei ${forLetter.length === 1 ? 'um ponto' : `${forLetter.length} pontos`} para conversarmos na nossa próxima reunião. São sugestões de discussão, não ordens de compra ou venda.${conflicts ? ` Em ${conflicts === 1 ? 'um deles' : `${conflicts} deles`}, a leitura técnica e o consenso de analistas discordam, e é exatamente por isso que prefiro decidir com você.` : ''}`
    : 'Não há, neste mês, alterações que eu recomende discutir na carteira.';

  const closing = f.next_meeting
    ? `Nossa próxima reunião está marcada para ${dateLong(f.next_meeting, L)}. Levarei os pontos acima detalhados. Se preferir conversar antes, é só me chamar.`
    : 'Se quiser conversar sobre qualquer ponto desta carta antes da nossa próxima reunião, é só me chamar.';

  return {
    greeting: `Prezado ${name},`,
    opening: `Segue o resumo da sua carteira em ${month}. Escrevi esta carta para que você entenda o que aconteceu, por que aconteceu e o que vale discutirmos adiante.`,
    performance: performance.join(' '),
    markets,
    meaning,
    recommendations_intro: recIntro,
    closing,
    sign_off: 'Um abraço,',
    language: 'pt-BR',
  };
}

export function deterministicWorldView(facts) {
  const ind = Object.fromEntries((facts.indicators || []).map((i) => [i.key, i]));
  const fired = (facts.triggers || []).filter((t) => t.status === 'BREACHED');
  const say = (k, fmt = (v) => v.toFixed(2)) => {
    const i = ind[k];
    if (!i || i.unavailable || i.price == null) return null;
    const mtd = i.mtdPct != null ? ` (${i.mtdPct >= 0 ? '+' : MINUS}${Math.abs(i.mtdPct * 100).toFixed(1)}% MTD)` : '';
    return `${i.label} at ${fmt(i.price)}${mtd}`;
  };
  const join = (...xs) => xs.filter(Boolean).join('; ');

  const headline = fired.length
    ? `${fired[0].label} — threshold breached`
    : 'No monitored threshold breached today';

  return {
    headline,
    briefing: {
      equities: join(say('sp500', (v) => v.toLocaleString('en-US', { maximumFractionDigits: 0 })), say('ibovespa', (v) => v.toLocaleString('en-US', { maximumFractionDigits: 0 })), say('vix')) || 'Equity indicators unavailable.',
      rates_credit: join(say('us10y', (v) => `${v.toFixed(2)}%`), say('selic', (v) => `${v.toFixed(2)}%`), say('hy_etf')) || 'Rates and credit indicators unavailable.',
      fx_commodities: join(say('usdbrl', (v) => v.toFixed(4)), say('dxy'), say('gold', (v) => `US$ ${v.toFixed(0)}`), say('brent', (v) => `US$ ${v.toFixed(2)}`)) || 'FX and commodity indicators unavailable.',
      macro_political: facts.macro_vintage
        ? `Reference macro view: ${facts.macro_vintage.headline} (${facts.macro_vintage.provider}, published ${facts.macro_vintage.published}). Compare against the live series above rather than substituting for them.`
        : 'No macro research vintage attached.',
      main_risk_or_opportunity: fired.length
        ? `${fired.length} threshold${fired.length > 1 ? 's' : ''} breached: ${fired.map((t) => t.label).join('; ')}.`
        : 'No configured threshold is currently breached. Monitor the approaching set.',
    },
    stance_by_asset_class: {
      'Equities BR': 'neutral', 'Equities Global': 'neutral', 'Fixed Income': 'neutral',
      Alternatives: 'neutral', 'Real Estate': 'neutral', Commodities: 'neutral', Cash: 'neutral',
    },
    stance_rationale: 'Generated without a language model. Stances default to neutral and must be set by the advisor before this world view is used in a client conversation.',
    generated_without_model: true,
  };
}

/** The daily inference without a model: Portuguese, from the same facts, stances neutral. */
export function deterministicDailyInference(facts) {
  const ind = Object.fromEntries((facts.indicators || []).map((i) => [i.key, i]));
  const fired = (facts.triggers || []).filter((t) => t.status === 'BREACHED');
  const n = (v, d = 2) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  // FACTS.indicators carries the figures as formatted strings (level, day,
  // d30), so the template quotes exactly what the model would have quoted,
  // with the timeframe written out.
  const say = (k) => {
    const i = ind[k];
    if (!i || i.unavailable || !i.level) return null;
    const moves = [i.day ? `${i.day} no dia` : null, i.d30 ? `${i.d30} em 30 dias` : null].filter(Boolean);
    return `${i.label} em ${i.level}${moves.length ? ` (${moves.join('; ')})` : ''}`;
  };
  const join = (...xs) => xs.filter(Boolean).join('; ');
  const headline = fired.length
    ? `${fired[0].label}: limiar rompido`
    : 'Nenhum limiar monitorado foi rompido hoje';
  const events = (facts.events || []).slice();
  const order = { high: 0, medium: 1, low: 2 };
  const candidates = new Map((facts.candidates || []).map((c) => [c.event_id, c]));
  const whatMatters = events
    .filter((e) => candidates.has(e.id))
    .sort((a, b) => (order[a.importance] ?? 1) - (order[b.importance] ?? 1) || (candidates.get(b.id).max_exposure - candidates.get(a.id).max_exposure))
    .slice(0, 8)
    .map((e) => ({ event_id: e.id, importance: e.importance || 'medium', why_it_matters_pt: null, advisor_action_pt: null, source_ids: e.source_id ? [e.source_id] : [] }));
  return {
    headline_pt: headline,
    summary_pt: fired.length
      ? `${fired.length === 1 ? 'Um limiar monitorado foi rompido' : `${fired.length} limiares monitorados foram rompidos`}: ${fired.map((t) => t.label).join('; ')}. ${whatMatters.length} eventos do período tocam carteiras sob sua responsabilidade. Este resumo foi montado sem modelo de linguagem, a partir dos dados recuperados agora.`
      : `Nenhum limiar configurado está rompido. ${whatMatters.length} eventos do período tocam carteiras sob sua responsabilidade. Este resumo foi montado sem modelo de linguagem, a partir dos dados recuperados agora.`,
    briefing: {
      equities_pt: join(say('sp500', (v) => n(v, 0)), say('ibovespa', (v) => n(v, 0)), say('vix', (v) => n(v, 2))) || 'Indicadores de ações indisponíveis.',
      rates_credit_pt: join(say('us10y', (v) => `${n(v, 2)}%`), say('selic', (v) => `${n(v, 2)}%`), say('hy_etf', (v) => n(v, 2))) || 'Indicadores de juros e crédito indisponíveis.',
      fx_commodities_pt: join(say('usdbrl', (v) => `R$ ${n(v, 4)}`), say('dxy', (v) => n(v, 2)), say('gold', (v) => `US$ ${n(v, 0)}`), say('brent', (v) => `US$ ${n(v, 2)}`)) || 'Indicadores de câmbio e commodities indisponíveis.',
      macro_political_pt: facts.macro_vintage
        ? `Visão macro de referência: ${facts.macro_vintage.headline} (${facts.macro_vintage.provider}, publicada em ${facts.macro_vintage.published}). Compare com as séries ao vivo acima em vez de substituí-las.`
        : 'Nenhuma visão macro de referência anexada.',
      main_risk_or_opportunity_pt: fired.length
        ? `${fired.length === 1 ? 'Limiar rompido' : 'Limiares rompidos'}: ${fired.map((t) => t.label).join('; ')}.`
        : 'Nenhum limiar configurado está rompido. Acompanhe os que se aproximam.',
    },
    what_matters: whatMatters,
    stance_by_asset_class: {
      'Equities BR': 'neutral', 'Equities Global': 'neutral', 'Fixed Income': 'neutral',
      Alternatives: 'neutral', 'Real Estate': 'neutral', Commodities: 'neutral', Cash: 'neutral',
    },
    stance_rationale_pt: 'Gerado sem modelo de linguagem. As posturas ficam neutras e devem ser definidas pelo assessor antes de usar esta visão em uma conversa com cliente.',
    generated_without_model: true,
  };
}

/**
 * Portuguese rationale lines without a model.
 *
 * These are built from the structured factors rather than from the English
 * advisor-facing labels, because a client letter that reads like a translated
 * internal note is worse than one written plainly in Portuguese.
 */
const TECH_PT = {
  'Strong Buy': 'compra forte', Buy: 'compra', Neutral: 'neutro', Sell: 'venda', 'Strong Sell': 'venda forte',
};

export function deterministicRationales(facts) {
  const out = {};
  for (const r of facts.recommendations || []) {
    const flag = (r.flags || []).find((f) => f.severity === 'high') || (r.flags || [])[0];
    const tech = r.technical_signal ? TECH_PT[r.technical_signal] || r.technical_signal.toLowerCase() : null;
    const analyst = r.analyst_signal ? TECH_PT[r.analyst_signal] || r.analyst_signal.toLowerCase() : null;

    if (r.signal_conflict && tech && analyst) {
      out[r.asset_id] = `A leitura técnica aponta ${tech} e o consenso de ${r.analyst_count} analistas aponta ${analyst}. Como os dois sinais discordam, prefiro decidirmos juntos em vez de agir por um deles.`;
      continue;
    }
    if (r.suitability_result && r.suitability_result !== 'PASS') {
      out[r.asset_id] = flag?.message_pt || flag?.message
        || 'A sugestão está condicionada a uma restrição da sua política de investimentos e serve apenas para discussão.';
      continue;
    }
    if (r.final_action === 'ADD' && tech) {
      const upside = r.implied_upside != null ? ` O preço-alvo médio dos analistas está ${percent(r.implied_upside, { locale: L })} acima do preço atual.` : '';
      out[r.asset_id] = r.current_weight > 0
        ? `Sinal técnico de ${tech} e a classe ainda tem espaço dentro da faixa aprovada.${upside}`
        : `A classe está abaixo do mínimo previsto na sua política e o sinal técnico é de ${tech}.${upside}`;
      continue;
    }
    if (r.final_action === 'REDUCE') {
      out[r.asset_id] = flag?.message_pt || `A posição está em ${weightPt(r.current_weight)} da carteira e vale revisarmos o tamanho.`;
      continue;
    }
    if (r.final_action === 'HOLD') {
      out[r.asset_id] = tech
        ? `Sinal técnico de ${tech}${analyst ? ` e consenso de analistas de ${analyst}` : ''}; a posição está enquadrada e não vejo razão para mexer agora.`
        : 'Posição enquadrada na política, sem sinal de mercado que justifique mudança neste mês.';
      continue;
    }
    out[r.asset_id] = 'Sem sinal de mercado disponível para este ativo; trago para discutirmos na reunião.';
  }
  return out;
}

function weightPt(w) {
  return w == null ? '—' : `${(w * 100).toFixed(1).replace('.', ',')}%`;
}

export { PROMPT_VERSION };
