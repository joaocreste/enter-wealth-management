/** Thin D1 helpers. Every query that touches client data goes through a scope check. */

export const nowIso = () => new Date().toISOString();

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export async function all(db, sql, ...params) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

export async function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export function json(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Audit every state change a compliance reviewer would want to see (§31). */
export async function audit(db, { entity, entity_id, action, actor_id = null, detail = null }) {
  await run(
    db,
    'INSERT INTO audit_log (id, entity, entity_id, action, actor_id, detail_json) VALUES (?,?,?,?,?,?)',
    id('aud'), entity, entity_id, action, actor_id, detail ? JSON.stringify(detail) : null,
  );
}

/**
 * Authorization boundary (§24). An advisor may only reach clients assigned to
 * them; a client may only reach their own record. Every client-scoped route
 * goes through this function — there is no second path.
 */
export async function resolveClientScope(db, session, clientId) {
  if (!session) return { ok: false, status: 401, error: 'authentication required' };

  if (session.role === 'advisor' || session.role === 'service') {
    const advisor = session.role === 'service'
      ? await first(db, 'SELECT * FROM advisors LIMIT 1')
      : await first(db, 'SELECT * FROM advisors WHERE user_id = ?', session.user_id);
    if (!advisor) return { ok: false, status: 403, error: 'no advisor record for this user' };
    const client = session.role === 'service'
      ? await first(db, 'SELECT * FROM clients WHERE id = ?', clientId)
      : await first(db, 'SELECT * FROM clients WHERE id = ? AND advisor_id = ?', clientId, advisor.id);
    if (!client) return { ok: false, status: 404, error: 'client not found in this advisor book' };
    const owner = await first(db, 'SELECT * FROM advisors WHERE id = ?', client.advisor_id);
    return { ok: true, client, advisor: owner || advisor, actingAs: session.role };
  }

  if (session.role === 'client') {
    const client = await first(db, 'SELECT * FROM clients WHERE id = ? AND user_id = ?', clientId, session.user_id);
    if (!client) return { ok: false, status: 403, error: 'clients may only access their own record' };
    const advisor = await first(db, 'SELECT * FROM advisors WHERE id = ?', client.advisor_id);
    return { ok: true, client, advisor, actingAs: 'client' };
  }

  return { ok: false, status: 403, error: 'role not permitted' };
}

export async function currentPolicy(db, clientId) {
  const row = await first(
    db,
    "SELECT * FROM investment_policies WHERE client_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1",
    clientId,
  );
  return row ? hydratePolicy(row) : null;
}

export function hydratePolicy(row) {
  return {
    ...row,
    restrictions: json(row.restrictions_json, []),
    target_allocation: json(row.target_allocation_json, {}),
    permitted_ranges: json(row.permitted_ranges_json, {}),
  };
}

export async function currentSnapshot(db, clientId) {
  return first(
    db,
    "SELECT * FROM portfolio_snapshots WHERE client_id = ? AND status = 'approved' ORDER BY effective_date DESC, created_at DESC LIMIT 1",
    clientId,
  );
}

export async function snapshotPositions(db, snapshotId) {
  return all(
    db,
    `SELECT p.*, a.ticker, a.isin, a.name AS asset_name, a.type, a.asset_class, a.sector, a.issuer,
            a.currency, a.yahoo_symbol, a.tv_symbol, a.coingecko_id, a.pricing_mode, a.accrual_terms,
            a.liquidity_days, a.risk_grade, a.credit_rating, a.matured_before, a.corporate_action,
            a.corporate_action_note, a.concentration_exempt, a.successor_asset_id, a.portfolio_role
       FROM positions p JOIN assets a ON a.id = p.asset_id
      WHERE p.portfolio_snapshot_id = ?`,
    snapshotId,
  );
}

export function positionToAsset(row) {
  return {
    id: row.asset_id,
    ticker: row.ticker,
    isin: row.isin,
    name: row.asset_name,
    type: row.type,
    asset_class: row.asset_class,
    sector: row.sector,
    issuer: row.issuer,
    currency: row.currency,
    yahoo_symbol: row.yahoo_symbol,
    tv_symbol: row.tv_symbol,
    coingecko_id: row.coingecko_id,
    pricing_mode: row.pricing_mode,
    accrual_terms: json(row.accrual_terms, null),
    liquidity_days: row.liquidity_days,
    risk_grade: row.risk_grade,
    credit_rating: row.credit_rating,
    matured_before: row.matured_before,
    corporate_action: row.corporate_action,
    corporate_action_note: row.corporate_action_note,
    concentration_exempt: !!row.concentration_exempt,
    successor_asset_id: row.successor_asset_id,
    portfolio_role: row.portfolio_role,
  };
}
