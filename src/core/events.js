/**
 * Journal-to-portfolio impact (§6).
 *
 * Turns "what moved today" plus "what happened today" into a row an advisor can
 * actually use in a client conversation: the move, why it matters, what the
 * client owns that is exposed, the likely direction of travel, and a discussion
 * prompt. The discussion prompt is never an instruction to trade.
 *
 * The mapping from an event to an exposure is data-driven (`asset_classes`,
 * `instruments`, `factor`), so the same engine works for a new event category
 * without touching this file.
 */

/** How a move is named beside its figure. A move without its timeframe is a number without a unit. */
export const MOVE_WINDOWS = { day: 'no dia', '5d': 'em 5 sessões', '30d': 'em 30 dias' };

/**
 * The one longer window worth showing beside the day move: five sessions when
 * they moved 3% or more, else thirty days at 5% or more, else nothing. The
 * day move is always shown; this is the exception that earns a second line.
 */
export function notableWindow(ind, { d5 = 0.03, d30 = 0.05 } = {}) {
  if (!ind) return null;
  if (ind.d5Pct != null && Math.abs(ind.d5Pct) >= d5) return { key: '5d', pct: ind.d5Pct, label_pt: MOVE_WINDOWS['5d'], from: ind.d5From ?? null };
  if (ind.d30Pct != null && Math.abs(ind.d30Pct) >= d30) return { key: '30d', pct: ind.d30Pct, label_pt: MOVE_WINDOWS['30d'], from: ind.d30From ?? null };
  return null;
}

/**
 * Where an event belongs on the advisor's table: Brazil or the rest of the
 * world. The newsroom feed is Brazilian by construction and the web scan is
 * told to look only outside Brazil, so the kind decides first; a market move
 * follows its indicator; a curated event without one follows its asset
 * classes. An explicit `region` on the event always wins.
 */
export const REGIONS = ['br', 'intl'];
export const REGION_PT = { br: 'Brasil', intl: 'Internacional' };
const BR_INDICATORS = new Set(['ibovespa', 'selic', 'ipca', 'usdbrl']);
export function eventRegion(e) {
  if (!e) return 'intl';
  if (REGIONS.includes(e.region)) return e.region;
  if (e.kind === 'headline') return 'br';
  if (e.kind === 'news') return 'intl';
  if (e.indicator_key) return BR_INDICATORS.has(e.indicator_key) ? 'br' : 'intl';
  const classes = e.asset_classes || e.exposure_summary?.asset_classes || [];
  if (classes.includes('Equities BR') && !classes.includes('Equities Global')) return 'br';
  if (['Equities Global', 'Commodities', 'Digital Assets'].some((k) => classes.includes(k))) return 'intl';
  return 'br';
}

/**
 * @param {object} event      { id, date, title, category, summary, direction, magnitude, asset_classes, instruments, importance, source_id }
 * @param {object} portfolio  { exposures: {class: weight}, positions: [{ticker, asset_class, weight, currency}], base_currency }
 */
export function mapEventToPortfolio(event, portfolio) {
  const classExposure = (event.asset_classes || []).reduce((a, k) => a + (portfolio.exposures?.[k] ?? 0), 0);

  const directHoldings = (portfolio.positions || []).filter((p) =>
    (event.instruments || []).includes(p.ticker) || (event.instruments || []).includes(p.asset_id));

  const directWeight = directHoldings.reduce((a, p) => a + (p.weight ?? 0), 0);

  // Currency events touch every position not denominated in the base currency.
  let fxWeight = 0;
  if (event.category === 'fx' || (event.asset_classes || []).includes('FX')) {
    fxWeight = (portfolio.positions || [])
      .filter((p) => p.currency && p.currency !== portfolio.base_currency)
      .reduce((a, p) => a + (p.weight ?? 0), 0);
  }

  const totalExposure = Math.max(classExposure, directWeight, fxWeight);
  const relevance = totalExposure >= 0.20 ? 'high' : totalExposure >= 0.05 ? 'medium' : totalExposure > 0 ? 'low' : 'none';

  return {
    event_id: event.id,
    date: event.date,
    title: event.title,
    title_pt: event.title_pt ?? event.title,
    category: event.category,
    move: event.move_label ?? null,
    why_it_matters: event.summary,
    why_it_matters_pt: event.summary_pt ?? null,
    portfolio_exposure: {
      asset_classes: (event.asset_classes || []).map((k) => ({ asset_class: k, weight: portfolio.exposures?.[k] ?? 0 })).filter((x) => x.weight > 0),
      direct_holdings: directHoldings.map((p) => ({ ticker: p.ticker, weight: p.weight })),
      fx_translated_weight: fxWeight || null,
      total_exposure: totalExposure,
    },
    potential_impact: event.impact_note || impactSentence(event, totalExposure, 'en'),
    potential_impact_pt: event.impact_note_pt || impactSentence(event, totalExposure, 'pt'),
    direction: event.direction ?? null,
    relevance,
    discussion_prompt: event.discussion_prompt || defaultPrompt(event, portfolio),
    discussion_prompt_pt: event.discussion_prompt_pt || null,
    source_id: event.source_id ?? null,
    // §17 — this is a conversation starter, never an order
    is_discussion_only: true,
  };
}

function impactSentence(event, exposure, lang = 'en') {
  if (exposure <= 0) {
    return lang === 'pt' ? 'Sem exposição material nesta carteira.' : 'No material exposure in this portfolio.';
  }
  if (lang === 'pt') {
    const pct = `${(exposure * 100).toFixed(1).replace('.', ',')}%`;
    const dir = event.direction === 'positive' ? 'que este movimento favorece'
      : event.direction === 'negative' ? 'em que este movimento pesa'
        : 'afetadas por este movimento';
    return `${pct} da carteira está nas classes de ativo ${dir}.`;
  }
  const pct = `${(exposure * 100).toFixed(1)}%`;
  const dir = event.direction === 'positive' ? 'supportive of' : event.direction === 'negative' ? 'a headwind for' : 'relevant to';
  return `${pct} of the portfolio sits in the asset classes this development is ${dir}.`;
}

function defaultPrompt(event, portfolio) {
  const k = (event.asset_classes || [])[0];
  if (!k) return 'Review whether this development changes anything in the approved policy.';
  const w = portfolio.exposures?.[k] ?? 0;
  return `Discuss whether the ${(w * 100).toFixed(1)}% allocation to ${k} remains appropriate within the client's approved range.`;
}

/** Build the full "What Matters Today" table for one advisor across their book. */
export function buildWhatMattersTable(events, indicators, clientPortfolios) {
  const rows = [];
  for (const event of events) {
    const perClient = clientPortfolios.map((cp) => ({
      client_id: cp.client_id,
      client_name: cp.client_name,
      ...mapEventToPortfolio(event, cp.portfolio),
    })).filter((r) => r.relevance !== 'none');

    // A story the whole market is reading stays on the table even when the
    // exposure arithmetic finds little: the clients will ask about it anyway.
    if (!perClient.length && event.importance !== 'high' && !event.market_wide) continue;

    const indicator = indicators.find((i) => i.key === event.indicator_key) || null;
    rows.push({
      event_id: event.id,
      date: event.date,
      event: event.title,
      event_pt: event.title_pt ?? null,
      indicator_key: event.indicator_key ?? null,
      region: eventRegion(event),
      current_move: indicator
        ? {
          value: indicator.price, unit: indicator.unit, asOf: indicator.asOf, unavailable: !!indicator.unavailable,
          changePct: indicator.changePct ?? null,               // the day: always shown
          d5Pct: indicator.d5Pct ?? null, d30Pct: indicator.d30Pct ?? null,
          notable: notableWindow(indicator),                    // the one longer window worth a second line, timeframe named
          mtdPct: indicator.mtdPct ?? null,                     // kept for the strip; the table does not show it
          level: indicator.level ?? null,                       // a policy rate or a monthly index: level, last change, previous value
        }
        : (event.move_label ? { label: event.move_label } : null),
      why_it_matters: event.summary,
      why_it_matters_pt: event.summary_pt ?? null,
      exposure_summary: {
        clients_affected: perClient.length,
        max_exposure: perClient.reduce((a, r) => Math.max(a, r.portfolio_exposure.total_exposure), 0),
        asset_classes: event.asset_classes || [],
      },
      potential_impact: event.impact_note || (perClient[0]?.potential_impact ?? null),
      potential_impact_pt: event.impact_note_pt || (perClient[0]?.potential_impact_pt ?? null),
      advisor_action: event.discussion_prompt || 'Review exposure and confirm it remains inside the approved policy range.',
      advisor_action_pt: event.discussion_prompt_pt || 'Revisar a exposição e confirmar que ela segue dentro da faixa aprovada na política.',
      importance: event.importance || 'medium',
      market_wide: !!event.market_wide,
      coverage: event.coverage ?? null,
      per_client: perClient,
      source_id: event.source_id ?? null,
      source_label: event.source_label ?? null,
      indicator_source_id: indicator?.source?.id ?? null,
    });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return rows.sort((a, b) =>
    (Number(b.market_wide) - Number(a.market_wide)) ||
    (order[a.importance] - order[b.importance]) ||
    (b.exposure_summary.max_exposure - a.exposure_summary.max_exposure));
}
