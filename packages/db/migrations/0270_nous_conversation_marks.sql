-- Operator 31/10 00:36 BKK (plan clipboard:8r0wmAHdsaW7): Clear conversation clears what the Nous dock shows, never the database. One mark
-- per owner: the dock's latest page starts after it; Nous's own reads and paging back see every row. Moved only by the operator's Clear.
CREATE TABLE nous_conversation_marks (owner_user_id TEXT PRIMARY KEY, cleared_at TIMESTAMPTZ NOT NULL DEFAULT now());
