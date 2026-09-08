/**
 * Loads the demo dataset into D1 (§28).
 *
 * Current-snapshot positions are valued with LIVE prices at seed time, so the
 * portal shows real market values from the first page load. Fund quota values
 * come from the simulated NAV series and are inserted as market_observations
 * with a provider string that says plainly that they are simulated — the UI
 * reads that string and badges them.
 */
import { all, first, run, id, nowIso } from './db.js';
import { hashPassword } from './auth.js';
import { ASSETS, ADVISOR } from '../../seed/seed.mjs';
import { CLIENTS, NAV_OBSERVATIONS, RETURN_HISTORY } from '../../seed/clients.mjs';
import { TRIGGERS, CURATED_EVENTS } from '../../seed/market.mjs';
import { quote } from '../../src/adapters/yahoo.js';
import * as bcb from '../../src/adapters/bcb.js';
import { useKv } from '../../src/adapters/cache.js';

const TABLES = [
  'sessions', 'audit_log', 'graph_runs', 'data_sources', 'reports', 'recommendations',
  'tradingview_signals', 'world_overviews', 'market_triggers', 'market_events',
  'market_observations', 'monthly_returns', 'cash_flows', 'positions', 'portfolio_snapshots',
  'meetings', 'investment_policies', 'assets', 'clients', 'advisors', 'users',
];

export async function seedDatabase(env) {
  if (env.MARKET_CACHE) useKv(env.MARKET_CACHE);
  const db = env.DB;
  const started = Date.now();

  for (const t of TABLES) await run(db, `DELETE FROM ${t}`);

  // ── users, advisor, clients ────────────────────────────────────────────
  const advPw = await hashPassword(ADVISOR.user.password);
  await run(db, 'INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?,?,?,?,?,?)',
    ADVISOR.user.id, ADVISOR.user.email, ADVISOR.user.name, 'advisor', advPw.hash, advPw.salt);
  await run(db, 'INSERT INTO advisors (id, user_id, advisor_code, team) VALUES (?,?,?,?)',
    ADVISOR.id, ADVISOR.user.id, ADVISOR.advisor_code, ADVISOR.team);

  for (const c of CLIENTS) {
    const pw = await hashPassword(c.user.password);
    await run(db, 'INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?,?,?,?,?,?)',
      c.user.id, c.user.email, c.user.name, 'client', pw.hash, pw.salt);
    await run(db, 'INSERT INTO clients (id, user_id, advisor_id, full_name, risk_profile, base_currency, segment, onboarded_at, next_review_at) VALUES (?,?,?,?,?,?,?,?,?)',
      c.id, c.user.id, ADVISOR.id, c.full_name, c.risk_profile, c.base_currency, c.segment, c.onboarded_at, c.next_review_at);
  }

  // ── assets ─────────────────────────────────────────────────────────────
  await db.batch(ASSETS.map((a) => db.prepare(
    `INSERT INTO assets (id, ticker, isin, name, type, asset_class, sector, issuer, currency, yahoo_symbol, tv_symbol, coingecko_id, pricing_mode, accrual_terms, liquidity_days, risk_grade, credit_rating, matured_before, corporate_action, corporate_action_note, concentration_exempt, successor_asset_id, portfolio_role)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    a.id, a.ticker ?? null, a.isin ?? null, a.name, a.type, a.asset_class, a.sector ?? null, a.issuer ?? null,
    a.currency, a.yahoo_symbol ?? null, a.tv_symbol ?? null, a.coingecko_id ?? null, a.pricing_mode,
    a.accrual_terms ? JSON.stringify(a.accrual_terms) : null, a.liquidity_days ?? null, a.risk_grade ?? null,
    a.credit_rating ?? null, a.matured_before ?? null, a.corporate_action ?? null,
    a.corporate_action_note ?? null, a.concentration_exempt ? 1 : 0, a.successor_asset_id ?? null,
    a.portfolio_role ?? null,
  )));

  // ── fund quota observations (simulated, and labelled as such) ───────────
  const CHUNK = 60;
  for (let i = 0; i < NAV_OBSERVATIONS.length; i += CHUNK) {
    const slice = NAV_OBSERVATIONS.slice(i, i + CHUNK);
    await db.batch(slice.map((o) => db.prepare(
      'INSERT INTO market_observations (id, asset_id, provider, observation_date, price, metadata_json) VALUES (?,?,?,?,?,?)',
    ).bind(id('obs'), o.asset_id, o.provider, o.observation_date, o.price, JSON.stringify({ simulated: true, provider: o.provider }))));
  }

  // ── live prices for the market-priced instruments in current snapshots ──
  const wanted = new Set();
  for (const c of CLIENTS) {
    for (const s of c.snapshots) {
      if (!s.is_current || !s.positions) continue;
      for (const p of s.positions) {
        const a = ASSETS.find((x) => x.id === p.asset_id);
        if (a?.pricing_mode === 'market' && a.yahoo_symbol) wanted.add(a.yahoo_symbol);
      }
    }
  }
  const prices = {};
  const priceSources = [];
  for (const sym of wanted) {
    const q = await quote(sym);
    if (!q.unavailable) { prices[sym] = q.price; priceSources.push(q.source); }
    else prices[sym] = null;
  }
  const fx = await bcb.series('USD_PTAX_SELL', addDays(-20), new Date().toISOString().slice(0, 10));
  const usdBrl = fx.unavailable || !fx.points.length ? null : fx.points[fx.points.length - 1].value;

  const navAt = (assetId, date) => {
    const rows = NAV_OBSERVATIONS.filter((o) => o.asset_id === assetId && o.observation_date <= date);
    return rows.length ? rows[rows.length - 1].price : null;
  };
  const today = new Date().toISOString().slice(0, 10);

  // ── policies, snapshots, positions, flows, meetings ─────────────────────
  const report = { clients: [], unpriced: [] };

  for (const c of CLIENTS) {
    for (const p of c.policies) {
      await run(db, `INSERT INTO investment_policies (id, client_id, version, effective_date, status, risk_profile, investment_horizon, liquidity_requirements, liquidity_requirement_days, objectives, base_currency, restrictions_json, target_allocation_json, permitted_ranges_json, single_name_cap, max_unhedged_fx, rebalance_trigger, notes, approved_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.id, p.client_id, p.version, p.effective_date,
        p.version === c.policies.length ? 'approved' : 'superseded',
        p.risk_profile, p.investment_horizon, p.liquidity_requirements, p.liquidity_requirement_days,
        p.objectives, p.base_currency, JSON.stringify(p.restrictions), JSON.stringify(p.target_allocation),
        JSON.stringify(p.permitted_ranges), p.single_name_cap, p.max_unhedged_fx, p.rebalance_trigger,
        p.notes, p.approved_by);
    }

    for (const s of c.snapshots) {
      if (s.meeting) {
        await run(db, 'INSERT INTO meetings (id, client_id, advisor_id, date, notes, status) VALUES (?,?,?,?,?,?)',
          s.meeting.id, c.id, ADVISOR.id, s.meeting.date, s.meeting.notes ?? null, 'held');
      }
      const policy = c.policies.find((p) => p.version === s.policy_version) || c.policies[c.policies.length - 1];
      const snapId = `snp_${c.id}_v${s.version}`;

      let positions = [];
      let total = 0;
      if (s.positions) {
        for (const p of s.positions) {
          const asset = ASSETS.find((x) => x.id === p.asset_id);
          let mv = p.market_value ?? null;
          let price = p.price ?? null;

          if (mv == null && asset) {
            if (asset.pricing_mode === 'market' && asset.yahoo_symbol) {
              price = prices[asset.yahoo_symbol];
              if (price != null) {
                const rate = asset.currency !== c.base_currency && usdBrl ? usdBrl : 1;
                mv = price * p.quantity * rate;
              } else {
                report.unpriced.push({ client: c.id, asset: asset.ticker || asset.name, reason: 'no provider price at seed time' });
              }
            } else if (asset.pricing_mode === 'nav') {
              price = navAt(asset.id, today);
              if (price != null) mv = price * p.quantity;
            } else if (asset.pricing_mode === 'accrual') {
              price = 1;
              mv = p.quantity;
            } else if (asset.pricing_mode === 'cash') {
              price = 1;
              mv = p.quantity;
            }
          }
          if (mv == null) continue;
          positions.push({ ...p, price, market_value: mv });
          total += mv;
        }
      } else {
        total = s.total_value ?? 0;
      }
      if (s.total_value != null && s.positions == null) total = s.total_value;

      await run(db, `INSERT INTO portfolio_snapshots (id, client_id, meeting_id, investment_policy_id, effective_date, status, total_value, cash_balance, base_currency, advisor_commentary)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        snapId, c.id, s.meeting?.id ?? null, policy.id, s.effective_date,
        s.is_current ? 'approved' : 'superseded', total, s.cash ?? 0, c.base_currency, s.commentary ?? null);

      if (positions.length) {
        await db.batch(positions.map((p) => db.prepare(
          'INSERT INTO positions (id, portfolio_snapshot_id, asset_id, quantity, cost_basis, price, market_value, portfolio_weight, acquired_at, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).bind(id('pos'), snapId, p.asset_id, p.quantity ?? null, p.cost_basis ?? null, p.price ?? null,
          p.market_value, total ? p.market_value / total : null, p.acquired_at ?? null, p.notes ?? null)));
      }
      if (s.is_current) report.clients.push({ id: c.id, name: c.full_name, total_value: total, positions: positions.length });
    }

    for (const f of c.flows || []) {
      await run(db, 'INSERT INTO cash_flows (id, client_id, date, amount, type, currency, description) VALUES (?,?,?,?,?,?,?)',
        id('cf'), c.id, f.date, f.amount, f.type, c.base_currency, f.description ?? null);
    }
    for (const m of c.meetings || []) {
      await run(db, 'INSERT INTO meetings (id, client_id, advisor_id, date, notes, status) VALUES (?,?,?,?,?,?)',
        m.id, c.id, ADVISOR.id, m.date, m.notes ?? null, m.status || 'scheduled');
    }
  }

  // ── return history ─────────────────────────────────────────────────────
  for (let i = 0; i < RETURN_HISTORY.length; i += CHUNK) {
    const slice = RETURN_HISTORY.slice(i, i + CHUNK);
    await db.batch(slice.map((r) => db.prepare(
      'INSERT INTO monthly_returns (id, client_id, month, portfolio_return, benchmark_return, method) VALUES (?,?,?,?,?,?)',
    ).bind(id('mr'), r.client_id, r.month, r.portfolio_return, r.benchmark_return, r.method)));
  }

  // ── triggers and curated events ────────────────────────────────────────
  await db.batch(TRIGGERS.map((t) => db.prepare(
    `INSERT INTO market_triggers (id, label, indicator_key, field, comparator, threshold, unit, approach_ratio, persistence_days, asset_classes_json, action, action_pt, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  ).bind(t.id, t.label, t.indicator_key, t.field || 'price', t.comparator, t.threshold, t.unit ?? null,
    t.approach_ratio ?? 0.95, t.persistence_days ?? 1, JSON.stringify(t.asset_classes || []), t.action ?? null, t.action_pt ?? null)));

  await db.batch(CURATED_EVENTS.map((e) => db.prepare(
    `INSERT INTO market_events (id, date, title, category, summary, title_pt, summary_pt, impact_note_pt, discussion_prompt_pt, direction, move_label, indicator_key, asset_classes_json, instruments_json, impact_note, discussion_prompt, importance, source_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(e.id, e.date, e.title, e.category, e.summary,
    e.title_pt ?? null, e.summary_pt ?? null, e.impact_note_pt ?? null, e.discussion_prompt_pt ?? null,
    e.direction ?? null, e.move_label ?? null,
    e.indicator_key ?? null, JSON.stringify(e.asset_classes || []), JSON.stringify(e.instruments || []),
    e.impact_note ?? null, e.discussion_prompt ?? null, e.importance || 'medium',
    e.source ? `${e.source.provider}:${e.source.identifier}` : null)));

  return {
    ok: true,
    elapsed_ms: Date.now() - started,
    advisor: ADVISOR.user.email,
    clients: report.clients,
    assets: ASSETS.length,
    nav_observations: NAV_OBSERVATIONS.length,
    return_history: RETURN_HISTORY.length,
    triggers: TRIGGERS.length,
    events: CURATED_EVENTS.length,
    live_prices: Object.entries(prices).filter(([, v]) => v != null).length,
    unpriced: report.unpriced,
    usd_brl: usdBrl,
    logins: {
      advisor: { email: ADVISOR.user.email, password: ADVISOR.user.password },
      clients: CLIENTS.map((c) => ({ email: c.user.email, password: c.user.password })),
    },
  };
}

function addDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
