CREATE TABLE IF NOT EXISTS agents (
  subject_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  workspace TEXT,
  environment TEXT,
  public_key TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_requests (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  workspace TEXT,
  resource TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  environment TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE(actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  workspace TEXT,
  resource TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  environment TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  request_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revoked_grants (
  grant_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_backups (
  backup_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvers (
  subject_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(subject_id, workspace)
);

CREATE INDEX IF NOT EXISTS grants_subject_scope ON grants(subject_id, resource, environment, expires_at);
