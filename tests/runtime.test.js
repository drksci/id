import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION,
  FailClosedError,
  SUBJECT_KIND,
  STATUS,
  approveAccessRequest,
  backupIdentity,
  dispatchMcp,
  handleRequest,
  intersectScope,
  requestAccess,
  restoreIdentity,
} from "../src/runtime.js";

const NOW = new Date("2026-09-17T00:00:00.000Z");
const agent = {
  sub: "agent://id/dev/child-1", kind: SUBJECT_KIND.AGENT, issuer: "https://id.drksci.com",
  audience: "id-worker", scopes: ["contents:read", "contents:write"], environment: "dev",
  parent_id: "agent://id/dev/parent-1", expires_at: "2026-09-17T01:00:00.000Z", jti: "jti-agent-1",
};
const human = {
  sub: "human://github/operator", kind: SUBJECT_KIND.HUMAN, issuer: "https://id.drksci.com",
  audience: "id-worker", scopes: ["approve"], environment: "dev",
  expires_at: "2026-09-18T00:00:00.000Z", jti: "jti-human-1",
};

class Store {
  constructor() { this.requests = new Map(); this.idempotency = new Map(); this.grants = new Map(); this.backups = new Map(); }
  async getRequest(id) { return this.requests.get(id); }
  async createRequest(record) { this.requests.set(record.request_id, record); }
  async transitionRequest(id, expected, update) {
    const current = this.requests.get(id);
    if (!current || current.status !== expected) return false;
    this.requests.set(id, { ...current, ...update });
    return true;
  }
  async getIdempotency(actor, key) { return this.idempotency.get(`${actor}:${key}`); }
  async putIdempotency(actor, key, value) { this.idempotency.set(`${actor}:${key}`, value); }
  async createGrant(grant) { this.grants.set(grant.grant_id, grant); }
  async getGrant(id) { return this.grants.get(id); }
  async putBackup(backup) { this.backups.set(backup.backup_id, backup); }
  async getBackup(id) { return this.backups.get(id); }
  async registerAgent() {}
}

function requestBody(extra = {}) {
  return {
    actor_id: agent.sub, resource: "github:alphaville-foundry/alphaville_foundary",
    actions: ["contents:read"], environment: "dev", reason: "read source",
    expires_at: "2026-09-17T00:30:00.000Z", idempotency_key: "idem-1", ...extra,
  };
}

test("scope is bounded by agent authority and parent expiry", () => {
  const bounded = intersectScope(agent, requestBody({ expires_at: "2026-09-17T00:55:00.000Z" }), NOW);
  assert.deepEqual(bounded.actions, ["contents:read"]);
  assert.equal(bounded.expires_at, "2026-09-17T00:55:00.000Z");
  assert.throws(() => intersectScope(agent, requestBody({ actions: ["admin:delete"] }), NOW), (error) => error.code === "scope_exceeds_parent");
  assert.throws(() => intersectScope(agent, requestBody({ environment: "production" }), NOW), (error) => error.code === "environment_exceeds_parent");
});

test("access approval is one-time and idempotent", async () => {
  const store = new Store();
  const created = await requestAccess({ subject: agent, request: requestBody(), store, now: NOW, randomId: () => "request_opaque_123456789" });
  const repeated = await requestAccess({ subject: agent, request: requestBody(), store, now: NOW, randomId: () => "different_opaque_123456" });
  assert.deepEqual(repeated, created);
  const grant = await approveAccessRequest({ requestId: created.request_id, subject: human, decision: DECISION.APPROVE, store, now: NOW, grantId: "grant_opaque_123456789" });
  assert.equal(grant.expires_at, "2026-09-17T00:30:00.000Z");
  await assert.rejects(() => approveAccessRequest({ requestId: created.request_id, subject: human, decision: DECISION.APPROVE, store, now: NOW }), (error) => error.code === "replayed_request");
});

test("missing authentication or storage fails closed", async () => {
  const response = await handleRequest(new Request("https://id.drksci.com/api/v1/access-requests", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "authentication_unavailable" });
  await assert.rejects(() => requestAccess({ subject: agent, request: requestBody(), store: {}, now: NOW }), (error) => error.code === "storage_unavailable");
  const unverified = await handleRequest(new Request("https://id.drksci.com/api/v1/access-requests", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { AUTHENTICATE: async () => ({ claim: agent }) });
  assert.equal(unverified.status, 503);
  assert.deepEqual(await unverified.json(), { error: "authentication_unavailable" });
});

test("backup stores only an opaque ciphertext envelope and restore needs proof plus authorizer", async () => {
  const store = new Store();
  const backup = await backupIdentity({ subject: agent, store, now: NOW, envelope: { algorithm: "AES-GCM", nonce: "bm9uY2U", ciphertext: "Y2lwaGVydGV4dA", key_id: "key-1" } });
  const authorizer = { ...human, audience: "id-worker" };
  const restored = await restoreIdentity({ subject: agent, authorizer, backupId: backup.backup_id, proof: { challenge: "challenge", signature: "signature" }, store, verifyProof: async () => true, now: NOW });
  assert.equal(restored.envelope.ciphertext, "Y2lwaGVydGV4dA");
  assert.equal(Object.hasOwn(restored.envelope, "plaintext"), false);
  await assert.rejects(() => restoreIdentity({ subject: agent, authorizer, backupId: backup.backup_id, proof: { challenge: "challenge", signature: "signature" }, store, now: NOW }), (error) => error.code === "proof_verifier_unavailable");
  await assert.rejects(() => restoreIdentity({ subject: agent, authorizer: { ...agent, sub: "agent://id/dev/other" }, backupId: backup.backup_id, proof: { challenge: "challenge", signature: "signature" }, store, verifyProof: async () => true, now: NOW }), (error) => error.code === "authorization_required");
});

test("MCP dispatch exposes registration, request, grant and backup methods", async () => {
  const store = new Store();
  const result = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "backup_identity", params: { envelope: { algorithm: "AES-GCM", nonce: "bm9uY2U", ciphertext: "Y2lwaGVydGV4dA" } } }, { subject: agent, store });
  assert.equal(result.stored, true);
  await assert.rejects(() => dispatchMcp({ jsonrpc: "2.0", id: 2, method: "restore_identity", params: { backup_id: result.backup_id, proof: { challenge: "x", signature: "y" } } }, { subject: agent, store, env: {} }), (error) => error.code === "authorization_required");
});
