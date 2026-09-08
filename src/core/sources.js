/**
 * Source attribution ledger.
 *
 * Every factual market statement in a client report must be traceable to a
 * provider, an instrument, a requested range and a retrieval timestamp.
 * Nothing enters the canonical report without a source id.
 *
 * A fallback is never silent: when a primary provider fails and a fallback is
 * used, the record keeps `fallback_for` so the audit trail shows the switch.
 */

let counter = 0;

export function newSourceId(prefix = 'src') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * @param {object} o
 * @param {string} o.provider           e.g. "Yahoo Finance", "TradingView", "Banco Central do Brasil"
 * @param {string} [o.instrument]       human name, e.g. "S&P 500"
 * @param {string} [o.identifier]       ticker / series code, e.g. "^GSPC", "BCB-SGS-11"
 * @param {string} [o.requested_range]  e.g. "2026-07-31..2026-08-31"
 * @param {string} [o.last_observation] ISO date of the newest observation actually used
 * @param {string} [o.reference]        URL or provider reference
 * @param {string} [o.fallback_for]     provider this record replaced
 * @param {string} [o.kind]             market_price | signal | macro | news | statement | derived
 * @param {boolean} [o.mocked]          true only for adapters that do not reach a real provider
 */
export function makeSource(o) {
  return {
    id: o.id || newSourceId(o.kind === 'signal' ? 'tv' : 'src'),
    provider: o.provider,
    kind: o.kind || 'market_price',
    instrument: o.instrument ?? null,
    identifier: o.identifier ?? null,
    requested_range: o.requested_range ?? null,
    retrieval_timestamp: o.retrieval_timestamp || new Date().toISOString(),
    last_observation: o.last_observation ?? null,
    reference: o.reference ?? null,
    fallback_for: o.fallback_for ?? null,
    mocked: o.mocked === true,
    notes: o.notes ?? null,
  };
}

/** Collects sources, de-duplicates, and renders the citation lines. */
export class SourceLedger {
  constructor() { this.map = new Map(); }

  add(source) {
    if (!source) return null;
    const key = `${source.provider}|${source.identifier}|${source.requested_range}|${source.kind}`;
    if (!this.map.has(key)) this.map.set(key, source);
    return this.map.get(key).id;
  }

  addAll(sources = []) { return sources.map((s) => this.add(s)).filter(Boolean); }

  all() { return [...this.map.values()]; }

  byId(id) { return this.all().find((s) => s.id === id) || null; }

  hasMock() { return this.all().some((s) => s.mocked); }

  /**
   * One-line provenance string for the advisor UI (§29).
   * "S&P 500: Yahoo Finance · ^GSPC · data through 31 Aug 2026"
   */
  static inspectLine(s) {
    const bits = [s.provider];
    if (s.identifier) bits.push(s.identifier);
    if (s.last_observation) bits.push(`data through ${s.last_observation}`);
    else if (s.requested_range) bits.push(s.requested_range);
    bits.push(`retrieved ${s.retrieval_timestamp.slice(0, 16).replace('T', ' ')}Z`);
    if (s.fallback_for) bits.push(`fallback for ${s.fallback_for}`);
    if (s.mocked) bits.push('MOCK DATA');
    return `${s.instrument ? s.instrument + ': ' : ''}${bits.join(' · ')}`;
  }

  /**
   * Compact citation block for the two-page letter (§29): grouped by provider,
   * instruments listed once, one date range per provider.
   */
  compactLines(locale = 'pt-BR') {
    const byProvider = new Map();
    for (const s of this.all()) {
      if (!byProvider.has(s.provider)) byProvider.set(s.provider, { instruments: new Set(), last: null, mocked: false });
      const g = byProvider.get(s.provider);
      if (s.identifier) g.instruments.add(s.identifier);
      if (s.last_observation && (!g.last || s.last_observation > g.last)) g.last = s.last_observation;
      if (s.mocked) g.mocked = true;
    }
    const word = locale === 'pt-BR' ? 'dados até' : 'data through';
    const out = [];
    for (const [provider, g] of byProvider) {
      const ins = [...g.instruments].slice(0, 8).join(', ');
      const more = g.instruments.size > 8 ? (locale === 'pt-BR' ? ` e outros ${g.instruments.size - 8}` : ` and ${g.instruments.size - 8} others`) : '';
      out.push(`${provider}${ins ? ` — ${ins}${more}` : ''}${g.last ? `; ${word} ${g.last}` : ''}${g.mocked ? ' [MOCK]' : ''}`);
    }
    return out;
  }
}

/** Standard record for a value that could not be sourced. Never fabricate (§30). */
export const DATA_UNAVAILABLE = Object.freeze({
  status: 'DATA_UNAVAILABLE',
  value: null,
  toString() { return 'DATA UNAVAILABLE'; },
});

export function unavailable(reason, attempted = []) {
  return { status: 'DATA_UNAVAILABLE', value: null, reason, providers_attempted: attempted };
}

export function isUnavailable(x) {
  return !x || x.status === 'DATA_UNAVAILABLE' || x.value === null || x.value === undefined;
}
