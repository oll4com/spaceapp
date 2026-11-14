/**
 * Nous Gateway tenant schema (plan clipboard:_0qBSFCftZuD step 3, lab only). Its own tables, never applied to Space's database:
 * the Space Gateway's `space_gateway_*` schema is untouched. Re-running it is a no-op.
 * Tenant tables have FORCE ROW LEVEL SECURITY on `ngw.tenant_id` (set with SET LOCAL per request by `withTenant`); the two
 * SECURITY DEFINER functions are the only cross-tenant reads the request path needs (a key by its hash, a pool's active plans).
 * shortcut: functions owned by the migrating superuser in the lab; production owns them by a BYPASSRLS `ngw_migrate` role.
 */
const tenantTables = ["ngw_tenant_keys", "ngw_tenant_period", "ngw_inflight", "ngw_usage", "ngw_usage_daily", "ngw_audit", "ngw_tenant_billing"];
const writableTenantTables = tenantTables.filter((table) => table !== "ngw_audit"); // the audit is append-only

export const NGW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ngw_tenant_keys (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  plan text NOT NULL CHECK (plan IN ('TRIAL', 'PERSONAL', 'PRO', 'ULTRA')),
  region text NOT NULL,
  risk_tier text NOT NULL CHECK (risk_tier IN ('NEW', 'TRUSTED')),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN', 'REVOKED')),
  rotated_from text REFERENCES ngw_tenant_keys(id),
  not_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS ngw_tenant_keys_live ON ngw_tenant_keys (tenant_id) WHERE status <> 'REVOKED';
CREATE TABLE IF NOT EXISTS ngw_tenant_period (
  tenant_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  allowance_micros bigint NOT NULL CHECK (allowance_micros >= 0),
  topup_micros bigint NOT NULL DEFAULT 0 CHECK (topup_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  day date NOT NULL,
  day_spent_micros bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period_start)
);
CREATE TABLE IF NOT EXISTS ngw_inflight (
  request_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  period_start timestamptz NOT NULL,
  pool text NOT NULL,
  plan text NOT NULL,
  traffic_class text NOT NULL,
  reserved_micros bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ngw_inflight_pool ON ngw_inflight (pool, expires_at);
CREATE TABLE IF NOT EXISTS ngw_usage (
  request_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  key_id text NOT NULL,
  pool text NOT NULL,
  account_id text,
  provider text NOT NULL,
  model text NOT NULL,
  traffic_class text NOT NULL,
  status text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ngw_usage_tenant_time ON ngw_usage (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS ngw_usage_daily (
  tenant_id text NOT NULL,
  day date NOT NULL,
  account_id text NOT NULL,
  model text NOT NULL,
  requests bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cost_micros bigint NOT NULL,
  PRIMARY KEY (tenant_id, day, account_id, model)
);
CREATE TABLE IF NOT EXISTS ngw_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  tenant_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  key_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- The tenant's Stripe customer, set by provisioning through the admin API.
CREATE TABLE IF NOT EXISTS ngw_tenant_billing (
  tenant_id text PRIMARY KEY,
  stripe_customer_id text NOT NULL CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
${tenantTables.map((table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${table}_tenant ON ${table};
CREATE POLICY ${table}_tenant ON ${table}
  USING (tenant_id = current_setting('ngw.tenant_id', true)) WITH CHECK (tenant_id = current_setting('ngw.tenant_id', true));`).join("")}
-- The nightly meter export's state (nous/stripe-export.ts).
CREATE TABLE IF NOT EXISTS ngw_meter_exports (
  tenant_id text NOT NULL,
  day date NOT NULL,
  identifier text NOT NULL UNIQUE,
  credits bigint NOT NULL CHECK (credits >= 0),
  cost_micros bigint NOT NULL,
  stripe_customer_id text,
  status text NOT NULL CHECK (status IN ('PENDING', 'SENT', 'NO_CUSTOMER')),
  stripe_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
-- Which tenant pool a provider account serves, and the list value one full 5-hour window of it serves (set by a person from
-- measured windows). An account without a row serves no tenant.
CREATE TABLE IF NOT EXISTS ngw_account_pools (
  account_id text PRIMARY KEY,
  pool text NOT NULL,
  five_hour_capacity_micros bigint NOT NULL CHECK (five_hour_capacity_micros > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A person's edits of the task routing lists (nous/routing.ts DEFAULT_TASK_ROUTES are the defaults).
CREATE TABLE IF NOT EXISTS ngw_task_routes (
  task text PRIMARY KEY,
  models text[] NOT NULL,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);
-- Kill switches (nous/switches.ts): one row per (switch, scope); a global one is applied only after a second person approves its request.
CREATE TABLE IF NOT EXISTS ngw_switches (
  name text NOT NULL,
  scope text NOT NULL,
  value boolean NOT NULL,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  PRIMARY KEY (name, scope)
);
CREATE TABLE IF NOT EXISTS ngw_switch_requests (
  id text PRIMARY KEY,
  name text NOT NULL,
  scope text NOT NULL,
  value boolean NOT NULL,
  reason text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
-- The audit is append-only for every role (K5-deletion): a tenant's deletion is recorded, never erased.
CREATE OR REPLACE FUNCTION ngw_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'ngw_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS ngw_audit_append_only ON ngw_audit;
CREATE TRIGGER ngw_audit_append_only BEFORE UPDATE OR DELETE ON ngw_audit FOR EACH ROW EXECUTE FUNCTION ngw_audit_append_only();
DROP TRIGGER IF EXISTS ngw_audit_no_truncate ON ngw_audit;
CREATE TRIGGER ngw_audit_no_truncate BEFORE TRUNCATE ON ngw_audit FOR EACH STATEMENT EXECUTE FUNCTION ngw_audit_append_only();
CREATE OR REPLACE FUNCTION ngw_key_by_hash(p_hash text) RETURNS SETOF ngw_tenant_keys
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM ngw_tenant_keys WHERE key_hash = p_hash $$;
CREATE OR REPLACE FUNCTION ngw_pool_active_plans(p_pool text, p_now timestamptz) RETURNS TABLE (plan text, tenants bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT plan, count(DISTINCT tenant_id) FROM ngw_inflight WHERE pool = p_pool AND expires_at > p_now GROUP BY plan $$;
`;

/** Grants for the request-path role (RLS applies to it); the role itself is created by the deployment, never by the schema. */
export const ngwAppGrantsSql = (role: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("role must be a plain identifier");
  return `GRANT SELECT, INSERT, UPDATE, DELETE ON ${writableTenantTables.join(", ")} TO ${role};
GRANT SELECT, INSERT ON ngw_audit TO ${role};
GRANT USAGE ON SEQUENCE ngw_audit_id_seq TO ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ngw_account_pools, ngw_task_routes TO ${role};
GRANT SELECT, INSERT, UPDATE ON ngw_switches, ngw_switch_requests TO ${role};
GRANT EXECUTE ON FUNCTION ngw_key_by_hash(text), ngw_pool_active_plans(text, timestamptz) TO ${role};
-- ngw_0004's table: a database built from NGW_SCHEMA_SQL alone (the lab) has none.
DO $$ BEGIN IF to_regclass('ngw_stripe_events') IS NOT NULL THEN GRANT SELECT, INSERT ON ngw_stripe_events TO ${role}; END IF; END $$;`;
};

/** Request logs are kept 13 months (install plan §3.7, DPIA); partitions are made 2 months ahead, so an insert never lacks one. */
export const REQUEST_LOG_KEEP_MONTHS = 13;
export const REQUEST_LOG_AHEAD_MONTHS = 2;

/**
 * K5-schema (install plan §3.7, §6 item 1): the request logs get the tenant (from the ledger id `ngwreq:<tenant>:<uuid>`, a generated
 * column, so Space's insert stays as it is) and monthly partitions. The ngw database starts empty, so the table is rebuilt partitioned,
 * with Space's own indexes and foreign keys copied from it; a table that already holds rows stops the migration instead.
 * `ngw_request_log_partitions()` (the ops job, daily) makes the coming months and drops what is older than 13 months; only ngw_ops runs it.
 */
const REQUEST_LOG_PARTITIONS_SQL = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM space_gateway_request_logs) THEN
    RAISE EXCEPTION 'space_gateway_request_logs holds rows: partition it by hand before ngw_0002';
  END IF;
END $$;
ALTER TABLE space_gateway_request_logs RENAME TO space_gateway_request_logs_flat;
ALTER TABLE space_gateway_request_logs_flat RENAME CONSTRAINT space_gateway_request_logs_pkey TO space_gateway_request_logs_flat_pkey;
CREATE TABLE space_gateway_request_logs (LIKE space_gateway_request_logs_flat INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING IDENTITY
  INCLUDING STORAGE INCLUDING COMMENTS) PARTITION BY RANGE (requested_at);
ALTER TABLE space_gateway_request_logs ADD CONSTRAINT space_gateway_request_logs_pkey PRIMARY KEY (id, requested_at);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'space_gateway_request_logs_flat'
      AND indexname <> 'space_gateway_request_logs_flat_pkey' LOOP
    EXECUTE format('DROP INDEX %I', r.indexname);
    EXECUTE regexp_replace(r.indexdef, ' ON (public\\.)?space_gateway_request_logs_flat ', ' ON public.space_gateway_request_logs ');
  END LOOP;
  FOR r IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'space_gateway_request_logs_flat'::regclass AND contype = 'f' LOOP
    EXECUTE format('ALTER TABLE space_gateway_request_logs_flat DROP CONSTRAINT %I', r.conname);
    EXECUTE format('ALTER TABLE space_gateway_request_logs ADD CONSTRAINT %I %s', r.conname, r.def);
  END LOOP;
END $$;
DROP TABLE space_gateway_request_logs_flat;
ALTER TABLE space_gateway_request_logs ADD COLUMN tenant_id text
  GENERATED ALWAYS AS (CASE WHEN request_id LIKE 'ngwreq:%' THEN split_part(request_id, ':', 2) END) STORED;
CREATE INDEX space_gateway_request_logs_tenant_idx ON space_gateway_request_logs (tenant_id) WHERE tenant_id IS NOT NULL;

CREATE FUNCTION ngw_request_log_partitions() RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  month timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  changed text[] := '{}';
  part text;
  r record;
BEGIN
  FOR i IN 0..${REQUEST_LOG_AHEAD_MONTHS} LOOP
    part := 'space_gateway_request_logs_' || to_char(month + make_interval(months => i), '"y"YYYY"m"MM');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF space_gateway_request_logs FOR VALUES FROM (%L) TO (%L)', part,
        (month + make_interval(months => i)) AT TIME ZONE 'UTC', (month + make_interval(months => i + 1)) AT TIME ZONE 'UTC');
      changed := changed || ('created ' || part);
    END IF;
  END LOOP;
  FOR r IN SELECT c.relname, (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz AS upper_bound
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'space_gateway_request_logs'::regclass LOOP
    IF r.upper_bound <= (month - make_interval(months => ${REQUEST_LOG_KEEP_MONTHS})) AT TIME ZONE 'UTC' THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      changed := changed || ('dropped ' || r.relname);
    END IF;
  END LOOP;
  RETURN changed;
END $fn$;
REVOKE ALL ON FUNCTION ngw_request_log_partitions() FROM PUBLIC;
SELECT ngw_request_log_partitions();
`;

/**
 * The Nous tables as migrations of the gateway's own set (`nous/migrate.ts`). Once an installation applied an entry, it is never
 * edited: later changes are new entries.
 */
export const NGW_MIGRATIONS: readonly { id: string; sql: string }[] = [{ id: "ngw_0001_tenancy", sql: NGW_SCHEMA_SQL },
  { id: "ngw_0002_request_log_partitions", sql: REQUEST_LOG_PARTITIONS_SQL },
  // The Stripe sender's first try of a row (past Stripe's 24 h idempotency window it is never sent again automatically) and the 4xx
  // that holds it until an export re-run of its day or a person clears it.
  { id: "ngw_0003_meter_send_state", sql: `ALTER TABLE ngw_meter_exports ADD COLUMN IF NOT EXISTS send_started_at timestamptz;
ALTER TABLE ngw_meter_exports ADD COLUMN IF NOT EXISTS send_error text;` },
  // K4-billing (nous/subscriptions.ts): the tenant's subscription, and every Stripe webhook event once (its id), with its outcome.
  { id: "ngw_0004_stripe_subscriptions", sql: `ALTER TABLE ngw_tenant_billing ADD COLUMN IF NOT EXISTS stripe_subscription_id text
  CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$');
CREATE TABLE IF NOT EXISTS ngw_stripe_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9]{1,64}$'),
  type text NOT NULL,
  tenant_id text,
  created timestamptz NOT NULL,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ngw_stripe_events_tenant_idx ON ngw_stripe_events (tenant_id, created) WHERE tenant_id IS NOT NULL;` }];
