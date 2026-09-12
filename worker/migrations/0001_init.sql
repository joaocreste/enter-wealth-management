-- XP Asset Management — advisory portal schema (Cloudflare D1 / SQLite)
-- §25. Every table that participates in a client report is append-only in
-- practice: snapshots, policies and reports are versioned rather than updated,
-- so a published report can always be reproduced from its inputs (§31).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('advisor','client','admin')),
  auth_identifier TEXT,                       -- Cloudflare Access subject when SSO is enabled
  password_hash   TEXT,                       -- PBKDF2 fallback for the local/demo login
  password_salt   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS advisors (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  advisor_code TEXT,
  team         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  advisor_id     TEXT NOT NULL REFERENCES advisors(id),
  full_name      TEXT NOT NULL,
  risk_profile   TEXT NOT NULL,
  base_currency  TEXT NOT NULL DEFAULT 'BRL',
  segment        TEXT,
  onboarded_at   TEXT,
  next_review_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_advisor ON clients(advisor_id);

CREATE TABLE IF NOT EXISTS investment_policies (
  id                         TEXT PRIMARY KEY,
  client_id                  TEXT NOT NULL REFERENCES clients(id),
  version                    INTEGER NOT NULL,
  effective_date             TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','superseded')),
  risk_profile               TEXT NOT NULL,
  investment_horizon         TEXT,
  liquidity_requirements     TEXT,
  liquidity_requirement_days INTEGER,
  objectives                 TEXT,
  base_currency              TEXT NOT NULL DEFAULT 'BRL',
  restrictions_json          TEXT NOT NULL DEFAULT '[]',
  target_allocation_json     TEXT NOT NULL DEFAULT '{}',
  permitted_ranges_json      TEXT NOT NULL DEFAULT '{}',
  single_name_cap            REAL DEFAULT 0.10,
  max_unhedged_fx            REAL,
  rebalance_trigger          REAL DEFAULT 0.05,
  notes                      TEXT,
  approved_by                TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, version)
);
CREATE INDEX IF NOT EXISTS idx_policies_client ON investment_policies(client_id, version DESC);

CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  ticker          TEXT,
  isin            TEXT,
  name            TEXT NOT NULL,
  type            TEXT,                    -- stock | etf | fund | cdb | cash | crypto
  asset_class     TEXT NOT NULL,
  sector          TEXT,
  issuer          TEXT,
  currency        TEXT NOT NULL DEFAULT 'BRL',
  yahoo_symbol    TEXT,
  tv_symbol       TEXT,
  coingecko_id    TEXT,
  pricing_mode    TEXT NOT NULL DEFAULT 'market' CHECK (pricing_mode IN ('market','nav','accrual','cash')),
  accrual_terms   TEXT,                    -- json: { index, spread_pa, percent_of_index }
  liquidity_days  INTEGER,
  risk_grade      INTEGER,                 -- 1 (cash-like) .. 5 (high risk)
  credit_rating   TEXT,
  matured_before  TEXT,
  corporate_action TEXT,                   -- set only when the listing no longer prices (blocking)
  corporate_action_note TEXT,              -- resolved action, informational only
  concentration_exempt INTEGER NOT NULL DEFAULT 0,  -- broad index wrappers: the single-name cap does not apply
  successor_asset_id TEXT,
  portfolio_role  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_ticker ON assets(ticker);

CREATE TABLE IF NOT EXISTS meetings (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  advisor_id TEXT NOT NULL REFERENCES advisors(id),
  date       TEXT NOT NULL,
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_preparation','held','cancelled')),
  agenda_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client_id, date DESC);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id                    TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES clients(id),
  meeting_id            TEXT REFERENCES meetings(id),
  investment_policy_id  TEXT NOT NULL REFERENCES investment_policies(id),
  effective_date        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','superseded')),
  total_value           REAL NOT NULL,
  cash_balance          REAL NOT NULL DEFAULT 0,
  base_currency         TEXT NOT NULL DEFAULT 'BRL',
  advisor_commentary    TEXT,
  world_overview_id     TEXT,
  recommendation_set_id TEXT,
  metrics_json          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_client ON portfolio_snapshots(client_id, effective_date DESC);

CREATE TABLE IF NOT EXISTS positions (
  id                    TEXT PRIMARY KEY,
  portfolio_snapshot_id TEXT NOT NULL REFERENCES portfolio_snapshots(id),
  asset_id              TEXT NOT NULL REFERENCES assets(id),
  quantity              REAL,
  cost_basis            REAL,
  price                 REAL,
  market_value          REAL NOT NULL,
  portfolio_weight      REAL,
  acquired_at           TEXT,
  notes                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_snapshot ON positions(portfolio_snapshot_id);

-- External cash flows and income, needed for a cash-flow-correct return (§13)
CREATE TABLE IF NOT EXISTS cash_flows (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  asset_id   TEXT REFERENCES assets(id),
  date       TEXT NOT NULL,
  amount     REAL NOT NULL,                -- positive contribution, negative withdrawal
  type       TEXT NOT NULL CHECK (type IN ('contribution','withdrawal','income','fee','tax')),
  currency   TEXT NOT NULL DEFAULT 'BRL',
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_flows_client ON cash_flows(client_id, date);

CREATE TABLE IF NOT EXISTS market_observations (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT REFERENCES assets(id),
  instrument_key   TEXT,
  provider         TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  price            REAL,
  metadata_json    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obs_asset_date ON market_observations(asset_id, observation_date);

CREATE TABLE IF NOT EXISTS market_events (
  id             TEXT PRIMARY KEY,
  date           TEXT NOT NULL,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,            -- equities | rates | credit | fx | commodities | macro | geopolitics | crypto
  summary        TEXT NOT NULL,
  -- §5.7 Portuguese and English are equal; neither is a translation layer over
  -- the other. Advisor surfaces read the English fields, the client letter reads
  -- the Portuguese ones, and both are authored.
  title_pt       TEXT,
  summary_pt     TEXT,
  impact_note_pt TEXT,
  discussion_prompt_pt TEXT,
  direction      TEXT,                     -- positive | negative | mixed
  move_label     TEXT,
  indicator_key  TEXT,
  asset_classes_json TEXT NOT NULL DEFAULT '[]',
  instruments_json   TEXT NOT NULL DEFAULT '[]',
  impact_note    TEXT,
  discussion_prompt TEXT,
  importance     TEXT NOT NULL DEFAULT 'medium' CHECK (importance IN ('high','medium','low')),
  source_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON market_events(date DESC);

CREATE TABLE IF NOT EXISTS market_triggers (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  indicator_key    TEXT NOT NULL,
  field            TEXT NOT NULL DEFAULT 'price',
  comparator       TEXT NOT NULL DEFAULT 'gt',
  threshold        REAL NOT NULL,
  unit             TEXT,
  approach_ratio   REAL DEFAULT 0.95,
  persistence_days INTEGER DEFAULT 1,
  asset_classes_json TEXT NOT NULL DEFAULT '[]',
  action           TEXT,
  action_pt        TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  advisor_id       TEXT REFERENCES advisors(id),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tradingview_signals (
  id                 TEXT PRIMARY KEY,
  asset_id           TEXT NOT NULL REFERENCES assets(id),
  tv_symbol          TEXT,
  technical_signal   TEXT,
  technical_rating   REAL,
  technical_timeframe TEXT,
  technical_weekly   TEXT,
  rsi_14             REAL,
  analyst_signal     TEXT,
  analyst_mark       REAL,
  analyst_count      INTEGER,
  analyst_buy        INTEGER,
  analyst_hold       INTEGER,
  analyst_sell       INTEGER,
  target_price       REAL,
  target_high        REAL,
  target_low         REAL,
  implied_upside     REAL,
  unavailable_reason TEXT,
  captured_at        TEXT NOT NULL,
  source_id          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tv_asset ON tradingview_signals(asset_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS recommendations (
  id                     TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES clients(id),
  asset_id               TEXT NOT NULL REFERENCES assets(id),
  reporting_month        TEXT NOT NULL,
  recommendation_set_id  TEXT NOT NULL,
  tradingview_signal_id  TEXT REFERENCES tradingview_signals(id),
  proposed_action        TEXT NOT NULL,
  final_action           TEXT NOT NULL,
  suitability_result     TEXT NOT NULL,
  score                  REAL,
  conviction             REAL,
  signal_conflict        INTEGER NOT NULL DEFAULT 0,
  current_weight         REAL,
  rationale              TEXT,
  factors_json           TEXT,
  flags_json             TEXT,
  statement_json         TEXT,
  advisor_status         TEXT NOT NULL DEFAULT 'proposed' CHECK (advisor_status IN ('proposed','approved','rejected','edited')),
  advisor_note           TEXT,
  decided_at             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recs_client ON recommendations(client_id, recommendation_set_id);
-- One live proposal per asset per reporting month, so re-running the workflow
-- refreshes the analysis in place instead of discarding the advisor's decisions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recs_month_asset ON recommendations(client_id, reporting_month, asset_id);

CREATE TABLE IF NOT EXISTS world_overviews (
  id                 TEXT PRIMARY KEY,
  advisor_id         TEXT NOT NULL REFERENCES advisors(id),
  date               TEXT NOT NULL,
  generated_summary  TEXT,
  briefing_json      TEXT,
  advisor_commentary TEXT,
  stance_json        TEXT,
  approval_status    TEXT NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','approved')),
  approved_at        TEXT,
  sources_json       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (advisor_id, date)
);

CREATE TABLE IF NOT EXISTS reports (
  id                    TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES clients(id),
  advisor_id            TEXT NOT NULL REFERENCES advisors(id),
  portfolio_snapshot_id TEXT REFERENCES portfolio_snapshots(id),
  reporting_month       TEXT NOT NULL,
  canonical_report_json TEXT NOT NULL,
  html_r2_key           TEXT,
  pdf_r2_key            TEXT,
  portal_r2_key         TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','published')),
  page_count            INTEGER,
  approved_at           TEXT,
  published_at          TEXT,
  graph_run_id          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, reporting_month)
);
CREATE INDEX IF NOT EXISTS idx_reports_client ON reports(client_id, reporting_month DESC);

CREATE TABLE IF NOT EXISTS data_sources (
  id                  TEXT PRIMARY KEY,
  report_id           TEXT REFERENCES reports(id),
  provider            TEXT NOT NULL,
  kind                TEXT,
  instrument          TEXT,
  identifier          TEXT,
  requested_range     TEXT,
  retrieval_timestamp TEXT NOT NULL,
  last_observation    TEXT,
  source_reference    TEXT,
  fallback_for        TEXT,
  mocked              INTEGER NOT NULL DEFAULT 0,
  metadata_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_report ON data_sources(report_id);

-- Full audit trail for a finalised report (§31)
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor_id   TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS graph_runs (
  id            TEXT PRIMARY KEY,
  graph_name    TEXT NOT NULL,
  client_id     TEXT,
  advisor_id    TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  prompt_version TEXT,
  inputs_json   TEXT,
  outputs_json  TEXT,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monthly_returns (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  month       TEXT NOT NULL,
  portfolio_return REAL,
  benchmark_return REAL,
  method      TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, month)
);
