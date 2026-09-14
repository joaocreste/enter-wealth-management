-- The monthly letter agent: one row per "criar carta mensal" run an advisor
-- asks for from the client page. Progress is written as the four steps advance
-- (dados, análise, redação, diagramação) so the tab that opened the run shows
-- what is happening; the letter itself lands in `reports`, which is where the
-- portal, the client and the approval flow all read it from, so this table
-- points at that row rather than holding a second copy of the document.
--
-- graph_run_id is the run in `graph_runs` that carries the intermediate state,
-- the same one the Rivet path writes, so a letter written from the portal shows
-- up in the client's Auditoria tab exactly as one written from the graph does.
CREATE TABLE IF NOT EXISTS letter_runs (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  advisor_id      TEXT NOT NULL REFERENCES advisors(id),
  graph_run_id    TEXT REFERENCES graph_runs(id),
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  step            INTEGER NOT NULL DEFAULT 0,      -- 0 queued · 1 dados · 2 análise · 3 redação · 4 diagramação · 5 done
  progress        INTEGER NOT NULL DEFAULT 0,      -- 0..100
  message         TEXT,
  log_json        TEXT NOT NULL DEFAULT '[]',
  reporting_month TEXT,
  reissue         INTEGER NOT NULL DEFAULT 0,      -- the advisor asked for a published month to be rewritten
  report_id       TEXT REFERENCES reports(id),     -- the letter this run produced
  report_status   TEXT,                            -- as it stood when the run ended
  blocked_by      TEXT,                            -- 'published' when the month's letter is immutable
  page_count      INTEGER,
  narrative_mode  TEXT,                            -- model | deterministic_template | deterministic_fallback_after_error
  error           TEXT,
  actor_id        TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_letter_runs_client ON letter_runs (client_id, started_at DESC);

-- The PDF report is gone: it was a second monthly document for the same client
-- and the same month, drawn from the same numbers as the carta mensal and
-- addressed to the same person, and two of those is one too many. Its runs are
-- dropped with it — the letters they stood for live in `reports`, unaffected.
DROP TABLE IF EXISTS pdf_reports;

-- A bulk sweep started before this migration points its roster at pdf_reports
-- rows that no longer exist. Its zip would come back empty rather than wrong,
-- but an empty archive is not worth offering, so those runs are closed.
UPDATE bulk_reports SET status = 'failed', error = 'as cartas desta execução foram escritas pelo agente de relatórios, que não existe mais; rode a varredura outra vez'
  WHERE status IN ('running', 'completed');
