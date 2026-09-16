import { createD1Store } from "./storage.js";
import { verifyAccessJwt } from "./auth.js";

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
});
export const MCP_TOOLS = Object.freeze([
  Object.freeze({ name: MCP_TOOL.REGISTER_AGENT, description: "Register an agent public key.", inputSchema: { type: "object", required: ["public_key"], properties: { public_key: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.REQUEST_ACCESS, description: "Request bounded delegated access.", inputSchema: { type: "object", required: ["actor_id", "resource", "actions", "expires_at", "reason", "idempotency_key"], properties: { actor_id: { type: "string" }, workspace: { type: "string" }, resource: { type: "string" }, actions: { type: "array", items: { type: "string" } }, environment: { type: "string" }, expires_at: { type: "string" }, reason: { type: "string" }, idempotency_key: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.GET_GRANT, description: "Retrieve the authenticated agent grant.", inputSchema: { type: "object", required: ["grant_id"], properties: { grant_id: { type: "string" } } } }),
  Object.freeze({ name: MCP_TOOL.BACKUP_IDENTITY, description: "Store a client-encrypted identity envelope.", inputSchema: { type: "object", required: ["envelope"], properties: { envelope: { type: "object" } } } }),
  Object.freeze({ name: MCP_TOOL.RESTORE_IDENTITY, description: "Restore an encrypted identity envelope with proof and authorization.", inputSchema: { type: "object", required: ["backup_id", "proof"], properties: { backup_id: { type: "string" }, proof: { type: "object" } } } }),
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
  if (claim.kind !== expectedKind) fail("wrong_subject_kind", `${expectedKind} subject required`, 403);
  return claim;
}

async function authenticate(request, env, expectedKind) {
  const authenticator = typeof env?.AUTHENTICATE === "function" ? env.AUTHENTICATE : (incoming) => verifyAccessJwt(incoming, env);
  return verifiedClaim(await authenticator(request), env, expectedKind);
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
