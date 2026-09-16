CREATE TABLE IF NOT EXISTS feedback (
  feedback_id TEXT PRIMARY KEY,
  actor_subject_hash TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  environment TEXT NOT NULL,
  resource TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT NOT NULL,
  context_json TEXT,
  expected_outcome TEXT NOT NULL,
  observed_result TEXT NOT NULL,
  reproduction_steps TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE(actor_subject_hash, idempotency_key)
);

CREATE TABLE IF NOT EXISTS feedback_outbox (
  outbox_id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(feedback_id),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_suggestions (
  feedback_id TEXT PRIMARY KEY REFERENCES feedback(feedback_id),
  correlation_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_requests (
  request_id TEXT PRIMARY KEY,
  actor_subject_hash TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  target TEXT NOT NULL,
  repository_remote TEXT,
  workspace TEXT NOT NULL,
  environment TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  intent TEXT,
  challenge_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE(actor_subject_hash, idempotency_key)
);

CREATE TABLE IF NOT EXISTS service_catalog (
  service_id TEXT PRIMARY KEY,
  actor_subject_hash TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  service_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  workspace TEXT NOT NULL,
  parent_workspace TEXT,
  environment TEXT NOT NULL,
  resource TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  challenge_json TEXT NOT NULL,
  last_seen TEXT,
  metadata_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE(actor_subject_hash, idempotency_key)
);

CREATE INDEX IF NOT EXISTS feedback_workspace_created ON feedback(workspace, created_at);
CREATE INDEX IF NOT EXISTS onboarding_workspace_created ON onboarding_requests(workspace, created_at);
CREATE INDEX IF NOT EXISTS service_catalog_workspace_created ON service_catalog(workspace, created_at);
