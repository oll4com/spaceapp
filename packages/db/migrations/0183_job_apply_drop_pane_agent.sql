-- Job Copilot panes briefly stored their CLI agent in job_apply_metadata.agent (2026-10-13). The Browser
-- Host parses pane rows with the contracts it loaded at start and rejects the unknown key, so browser
-- starts failed in rooms with such a pane. The account lives in the pane's CLI session instead.
UPDATE panes SET job_apply_metadata = job_apply_metadata - 'agent' WHERE job_apply_metadata ? 'agent';
