-- Nous Pro step 7, finding C6 of the internal MASVS L2 review (plan clipboard:kTV3y2lwO-99): the serials of a paired phone's decide-key
-- attestation chain, as Google's status list writes them (lowercase hex, no leading zeros), so a chain Google revokes or suspends after the
-- pairing loses decide at the next check. Null: no decide key, or paired before this column. Class B with its row (app_device_sessions).
ALTER TABLE app_device_sessions
  ADD COLUMN IF NOT EXISTS decide_serials text[]
    CHECK (decide_serials IS NULL OR array_to_string(decide_serials, ',') ~ '^[0-9a-f]{1,64}(,[0-9a-f]{1,64}){1,7}$');
