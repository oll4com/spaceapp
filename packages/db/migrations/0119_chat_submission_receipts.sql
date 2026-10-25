ALTER TABLE space_agent_runs
  ADD COLUMN client_request_id text,
  ADD COLUMN request_fingerprint text,
  ADD CONSTRAINT space_agent_runs_submission_receipt_check CHECK (
    (client_request_id IS NULL AND request_fingerprint IS NULL)
    OR (client_request_id IS NOT NULL AND length(client_request_id) BETWEEN 8 AND 128
      AND request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[a-f0-9]{64}$')
  );

CREATE UNIQUE INDEX space_agent_runs_pane_submission_unique
  ON space_agent_runs (pane_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
