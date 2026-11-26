-- DEV3D-016: space_db_query (apps/api/src/nous/db.ts) runs every read as this role, which the API grants SELECT on
-- non-secret columns only, so an alias or a whole-row cast (to_jsonb(t), t::text) of a secret column fails closed.
-- Idempotent: roles are cluster-wide (stable and dev share one cluster), so a second run or another database finds it.
-- A database user that may not create roles (dev's space_dev) skips it; scripts/space-dev-db-owner.sql grants it there.
DO $$
DECLARE me pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'space_nous_reader') THEN
    IF NOT (me.rolsuper OR me.rolcreaterole) THEN
      RAISE NOTICE 'space_nous_reader not created: % may not create roles', current_user;
      RETURN;
    END IF;
    CREATE ROLE space_nous_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- A superuser sets any role; a role creator needs the membership to SET ROLE.
  IF NOT me.rolsuper AND NOT pg_has_role(current_user, 'space_nous_reader', 'SET') THEN
    BEGIN
      EXECUTE format('GRANT space_nous_reader TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'space_nous_reader not granted to %', current_user;
    END;
  END IF;
  -- pg_stat_activity and pg_stat_statements show every session's query text, as before, to a superuser's grant only.
  IF me.rolsuper THEN
    GRANT pg_read_all_stats TO space_nous_reader;
  END IF;
END $$;
