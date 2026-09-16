import { createD1Store } from "./storage.js";
import { verifyAccessJwt } from "./auth.js";
import { handleGitHubWebhook } from "./github-webhook.js";

/**
 * Small, dependency-free authorization primitives for the id-worker.
 *
 * Storage and authentication are deliberately injected. The Worker never
 * invents a credential store and never treats a missing binding as trust.
 */

export const SCHEMA = Object.freeze({
  ACCESS_REQUEST: "drksci.id.access-request.v1",
  GRANT: "drksci.id.grant.v1",
  BACKUP: "drksci.id.identity-backup.v1",
  FEEDBACK: "drksci.id.feedback.v1",
  ONBOARDING: "drksci.id.onboarding.v1",
});

export const STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  DECLINED: "declined",
  EXPIRED: "expired",
});

export const SUBJECT_KIND = Object.freeze({ AGENT: "agent", HUMAN: "human" });
export const DECISION = Object.freeze({ APPROVE: "approve", DECLINE: "decline" });
export const MCP_METHOD = Object.freeze({
  REGISTER_AGENT: "register_agent",
  REQUEST_ACCESS: "request_access",
  GET_GRANT: "get_grant",
  BACKUP_IDENTITY: "backup_identity",
  RESTORE_IDENTITY: "restore_identity",
  SUBMIT_FEEDBACK: "submit_feedback",
  REQUEST_ONBOARDING: "request_onboarding",
  GET_ONBOARDING_REQUEST: "get_onboarding_request",
  REGISTER_SERVICE: "register_service",
  LIST_SERVICES: "list_services",
  ANALYZE_FEEDBACK: "analyze_feedback",
  GET_FEEDBACK_SUGGESTIONS: "get_feedback_suggestions",
});
export const MCP_PROTOCOL = Object.freeze({
  INITIALIZE: "initialize",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
  INITIALIZED: "notifications/initialized",
  VERSION: "2025-06-18",
});
export const MCP_TOOL = Object.freeze({
  REGISTER_AGENT: "register_agent",
  REQUEST_ACCESS: "request_access",
  GET_GRANT: "get_grant",
  BACKUP_IDENTITY: "backup_identity",
  RESTORE_IDENTITY: "restore_identity",
  SUBMIT_FEEDBACK: "submit_feedback",
  REQUEST_ONBOARDING: "request_onboarding",
  GET_ONBOARDING_REQUEST: "get_onboarding_request",
  REGISTER_SERVICE: "register_service",
  LIST_SERVICES: "list_services",
  ANALYZE_FEEDBACK: "analyze_feedback",
  GET_FEEDBACK_SUGGESTIONS: "get_feedback_suggestions",
});
export const MCP_TOOLS = Object.freeze([
  Object.freeze({ name: MCP_TOOL.REGISTER_AGENT, description: "Register an agent public key.", inputSchema: { type: "object", required: ["public_key"], properties: { public_key: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.REQUEST_ACCESS, description: "Request bounded delegated access.", inputSchema: { type: "object", required: ["actor_id", "resource", "actions", "expires_at", "reason", "idempotency_key"], properties: { actor_id: { type: "string" }, workspace: { type: "string" }, resource: { type: "string" }, actions: { type: "array", items: { type: "string" } }, environment: { type: "string" }, expires_at: { type: "string" }, reason: { type: "string" }, idempotency_key: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.GET_GRANT, description: "Retrieve the authenticated agent grant.", inputSchema: { type: "object", required: ["grant_id"], properties: { grant_id: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.BACKUP_IDENTITY, description: "Store a client-encrypted identity envelope.", inputSchema: { type: "object", required: ["envelope"], properties: { envelope: { type: "object" } } } }),
  Object.freeze({ name: MCP_TOOL.RESTORE_IDENTITY, description: "Restore an encrypted identity envelope with proof and authorization.", inputSchema: { type: "object", required: ["backup_id", "proof"], properties: { backup_id: { type: "string" }, proof: { type: "object" } } } }),
  Object.freeze({ name: MCP_TOOL.SUBMIT_FEEDBACK, description: "Submit structured runtime feedback with prompt_id, expected_outcome, observed_result, reproduction_steps, event, action, and context.", inputSchema: { type: "object", required: ["idempotency_key", "correlation_id", "prompt_id", "expected_outcome", "observed_result", "reproduction_steps", "event", "action", "severity", "message"], properties: { idempotency_key: { type: "string" }, correlation_id: { type: "string" }, prompt_id: { type: "string" }, expected_outcome: { type: "string" }, observed_result: { type: "string" }, reproduction_steps: { type: "string" }, event: { type: "string" }, action: { type: "string" }, context: { type: "object" }, severity: { type: "string" }, message: { type: "string" }, workspace: { type: "string" }, environment: { type: "string" }, resource: { type: "string" }, metadata: { type: "object" } } } }),
  Object.freeze({ name: MCP_TOOL.REQUEST_ONBOARDING, description: "Create a pending provider onboarding request with DNS verification instructions; provider side effects remain explicit.", inputSchema: { type: "object", required: ["idempotency_key", "provider", "target", "workspace", "environment"], properties: { idempotency_key: { type: "string" }, provider: { type: "string" }, target: { type: "string" }, workspace: { type: "string" }, environment: { type: "string" }, resource: { type: "string" }, intent: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.GET_ONBOARDING_REQUEST, description: "Read an authorized onboarding request and its verification status.", inputSchema: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.REGISTER_SERVICE, description: "Register a pending service catalog record.", inputSchema: { type: "object", required: ["canonical_name", "service_type", "provider", "endpoint", "workspace", "capabilities", "expires_at", "idempotency_key"], properties: { canonical_name: { type: "string" }, service_type: { type: "string" }, provider: { type: "string" }, endpoint: { type: "string" }, workspace: { type: "string" }, parent_workspace: { type: "string" }, environment: { type: "string" }, capabilities: { type: "array" }, expires_at: { type: "string" }, idempotency_key: { type: "string" }, metadata: { type: "object" } } } }),
  Object.freeze({ name: MCP_TOOL.LIST_SERVICES, description: "List authorized service catalog records.", inputSchema: { type: "object", required: ["workspace"], properties: { workspace: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.ANALYZE_FEEDBACK, description: "Analyze one authorized feedback record into deterministic, reviewable suggestions.", inputSchema: { type: "object", required: ["feedback_id", "correlation_id"], properties: { feedback_id: { type: "string" }, correlation_id: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.GET_FEEDBACK_SUGGESTIONS, description: "Read authorized feedback suggestions without applying policy.", inputSchema: { type: "object", required: ["feedback_id"], properties: { feedback_id: { type: "string" } } } }),
]);
export const AUDIENCE = "id-worker";
export const ENVIRONMENT = Object.freeze({
  LOCAL: "local",
  DEV: "dev",
  PREVIEW: "preview",
  STAGING: "staging",
  TEST: "test",
  PRODUCTION: "production",
});
const ENVIRONMENTS = new Set(Object.values(ENVIRONMENT));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ACTIONS = 32;
const MAX_TEXT = 512;
export const FEEDBACK_STATUS = Object.freeze({ OPEN: "open", ACKNOWLEDGED: "acknowledged", RESOLVED: "resolved", DISMISSED: "dismissed" });
export const FEEDBACK_SEVERITY = Object.freeze({ DEBUG: "debug", INFO: "info", WARNING: "warning", ERROR: "error", CRITICAL: "critical" });
export const ONBOARDING_STATUS = Object.freeze({ PENDING: "pending", VERIFIED: "verified", DENIED: "denied", EXPIRED: "expired" });
export const ONBOARDING_PROVIDER = Object.freeze({ GITHUB_APP: "github_app", CLOUDFLARE_DOMAIN: "cloudflare_domain", SERVICE_INTEGRATION: "service_integration" });
export const SERVICE_VERIFICATION = Object.freeze({ PENDING: "pending", VERIFIED: "verified", DENIED: "denied" });
export const SERVICE_CATALOG_STATUS = Object.freeze({ ACTIVE: "active", EXPIRED: "expired" });
const SERVICE_CATALOG_ENABLED = "SERVICE_CATALOG_ENABLED";
const FEEDBACK_SEVERITIES = new Set(Object.values(FEEDBACK_SEVERITY));
const ONBOARDING_PROVIDERS = new Set(Object.values(ONBOARDING_PROVIDER));
const FEEDBACK_METADATA_KEYS = Object.freeze(["component", "operation", "route", "error_code", "provider", "attempt", "duration_ms", "status_code", "context"]);
const FEEDBACK_MAX_MESSAGE = 4096;
const FEEDBACK_MAX_FIELD = 512;
const FEEDBACK_MAX_METADATA_BYTES = 8192;
const FEEDBACK_ENABLED = "FEEDBACK_ENABLED";
const ONBOARDING_MAX_INTENT = 2048;
const ONBOARDING_MAX_TARGET = 512;

function serviceFeatureEnabled(env = {}) {
  const value = env[SERVICE_CATALOG_ENABLED];
  if (value === true || value === "true" || value === "1") return true;
  fail("feature_disabled", "service catalog is disabled", 404);
}

function canonicalWorkspace(value, field = "workspace") {
  const workspace = boundedText(value, field);
  if (!workspace.startsWith("workspace://") || /[?#\s]/.test(workspace)) fail("invalid_service", `${field} must be a canonical workspace URI`, 400);
  return workspace.replace(/\/+$/, "");
}

function assertWorkspaceHierarchy(workspace, parentWorkspace) {
  if (!parentWorkspace) return;
  const parent = canonicalWorkspace(parentWorkspace, "parent_workspace");
  if (workspace === parent || !workspace.startsWith(`${parent}/`)) fail("workspace_mismatch", "workspace must be nested below parent_workspace", 403);
}

function enforceCatalogWorkspace(workspace, policy) {
  if (!policy) return;
  if (workspace !== policy.workspace && !workspace.startsWith(`${policy.workspace}/`)) fail("workspace_mismatch", "scope is outside the registered workspace", 403);
}

export async function registerService({ subject, service, store, policy, env = {}, now = new Date(), randomId } = {}) {
  serviceFeatureEnabled(env);
  const actor = assertLiveSubject(subject, now);
  const body = service || {};
  const workspace = canonicalWorkspace(body.workspace, "workspace");
  const parentWorkspace = body.parent_workspace ? canonicalWorkspace(body.parent_workspace, "parent_workspace") : undefined;
  assertWorkspaceHierarchy(workspace, parentWorkspace);
  const environment = normalizeEnvironment(body.environment);
  const resource = boundedText(body.resource || policy?.resource || "service:catalog", "resource");
  enforceCatalogWorkspace(workspace, policy);
  if (policy?.resource && resource !== policy.resource) fail("resource_mismatch", "resource is outside the registered policy", 403);
  if (policy?.environment && environment !== policy.environment) fail("environment_mismatch", "scope is outside the Worker environment", 403);
  const canonicalName = boundedText(body.canonical_name, "canonical_name");
  const serviceType = boundedText(body.service_type, "service_type");
  const provider = boundedText(body.provider, "provider");
  let endpoint;
  try { endpoint = new URL(boundedText(body.endpoint, "endpoint")); } catch { fail("invalid_service", "endpoint must be a valid URL", 400); }
  if (endpoint.protocol !== "https:") fail("invalid_service", "endpoint must use HTTPS", 400);
  const capabilities = actions(body.capabilities, "capabilities");
  const expiresAt = isoTime(body.expires_at, "expires_at");
  if (Date.parse(expiresAt) <= now.getTime()) fail("invalid_service", "expires_at must be in the future", 400);
  const idempotencyKey = text(body.idempotency_key, "idempotency_key");
  const actorHash = await subjectHash(actor.sub);
  requireMethod(store, "getIdempotency");
  const prior = await store.getIdempotency(actorHash, idempotencyKey);
  if (prior) return prior;
  const serviceId = opaqueId(randomId);
  const stamp = new Date(now).toISOString();
  const record = Object.freeze({ schema: SCHEMA.ONBOARDING, service_id: serviceId, actor_subject_hash: actorHash, canonical_name: canonicalName, service_type: serviceType, provider, endpoint: endpoint.toString(), workspace, parent_workspace: parentWorkspace, environment, resource, capabilities, verification_state: SERVICE_VERIFICATION.PENDING, challenge: onboardingChallenge(ONBOARDING_PROVIDER.SERVICE_INTEGRATION, canonicalName, serviceId), last_seen: undefined, metadata: sanitizeMetadata(body.metadata), expires_at: expiresAt, created_at: stamp, updated_at: stamp, idempotency_key: idempotencyKey });
  const response = { service_id: serviceId, canonical_name: canonicalName, verification_state: SERVICE_VERIFICATION.PENDING, challenge: record.challenge, expires_at: expiresAt };
  if (typeof store.createServiceWithIdempotency === "function") await store.createServiceWithIdempotency(record, response);
  else { requireMethod(store, "createService"); await store.createService(record); requireMethod(store, "putIdempotency"); await store.putIdempotency(actorHash, idempotencyKey, response); }
  return response;
}

export async function getService({ serviceId, subject, store, policy, env = {}, now = new Date() } = {}) {
  serviceFeatureEnabled(env);
  const actor = assertLiveSubject(subject, now);
  requireMethod(store, "getService");
  const record = await store.getService(text(serviceId, "service_id"));
  if (!record) fail("not_found", "service not found", 404);
  enforceCatalogWorkspace(record.workspace, policy);
  if (policy?.resource && record.resource !== policy.resource) fail("resource_mismatch", "resource is outside the registered policy", 403);
  if (policy?.environment && record.environment !== policy.environment) fail("environment_mismatch", "scope is outside the Worker environment", 403);
  const actorHash = await subjectHash(actor.sub);
  let allowed = actorHash === record.actor_subject_hash;
  if (!allowed && actor.kind === SUBJECT_KIND.HUMAN) {
    if (policy?.approvers?.includes(actor.sub)) allowed = true;
    if (!allowed && typeof store.isApprover === "function") allowed = await store.isApprover(actor.sub, record.workspace);
  }
  if (!allowed) fail("forbidden", "service is not visible to this subject", 403);
  return record;
}

export async function listServices({ subject, workspace, store, policy, env = {}, now = new Date() } = {}) {
  serviceFeatureEnabled(env);
  const actor = assertLiveSubject(subject, now);
  const requestedWorkspace = canonicalWorkspace(workspace || policy?.workspace, "workspace");
  enforceCatalogWorkspace(requestedWorkspace, policy);
  requireMethod(store, "listServices");
  const actorHash = await subjectHash(actor.sub);
  const approver = actor.kind === SUBJECT_KIND.HUMAN && (policy?.approvers?.includes(actor.sub) || (typeof store.isApprover === "function" && await store.isApprover(actor.sub, requestedWorkspace)));
  const records = await store.listServices(requestedWorkspace);
  return records.filter((record) => approver || record.actor_subject_hash === actorHash).map((record) => ({ ...record, endpoint: record.endpoint }));
}

export class FailClosedError extends Error {
  constructor(code, message = code, status = 503) {
    super(message);
    this.name = "FailClosedError";
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message = code, status = 503) => {
  throw new FailClosedError(code, message, status);
};

function text(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) {
    fail("invalid_request", `${field} must be a non-empty short string`, 400);
  }
  return value;
}

function boundedText(value, field, maximum = FEEDBACK_MAX_FIELD) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("invalid_feedback", `${field} must be a non-empty bounded string`, 400);
  }
  return value;
}

function feedbackFeatureEnabled(env = {}) {
  const value = env[FEEDBACK_ENABLED];
  if (value === true || value === "true" || value === "1") return true;
  fail("feature_disabled", "feedback is disabled", 404);
}

function redactSecrets(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key|secret)\s*[:=]\s*["']?[^,\s"'}]+/gi, "$1=[REDACTED]");
}

function sanitizeMetadata(value, field = "metadata") {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_feedback", `${field} must be an object`, 400);
  const output = {};
  for (const key of Object.keys(value)) {
    if (!FEEDBACK_METADATA_KEYS.includes(key)) fail("invalid_feedback", `${field}.${key} is not allowed`, 400);
    const item = value[key];
    if (!["string", "number", "boolean"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) {
      fail("invalid_feedback", `${field}.${key} must be a scalar`, 400);
    }
    output[key] = typeof item === "string" ? redactSecrets(item).slice(0, FEEDBACK_MAX_FIELD) : item;
  }
  const encoded = JSON.stringify(output);
  if (new TextEncoder().encode(encoded).byteLength > FEEDBACK_MAX_METADATA_BYTES) fail("feedback_too_large", "feedback metadata is too large", 413);
  return Object.freeze(output);
}

function sanitizeContext(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_feedback", "context must be an object", 400);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    boundedText(key, "context key", 64);
    if (!["string", "number", "boolean"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) fail("invalid_feedback", "context values must be scalar", 400);
    output[key] = typeof item === "string" ? redactSecrets(item).slice(0, FEEDBACK_MAX_FIELD) : item;
  }
  const encoded = JSON.stringify(output);
  if (new TextEncoder().encode(encoded).byteLength > FEEDBACK_MAX_METADATA_BYTES) fail("feedback_too_large", "feedback context is too large", 413);
  return Object.freeze(output);
}

async function subjectHash(subject) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function providerForRemote(remote) {
  if (typeof remote !== "string" || remote.length === 0 || remote.length > ONBOARDING_MAX_TARGET) fail("invalid_onboarding", "repository_remote is required", 400);
  if (/^[^@\s]+@[^:]+:.+$/.test(remote)) {
    const host = remote.split("@")[1].split(":")[0].toLowerCase();
    if (host === "github.com") return ONBOARDING_PROVIDER.GITHUB_APP;
    fail("invalid_onboarding", "repository provider is not allowed", 400);
  }
  let parsed;
  try { parsed = new URL(remote); } catch { fail("invalid_onboarding", "repository_remote must be a valid URL", 400); }
  if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.username || parsed.password) fail("invalid_onboarding", "repository_remote must not contain credentials", 400);
  const host = parsed.hostname.toLowerCase();
  if (host === "github.com") return ONBOARDING_PROVIDER.GITHUB_APP;
  if (host === "gitlab.com" || host === "bitbucket.org") return ONBOARDING_PROVIDER.SERVICE_INTEGRATION;
  fail("invalid_onboarding", "repository provider is not allowed", 400);
}

function onboardingChallenge(provider, target, requestId) {
  if (provider === ONBOARDING_PROVIDER.CLOUDFLARE_DOMAIN) {
    const name = `_id.${target}`;
    const value = `id-challenge-${requestId}`;
    return Object.freeze({ type: "TXT", name, value, instructions: `Publish TXT ${name} with the issued challenge value.` });
  }
  return Object.freeze({ type: "CNAME", name: target, value: "pending-provider-verification", instructions: "Complete the provider installation or authorization explicitly; no permissions are granted by this request." });
}

export function normalizeDnsAnswer(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (value && typeof value === "object") return normalizeDnsAnswer(value.answer || value.answers || value.data || []);
  return [];
}

export async function verifyOnboardingDns({ request, lookup, now = new Date(), store } = {}) {
  if (!request || request.status !== ONBOARDING_STATUS.PENDING) fail("invalid_onboarding", "onboarding request is not pending", 409);
  if (Date.parse(request.expires_at) <= now.getTime()) {
    if (store?.transitionOnboarding) await store.transitionOnboarding(request.request_id, ONBOARDING_STATUS.PENDING, { status: ONBOARDING_STATUS.EXPIRED, updated_at: new Date(now).toISOString() });
    fail("onboarding_expired", "onboarding request has expired", 410);
  }
  if (typeof lookup !== "function") fail("dns_verifier_unavailable", "authoritative DNS verification is unavailable");
  const answers = normalizeDnsAnswer(await lookup(request.challenge.name, request.challenge.type));
  const verified = answers.includes(request.challenge.value);
  if (verified && store?.transitionOnboarding) await store.transitionOnboarding(request.request_id, ONBOARDING_STATUS.PENDING, { status: ONBOARDING_STATUS.VERIFIED, updated_at: new Date(now).toISOString() });
  return { request_id: request.request_id, status: verified ? ONBOARDING_STATUS.VERIFIED : ONBOARDING_STATUS.PENDING, verified };
}

export async function requestOnboarding({ subject, onboarding, store, policy, env = {}, now = new Date(), randomId } = {}) {
  const actor = assertLiveSubject(subject, now);
  const body = onboarding || {};
  const provider = body.provider || (body.repository_remote ? providerForRemote(body.repository_remote) : undefined);
  if (!ONBOARDING_PROVIDERS.has(provider)) fail("invalid_onboarding", "provider is not allowed", 400);
  const target = boundedText(body.target || body.domain || body.repository_remote, "target", ONBOARDING_MAX_TARGET);
  if (body.repository_remote) providerForRemote(body.repository_remote);
  const workspace = boundedText(body.workspace, "workspace");
  const environment = normalizeEnvironment(body.environment);
  const resource = boundedText(body.resource || policy?.resource || "service:onboarding", "resource");
  const scope = actions(body.scopes || body.actions, "scopes");
  const expiresAt = isoTime(body.expires_at, "expires_at");
  if (Date.parse(expiresAt) <= now.getTime()) fail("onboarding_expired", "onboarding expiry must be in the future", 400);
  enforcePolicy({ workspace, resource, environment }, policy);
  const idempotencyKey = text(body.idempotency_key, "idempotency_key");
  requireMethod(store, "getIdempotency");
  const actorHash = await subjectHash(actor.sub);
  const prior = await store.getIdempotency(actorHash, idempotencyKey);
  if (prior) return prior;
  const requestId = opaqueId(randomId);
  const nowIso = new Date(now).toISOString();
  const record = Object.freeze({
    schema: SCHEMA.ONBOARDING, request_id: requestId, actor_subject_hash: actorHash, actor_kind: actor.kind,
    provider, target, repository_remote: body.repository_remote ? boundedText(body.repository_remote, "repository_remote", ONBOARDING_MAX_TARGET) : undefined,
    workspace, environment, resource, scopes: scope, intent: body.intent ? redactSecrets(boundedText(body.intent, "intent", ONBOARDING_MAX_INTENT)) : undefined,
    challenge: onboardingChallenge(provider, target, requestId), status: ONBOARDING_STATUS.PENDING,
    created_at: nowIso, updated_at: nowIso, expires_at: expiresAt, idempotency_key: idempotencyKey,
  });
  const response = { request_id: requestId, status: record.status, provider, challenge: record.challenge, expires_at: record.expires_at };
  if (typeof store.createOnboardingWithIdempotency === "function") await store.createOnboardingWithIdempotency(record, response);
  else { requireMethod(store, "createOnboarding"); await store.createOnboarding(record); requireMethod(store, "putIdempotency"); await store.putIdempotency(actorHash, idempotencyKey, response); }
  return response;
}

export async function getOnboardingRequest({ requestId, subject, store, policy, now = new Date() } = {}) {
  const actor = assertLiveSubject(subject, now);
  requireMethod(store, "getOnboarding");
  const record = await store.getOnboarding(text(requestId, "request_id"));
  if (!record) fail("not_found", "onboarding request not found", 404);
  enforcePolicy(record, policy);
  const actorHash = await subjectHash(actor.sub);
  let allowed = actorHash === record.actor_subject_hash;
  if (!allowed && actor.kind === SUBJECT_KIND.HUMAN) {
    if (policy?.approvers?.includes(actor.sub)) allowed = true;
    if (!allowed && typeof store.isApprover === "function") allowed = await store.isApprover(actor.sub, record.workspace);
  }
  if (!allowed) fail("forbidden", "onboarding request is not visible to this subject", 403);
  if (record.status === ONBOARDING_STATUS.PENDING && Date.parse(record.expires_at) <= now.getTime()) {
    if (typeof store.transitionOnboarding === "function") await store.transitionOnboarding(record.request_id, ONBOARDING_STATUS.PENDING, { status: ONBOARDING_STATUS.EXPIRED, updated_at: new Date(now).toISOString() });
    record.status = ONBOARDING_STATUS.EXPIRED;
  }
  return { ...record, challenge: record.challenge, repository_remote: record.repository_remote };
}

export async function submitFeedback({ subject, feedback, store, policy, env = {}, now = new Date(), randomId } = {}) {
  feedbackFeatureEnabled(env);
  const actor = assertLiveSubject(subject, now);
  const body = feedback || {};
  const workspace = boundedText(body.workspace || policy?.workspace, "workspace");
  const environment = normalizeEnvironment(body.environment || policy?.environment);
  const resource = boundedText(body.resource || policy?.resource, "resource");
  enforcePolicy({ workspace, resource, environment }, policy);
  const metadata = sanitizeMetadata(body.metadata);
  const context = sanitizeContext(body.context);
  const actorSubjectHash = await subjectHash(actor.sub);
  const idempotencyKey = text(body.idempotency_key, "idempotency_key");
  requireMethod(store, "getIdempotency");
  const prior = await store.getIdempotency(actorSubjectHash, idempotencyKey);
  if (prior) return prior;
  const createdAt = new Date(now).toISOString();
  const record = Object.freeze({
    schema: SCHEMA.FEEDBACK, feedback_id: opaqueId(randomId), actor_subject_hash: actorSubjectHash, actor_kind: actor.kind,
    correlation_id: boundedText(body.correlation_id, "correlation_id"), prompt_id: boundedText(body.prompt_id, "prompt_id"),
    workspace, environment, resource, event: boundedText(body.event, "event"), action: boundedText(body.action, "action"), context,
    expected_outcome: redactSecrets(boundedText(body.expected_outcome, "expected_outcome", FEEDBACK_MAX_MESSAGE)),
    observed_result: redactSecrets(boundedText(body.observed_result, "observed_result", FEEDBACK_MAX_MESSAGE)),
    reproduction_steps: redactSecrets(boundedText(body.reproduction_steps, "reproduction_steps", FEEDBACK_MAX_MESSAGE)),
    severity: body.severity, message: redactSecrets(boundedText(body.message, "message", FEEDBACK_MAX_MESSAGE)), metadata,
    created_at: createdAt, updated_at: createdAt, status: FEEDBACK_STATUS.OPEN, idempotency_key: idempotencyKey,
  });
  if (!FEEDBACK_SEVERITIES.has(record.severity)) fail("invalid_feedback", "severity is not allowed", 400);
  const response = feedbackResponse(record);
  if (typeof store.createFeedbackWithIdempotency === "function") await store.createFeedbackWithIdempotency(record, response);
  else { requireMethod(store, "createFeedback"); await store.createFeedback(record); requireMethod(store, "putIdempotency"); await store.putIdempotency(actorSubjectHash, idempotencyKey, response); }
  return response;
}

export async function getFeedback({ feedbackId, subject, store, policy, now = new Date(), env = {} } = {}) {
  feedbackFeatureEnabled(env);
  const actor = assertLiveSubject(subject, now);
  requireMethod(store, "getFeedback");
  const record = await store.getFeedback(text(feedbackId, "feedback_id"));
  if (!record) fail("not_found", "feedback not found", 404);
  enforcePolicy(record, policy);
  const actorHash = await subjectHash(actor.sub);
  let allowed = actorHash === record.actor_subject_hash;
  if (!allowed && actor.kind === SUBJECT_KIND.HUMAN) {
    if (policy?.approvers?.includes(actor.sub)) allowed = true;
    if (!allowed && typeof store.isApprover === "function") allowed = await store.isApprover(actor.sub, record.workspace);
  }
  if (!allowed) fail("forbidden", "feedback is not visible to this subject", 403);
  return feedbackRecordForResponse(record);
}

const ASSISTANT_ENABLED = "ASSISTANT_ENABLED";

function assistantFeatureEnabled(env = {}) {
  const value = env[ASSISTANT_ENABLED];
  if (value === true || value === "true" || value === "1") return true;
  fail("feature_disabled", "feedback analysis is disabled", 404);
}

export async function analyzeFeedback({ feedbackId, correlationId, subject, store, policy, env = {}, now = new Date() } = {}) {
  assistantFeatureEnabled(env);
  const feedback = await getFeedback({ feedbackId, subject, store, policy, env: { ...env, [FEEDBACK_ENABLED]: true }, now });
  const correlation = boundedText(correlationId || feedback.correlation_id, "correlation_id");
  const suggestions = [];
  if (feedback.severity === FEEDBACK_SEVERITY.ERROR || feedback.severity === FEEDBACK_SEVERITY.CRITICAL) suggestions.push({ recipe: "verify_authorization_inputs", required_scopes: ["id:feedback:read"], risks: ["scope escalation", "stale approval"], missing_verification: ["active parent grant", "approver record"] });
  if (feedback.event.includes("access") || feedback.action.includes("approve")) suggestions.push({ recipe: "show_explicit_approval_state", required_scopes: ["id:access:read"], risks: ["ambiguous human approval"], missing_verification: ["correlation_id linkage"] });
  if (suggestions.length === 0) suggestions.push({ recipe: "capture_reproduction_and_context", required_scopes: ["id:feedback:read"], risks: ["incomplete diagnosis"], missing_verification: ["reproduction evidence"] });
  const result = Object.freeze({ schema: SCHEMA.FEEDBACK, feedback_id: feedback.feedback_id, correlation_id: correlation, suggestions, proposed_policy_diff: { apply: false, changes: [] }, generated_at: new Date(now).toISOString() });
  if (typeof store.createFeedbackSuggestion === "function") await store.createFeedbackSuggestion(result);
  return result;
}

export async function getFeedbackSuggestions({ feedbackId, subject, store, policy, env = {}, now = new Date() } = {}) {
  assistantFeatureEnabled(env);
  requireMethod(store, "getFeedbackSuggestions");
  const feedback = await getFeedback({ feedbackId, subject, store, policy, env: { ...env, [FEEDBACK_ENABLED]: true }, now });
  const result = await store.getFeedbackSuggestions(feedback.feedback_id);
  if (!result) fail("not_found", "feedback suggestions not found", 404);
  return result;
}

function feedbackResponse(record) {
  return { feedback_id: record.feedback_id, status: record.status, correlation_id: record.correlation_id, created_at: record.created_at };
}

function feedbackRecordForResponse(record) {
  return {
    schema: SCHEMA.FEEDBACK,
    feedback_id: record.feedback_id,
    actor_subject_hash: record.actor_subject_hash,
    actor_kind: record.actor_kind,
    correlation_id: record.correlation_id,
    prompt_id: record.prompt_id,
    workspace: record.workspace,
    environment: record.environment,
    resource: record.resource,
    event: record.event,
    action: record.action,
    context: record.context,
    expected_outcome: record.expected_outcome,
    observed_result: record.observed_result,
    reproduction_steps: record.reproduction_steps,
    severity: record.severity,
    message: record.message,
    metadata: record.metadata,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status: record.status,
  };
}

function isoTime(value, field) {
  text(value, field);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) fail("invalid_request", `${field} must be RFC3339`, 400);
  return new Date(millis).toISOString();
}

function actions(value, field = "actions") {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTIONS) {
    fail("invalid_scope", `${field} must contain at least one action`, 400);
  }
  const unique = [...new Set(value.map((action) => text(action, field)))];
  if (unique.length !== value.length) fail("invalid_scope", "actions must be unique", 400);
  return unique;
}

export function normalizeEnvironment(value) {
  // Unknown or omitted environments are handled as production policy.
  return ENVIRONMENTS.has(value) ? value : ENVIRONMENT.PRODUCTION;
}

export function runtimePolicy(env = {}) {
  const workspace = env.WORKSPACE || env.ID_WORKSPACE;
  const resource = env.RESOURCE || env.ID_RESOURCE;
  if (typeof workspace !== "string" || workspace.length === 0 || typeof resource !== "string" || resource.length === 0 || typeof env.APP_ENV !== "string" || env.APP_ENV.length === 0) {
    fail("policy_unavailable", "workspace, resource, and runtime environment policy are required");
  }
  const approvers = Array.isArray(env.APPROVERS) ? env.APPROVERS : typeof env.APPROVERS === "string" ? env.APPROVERS.split(",").map((value) => value.trim()).filter(Boolean) : [];
  return Object.freeze({ workspace, resource, environment: normalizeEnvironment(env.APP_ENV), approvers, requireParentGrant: true, requireApproverRecord: true, requireRevocation: true });
}

function enforcePolicy(scope, policy) {
  if (!policy) return;
  if (scope.workspace !== policy.workspace) fail("workspace_mismatch", "scope is outside the registered workspace", 403);
  if (policy.resource && scope.resource !== policy.resource) fail("resource_mismatch", "resource is outside the registered policy", 403);
  if (scope.environment !== policy.environment) fail("environment_mismatch", "scope is outside the Worker environment", 403);
}

function requestWorkspace(request, policy) {
  if (!policy) return request.workspace;
  if (typeof request.workspace !== "string" || request.workspace.length === 0) fail("workspace_required", "workspace is required", 400);
  return request.workspace;
}

export function parseSubjectClaim(input) {
  if (!input || typeof input !== "object") fail("invalid_subject", "subject claim is required", 401);
  const kind = input.kind;
  if (kind !== SUBJECT_KIND.AGENT && kind !== SUBJECT_KIND.HUMAN) {
    fail("invalid_subject", "subject kind must be agent or human", 401);
  }
  const claim = {
    sub: text(input.sub, "sub"),
    kind,
    issuer: text(input.issuer, "issuer"),
    audience: Array.isArray(input.audience) ? input.audience.map((item) => text(item, "audience")) : [text(input.audience, "audience")],
    scopes: actions(input.scopes, "scopes"),
    environment: normalizeEnvironment(input.environment),
    expires_at: isoTime(input.expires_at, "expires_at"),
    jti: text(input.jti, "jti"),
  };
  if (kind === SUBJECT_KIND.AGENT) claim.parent_id = text(input.parent_id, "parent_id");
  return Object.freeze(claim);
}

export function assertLiveSubject(subject, now = new Date()) {
  const claim = parseSubjectClaim(subject);
  if (Date.parse(claim.expires_at) <= now.getTime()) fail("subject_expired", "subject claim has expired", 401);
  return claim;
}

export function assertAudience(subject, expectedAudience) {
  const expected = text(expectedAudience, "audience");
  if (!subject.audience.includes(expected)) fail("wrong_audience", "subject is not bound to this audience", 401);
  return subject;
}

export function intersectScope(parent, requested, now = new Date()) {
  const parentClaim = assertLiveSubject(parent, now);
  if (!requested || typeof requested !== "object") fail("invalid_scope", "requested scope is required", 400);
  const resource = text(requested.resource, "resource");
  const environment = normalizeEnvironment(requested.environment);
  const requestedActions = actions(requested.actions);
  const parentActions = new Set(parentClaim.scopes);
  const denied = requestedActions.filter((action) => !parentActions.has(action));
  if (denied.length > 0) fail("scope_exceeds_parent", "requested action exceeds parent authority", 403);
  if (environment !== parentClaim.environment) fail("environment_exceeds_parent", "requested environment exceeds parent authority", 403);
  const requestedExpiry = isoTime(requested.expires_at, "expires_at");
  const expiresAt = new Date(Math.min(Date.parse(requestedExpiry), Date.parse(parentClaim.expires_at))).toISOString();
  if (Date.parse(expiresAt) <= now.getTime()) fail("scope_expired", "requested scope has expired", 403);
  return Object.freeze({ resource, actions: requestedActions, environment, expires_at: expiresAt });
}

function opaqueId(random = () => crypto.randomUUID()) {
  const id = typeof random === "function" ? random() : "";
  if (typeof id !== "string" || id.length < 20 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    fail("entropy_unavailable", "secure request identifier unavailable");
  }
  return id;
}

function requireStore(store) {
  if (!store || typeof store.getRequest !== "function" || typeof store.createRequest !== "function" || typeof store.transitionRequest !== "function") {
    fail("storage_unavailable", "authorization storage is unavailable");
  }
  return store;
}

function requireMethod(store, method) {
  if (typeof store[method] !== "function") fail("storage_unavailable", `storage method ${method} is unavailable`);
}

function storeForEnv(env) {
  if (env?.STORE) return env.STORE;
  if (env?.DB) return createD1Store(env.DB);
  fail("storage_unavailable", "authorization storage is unavailable");
}

function envList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* comma-separated deployment variable */ }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function envMap(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function deliveryStoreForEnv(env) {
  if (env?.DELIVERY_STORE && typeof env.DELIVERY_STORE.claim === "function") return env.DELIVERY_STORE;
  if (env?.STORE && typeof env.STORE.claimDelivery === "function") return { claim: (deliveryId) => env.STORE.claimDelivery(deliveryId) };
  if (env?.DB) {
    const store = createD1Store(env.DB);
    if (typeof store.claimDelivery === "function") return { claim: (deliveryId) => store.claimDelivery(deliveryId) };
  }
  return undefined;
}

function githubWebhookOptions(env) {
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    allowedRepositories: envList(env.GITHUB_ALLOWED_REPOSITORIES),
    allowedWorkspaces: envList(env.GITHUB_ALLOWED_WORKSPACES),
    workspaceByRepository: envMap(env.GITHUB_WORKSPACE_MAP),
    deliveryStore: deliveryStoreForEnv(env),
  };
}

export async function requestAccess({ subject, request, store, policy, now = new Date(), randomId } = {}) {
  requireStore(store);
  const agent = assertLiveSubject(subject, now);
  if (agent.kind !== SUBJECT_KIND.AGENT) fail("agent_required", "only an agent may request access", 403);
  const body = request || {};
  if (body.actor_id !== agent.sub) fail("subject_mismatch", "actor_id must match the authenticated agent", 403);
  const scope = intersectScope({ ...agent, scopes: agent.scopes }, body, now);
  const workspace = requestWorkspace(body, policy);
  enforcePolicy({ ...scope, workspace }, policy);
  let boundedScope = scope;
  if (policy?.requireParentGrant) {
    requireMethod(store, "getActiveGrant");
    const parentGrant = await store.getActiveGrant(agent.parent_id, scope.resource, scope.environment, now);
    if (!parentGrant || parentGrant.workspace !== workspace) fail("parent_grant_unavailable", "active parent grant is required", 403);
    boundedScope = intersectScope({ ...agent, scopes: parentGrant.actions, environment: parentGrant.environment, expires_at: parentGrant.expires_at }, body, now);
  }
  const requestId = opaqueId(randomId);
  const idempotencyKey = text(body.idempotency_key, "idempotency_key");
  const record = Object.freeze({
    schema: SCHEMA.ACCESS_REQUEST,
    request_id: requestId,
    actor_id: agent.sub,
    parent_id: agent.parent_id,
    workspace,
    resource: boundedScope.resource,
    actions: boundedScope.actions,
    environment: boundedScope.environment,
    reason: text(body.reason, "reason"),
    requested_at: new Date(now).toISOString(),
    expires_at: boundedScope.expires_at,
    status: STATUS.PENDING,
    ask_path: `/ask/${requestId}`,
    idempotency_key: idempotencyKey,
    parent_claim: agent,
  });
  requireMethod(store, "getIdempotency");
  const prior = await store.getIdempotency(agent.sub, idempotencyKey);
  if (prior) return prior;
  const response = { request_id: requestId, status: STATUS.PENDING, ask_path: record.ask_path, expires_at: record.expires_at };
  if (typeof store.createRequestWithIdempotency === "function") {
    await store.createRequestWithIdempotency(record, response);
  } else {
    await store.createRequest(record);
    requireMethod(store, "putIdempotency");
    await store.putIdempotency(agent.sub, idempotencyKey, response);
  }
  return response;
}

export async function readAccessRequest({ requestId, subject, store, policy, now = new Date() } = {}) {
  const human = assertLiveSubject(subject, now);
  if (human.kind !== SUBJECT_KIND.HUMAN) fail("human_required", "an authenticated human is required", 403);
  const id = text(requestId, "request_id");
  const request = await requireStore(store).getRequest(id);
  if (!request) fail("not_found", "access request not found", 404);
  enforcePolicy(request, policy);
  if (request.status === STATUS.PENDING && Date.parse(request.expires_at) <= now.getTime()) {
    await store.transitionRequest(id, STATUS.PENDING, { status: STATUS.EXPIRED });
    fail("scope_expired", "access request has expired", 410);
  }
  return { request_id: request.request_id, actor_id: request.actor_id, parent_id: request.parent_id, workspace: request.workspace, resource: request.resource, actions: request.actions, environment: request.environment, reason: request.reason, expires_at: request.expires_at, status: request.status };
}

export async function approveAccessRequest({ requestId, subject, decision, store, policy, now = new Date(), grantId } = {}) {
  const human = assertLiveSubject(subject, now);
  if (human.kind !== SUBJECT_KIND.HUMAN) fail("human_required", "only an authenticated human may approve", 403);
  if (decision !== DECISION.APPROVE && decision !== DECISION.DECLINE) fail("invalid_decision", "decision must be approve or decline", 400);
  const request = await requireStore(store).getRequest(text(requestId, "request_id"));
  if (!request) fail("not_found", "access request not found", 404);
  enforcePolicy(request, policy);
  if (policy?.approvers?.length && !policy.approvers.includes(human.sub)) fail("approver_not_allowed", "human is not an approver for this workspace", 403);
  if (policy?.requireApproverRecord) {
    requireMethod(store, "isApprover");
    if (!(await store.isApprover(human.sub, request.workspace))) fail("approver_not_allowed", "human is not an active approver", 403);
  }
  if (policy?.requireParentGrant) {
    requireMethod(store, "getActiveGrant");
    const parentGrant = await store.getActiveGrant(request.parent_id, request.resource, request.environment, now);
    if (!parentGrant || parentGrant.workspace !== request.workspace || request.actions.some((action) => !parentGrant.actions.includes(action))) fail("parent_grant_unavailable", "active parent grant is required", 403);
  }
  if (request.status !== STATUS.PENDING) fail("replayed_request", "access request has already been consumed", 409);
  if (Date.parse(request.expires_at) <= now.getTime()) {
    await store.transitionRequest(request.request_id, STATUS.PENDING, { status: STATUS.EXPIRED });
    fail("scope_expired", "access request has expired", 410);
  }
  if (decision === DECISION.DECLINE) return { request_id: request.request_id, status: STATUS.DECLINED };
  const id = grantId ? opaqueId(() => grantId) : opaqueId();
  const grant = Object.freeze({ schema: SCHEMA.GRANT, grant_id: id, subject_id: request.actor_id, parent_id: request.parent_id, workspace: request.workspace, resource: request.resource, actions: request.actions, environment: request.environment, expires_at: request.expires_at, issued_at: new Date(now).toISOString(), issued_by: human.sub, request_id: request.request_id });
  if (typeof store.approveRequestWithGrant === "function") {
    const consumed = await store.approveRequestWithGrant(request, grant);
    if (!consumed) fail("replayed_request", "access request has already been consumed", 409);
    return grant;
  }
  requireMethod(store, "createGrant");
  const update = { status: STATUS.APPROVED, decided_at: new Date(now).toISOString(), decided_by: human.sub };
  const consumed = await store.transitionRequest(request.request_id, STATUS.PENDING, update);
  if (!consumed) fail("replayed_request", "access request has already been consumed", 409);
  await store.createGrant(grant);
  return grant;
}

export async function getGrant({ grantId, subject, store, policy, now = new Date() } = {}) {
  const agent = assertLiveSubject(subject, now);
  if (agent.kind !== SUBJECT_KIND.AGENT) fail("agent_required", "only an agent may retrieve its grant", 403);
  requireMethod(store, "getGrant");
  const grant = await store.getGrant(text(grantId, "grant_id"));
  if (!grant || grant.subject_id !== agent.sub) fail("not_found", "grant not found", 404);
  enforcePolicy(grant, policy);
  if (policy?.requireRevocation) {
    requireMethod(store, "isRevoked");
    if (await store.isRevoked(grant.grant_id)) fail("grant_revoked", "grant has been revoked", 403);
  }
  if (Date.parse(grant.expires_at) <= now.getTime()) fail("scope_expired", "grant has expired", 403);
  return grant;
}

function validateBackupEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") fail("invalid_backup", "encrypted backup envelope is required", 400);
  if (Object.hasOwn(envelope, "plaintext") || Object.hasOwn(envelope, "private_key") || Object.hasOwn(envelope, "secret")) {
    fail("invalid_backup", "plaintext secrets are never accepted", 400);
  }
  const algorithm = text(envelope.algorithm, "algorithm");
  const ciphertext = text(envelope.ciphertext, "ciphertext");
  const nonce = text(envelope.nonce, "nonce");
  if (!/^[A-Za-z0-9_-]+$/.test(ciphertext) || !/^[A-Za-z0-9_-]+$/.test(nonce)) fail("invalid_backup", "backup fields must be opaque base64url values", 400);
  return Object.freeze({ schema: SCHEMA.BACKUP, version: 1, algorithm, ciphertext, nonce, key_id: envelope.key_id ? text(envelope.key_id, "key_id") : undefined });
}

export async function backupIdentity({ subject, envelope, store, now = new Date() } = {}) {
  const agent = assertLiveSubject(subject, now);
  if (agent.kind !== SUBJECT_KIND.AGENT) fail("agent_required", "only an agent may store an identity backup", 403);
  const backup = validateBackupEnvelope(envelope);
  requireMethod(store, "putBackup");
  const backupId = opaqueId();
  await store.putBackup({ backup_id: backupId, subject_id: agent.sub, created_at: new Date(now).toISOString(), envelope: backup });
  return { backup_id: backupId, schema: SCHEMA.BACKUP, stored: true };
}

export async function restoreIdentity({ subject, backupId, proof, authorizer, store, verifyProof, now = new Date() } = {}) {
  const agent = assertLiveSubject(subject, now);
  if (agent.kind !== SUBJECT_KIND.AGENT) fail("agent_required", "agent proof is required for restore", 403);
  if (!authorizer) fail("authorization_required", "parent or human authorization is required", 403);
  const approving = assertLiveSubject(authorizer, now);
  const parentOrHuman = approving.kind === SUBJECT_KIND.HUMAN || approving.sub === agent.parent_id;
  if (!parentOrHuman) fail("authorization_required", "parent or human authorization is required", 403);
  if (!proof || typeof proof !== "object" || !text(proof.challenge, "challenge") || !text(proof.signature, "signature")) fail("proof_required", "proof of possession is required", 401);
  if (typeof verifyProof !== "function") fail("proof_verifier_unavailable", "proof verifier is unavailable");
  const valid = await verifyProof({ subject: agent, proof });
  if (valid !== true) fail("invalid_proof", "proof of possession was rejected", 401);
  requireMethod(store, "getBackup");
  const backup = await store.getBackup(text(backupId, "backup_id"));
  if (!backup || backup.subject_id !== agent.sub) fail("not_found", "backup not found", 404);
  return { backup_id: backup.backup_id, subject_id: backup.subject_id, envelope: backup.envelope, restored: true };
}

export function failClosedResponse(error) {
  const status = error instanceof FailClosedError ? error.status : 503;
  const code = error instanceof FailClosedError ? error.code : "service_unavailable";
  return json({ error: code }, status);
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function parseBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) fail("unsupported_media_type", "application/json is required", 415);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) fail("request_too_large", "request body is too large", 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) fail("request_too_large", "request body is too large", 413);
  try { return JSON.parse(body); } catch { fail("invalid_json", "request body must be JSON", 400); }
}

function verifiedClaim(result, env, expectedKind) {
  // The adapter is the identity-provider seam. In production it must verify
  // the token (for example with jose + the issuer JWKS) before returning this
  // marker; the Worker never decodes or trusts bearer claims itself.
  if (!result || result.verified !== true || !result.claim) fail("authentication_unavailable", "verified identity authentication is required");
  const claim = assertLiveSubject(result.claim, new Date());
  const configuredAudience = env.ACCESS_AUDIENCE || AUDIENCE;
  if (Array.isArray(configuredAudience)) {
    if (!configuredAudience.some((value) => claim.audience.includes(value))) fail("wrong_audience", "subject is not bound to this audience", 401);
  } else {
    assertAudience(claim, configuredAudience);
  }
  if (env.PUBLIC_ISSUER && claim.issuer !== env.PUBLIC_ISSUER) fail("issuer_mismatch", "subject issuer is not configured for this Worker", 401);
  if (expectedKind && claim.kind !== expectedKind) fail("wrong_subject_kind", `${expectedKind} subject required`, 403);
  return claim;
}

async function authenticate(request, env, expectedKind) {
  const authenticator = typeof env?.AUTHENTICATE === "function" ? env.AUTHENTICATE : (incoming) => verifyAccessJwt(incoming, env);
  return verifiedClaim(await authenticator(request), env, expectedKind);
}

async function authenticateAny(request, env) {
  const authenticator = typeof env?.AUTHENTICATE === "function" ? env.AUTHENTICATE : (incoming) => verifyAccessJwt(incoming, env);
  return verifiedClaim(await authenticator(request), env);
}

function pathParts(url) { return new URL(url).pathname.split("/").filter(Boolean); }

export async function handleRequest(request, env = {}) {
  try {
    const url = new URL(request.url);
    const parts = pathParts(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/readyz") {
      const store = storeForEnv(env);
      if (typeof store.checkReadiness !== "function" || !(await store.checkReadiness())) fail("not_ready", "authorization storage is not ready");
      return json({ status: "ready" });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/github/webhook") {
      return handleGitHubWebhook(request, githubWebhookOptions(env));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/feedback") {
      const subject = await authenticateAny(request, env);
      const body = await parseBody(request);
      if (!body.idempotency_key) body.idempotency_key = request.headers.get("idempotency-key") || undefined;
      return json(await submitFeedback({ subject, feedback: body, policy: runtimePolicy(env), store: storeForEnv(env), env: { ...env, [FEEDBACK_ENABLED]: env[FEEDBACK_ENABLED] === true || env[FEEDBACK_ENABLED] === "true" } }), 201);
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "feedback" && parts.length === 4) {
      const subject = await authenticateAny(request, env);
      return json(await getFeedback({ feedbackId: parts[3], subject, policy: runtimePolicy(env), store: storeForEnv(env), env }));
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "feedback" && parts[4] === "analyze" && parts.length === 5) {
      const subject = await authenticateAny(request, env);
      const body = await parseBody(request);
      return json(await analyzeFeedback({ feedbackId: parts[3], correlationId: body.correlation_id, subject, policy: runtimePolicy(env), store: storeForEnv(env), env }));
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "feedback" && parts[4] === "suggestions" && parts.length === 5) {
      const subject = await authenticateAny(request, env);
      return json(await getFeedbackSuggestions({ feedbackId: parts[3], subject, policy: runtimePolicy(env), store: storeForEnv(env), env }));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/onboarding/requests") {
      const subject = await authenticateAny(request, env);
      const body = await parseBody(request);
      if (!body.idempotency_key) body.idempotency_key = request.headers.get("idempotency-key") || undefined;
      return json(await requestOnboarding({ subject, onboarding: body, policy: runtimePolicy(env), store: storeForEnv(env), env } ), 201);
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "onboarding" && parts[3] === "requests" && parts.length === 5) {
      const subject = await authenticateAny(request, env);
      return json(await getOnboardingRequest({ requestId: parts[4], subject, policy: runtimePolicy(env), store: storeForEnv(env) }));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/services/register") {
      const subject = await authenticateAny(request, env);
      const body = await parseBody(request);
      if (!body.idempotency_key) body.idempotency_key = request.headers.get("idempotency-key") || undefined;
      return json(await registerService({ subject, service: body, policy: runtimePolicy(env), store: storeForEnv(env), env }), 201);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/services") {
      const subject = await authenticateAny(request, env);
      const workspace = url.searchParams.get("workspace") || undefined;
      return json({ services: await listServices({ subject, workspace, policy: runtimePolicy(env), store: storeForEnv(env), env }) });
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "v1" && parts[2] === "services" && parts.length === 4) {
      const subject = await authenticateAny(request, env);
      return json(await getService({ serviceId: parts[3], subject, policy: runtimePolicy(env), store: storeForEnv(env), env }));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/access-requests") {
      const subject = await authenticate(request, env, SUBJECT_KIND.AGENT);
      const body = await parseBody(request);
      if (!body.idempotency_key) body.idempotency_key = request.headers.get("idempotency-key") || undefined;
      return json(await requestAccess({ subject, request: body, policy: runtimePolicy(env), store: storeForEnv(env) }));
    }
    if (parts[0] === "ask" && parts.length === 2 && (request.method === "GET" || request.method === "POST")) {
      const subject = await authenticate(request, env, SUBJECT_KIND.HUMAN);
      const requestId = parts[1];
      const policy = runtimePolicy(env);
      const store = storeForEnv(env);
      if (request.method === "GET") return json({ approval_required: true, request: await readAccessRequest({ requestId, subject, policy, store }) });
      const body = await parseBody(request);
      return json(await approveAccessRequest({ requestId, subject, decision: body.decision, policy, store }));
    }
    if (request.method === "POST" && url.pathname === "/mcp") return handleMcp(request, env);
    if (request.method === "GET" && env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(request);
    fail("not_found", "route not found", 404);
  } catch (error) { return failClosedResponse(error); }
}

export async function handleMcp(request, env = {}) {
  let messageId = null;
  try {
    const body = await parseBody(request);
    messageId = body?.id ?? null;
    const subject = await authenticate(request, env, SUBJECT_KIND.AGENT);
    let authorizer;
    if (body.method === MCP_METHOD.RESTORE_IDENTITY) {
      if (typeof env.AUTHORIZE_RECOVERY !== "function") fail("authorization_unavailable", "recovery authorization is unavailable");
      authorizer = verifiedClaim(await env.AUTHORIZE_RECOVERY(request, subject), env, SUBJECT_KIND.HUMAN);
    }
    const result = await dispatchMcp(body, { subject, authorizer, policy: runtimePolicy(env), store: storeForEnv(env), env });
    return json({ jsonrpc: "2.0", id: body.id ?? null, result });
  } catch (error) { return json({ jsonrpc: "2.0", id: messageId, error: { code: error instanceof FailClosedError ? error.code : "service_unavailable" } }, error instanceof FailClosedError ? error.status : 503); }
}

export async function dispatchMcp(message, { subject, authorizer, policy, store, env = {} } = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") fail("invalid_mcp_request", "invalid MCP request", 400);
  if (message.method === MCP_PROTOCOL.INITIALIZE) return { protocolVersion: MCP_PROTOCOL.VERSION, capabilities: { tools: {} }, serverInfo: { name: "id-worker", version: "1.0.0" } };
  if (message.method === MCP_PROTOCOL.TOOLS_LIST) return { tools: MCP_TOOLS };
  if (message.method === MCP_PROTOCOL.INITIALIZED) return null;
  const params = message.params || {};
  if (message.method === MCP_PROTOCOL.TOOLS_CALL) {
    if (!params || typeof params.name !== "string") fail("invalid_mcp_request", "tool name is required", 400);
    const toolArguments = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    let toolResult;
    switch (params.name) {
      case MCP_TOOL.REGISTER_AGENT: toolResult = await registerAgent({ subject, publicKey: toolArguments.public_key, policy, store }); break;
      case MCP_TOOL.REQUEST_ACCESS: toolResult = await requestAccess({ subject, request: toolArguments, policy, store }); break;
      case MCP_TOOL.GET_GRANT: toolResult = await getGrant({ subject, grantId: toolArguments.grant_id, policy, store }); break;
      case MCP_TOOL.BACKUP_IDENTITY: toolResult = await backupIdentity({ subject, envelope: toolArguments.envelope, store }); break;
      case MCP_TOOL.RESTORE_IDENTITY: toolResult = await restoreIdentity({ subject, backupId: toolArguments.backup_id, proof: toolArguments.proof, authorizer, store, verifyProof: env.verifyProof }); break;
      case MCP_TOOL.SUBMIT_FEEDBACK: toolResult = await submitFeedback({ subject, feedback: toolArguments, policy, store, env }); break;
      case MCP_TOOL.REQUEST_ONBOARDING: toolResult = await requestOnboarding({ subject, onboarding: toolArguments, policy, store, env }); break;
      case MCP_TOOL.GET_ONBOARDING_REQUEST: toolResult = await getOnboardingRequest({ subject, requestId: toolArguments.request_id, policy, store }); break;
      case MCP_TOOL.REGISTER_SERVICE: toolResult = await registerService({ subject, service: toolArguments, policy, store, env }); break;
      case MCP_TOOL.LIST_SERVICES: toolResult = { services: await listServices({ subject, workspace: toolArguments.workspace, policy, store, env }) }; break;
      case MCP_TOOL.ANALYZE_FEEDBACK: toolResult = await analyzeFeedback({ subject, feedbackId: toolArguments.feedback_id, correlationId: toolArguments.correlation_id, policy, store, env }); break;
      case MCP_TOOL.GET_FEEDBACK_SUGGESTIONS: toolResult = await getFeedbackSuggestions({ subject, feedbackId: toolArguments.feedback_id, policy, store, env }); break;
      default: fail("method_not_found", "MCP tool not found", 404);
    }
    return { content: [{ type: "text", text: JSON.stringify(toolResult) }], structuredContent: toolResult, ...toolResult };
  }
  switch (message.method) {
    case MCP_METHOD.REGISTER_AGENT: return registerAgent({ subject, publicKey: params.public_key, policy, store });
    case MCP_METHOD.REQUEST_ACCESS: return requestAccess({ subject, request: params, policy, store });
    case MCP_METHOD.GET_GRANT: return getGrant({ subject, grantId: params.grant_id, policy, store });
    case MCP_METHOD.BACKUP_IDENTITY: return backupIdentity({ subject, envelope: params.envelope, store });
    case MCP_METHOD.RESTORE_IDENTITY: return restoreIdentity({ subject, backupId: params.backup_id, proof: params.proof, authorizer, store, verifyProof: env.verifyProof });
    case MCP_METHOD.SUBMIT_FEEDBACK: return submitFeedback({ subject, feedback: params, policy, store, env });
    case MCP_METHOD.REQUEST_ONBOARDING: return requestOnboarding({ subject, onboarding: params, policy, store, env });
    case MCP_METHOD.GET_ONBOARDING_REQUEST: return getOnboardingRequest({ subject, requestId: params.request_id, policy, store });
    case MCP_METHOD.REGISTER_SERVICE: return registerService({ subject, service: params, policy, store, env });
    case MCP_METHOD.LIST_SERVICES: return listServices({ subject, workspace: params.workspace, policy, store, env });
    case MCP_METHOD.ANALYZE_FEEDBACK: return analyzeFeedback({ subject, feedbackId: params.feedback_id, correlationId: params.correlation_id, policy, store, env });
    case MCP_METHOD.GET_FEEDBACK_SUGGESTIONS: return getFeedbackSuggestions({ subject, feedbackId: params.feedback_id, policy, store, env });
    default: fail("method_not_found", "MCP method not found", 404);
  }
}

export async function registerAgent({ subject, publicKey, store, policy, now = new Date() } = {}) {
  const agent = assertLiveSubject(subject, now);
  if (agent.kind !== SUBJECT_KIND.AGENT) fail("agent_required", "only an agent may register", 403);
  const key = text(publicKey, "public_key");
  requireMethod(store, "registerAgent");
  await store.registerAgent({ subject_id: agent.sub, parent_id: agent.parent_id, workspace: policy?.workspace, environment: policy?.environment || agent.environment, public_key: key, registered_at: new Date(now).toISOString() });
  return { subject_id: agent.sub, registered: true };
}

export const worker = { fetch: handleRequest };
export default worker;
