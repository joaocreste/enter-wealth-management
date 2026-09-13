-- Bulk letters: one row per "Criar Cartas" run an advisor asks for from the
-- day's panorama. The run drives the report agent once per client in its book,
-- so each letter still gets its own pdf_reports row with its own four steps and
-- its own audit line; this table only records the sweep over them.
--
-- clients_json is the roster the run was started with — client id, name, the
-- pdf_reports run each one got, and how it ended — so the progress card can
-- name the person being written about, and a partial run can say which letters
-- are missing rather than only how many.
CREATE TABLE IF NOT EXISTS bulk_reports (
  id           TEXT PRIMARY KEY,
  advisor_id   TEXT NOT NULL REFERENCES advisors(id),
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  step         INTEGER NOT NULL DEFAULT 0,      -- 0 queued · 1..N the Nth client · N+1 the zip
  progress     INTEGER NOT NULL DEFAULT 0,      -- 0..100
  message      TEXT,                            -- what is happening right now, for the person waiting
  log_json     TEXT NOT NULL DEFAULT '[]',
  clients_json TEXT NOT NULL DEFAULT '[]',      -- [{client_id, name, run_id, status, error, page_count}]
  total        INTEGER NOT NULL DEFAULT 0,      -- letters asked for
  written      INTEGER NOT NULL DEFAULT 0,      -- letters that came out
  failed       INTEGER NOT NULL DEFAULT 0,
  reporting_month TEXT,
  zip_r2_key   TEXT,
  zip_name     TEXT,
  zip_bytes    INTEGER,
  error        TEXT,
  actor_id     TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_bulk_reports_advisor ON bulk_reports (advisor_id, started_at DESC);
