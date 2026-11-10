-- R13-14 (29/10 13:17 BKK: a held Security restart whose target had already been met stayed on the operator's card): a held Security or
-- Monitoring change whose target is already there is SUPERSEDED by the copilot, its review card too.
ALTER TABLE security_copilot_actions DROP CONSTRAINT IF EXISTS security_copilot_actions_status_check;
ALTER TABLE security_copilot_actions ADD CONSTRAINT security_copilot_actions_status_check
  CHECK (status IN ('RUNNING','ASKED','APPROVED','DECLINED','VERIFIED','FAILED','ROLLED_BACK','SUPERSEDED'));
ALTER TABLE security_copilot_events DROP CONSTRAINT IF EXISTS security_copilot_events_check;
ALTER TABLE security_copilot_events ADD CONSTRAINT security_copilot_events_check
  CHECK ((type = 'BRIEF' AND status IN ('PENDING','TAKEN','DONE','FAILED'))
    OR (type = 'QUESTION' AND status IN ('OPEN','ANSWERED'))
    OR (type = 'REVIEW' AND status IN ('OPEN','APPROVED','DECLINED','SUPERSEDED'))
    OR (type NOT IN ('BRIEF','QUESTION','REVIEW') AND status IS NULL));
ALTER TABLE monitoring_copilot_actions DROP CONSTRAINT IF EXISTS monitoring_copilot_actions_status_check;
ALTER TABLE monitoring_copilot_actions ADD CONSTRAINT monitoring_copilot_actions_status_check
  CHECK (status IN ('RUNNING','ASKED','APPROVED','DECLINED','VERIFIED','FAILED','ROLLED_BACK','SUPERSEDED'));
ALTER TABLE monitoring_copilot_events DROP CONSTRAINT IF EXISTS monitoring_copilot_events_check;
ALTER TABLE monitoring_copilot_events ADD CONSTRAINT monitoring_copilot_events_check
  CHECK ((type = 'BRIEF' AND status IN ('PENDING','TAKEN','DONE','FAILED'))
    OR (type = 'QUESTION' AND status IN ('OPEN','ANSWERED'))
    OR (type = 'REVIEW' AND status IN ('OPEN','APPROVED','DECLINED','SUPERSEDED'))
    OR (type NOT IN ('BRIEF','QUESTION','REVIEW') AND status IS NULL));
