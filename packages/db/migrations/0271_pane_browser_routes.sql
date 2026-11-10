-- Plan clipboard:iLvBs5eOMZjF (operator 31/10 01:00 BKK): the network route a pane browser leaves from, chosen per pane (a Freelance Copilot
-- keeps its own in Setup). A table of its own, never a pane metadata key: the running Browser Host parses pane rows strictly (R9 item 4).
CREATE TABLE pane_browser_routes (
  pane_id TEXT PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
  route TEXT NOT NULL CHECK (route IN ('direct', 'greece', 'thailand', 'mullvad', 'nord')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
