-- When each open plan's percentage last changed, as Nous observes it (plan clipboard:8s0ZNiO3q5ZT S4). The plan's own
-- last_progress_at moves on every progress write, also when the percentage stays, so it cannot show a stall.
CREATE TABLE IF NOT EXISTS nous_plan_marks (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  percent integer NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, plan_id)
);
