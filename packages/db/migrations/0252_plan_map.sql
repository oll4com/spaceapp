-- Plan map (operator request 2026-10-25): the plans a plan depends on, the date it must keep and what it waits on,
-- so the Nous dock and Nous's world show one picture of every plan. Additive: old rows read as no dependencies, no date, no wait.
ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS due_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS waits_on_json jsonb;
