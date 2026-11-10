-- R24-3 (operator rule 5e8bc029, 1/11 11:50 BKK: Nous approves or sends back every Marketing review, never the operator; X reply
-- mktpost:SUoAkMeF1xpR sat IN_REVIEW after it went stale and nothing could close it): the Marketing and Freelance copilots close their own
-- post or message in review that went stale or a newer one replaced, with evidence; its review card resolves.
ALTER TABLE marketing_copilot_posts DROP CONSTRAINT IF EXISTS marketing_copilot_posts_status_check;
ALTER TABLE marketing_copilot_posts ADD CONSTRAINT marketing_copilot_posts_status_check
  CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','PUBLISHING','PUBLISHED','FAILED','REJECTED','SUPERSEDED'));
ALTER TABLE freelance_copilot_messages DROP CONSTRAINT IF EXISTS freelance_copilot_messages_status_check;
ALTER TABLE freelance_copilot_messages ADD CONSTRAINT freelance_copilot_messages_status_check
  CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','SENDING','SENT','FAILED','REJECTED','RECEIVED','SUPERSEDED'));
