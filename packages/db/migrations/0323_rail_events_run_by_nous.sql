-- USQ6 step 4 (plan clipboard:USQ6ktIIN_1D): rail decisions a Nous decision ran (approved or by allowance) before every copilot marked
-- them `by: "nous"` (Mail only from 12/11, Marketing, Freelance, Job and Security never) get the mark, so the decision ledger stops
-- scoring them as the operator's rail answers; the RAIL ledger rows already made from them go (they are the decision's own NEEDS_YOU or
-- ALLOWANCE rows twice, and made the false «Mail reject ×2» rule). An event is Nous's when an APPROVED COPILOT decision for its item ran
-- between the decision's creation and an hour after its answer.
WITH runs AS (
  SELECT owner_user_id, action->>'copilot' AS copilot, action->>'item' AS item, action->>'itemId' AS item_id,
    created_at AS since, coalesce(answered_at, created_at) + interval '1 hour' AS until
  FROM nous_decisions WHERE status = 'APPROVED' AND action->>'type' = 'COPILOT'
)
UPDATE mail_copilot_events e SET payload = e.payload || '{"by":"nous"}'::jsonb
FROM runs r WHERE r.copilot = 'MAIL' AND r.owner_user_id = e.owner_user_id AND e.created_at BETWEEN r.since AND r.until
  AND coalesce(e.payload->>'by', '') <> 'nous'
  AND ((r.item = 'REVIEW' AND e.type = 'REVIEW_DECIDED' AND e.payload->>'reviewId' = r.item_id)
    OR (r.item = 'RULE' AND e.type = 'RULE_DECIDED' AND e.payload->>'ruleId' = r.item_id));

WITH runs AS (
  SELECT owner_user_id, action->>'item' AS item, action->>'itemId' AS item_id, created_at AS since, coalesce(answered_at, created_at) + interval '1 hour' AS until
  FROM nous_decisions WHERE status = 'APPROVED' AND action->>'type' = 'COPILOT' AND action->>'copilot' = 'MARKETING'
)
UPDATE marketing_copilot_events e SET payload = e.payload || '{"by":"nous"}'::jsonb
FROM runs r WHERE r.owner_user_id = e.owner_user_id AND e.created_at BETWEEN r.since AND r.until AND coalesce(e.payload->>'by', '') <> 'nous'
  AND ((r.item = 'REVIEW' AND e.type = 'REVIEW_DECIDED' AND e.post_id::text = r.item_id)
    OR (r.item = 'CAMPAIGN' AND e.type = 'CAMPAIGN_DECIDED' AND e.campaign_id::text = r.item_id)
    OR (r.item = 'RULE' AND e.type = 'RULE_DECIDED' AND e.payload->>'ruleId' = r.item_id));

WITH runs AS (
  SELECT owner_user_id, action->>'item' AS item, action->>'itemId' AS item_id, created_at AS since, coalesce(answered_at, created_at) + interval '1 hour' AS until
  FROM nous_decisions WHERE status = 'APPROVED' AND action->>'type' = 'COPILOT' AND action->>'copilot' = 'FREELANCE'
)
UPDATE freelance_copilot_events e SET payload = e.payload || '{"by":"nous"}'::jsonb
FROM runs r WHERE r.owner_user_id = e.owner_user_id AND e.created_at BETWEEN r.since AND r.until AND coalesce(e.payload->>'by', '') <> 'nous'
  AND ((r.item = 'REVIEW' AND e.type = 'REVIEW_DECIDED' AND e.message_id::text = r.item_id)
    OR (r.item = 'LEAD' AND e.type = 'LEAD_DECIDED' AND e.lead_id::text = r.item_id)
    OR (r.item = 'RULE' AND e.type = 'RULE_DECIDED' AND e.payload->>'ruleId' = r.item_id));

WITH runs AS (
  SELECT owner_user_id, action->>'copilot' AS copilot, action->>'itemId' AS item_id, created_at AS since, coalesce(answered_at, created_at) + interval '1 hour' AS until
  FROM nous_decisions WHERE status = 'APPROVED' AND action->>'type' = 'COPILOT' AND action->>'item' = 'REVIEW' AND action->>'copilot' = 'JOB'
)
UPDATE job_apply_events e SET payload = e.payload || '{"by":"nous"}'::jsonb
FROM runs r WHERE r.owner_user_id = e.owner_user_id AND e.created_at BETWEEN r.since AND r.until AND coalesce(e.payload->>'by', '') <> 'nous'
  AND e.type = 'REVIEW_DECIDED' AND e.payload->>'reviewId' = r.item_id;

WITH runs AS (
  SELECT owner_user_id, action->>'itemId' AS item_id, created_at AS since, coalesce(answered_at, created_at) + interval '1 hour' AS until
  FROM nous_decisions WHERE status = 'APPROVED' AND action->>'type' = 'COPILOT' AND action->>'item' = 'REVIEW' AND action->>'copilot' = 'SECURITY'
)
UPDATE security_copilot_events e SET payload = e.payload || '{"by":"nous"}'::jsonb
FROM runs r WHERE r.owner_user_id = e.owner_user_id AND e.created_at BETWEEN r.since AND r.until AND coalesce(e.payload->>'by', '') <> 'nous'
  AND e.type = 'REVIEWED' AND e.payload->>'reviewId' = r.item_id;

UPDATE security_copilot_events SET payload = payload || '{"by":"nous"}'::jsonb
WHERE type = 'ANSWERED' AND payload->>'answeredBy' = 'NOUS' AND coalesce(payload->>'by', '') <> 'nous';

DELETE FROM nous_decision_ledger l USING (
  SELECT owner_user_id, 'Mail Copilot:' || id AS ref FROM mail_copilot_events WHERE payload->>'by' = 'nous'
  UNION ALL SELECT owner_user_id, 'Marketing Copilot:' || id FROM marketing_copilot_events WHERE payload->>'by' = 'nous'
  UNION ALL SELECT owner_user_id, 'Freelance Copilot:' || id FROM freelance_copilot_events WHERE payload->>'by' = 'nous'
  UNION ALL SELECT owner_user_id, 'Job Copilot:' || id FROM job_apply_events WHERE payload->>'by' = 'nous'
) n WHERE l.source LIKE 'RAIL:%' AND l.owner_user_id = n.owner_user_id AND l.ref = n.ref;
