-- Mail Copilot "Send to AI": the operator hands a mail to the copilot to check and fix what it needs. The hand-off is
-- an action of the log (FIX), learnable as a rule (action FIX), a work item (FIX_REQUESTED) and an outcome (FIXED).
ALTER TABLE mail_copilot_actions DROP CONSTRAINT IF EXISTS mail_copilot_actions_action_check;
ALTER TABLE mail_copilot_actions ADD CONSTRAINT mail_copilot_actions_action_check CHECK (action IN ('ARCHIVE','UNARCHIVE','TRASH','UNTRASH','DELETE','MOVE','LABEL','UNLABEL','STAR','UNSTAR','SPAM','NOT_SPAM','REPLY','FORWARD','FIX'));
ALTER TABLE mail_copilot_events DROP CONSTRAINT IF EXISTS mail_copilot_events_type_check;
ALTER TABLE mail_copilot_events ADD CONSTRAINT mail_copilot_events_type_check CHECK (type IN ('MAIL_RECEIVED','USER_ACTION','TRIAGED','DRAFTED','REPLIED','SENT','ARCHIVED','TRASHED','LABELED','STARRED','SKIPPED',
  'NEEDS_USER','QUESTION','ANSWERED','REVIEW_REQUESTED','REVIEW_DECIDED','RULE_PROPOSED','RULE_DECIDED','RULE_APPLIED','SYNC_RESET','NOTE',
  'RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_STOPPED','RUN_FINISHED','TRIAGE','RULE_LEARNED','RULE_RETIRED','FIX_REQUESTED','FIXED'));
