import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION,
  FailClosedError,
  SUBJECT_KIND,
  STATUS,
  approveAccessRequest,
  backupIdentity,
  MCP_PROTOCOL,
  MCP_TOOL,
  dispatchMcp,
  getGrant,
  handleRequest,
  intersectScope,
  requestAccess,
  restoreIdentity,
} from "../src/runtime.js";
import { D1Store } from "../src/storage.js";
import { clearJwksCache, verifyAccessJwt } from "../src/auth.js";

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
  constructor({ parentGrant = null, approver = true, revoked = false } = {}) { this.requests = new Map(); this.idempotency = new Map(); this.grants = new Map(); this.backups = new Map(); this.parentGrant = parentGrant; this.approver = approver; this.revoked = revoked; }
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
  async getActiveGrant() { return this.parentGrant; }
  async isRevoked() { return this.revoked; }
  async isApprover() { return this.approver; }
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
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
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

test("policy binds requests to workspace and runtime environment", async () => {
  const store = new Store();
  const policy = { workspace: "workspace://drksci/alphaville_foundary/dev", resource: "github:alphaville-foundry/alphaville_foundary", environment: "dev" };
  const result = await requestAccess({ subject: agent, store, policy, now: NOW, randomId: () => "request_policy_123456789", request: requestBody({ workspace: policy.workspace }) });
  assert.equal(result.status, STATUS.PENDING);
  await assert.rejects(() => requestAccess({ subject: agent, store, policy, now: NOW, randomId: () => "request_policy_987654321", request: requestBody({ workspace: "workspace://other/dev", idempotency_key: "idem-other" }) }), (error) => error.code === "workspace_mismatch");
});

test("health is public while readiness fails closed without a complete D1 schema", async () => {
  const health = await handleRequest(new Request("https://id.drksci.com/healthz"), {});
  assert.equal(health.status, 200);
  const missing = await handleRequest(new Request("https://id.drksci.com/readyz"), {});
  assert.equal(missing.status, 503);
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return { results: [{ name: "access_requests" }, { name: "grants" }, { name: "idempotency_keys" }, { name: "identity_backups" }, { name: "revoked_grants" }] }; },
      };
    },
  };
  const ready = await handleRequest(new Request("https://id.drksci.com/readyz"), { DB: db });
  assert.equal(ready.status, 200);
});

test("D1 request creation uses one batch for request plus idempotency", async () => {
  const batches = [];
  const db = {
    prepare(sql) {
      return { bind(...values) { return { sql, values, async run() { return { meta: { changes: 1 } }; } }; } };
    },
    async batch(statements) { batches.push(statements); },
  };
  const store = new D1Store(db);
  await store.createRequestWithIdempotency({ request_id: "request_d1_123456789", actor_id: agent.sub, parent_id: agent.parent_id, resource: "r", actions: ["a"], environment: "dev", reason: "test", requested_at: NOW.toISOString(), expires_at: "2026-09-17T00:30:00.000Z", status: STATUS.PENDING, idempotency_key: "idem-d1" }, { request_id: "request_d1_123456789" });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});

test("policy requires a live parent grant and active approver", async () => {
  const policy = { workspace: "workspace://drksci/alphaville_foundary/dev", resource: "github:alphaville-foundry/alphaville_foundary", environment: "dev", requireParentGrant: true, requireApproverRecord: true };
  const parentGrant = { grant_id: "parent_grant_123456789", subject_id: agent.parent_id, parent_id: "agent://id/dev/root", workspace: policy.workspace, resource: policy.resource, actions: ["contents:read"], environment: "dev", expires_at: "2026-09-17T00:45:00.000Z" };
  const store = new Store({ parentGrant, approver: true });
  const created = await requestAccess({ subject: agent, request: requestBody({ workspace: policy.workspace }), policy, store, now: NOW, randomId: () => "request_bound_123456789" });
  const grant = await approveAccessRequest({ requestId: created.request_id, subject: human, decision: DECISION.APPROVE, policy, store, now: NOW, grantId: "grant_bound_123456789" });
  assert.equal(grant.workspace, policy.workspace);
  store.revoked = true;
  await assert.rejects(() => getGrant({ grantId: grant.grant_id, subject: agent, policy: { ...policy, requireParentGrant: false, requireRevocation: true }, store, now: NOW }), (error) => error.code === "grant_revoked");
  const denied = new Store({ parentGrant, approver: false });
  const pending = await requestAccess({ subject: agent, request: requestBody({ workspace: policy.workspace, idempotency_key: "idem-denied" }), policy, store: denied, now: NOW, randomId: () => "request_bound_987654321" });
  await assert.rejects(() => approveAccessRequest({ requestId: pending.request_id, subject: human, decision: DECISION.APPROVE, policy, store: denied, now: NOW }), (error) => error.code === "approver_not_allowed");
});

function base64url(bytes) {
  const binary = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signedJwt(privateKey, payload, kid = "kid-1") {
  const header = { alg: "RS256", typ: "JWT", kid };
  const encoded = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${base64url(signature)}`;
}

test("Access JWT verification enforces issuer, audience, expiry, kid and signature with JWKS cache", async () => {
  clearJwksCache();
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "kid-1", alg: "RS256", use: "sig" };
  let fetches = 0;
  const env = { ACCESS_ISSUER: "https://access.example", ACCESS_AUDIENCE: "id-worker", ACCESS_JWKS_URL: "https://access.example/certs", ACCESS_AGENT_SCOPES: ["contents:read"], APP_ENV: "dev" };
  const payload = { iss: env.ACCESS_ISSUER, aud: env.ACCESS_AUDIENCE, sub: agent.sub, kind: "agent", parent_id: agent.parent_id, scope: "contents:read", environment: "dev", exp: Math.floor(Date.now() / 1000) + 300, jti: "jwt-1" };
  const token = await signedJwt(pair.privateKey, payload);
  const request = new Request("https://id.drksci.com/mcp", { headers: { authorization: `Bearer ${token}` } });
  const fetcher = async () => { fetches += 1; return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "content-type": "application/json" } }); };
  const result = await verifyAccessJwt(request, env, { fetcher });
  assert.equal(result.verified, true);
  assert.equal(result.claim.sub, agent.sub);
  await verifyAccessJwt(request, env, { fetcher });
  assert.equal(fetches, 1);
  const tokenParts = token.split(".");
  const tamperedPayload = `${tokenParts[1].slice(0, -1)}${tokenParts[1].endsWith("A") ? "B" : "A"}`;
  const tampered = `${tokenParts[0]}.${tamperedPayload}.${tokenParts[2]}`;
  await assert.rejects(() => verifyAccessJwt(new Request(request.url, { headers: { authorization: `Bearer ${tampered}` } }), env, { fetcher }), (error) => error.code === "invalid_token");
  await assert.rejects(() => verifyAccessJwt(new Request(request.url, { headers: { authorization: `Bearer ${token}` } }), { ...env, ACCESS_AUDIENCE: "other" }, { fetcher }), (error) => error.code === "wrong_audience");
  const expired = await signedJwt(pair.privateKey, { ...payload, exp: Math.floor(Date.now() / 1000) - 120 });
  await assert.rejects(() => verifyAccessJwt(new Request(request.url, { headers: { authorization: `Bearer ${expired}` } }), env, { fetcher }), (error) => error.code === "subject_expired");
});

test("MCP protocol supports initialize, tools/list and tools/call", async () => {
  const initialized = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: MCP_PROTOCOL.INITIALIZE }, {});
  assert.equal(initialized.protocolVersion, MCP_PROTOCOL.VERSION);
  const listed = await dispatchMcp({ jsonrpc: "2.0", id: 2, method: MCP_PROTOCOL.TOOLS_LIST }, {});
  assert.ok(listed.tools.some((tool) => tool.name === MCP_TOOL.REQUEST_ACCESS));
  const store = new Store();
  const called = await dispatchMcp({ jsonrpc: "2.0", id: 3, method: MCP_PROTOCOL.TOOLS_CALL, params: { name: MCP_TOOL.BACKUP_IDENTITY, arguments: { envelope: { algorithm: "AES-GCM", nonce: "bm9uY2U", ciphertext: "Y2lwaGVydGV4dA" } } } }, { subject: agent, store });
  assert.equal(called.stored, true);
  assert.equal(called.content[0].type, "text");
});

test("HTTP MCP initialize preserves JSON-RPC id and uses authenticated policy", async () => {
  const claim = { ...agent, expires_at: "2099-01-01T00:00:00.000Z" };
  const request = new Request("https://id.drksci.com/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: MCP_PROTOCOL.INITIALIZE }) });
  const response = await handleRequest(request, { AUTHENTICATE: async () => ({ verified: true, claim }), STORE: new Store(), APP_ENV: "dev", WORKSPACE: "workspace://drksci/alphaville_foundary/dev", RESOURCE: "github:alphaville-foundry/alphaville_foundary" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 42);
  assert.equal(body.result.protocolVersion, MCP_PROTOCOL.VERSION);
});
