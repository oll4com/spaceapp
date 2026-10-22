-- MU-003 (operator decision 2026-10-17): every WORKSPACE room has an owner. Agent Proof and CLI Recovery rooms keep
-- theirs optional (proof profiles create ownerless rooms on purpose).
UPDATE rooms
SET owner_user_id = (SELECT id FROM users WHERE role IN ('OPERATOR', 'ADMIN') ORDER BY created_at ASC LIMIT 1)
WHERE kind = 'WORKSPACE' AND owner_user_id IS NULL;

-- New rows are checked at once; existing rows only once none is left without an owner (a database with rooms but no
-- administrator yet keeps them until one exists).
ALTER TABLE rooms ADD CONSTRAINT rooms_workspace_owner_required
  CHECK (kind <> 'WORKSPACE' OR owner_user_id IS NOT NULL) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rooms WHERE kind = 'WORKSPACE' AND owner_user_id IS NULL) THEN
    ALTER TABLE rooms VALIDATE CONSTRAINT rooms_workspace_owner_required;
  END IF;
END $$;
