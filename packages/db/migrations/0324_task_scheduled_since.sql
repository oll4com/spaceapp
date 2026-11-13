-- Daily tasks -110 (13/11, plan clipboard:1NF6u6gcCwtj): when a task's schedule last began to apply (its next run went from none to some:
-- a schedule added or restored, a task reopened). The Score judges no day before it; NULL (rows from before this column) means createdAt.
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS scheduled_since timestamptz;
