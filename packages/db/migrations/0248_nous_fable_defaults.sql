-- Nous runs on Claude Fable 5.1 by default since 2026-10-24 (operator decision "Nous at maximum": max effort for the operator's and
-- decision turns, high for inbox, standing and helper turns). Stored per-kind choices equal to the old default (Opus 5.5 xhigh, the
-- value the Settings card saved for every kind once any model was touched) move once; any other explicit choice stays.
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,models,operator}', '{"model":"claude-fable-5-1","effort":"max"}')
WHERE settings #> '{nous,models,operator}' = '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb;
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,models,decision}', '{"model":"claude-fable-5-1","effort":"max"}')
WHERE settings #> '{nous,models,decision}' = '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb;
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,models,inbox}', '{"model":"claude-fable-5-1","effort":"high"}')
WHERE settings #> '{nous,models,inbox}' = '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb;
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,models,standing}', '{"model":"claude-fable-5-1","effort":"high"}')
WHERE settings #> '{nous,models,standing}' = '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb;
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous,models,helper}', '{"model":"claude-fable-5-1","effort":"high"}')
WHERE settings #> '{nous,models,helper}' = '{"model":"claude-opus-5-5","effort":"xhigh"}'::jsonb;
