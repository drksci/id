import test from "node:test";
import assert from "node:assert/strict";
import {
  handleGitHubWebhook,
  parseCanonicalWorkspaceHost,
} from "../src/github-webhook.js";

const SECRET = "unit-test-webhook-secret";

async function sign(body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(bytes).toString("hex")}`;
}

function store() {
  const deliveries = new Set();
  return {
    async claim(deliveryId) {
      if (deliveries.has(deliveryId)) return false;
      deliveries.add(deliveryId);
      return true;
    },
  };
}

function options(deliveryStore = store()) {
  return {
    secret: SECRET,
    allowedRepositories: ["drksci/id"],
    allowedWorkspaces: ["alphaville.plane"],
    workspaceByRepository: { "drksci/id": "alphaville.plane" },
    deliveryStore,
  };
}

async function request({ body, delivery = "delivery-1", host = "alphaville.plane.id.drksci.com", signature } = {}) {
  const raw = JSON.stringify(body || { repository: { full_name: "drksci/id" } });
  return new Request(`https://${host}/api/v1/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": delivery,
      "x-github-event": "repository",
      "x-hub-signature-256": signature || await sign(raw),
    },
    body: raw,
  });
}

test("accepts a signed allowed delivery and binds the nested workspace", async () => {
  const response = await handleGitHubWebhook(
    await request({ body: { repository: { full_name: "drksci/id" } } }),
    options(),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, delivery_id: "delivery-1", workspace: "alphaville.plane" });
});

test("rejects an invalid signature before claiming the delivery", async () => {
  const deliveryStore = store();
  const response = await handleGitHubWebhook(
    await request({ signature: "sha256=" + "0".repeat(64) }),
    options(deliveryStore),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
  assert.equal(await deliveryStore.claim("delivery-1"), true);
});

test("rejects a replayed delivery without invoking a second claim", async () => {
  const deliveryStore = store();
  const first = await handleGitHubWebhook(await request(), options(deliveryStore));
  const second = await handleGitHubWebhook(await request(), options(deliveryStore));
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "replayed_delivery" });
});

test("rejects repositories outside the allowlist", async () => {
  const response = await handleGitHubWebhook(
    await request({ body: { repository: { full_name: "someone/other" } } }),
    options(),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "repository_not_allowed" });
});

test("rejects a repository whose trusted workspace does not match the host selector", async () => {
  const configured = options();
  configured.workspaceByRepository["drksci/id"] = "plane";
  const response = await handleGitHubWebhook(await request(), configured);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace_mismatch" });
});

test("parses nested canonical hosts from right to left and rejects invalid labels", () => {
  assert.deepEqual(parseCanonicalWorkspaceHost("alphaville.plane.id.drksci.com"), {
    canonical: "alphaville.plane",
    labels: ["alphaville", "plane"],
    parent_chain: ["plane", "alphaville"],
  });
  assert.throws(() => parseCanonicalWorkspaceHost("api.id.drksci.com"), (error) => error.code === "reserved_workspace_label");
  assert.throws(() => parseCanonicalWorkspaceHost("bad_.plane.id.drksci.com"), (error) => error.code === "invalid_workspace_host");
});

test("fails closed when a dedupe store is not configured", async () => {
  const response = await handleGitHubWebhook(await request(), { ...options(), deliveryStore: undefined });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "dedupe_unavailable" });
});
