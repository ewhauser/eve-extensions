CREATE TABLE IF NOT EXISTS eve_ambient_events (
  ref text PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  application_id text NOT NULL,
  channel_id text NOT NULL,
  ingress_sequence bigint NOT NULL,
  payload_expires_at timestamptz NOT NULL,
  dedupe_expires_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS eve_ambient_events_payload_expiry_idx
  ON eve_ambient_events (payload_expires_at);
CREATE INDEX IF NOT EXISTS eve_ambient_events_dedupe_expiry_idx
  ON eve_ambient_events (dedupe_expires_at);

CREATE TABLE IF NOT EXISTS eve_ambient_subscriptions (
  id text PRIMARY KEY,
  event_ref text NOT NULL,
  tenant_id text NOT NULL,
  application_id text NOT NULL,
  monitor_id text NOT NULL,
  definition_version text NOT NULL,
  correlation_key_hash text,
  ingress_sequence bigint NOT NULL,
  status text NOT NULL,
  available_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  record jsonb NOT NULL
);

-- Keep the bootstrap migration re-runnable for pre-release installations that
-- applied an earlier draft before correlation hashes became relational.
ALTER TABLE eve_ambient_subscriptions
  ADD COLUMN IF NOT EXISTS correlation_key_hash text;

CREATE INDEX IF NOT EXISTS eve_ambient_subscriptions_due_idx
  ON eve_ambient_subscriptions (
    application_id,
    status,
    available_at,
    lease_expires_at,
    tenant_id,
    ingress_sequence
  );
CREATE INDEX IF NOT EXISTS eve_ambient_subscriptions_event_idx
  ON eve_ambient_subscriptions (event_ref);
CREATE INDEX IF NOT EXISTS eve_ambient_subscriptions_ordering_idx
  ON eve_ambient_subscriptions (
    application_id,
    tenant_id,
    monitor_id,
    definition_version,
    correlation_key_hash,
    ingress_sequence
  )
  WHERE status IN ('pending', 'processing', 'ready');

CREATE TABLE IF NOT EXISTS eve_ambient_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  application_id text NOT NULL,
  monitor_id text NOT NULL,
  definition_version text NOT NULL,
  next_evaluation_at timestamptz,
  active_run_id text,
  expires_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS eve_ambient_instances_due_idx
  ON eve_ambient_instances (application_id, next_evaluation_at, tenant_id)
  WHERE active_run_id IS NULL AND next_evaluation_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS eve_ambient_instances_monitor_idx
  ON eve_ambient_instances (application_id, monitor_id);
CREATE INDEX IF NOT EXISTS eve_ambient_instances_tenant_count_idx
  ON eve_ambient_instances (application_id, tenant_id);

CREATE TABLE IF NOT EXISTS eve_ambient_runs (
  id text PRIMARY KEY,
  instance_id text NOT NULL,
  tenant_id text NOT NULL,
  application_id text NOT NULL,
  monitor_id text NOT NULL,
  status text NOT NULL,
  available_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS eve_ambient_runs_due_idx
  ON eve_ambient_runs (application_id, status, available_at, lease_expires_at, tenant_id);
CREATE INDEX IF NOT EXISTS eve_ambient_runs_monitor_idx
  ON eve_ambient_runs (application_id, monitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eve_ambient_dead_letters (
  id text PRIMARY KEY,
  application_id text NOT NULL,
  monitor_id text,
  created_at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS eve_ambient_dead_letters_monitor_idx
  ON eve_ambient_dead_letters (application_id, monitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eve_ambient_deployments (
  application_id text PRIMARY KEY,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS eve_ambient_usage (
  id text PRIMARY KEY,
  scope text NOT NULL,
  metric text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS eve_ambient_usage_window_idx
  ON eve_ambient_usage (scope, metric, occurred_at);
CREATE INDEX IF NOT EXISTS eve_ambient_usage_expiry_idx
  ON eve_ambient_usage (expires_at);

CREATE SEQUENCE IF NOT EXISTS eve_ambient_ingress_sequence AS bigint;
