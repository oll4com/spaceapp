-- Nous Computer (plan clipboard:ZGz1LnD51ELH step 7, K3): one row per tenant's cell (microVM), the durable state the cell
-- orchestrator (apps/api/src/computer/cells.ts) places and wakes from. Durable record: a deleted cell stays as a DELETED row.
CREATE TABLE nous_computer_cells (
  tenant_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('NONE', 'CREATING', 'AWAKE', 'SLEEPING', 'COLD', 'DELETED')),
  host_id text,
  mem_mib integer NOT NULL,
  last_active_at timestamptz NOT NULL,
  slept_at timestamptz,
  snapshot_bytes bigint,
  object_key text,
  export_key text,
  exported_at timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE INDEX nous_computer_cells_host ON nous_computer_cells (host_id, state);
