-- Operator token audit 2026-10-31 («υπερβολή για τα goals ανά ένα λεπτό»; decision c1825440 approved goal turns every 10 minutes): the goal
-- loop's defaults moved to a 600 s gap, 2 unchanged turns and a 30 → 120 minute back-off. The Settings card saves the goals object whole,
-- so stored values equal to the old defaults (60 s, 3 turns, 15 → 60 minutes) move once; any other explicit choice stays.
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,goals,gapSeconds}', '600'::jsonb)
WHERE settings #> '{nous,goals,gapSeconds}' = '60'::jsonb;
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,goals,unchangedTurns}', '2'::jsonb)
WHERE settings #> '{nous,goals,unchangedTurns}' = '3'::jsonb;
UPDATE user_settings
SET settings = jsonb_set(jsonb_set(settings, '{nous,goals,backoffMinutes}', '30'::jsonb), '{nous,goals,backoffMaxMinutes}', '120'::jsonb)
WHERE settings #> '{nous,goals,backoffMinutes}' = '15'::jsonb AND settings #> '{nous,goals,backoffMaxMinutes}' = '60'::jsonb;
