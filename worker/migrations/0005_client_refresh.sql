-- Per-client data refresh: one row per "Atualizar dados" an advisor asks for
-- from a client page, half an hour before a meeting.
--
-- The run remarks every position of the client's approved snapshot at the
-- newest price its provider has, and writes the result as a NEW snapshot: the
-- portfolio is the same holdings on a later date, and the previous snapshot is
-- superseded rather than overwritten (§11). snapshot_id and previous_snapshot_id
-- record both ends of that move, so the audit trail says which valuation the
-- letter written after the run was based on.
--
-- result_json holds what the advisor is shown when it ends: the new total
-- against the old one, a line per position with the price it came from and the
-- provider that supplied it, the allocation against the policy, and whether the
-- day's panorama is older than the valuation now is.
CREATE TABLE IF NOT EXISTS client_refresh_runs (
  id                   TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL REFERENCES clients(id),
  advisor_id           TEXT NOT NULL REFERENCES advisors(id),
  status               TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  step                 INTEGER NOT NULL DEFAULT 0,   -- 0 queued · 1 preços · 2 carteira · 3 leitura · 4 done
  progress             INTEGER NOT NULL DEFAULT 0,   -- 0..100
  message              TEXT,
  log_json             TEXT NOT NULL DEFAULT '[]',
  previous_snapshot_id TEXT REFERENCES portfolio_snapshots(id),
  snapshot_id          TEXT REFERENCES portfolio_snapshots(id),
  result_json          TEXT,
  error                TEXT,
  actor_id             TEXT,
  started_at           TEXT NOT NULL,
  finished_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_refresh_client ON client_refresh_runs (client_id, started_at DESC);
