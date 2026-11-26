-- K1 tenancy M5 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.3): the roles the API and the tenant
-- directory move to at the cutover (M7). NOLOGIN and used by nothing yet (M6 sets them only with SPACE_TENANCY_ENABLED), so nothing changes.
--   space_app: NOBYPASSRLS and owns no table, so tenant_isolation (M4) shows it only its transaction's tenant.
--   space_system: BYPASSRLS, for the tenant directory and named platform jobs only.
-- No space_read: space_nous_reader (0356) already is the read-only reader under RLS.
-- Roles are cluster-wide (stable and dev share one cluster): a user that may not create them (dev's space_dev) skips them here;
-- scripts/space-dev-db-owner.sql creates and grants them on dev.
DO $$
DECLARE me pg_roles%ROWTYPE; r text;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'space_app') AND (me.rolsuper OR me.rolcreaterole) THEN
    CREATE ROLE space_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- Only a superuser, or a role creator that bypasses RLS itself, may create a BYPASSRLS role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'space_system') AND (me.rolsuper OR (me.rolcreaterole AND me.rolbypassrls)) THEN
    CREATE ROLE space_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
  FOREACH r IN ARRAY ARRAY['space_app', 'space_system'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE NOTICE '% not created: % may not create roles', r, current_user;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', current_database(), r);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', current_schema(), r);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', current_schema(), r);
    -- Tables and sequences that later migrations create (as this same user) get the same grants.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', current_schema(), r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', current_schema(), r);
    -- A superuser sets any role; anyone else needs the membership to SET ROLE.
    IF NOT me.rolsuper AND NOT pg_has_role(current_user, r, 'SET') THEN
      BEGIN
        EXECUTE format('GRANT %I TO %I', r, current_user);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE '% not granted to %', r, current_user;
      END;
    END IF;
  END LOOP;
END $$;
