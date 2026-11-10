-- Test signature requests (Nous, nous_msg:781819c5ba0440fbbee8682c, operator 6/11 01:15 BKK: the Sign badge read 1 for App Studio's
-- «ΔΟΚΙΜΗ» request of 5/11). A request an App Studio pane or an Agent Proof room asked for is a test: never in the operator's list or badge.
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS test boolean NOT NULL DEFAULT false;
UPDATE signature_requests r SET test = true FROM panes p WHERE p.id = r.pane_id AND p.mode = 'APP_STUDIO' AND NOT r.test;
UPDATE signature_requests r SET test = true FROM rooms room WHERE room.id = r.room_id AND room.kind = 'AGENT_PROOF' AND NOT r.test;
-- The tests still waiting close by status (their cards were already resolved); class A, never deleted.
UPDATE signature_requests SET status = 'CANCELLED', updated_at = now() WHERE test AND status = 'PENDING';
