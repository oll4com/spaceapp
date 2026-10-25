-- One durable create claim per personal binding. Unknown outcomes are never retried automatically.
CREATE TABLE IF NOT EXISTS repository_publish_operations (
  binding_id text PRIMARY KEY REFERENCES project_repository_bindings(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  CHECK (data->>'bindingId' = binding_id),
  CHECK (data->>'ownerUserId' = owner_user_id),
  CHECK (data->>'state' IN ('creating', 'created', 'unknown', 'rejected'))
);
CREATE INDEX IF NOT EXISTS repository_publish_operations_owner_idx ON repository_publish_operations(owner_user_id);
