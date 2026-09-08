-- The daily agents (§34): one row per run of the three-step World Overview
-- pipeline. Progress is written as the run advances so a waiting user sees what
-- is happening; the finished payload is kept so the portal reads the last run
-- rather than recomputing on every visit.
CREATE TABLE IF NOT EXISTS overview_runs (
  id           TEXT PRIMARY KEY,
  advisor_id   TEXT NOT NULL REFERENCES advisors(id),
  date         TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('cron','manual','bootstrap')),
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  step         INTEGER NOT NULL DEFAULT 0,      -- 0 queued · 1 dados · 2 inferência · 3 gatilhos · 4 done
  progress     INTEGER NOT NULL DEFAULT 0,      -- 0..100
  message      TEXT,                            -- what is happening right now, for the person waiting
  log_json     TEXT NOT NULL DEFAULT '[]',
  result_json  TEXT,                            -- the overview payload once completed
  error        TEXT,
  actor_id     TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_overview_runs_advisor ON overview_runs (advisor_id, started_at DESC);
