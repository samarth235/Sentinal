-- Optional hardening for a real deployment (run once as the database owner).
-- Sentinel's app role only needs to INSERT and SELECT audit rows. Without UPDATE/DELETE,
-- even a compromised app server cannot rewrite or remove history. (The tamper demo needs
-- UPDATE, so skip this on a demo deployment that uses ENABLE_TAMPER_DEMO=true.)
--
--   psql "$OWNER_DATABASE_URL" -v app_password="'choose-a-strong-password'" -f sql/002_least_privilege.sql
--   then set DATABASE_URL to postgres://sentinel_app:<password>@host/db?sslmode=require

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN
    CREATE ROLE sentinel_app LOGIN;
  END IF;
END$$;
ALTER ROLE sentinel_app PASSWORD :app_password;

REVOKE ALL ON audit_log FROM sentinel_app;
GRANT SELECT, INSERT ON audit_log TO sentinel_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_seq_seq TO sentinel_app;

-- Defence in depth: refuse UPDATE/DELETE/TRUNCATE for everyone except the owner.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF current_user <> (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log') THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  RETURN OLD;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
