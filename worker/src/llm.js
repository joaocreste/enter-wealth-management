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

export async function complete(env, { system, user, maxTokens = 2000, temperature = 0.3 }) {
  if (env.ANTHROPIC_API_KEY) {
    const model = env.ANTHROPIC_MODEL || 'claude-opus-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature, system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return { text: (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), model, provider: 'anthropic' };
  }

  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_MODEL || 'gpt-4o';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature,
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
  return { data: parsed, model: out.model, provider: out.provider, prompt_version: p.prompt_version };
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
