-- Nous Pro phase 2b (plan clipboard:kTV3y2lwO-99 step 6, design §4.1, §5, §8.1): a phone paired through the SpaceApp relay keeps its offer's
-- 256-bit rendezvous id, which the instance's relay client listens on; a Pro phone's push handle (opaque, made by the push service) is what
-- the instance wakes it with. Both are random ids, never a secret or a link to an account. Class B with their row (app_device_sessions).
ALTER TABLE app_device_sessions
  ADD COLUMN IF NOT EXISTS rendezvous_id text UNIQUE CHECK (rendezvous_id ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN IF NOT EXISTS push_handle text CHECK (push_handle ~ '^[A-Za-z0-9_-]{16,64}$');
