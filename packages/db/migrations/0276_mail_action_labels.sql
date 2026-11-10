-- Operator 31/10 16:07 BKK «Βγάλε όλα τα όρια!! Από παντού!!» (plan clipboard:xCBrZwhCTzmC): a recorded mail action keeps every label it
-- touched (until 31/10 at most 20).
ALTER TABLE mail_copilot_actions DROP CONSTRAINT IF EXISTS mail_copilot_actions_label_ids_check;
