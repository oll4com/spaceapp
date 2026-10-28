-- Needs-you records nothing could close (operator 2026-10-25: the focus kept taking them to panes with nothing to do).
-- A Job Copilot posting parked without a question id raised a QUESTION keyed by its event id, which no answer resolves
-- (the producer stopped on 2026-10-25); they are closed once.
UPDATE space_notifications SET status = 'RESOLVED', resolved_at = now(), updated_at = now()
WHERE source = 'JOB_COPILOT' AND kind = 'QUESTION' AND dedupe_key LIKE 'job-apply:question:jobevt:%' AND status IN ('OPEN', 'READ');
-- A read after the record was resolved or acknowledged turned it back into READ (the read now moves only forward); restore it.
UPDATE space_notifications SET status = CASE WHEN resolved_at IS NOT NULL THEN 'RESOLVED' ELSE 'ACKED' END, updated_at = now()
WHERE status = 'READ' AND (resolved_at IS NOT NULL OR acked_at IS NOT NULL);
