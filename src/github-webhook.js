/**
 * Signed GitHub App webhook boundary.
 *
 * This module is intentionally independent from the Worker router. A later wiring change can
 * call handleGitHubWebhook from the route without changing signature, replay, or workspace policy.
 */

export const GITHUB_WEBHOOK = Object.freeze({
  METHOD: "POST",
  SIGNATURE_HEADER: "x-hub-signature-256",
  DELIVERY_HEADER: "x-github-delivery",
  EVENT_HEADER: "x-github-event",
  SIGNATURE_PREFIX: "sha256=",
  MAX_BODY_BYTES: 256 * 1024,
  WORKSPACE_SUFFIX: "id.drksci.com",
});

export const SUPPORTED_EVENTS = Object.freeze([
  "installation",
  "installation_repositories",
  "repository",
  "workflow_run",
]);

const SUPPORTED_EVENT_SET = new Set(SUPPORTED_EVENTS);
const WORKSPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,256}$/;
const HEX_SIGNATURE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_RESERVED_LABELS = new Set([
  "api", "console", "docs", "idea", "dev", "test", "preview", "www", "mcp", "oauth", "status",
]);

export class GitHubWebhookError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.name = "GitHubWebhookError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message = code, status = 400) {
  throw new GitHubWebhookError(code, message, status);
}

function asSet(value, name) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  if (values.length === 0 || values.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${name}_allowlist_unavailable`, `${name} allowlist is required`, 503);
  }
  return new Set(values);
}

function workspaceValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    fail("workspace_invalid", "workspace binding is invalid", 503);
  }
  const labels = value.toLowerCase().split(".");
  if (labels.some((label) => !WORKSPACE_SLUG.test(label) || DEFAULT_RESERVED_LABELS.has(label))) {
    fail("workspace_invalid", "workspace binding is invalid", 503);
  }
  return labels.join(".");
}

function mappedWorkspace(mapping, repository) {
  const value = mapping instanceof Map ? mapping.get(repository) : mapping?.[repository];
  if (value === undefined) fail("workspace_not_bound", "repository has no trusted workspace binding", 403);
  return workspaceValue(value);
}

function bytesFromHex(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function equalBytes(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

async function validSignature(secret, body, header) {
  if (typeof secret !== "string" || secret.length === 0) fail("webhook_secret_unavailable", "webhook secret is unavailable", 503);
  if (typeof header !== "string" || !header.startsWith(GITHUB_WEBHOOK.SIGNATURE_PREFIX)) fail("invalid_signature", "webhook signature is invalid", 401);
  const encoded = header.slice(GITHUB_WEBHOOK.SIGNATURE_PREFIX.length);
  if (!HEX_SIGNATURE.test(encoded)) fail("invalid_signature", "webhook signature is invalid", 401);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return equalBytes(expected, bytesFromHex(encoded));
}

function repositoriesFromPayload(payload) {
  const repositories = [];
  if (payload?.repository?.full_name) repositories.push(payload.repository.full_name);
  if (Array.isArray(payload?.repositories)) {
    for (const repository of payload.repositories) if (repository?.full_name) repositories.push(repository.full_name);
  }
  return [...new Set(repositories)];
}

/** Parse a canonical nested workspace hostname; labels are returned in host and parent order. */
export function parseCanonicalWorkspaceHost(hostname, { suffix = GITHUB_WEBHOOK.WORKSPACE_SUFFIX, reservedLabels = DEFAULT_RESERVED_LABELS } = {}) {
  if (typeof hostname !== "string") fail("invalid_workspace_host", "workspace host is invalid", 400);
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const canonicalSuffix = suffix.toLowerCase().replace(/\.$/, "");
  if (host === canonicalSuffix) return { canonical: null, labels: [], parent_chain: [] };
  const suffixMarker = `.${canonicalSuffix}`;
  if (!host.endsWith(suffixMarker)) fail("invalid_workspace_host", "workspace host is invalid", 400);
  const prefix = host.slice(0, -suffixMarker.length);
  const labels = prefix.split(".");
  if (labels.length === 0 || labels.some((label) => !WORKSPACE_SLUG.test(label))) fail("invalid_workspace_host", "workspace host is invalid", 400);
  if (labels.some((label) => reservedLabels.has(label))) fail("reserved_workspace_label", "workspace host uses a reserved label", 403);
  return { canonical: labels.join("."), labels, parent_chain: [...labels].reverse() };
}

function json(value, status) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function errorResponse(error) {
  if (error instanceof GitHubWebhookError) return json({ error: error.code }, error.status);
  return json({ error: "webhook_unavailable" }, 503);
}

/** Verify and claim a webhook delivery for a later event handler. */
export async function verifyGitHubWebhook(request, options = {}) {
  if (!request || request.method !== GITHUB_WEBHOOK.METHOD) fail("method_not_allowed", "webhook method is not allowed", 405);
  const deliveryId = request.headers.get(GITHUB_WEBHOOK.DELIVERY_HEADER);
  const event = request.headers.get(GITHUB_WEBHOOK.EVENT_HEADER);
  if (!deliveryId || !DELIVERY_ID.test(deliveryId)) fail("invalid_delivery", "webhook delivery is invalid", 400);
  if (!event || !SUPPORTED_EVENT_SET.has(event)) fail("unsupported_event", "webhook event is not supported", 400);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > GITHUB_WEBHOOK.MAX_BODY_BYTES) fail("request_too_large", "webhook body is too large", 413);
  if (!(await validSignature(options.secret, body, request.headers.get(GITHUB_WEBHOOK.SIGNATURE_HEADER)))) fail("invalid_signature", "webhook signature is invalid", 401);
  let payload;
  try { payload = JSON.parse(body); } catch { fail("invalid_json", "webhook body is invalid", 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("invalid_payload", "webhook payload is invalid", 400);

  const allowedRepositories = asSet(options.allowedRepositories, "repository");
  const repositories = repositoriesFromPayload(payload);
  if (repositories.length === 0) fail("repository_missing", "webhook repository is required", 403);
  if (repositories.some((repository) => !allowedRepositories.has(repository))) fail("repository_not_allowed", "webhook repository is not allowed", 403);
  const workspaces = repositories.map((repository) => mappedWorkspace(options.workspaceByRepository, repository));
  if (new Set(workspaces).size !== 1) fail("workspace_mismatch", "webhook repositories do not share a workspace", 403);
  const workspace = workspaces[0];
  const hostWorkspace = parseCanonicalWorkspaceHost(new URL(request.url).hostname).canonical;
  if (hostWorkspace !== null && hostWorkspace !== workspace) fail("workspace_mismatch", "webhook host does not match repository workspace", 403);
  const allowedWorkspaces = asSet(options.allowedWorkspaces, "workspace");
  if (!allowedWorkspaces.has(workspace)) fail("workspace_not_allowed", "webhook workspace is not allowed", 403);

  if (!options.deliveryStore || typeof options.deliveryStore.claim !== "function") fail("dedupe_unavailable", "webhook delivery store is unavailable", 503);
  if (!(await options.deliveryStore.claim(deliveryId))) fail("replayed_delivery", "webhook delivery was already processed", 409);
  return Object.freeze({ delivery_id: deliveryId, event, repositories, workspace, payload });
}

/** Standalone handler for later route wiring; it acknowledges only verified, claimed deliveries. */
export async function handleGitHubWebhook(request, options = {}) {
  try {
    const delivery = await verifyGitHubWebhook(request, options);
    if (typeof options.onAccepted === "function") await options.onAccepted(delivery);
    return json({ accepted: true, delivery_id: delivery.delivery_id, workspace: delivery.workspace }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
