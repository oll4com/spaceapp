-- Plan clipboard:ro5ukMcJnIk4 step 6: a lesson counts in the Score on its creation, not on every rewrite or merge. Rows from before stay NULL (unknown).
ALTER TABLE nous_notes ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE nous_notes ALTER COLUMN created_at SET DEFAULT now();
