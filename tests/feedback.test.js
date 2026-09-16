import test from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_STATUS,
  ONBOARDING_STATUS,
  SERVICE_VERIFICATION,
  SUBJECT_KIND,
  getFeedback,
  analyzeFeedback,
  getOnboardingRequest,
  getService,
  handleRequest,
  listServices,
  registerService,
  requestOnboarding,
  submitFeedback,
  verifyOnboardingDns,
} from "../src/runtime.js";
import { D1Store } from "../src/storage.js";

const NOW = new Date("2026-09-17T00:00:00.000Z");
const policy = { workspace: "workspace://drksci/alphaville_foundary/dev", resource: "github:alphaville-foundry/alphaville_foundary", environment: "dev", approvers: ["human://approver"] };
const agent = { sub: "agent://feedback/test", kind: SUBJECT_KIND.AGENT, issuer: "https://id.drksci.com", audience: ["id-worker"], scopes: ["contents:read"], environment: "dev", parent_id: "agent://parent", expires_at: "2026-09-18T00:00:00.000Z", jti: "feedback-jti" };
const human = { sub: "human://approver", kind: SUBJECT_KIND.HUMAN, issuer: "https://id.drksci.com", audience: ["id-worker"], scopes: ["approve"], environment: "dev", expires_at: "2026-09-18T00:00:00.000Z", jti: "human-jti" };

class Store {
  constructor() { this.idempotency = new Map(); this.feedback = new Map(); this.onboarding = new Map(); this.services = new Map(); this.outbox = []; }
  async getIdempotency(actor, key) { return this.idempotency.get(`${actor}:${key}`) || null; }
  async putIdempotency(actor, key, value) { this.idempotency.set(`${actor}:${key}`, value); }
  async createFeedback(record) { this.feedback.set(record.feedback_id, record); }
  async createFeedbackWithIdempotency(record, response) { await this.createFeedback(record); await this.putIdempotency(record.actor_subject_hash, record.idempotency_key, response); this.outbox.push({ feedback_id: record.feedback_id, status: "pending" }); }
  async getFeedback(id) { return this.feedback.get(id) || null; }
  async createFeedbackSuggestion(record) { this.suggestions = this.suggestions || new Map(); this.suggestions.set(record.feedback_id, record); }
  async getFeedbackSuggestions(id) { return this.suggestions?.get(id) || null; }
  async createOnboarding(record) { this.onboarding.set(record.request_id, record); }
  async createOnboardingWithIdempotency(record, response) { await this.createOnboarding(record); await this.putIdempotency(record.actor_subject_hash, record.idempotency_key, response); }
  async getOnboarding(id) { return this.onboarding.get(id) || null; }
  async transitionOnboarding(id, expected, update) { const record = this.onboarding.get(id); if (!record || record.status !== expected) return false; this.onboarding.set(id, { ...record, ...update }); return true; }
  async createService(record) { this.services.set(record.service_id, record); }
  async createServiceWithIdempotency(record, response) { await this.createService(record); await this.putIdempotency(record.actor_subject_hash, record.idempotency_key, response); }
  async getService(id) { return this.services.get(id) || null; }
  async listServices(workspace) { return [...this.services.values()].filter((service) => service.workspace === workspace); }
  async isApprover(subject) { return subject === human.sub; }
}

function feedbackInput(extra = {}) {
  return { idempotency_key: "feedback-idem", correlation_id: "corr-1", prompt_id: "prompt-1", expected_outcome: "a grant is returned", observed_result: "the request was rejected", reproduction_steps: "1. request; 2. retry", workspace: policy.workspace, environment: "dev", resource: policy.resource, event: "access.request", action: "approve", severity: "error", message: "Bearer abc should never be retained", metadata: { component: "runtime", error_code: "denied" }, ...extra };
}

test("feedback is feature gated, redacts secrets, and emits a pending mirror outbox record", async () => {
  const store = new Store();
  await assert.rejects(() => submitFeedback({ subject: agent, feedback: feedbackInput(), store, policy, now: NOW, env: {} }), (error) => error.code === "feature_disabled");
  const response = await submitFeedback({ subject: agent, feedback: feedbackInput(), store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_opaque_123456789" });
  assert.equal(response.status, FEEDBACK_STATUS.OPEN);
  const record = store.feedback.get(response.feedback_id);
  assert.match(record.message, /Bearer \[REDACTED\]/);
  assert.match(record.actor_subject_hash, /^sha256:/);
  assert.equal(store.outbox[0].status, "pending");
  const repeated = await submitFeedback({ subject: agent, feedback: feedbackInput(), store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "different_opaque_123456" });
  assert.deepEqual(repeated, response);
});

test("feedback read is limited to its actor or an approver", async () => {
  const store = new Store();
  const response = await submitFeedback({ subject: agent, feedback: feedbackInput(), store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_read_123456789" });
  const visible = await getFeedback({ feedbackId: response.feedback_id, subject: human, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true } });
  assert.equal(visible.feedback_id, response.feedback_id);
  await assert.rejects(() => getFeedback({ feedbackId: response.feedback_id, subject: { ...agent, sub: "agent://other" }, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true } }), (error) => error.code === "forbidden");
});

test("assistant analysis is feature gated, linked to correlation, and never proposes an applied policy", async () => {
  const store = new Store();
  const feedback = await submitFeedback({ subject: agent, feedback: feedbackInput({ idempotency_key: "assistant-feedback" }), store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_assistant_123456789" });
  await assert.rejects(() => analyzeFeedback({ feedbackId: feedback.feedback_id, subject: agent, store, policy, now: NOW, env: {} }), (error) => error.code === "feature_disabled");
  const result = await analyzeFeedback({ feedbackId: feedback.feedback_id, subject: agent, store, policy, now: NOW, env: { ASSISTANT_ENABLED: true }, correlationId: "corr-linked" });
  assert.equal(result.correlation_id, "corr-linked");
  assert.equal(result.proposed_policy_diff.apply, false);
  assert.ok(result.suggestions.length > 0);
});

test("onboarding creates an explicit pending challenge, supports authoritative DNS verification, and rejects credential URLs", async () => {
  const store = new Store();
  const request = await requestOnboarding({ subject: agent, store, policy, now: NOW, onboarding: { idempotency_key: "onboard-1", provider: "github_app", target: "alphaville-foundry/id", repository_remote: "https://github.com/alphaville-foundry/id.git", workspace: policy.workspace, environment: "dev", resource: policy.resource, scopes: ["contents:read"], expires_at: "2026-09-17T01:00:00.000Z" }, randomId: () => "onboard_opaque_123456789" });
  assert.equal(request.status, ONBOARDING_STATUS.PENDING);
  assert.equal((await verifyOnboardingDns({ request: store.onboarding.get(request.request_id), lookup: async () => [request.challenge.value], store, now: NOW })).verified, true);
  assert.equal(store.onboarding.get(request.request_id).status, ONBOARDING_STATUS.VERIFIED);
  await assert.rejects(() => requestOnboarding({ subject: agent, store, policy, now: NOW, onboarding: { idempotency_key: "onboard-bad", provider: "github_app", target: "x", repository_remote: "https://user:token@github.com/a/b.git", workspace: policy.workspace, environment: "dev", resource: policy.resource, scopes: ["contents:read"], expires_at: "2026-09-17T01:00:00.000Z" } }), (error) => error.code === "invalid_onboarding");
});

test("service catalog is feature gated, enforces nested workspace and remains pending", async () => {
  const store = new Store();
  const service = await registerService({ subject: agent, store, policy: { ...policy, workspace: "workspace://drksci/alphaville_foundary" }, env: { SERVICE_CATALOG_ENABLED: true }, now: NOW, randomId: () => "service_opaque_123456789", service: { idempotency_key: "service-1", canonical_name: "github", service_type: "source-control", provider: "github", endpoint: "https://github.com", workspace: "workspace://drksci/alphaville_foundary/dev", parent_workspace: "workspace://drksci/alphaville_foundary", environment: "dev", resource: policy.resource, capabilities: ["contents:read"], expires_at: "2026-09-18T00:00:00.000Z", metadata: { component: "catalog" } } });
  assert.equal(service.verification_state, SERVICE_VERIFICATION.PENDING);
  assert.equal((await listServices({ subject: agent, workspace: "workspace://drksci/alphaville_foundary/dev", store, policy: { ...policy, workspace: "workspace://drksci/alphaville_foundary" }, env: { SERVICE_CATALOG_ENABLED: true }, now: NOW })).length, 1);
  await assert.rejects(() => registerService({ subject: agent, store, policy: { ...policy, workspace: "workspace://drksci/alphaville_foundary" }, env: { SERVICE_CATALOG_ENABLED: false }, now: NOW, service: {} }), (error) => error.code === "feature_disabled");
  await assert.rejects(() => registerService({ subject: agent, store, policy: { ...policy, workspace: "workspace://drksci/alphaville_foundary" }, env: { SERVICE_CATALOG_ENABLED: true }, now: NOW, service: { ...service, idempotency_key: "bad", workspace: "workspace://other/dev", parent_workspace: "workspace://drksci/alphaville_foundary" } }), (error) => error.code === "workspace_mismatch");
});

test("HTTP feedback route authenticates and feature gates before persistence", async () => {
  const store = new Store();
  const request = new Request("https://id.drksci.com/api/v1/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(feedbackInput()) });
  const env = { AUTHENTICATE: async () => ({ verified: true, claim: agent }), STORE: store, FEEDBACK_ENABLED: true, APP_ENV: "dev", WORKSPACE: policy.workspace, RESOURCE: policy.resource };
  const response = await handleRequest(request, env);
  assert.equal(response.status, 201);
  const disabled = await handleRequest(new Request("https://id.drksci.com/api/v1/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(feedbackInput()) }), { ...env, FEEDBACK_ENABLED: false });
  assert.equal(disabled.status, 404);
});

test("D1 feedback persistence batches record, outbox and idempotency", async () => {
  const batches = [];
  const db = { prepare(sql) { return { bind(...values) { return { sql, values, async run() { return { meta: { changes: 1 } }; } }; } }; }, async batch(statements) { batches.push(statements); } };
  const store = new D1Store(db);
  await store.createFeedbackWithIdempotency({ feedback_id: "feedback_d1_123456789", actor_subject_hash: "sha256:abc", actor_kind: "agent", correlation_id: "c", prompt_id: "p", workspace: "w", environment: "dev", resource: "r", event: "e", action: "a", context: undefined, expected_outcome: "x", observed_result: "y", reproduction_steps: "z", severity: "error", message: "safe", metadata: {}, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: "open", idempotency_key: "i" }, { feedback_id: "feedback_d1_123456789" });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
});
