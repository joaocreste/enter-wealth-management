-- The report agent: one row per on-demand PDF report an advisor asked for.
-- Progress is written as the four steps advance (dados, análise, redação,
-- diagramação) so the tab that opened the run shows what is happening; the
-- composed model is kept so the PDF can be re-rendered on an R2 miss.
CREATE TABLE IF NOT EXISTS pdf_reports (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  advisor_id      TEXT NOT NULL REFERENCES advisors(id),
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  step            INTEGER NOT NULL DEFAULT 0,      -- 0 queued · 1 dados · 2 análise · 3 redação · 4 diagramação · 5 done
  progress        INTEGER NOT NULL DEFAULT 0,      -- 0..100
  message         TEXT,
  log_json        TEXT NOT NULL DEFAULT '[]',
  reporting_month TEXT,
  model_json      TEXT,                            -- the composed report model once diagrammed
  pdf_r2_key      TEXT,
  page_count      INTEGER,
  reduction_level INTEGER,
  omitted_json    TEXT,                            -- blocks the two-page rule left out
  narrative_mode  TEXT,                            -- model | deterministic_template
  error           TEXT,
  actor_id        TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pdf_reports_client ON pdf_reports (client_id, started_at DESC);
