-- Operator 14/11 11:19 BKK: the Freelance Copilot bids low to win its first jobs and reviews, so the hourly floor default went from $35 to $20
-- (packages/contracts/src/freelance-copilot.ts). Panes saved with the old default 35 (Dino/Emma pane:KPCT9JCt_OJ_) move to 20; any other floor stays.
UPDATE panes
SET freelance_copilot_metadata = jsonb_set(freelance_copilot_metadata, '{settings,rateFloorHourly}', '20'::jsonb), updated_at = now()
WHERE mode = 'FREELANCE_COPILOT' AND freelance_copilot_metadata #> '{settings,rateFloorHourly}' = '35'::jsonb;
