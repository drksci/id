/**
 * D1 adapter for live authorization state.
 *
 * This stores request/grant metadata, public keys, revocations, and opaque
 * encrypted backup envelopes only. It never stores private keys or plaintext
 * identity material. All SQL identifiers are fixed constants; values are
 * always bound parameters.
 */

import { SCHEMA, STATUS } from "./runtime.js";

const TABLE = Object.freeze({
  REQUESTS: "access_requests",
  IDEMPOTENCY: "idempotency_keys",
  GRANTS: "grants",
  AGENTS: "agents",
  BACKUPS: "identity_backups",
  REVOKED: "revoked_grants",
  APPROVERS: "approvers",
});

function unavailable() { throw new Error("D1 binding unavailable"); }

function parseJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function requestRow(row) {
  if (!row) return null;
  return {
    schema: SCHEMA.ACCESS_REQUEST,
    request_id: row.request_id,
    actor_id: row.actor_id,
    parent_id: row.parent_id,
    workspace: row.workspace,
    resource: row.resource,
    actions: parseJson(row.actions_json),
    environment: row.environment,
    reason: row.reason,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    status: row.status,
    ask_path: `/ask/${row.request_id}`,
    idempotency_key: row.idempotency_key,
    decided_at: row.decided_at || undefined,
    decided_by: row.decided_by || undefined,
  };
}

function grantRow(row) {
  if (!row) return null;
  return {
    schema: SCHEMA.GRANT,
    grant_id: row.grant_id,
    subject_id: row.subject_id,
    parent_id: row.parent_id,
    workspace: row.workspace,
    resource: row.resource,
    actions: parseJson(row.actions_json),
    environment: row.environment,
    expires_at: row.expires_at,
    issued_at: row.issued_at,
    issued_by: row.issued_by,
    request_id: row.request_id,
  };
}

export class D1Store {
  constructor(db) { this.db = db; }

  prepare(sql, ...values) {
    if (!this.db || typeof this.db.prepare !== "function") unavailable();
    return this.db.prepare(sql).bind(...values);
  }

  async getRequest(requestId) {
    const result = await this.prepare(
      `SELECT * FROM ${TABLE.REQUESTS} WHERE request_id = ?`, requestId,
    ).first();
    return requestRow(result);
  }

  async createRequest(record) {
    await this.prepare(
      `INSERT INTO ${TABLE.REQUESTS} (request_id, actor_id, parent_id, workspace, resource, actions_json, environment, reason, requested_at, expires_at, status, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.request_id, record.actor_id, record.parent_id, record.workspace || null,
      record.resource, JSON.stringify(record.actions), record.environment, record.reason,
      record.requested_at, record.expires_at, record.status, record.idempotency_key,
    ).run();
  }

  async createRequestWithIdempotency(record, response) {
    if (!this.db || typeof this.db.batch !== "function") unavailable();
    await this.db.batch([
      this.prepare(
        `INSERT INTO ${TABLE.REQUESTS} (request_id, actor_id, parent_id, workspace, resource, actions_json, environment, reason, requested_at, expires_at, status, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.request_id, record.actor_id, record.parent_id, record.workspace || null,
        record.resource, JSON.stringify(record.actions), record.environment, record.reason,
        record.requested_at, record.expires_at, record.status, record.idempotency_key,
      ),
      this.prepare(
        `INSERT INTO ${TABLE.IDEMPOTENCY} (actor_id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`,
        record.actor_id, record.idempotency_key, JSON.stringify(response), record.requested_at,
      ),
    ]);
  }

  async transitionRequest(requestId, expectedStatus, update) {
    const status = update.status;
    if (![STATUS.PENDING, STATUS.APPROVED, STATUS.DECLINED, STATUS.EXPIRED].includes(status)) return false;
    const result = await this.prepare(
      `UPDATE ${TABLE.REQUESTS} SET status = ?, decided_at = ?, decided_by = ? WHERE request_id = ? AND status = ?`,
      status, update.decided_at || null, update.decided_by || null, requestId, expectedStatus,
    ).run();
    return Number(result?.meta?.changes || 0) === 1;
  }

  async getIdempotency(actorId, idempotencyKey) {
    const row = await this.prepare(
      `SELECT response_json FROM ${TABLE.IDEMPOTENCY} WHERE actor_id = ? AND idempotency_key = ?`, actorId, idempotencyKey,
    ).first();
    return row ? parseJson(row.response_json, null) : null;
  }

  async putIdempotency(actorId, idempotencyKey, response) {
    await this.prepare(
      `INSERT INTO ${TABLE.IDEMPOTENCY} (actor_id, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)`,
      actorId, idempotencyKey, JSON.stringify(response), new Date().toISOString(),
    ).run();
  }

  async createGrant(grant) {
    await this.prepare(
      `INSERT INTO ${TABLE.GRANTS} (grant_id, subject_id, parent_id, workspace, resource, actions_json, environment, expires_at, issued_at, issued_by, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grant.grant_id, grant.subject_id, grant.parent_id, grant.workspace || null, grant.resource,
      JSON.stringify(grant.actions), grant.environment, grant.expires_at, grant.issued_at,
      grant.issued_by, grant.request_id,
    ).run();
  }

  async approveRequestWithGrant(request, grant) {
    if (!this.db || typeof this.db.batch !== "function") unavailable();
    const decidedAt = grant.issued_at;
    const results = await this.db.batch([
      this.prepare(
        `UPDATE ${TABLE.REQUESTS} SET status = ?, decided_at = ?, decided_by = ? WHERE request_id = ? AND status = ?`,
        STATUS.APPROVED, decidedAt, grant.issued_by, request.request_id, STATUS.PENDING,
      ),
      this.prepare(
        `INSERT INTO ${TABLE.GRANTS} (grant_id, subject_id, parent_id, workspace, resource, actions_json, environment, expires_at, issued_at, issued_by, request_id) SELECT ?, actor_id, parent_id, workspace, resource, actions_json, environment, expires_at, ?, ?, ? FROM ${TABLE.REQUESTS} WHERE request_id = ? AND status = ? AND decided_by = ?`,
        grant.grant_id, grant.issued_at, grant.issued_by, grant.request_id, grant.request_id, STATUS.APPROVED, grant.issued_by,
      ),
    ]);
    return Number(results?.[1]?.meta?.changes || 0) === 1;
  }

  async getGrant(grantId) {
    const row = await this.prepare(
      `SELECT g.* FROM ${TABLE.GRANTS} g WHERE g.grant_id = ? AND NOT EXISTS (SELECT 1 FROM ${TABLE.REVOKED} r WHERE r.grant_id = g.grant_id)`, grantId,
    ).first();
    return grantRow(row);
  }

  async isRevoked(grantId) {
    const row = await this.prepare(
      `SELECT grant_id FROM ${TABLE.REVOKED} WHERE grant_id = ?`, grantId,
    ).first();
    return Boolean(row);
  }

  async getActiveGrant(subjectId, resource, environment, now) {
    const row = await this.prepare(
      `SELECT g.* FROM ${TABLE.GRANTS} g WHERE g.subject_id = ? AND g.resource = ? AND g.environment = ? AND g.expires_at > ? AND NOT EXISTS (SELECT 1 FROM ${TABLE.REVOKED} r WHERE r.grant_id = g.grant_id) ORDER BY g.expires_at DESC LIMIT 1`,
      subjectId, resource, environment, new Date(now).toISOString(),
    ).first();
    return grantRow(row);
  }

  async putBackup(backup) {
    await this.prepare(
      `INSERT INTO ${TABLE.BACKUPS} (backup_id, subject_id, envelope_json, created_at) VALUES (?, ?, ?, ?)`,
      backup.backup_id, backup.subject_id, JSON.stringify(backup.envelope), backup.created_at,
    ).run();
  }

  async getBackup(backupId) {
    const row = await this.prepare(
      `SELECT backup_id, subject_id, envelope_json, created_at FROM ${TABLE.BACKUPS} WHERE backup_id = ?`, backupId,
    ).first();
    return row ? { backup_id: row.backup_id, subject_id: row.subject_id, envelope: parseJson(row.envelope_json, null), created_at: row.created_at } : null;
  }

  async registerAgent(agent) {
    await this.prepare(
      `INSERT INTO ${TABLE.AGENTS} (subject_id, parent_id, workspace, environment, public_key, registered_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject_id) DO UPDATE SET parent_id = excluded.parent_id, workspace = excluded.workspace, environment = excluded.environment, public_key = excluded.public_key`,
      agent.subject_id, agent.parent_id, agent.workspace || null, agent.environment || null, agent.public_key, agent.registered_at,
    ).run();
  }

  async isApprover(subjectId, workspace) {
    const row = await this.prepare(
      `SELECT subject_id FROM ${TABLE.APPROVERS} WHERE subject_id = ? AND workspace = ? AND revoked_at IS NULL`, subjectId, workspace,
    ).first();
    return Boolean(row);
  }

  async checkReadiness() {
    if (!this.db || typeof this.db.prepare !== "function") return false;
    try {
      const result = await this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('access_requests', 'grants', 'idempotency_keys', 'identity_backups', 'revoked_grants')").all();
      const names = new Set((result?.results || []).map((row) => row.name));
      return [TABLE.REQUESTS, TABLE.GRANTS, TABLE.IDEMPOTENCY, TABLE.BACKUPS, TABLE.REVOKED].every((name) => names.has(name));
    } catch { return false; }
  }
}

export function createD1Store(db) { return new D1Store(db); }
