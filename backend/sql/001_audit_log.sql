CREATE TABLE IF NOT EXISTS audit_log (
  seq         BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash   CHAR(64) NOT NULL,
  hash        CHAR(64) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_log_run_idx ON audit_log (run_id);
