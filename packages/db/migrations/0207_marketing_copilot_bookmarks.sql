-- Marketing Copilot bookmarks (operator request 2026-10-16): a page the pane browser opens in a new tab with one
-- Google account (profile_id null: the pane's own account), listed in the pane's Bookmarks tab and to its agent.
CREATE TABLE IF NOT EXISTS marketing_copilot_bookmarks (
  id text PRIMARY KEY CHECK (id ~ '^mktbm:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  profile_id text CHECK (profile_id IS NULL OR char_length(profile_id) BETWEEN 1 AND 200),
  account_label text CHECK (account_label IS NULL OR char_length(account_label) BETWEEN 1 AND 320),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_copilot_bookmarks_owner_idx ON marketing_copilot_bookmarks(owner_user_id, created_at);
