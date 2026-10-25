CREATE TABLE IF NOT EXISTS user_link_libraries (
  owner_user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  initialized_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_links (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  open_mode text NOT NULL CHECK (open_mode IN ('EMBEDDED', 'NEW_TAB')),
  is_quick boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, url)
);

CREATE INDEX IF NOT EXISTS idx_user_links_owner_order
  ON user_links(owner_user_id, sort_order ASC, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_user_links_owner_quick_order
  ON user_links(owner_user_id, is_quick, sort_order ASC, created_at ASC, id ASC);
