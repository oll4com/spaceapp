-- The operator's feedback on an answered Nous decision (plan clipboard:L7RgHsveHbcR step 5): "You could have decided this"
-- marks a question Nous should have answered itself; its scorecard counts it against escalation quality.
ALTER TABLE nous_decisions ADD COLUMN IF NOT EXISTS could_have_decided boolean NOT NULL DEFAULT false;
