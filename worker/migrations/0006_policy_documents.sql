-- The investment policy as the client signed it: one row per PDF the advisor
-- uploaded for a client, newest marked current.
--
-- The policy already lives in `investment_policies` as structured parameters
-- the engine reads — bands, caps, restrictions. This table holds the document
-- those parameters were agreed in, which is what the advisor actually hands to
-- a client, opens in a meeting, and has to be able to replace when a new one is
-- signed. investment_policy_id says which version of the parameters the file
-- was current alongside.
--
-- Replacing never deletes: the previous document is marked superseded and its
-- R2 object stays, so a letter written under an older policy can still be read
-- against the document that governed it (§11).
CREATE TABLE IF NOT EXISTS policy_documents (
  id                   TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL REFERENCES clients(id),
  investment_policy_id TEXT REFERENCES investment_policies(id),
  version              INTEGER NOT NULL,           -- 1, 2, 3 … per client
  status               TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
  filename             TEXT NOT NULL,              -- as the advisor's machine named it
  content_type         TEXT NOT NULL,
  size_bytes           INTEGER NOT NULL,
  sha256               TEXT,                       -- so an identical re-upload is recognisable
  r2_key               TEXT NOT NULL,
  note                 TEXT,                       -- why it was replaced
  uploaded_by          TEXT,
  uploaded_at          TEXT NOT NULL,
  UNIQUE (client_id, version)
);
CREATE INDEX IF NOT EXISTS idx_policy_docs_client ON policy_documents (client_id, version DESC);
