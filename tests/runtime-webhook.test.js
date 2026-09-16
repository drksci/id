import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/runtime.js";

const SECRET = "runtime-webhook-secret";

async function signature(body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(bytes).toString("hex")}`;
}

function deliveryStore() {
  const seen = new Set();
  return { async claim(id) { if (seen.has(id)) return false; seen.add(id); return true; } };
}

async function webhookRequest(delivery = "runtime-delivery-1") {
  const body = JSON.stringify({ repository: { full_name: "drksci/id" } });
  return new Request("https://alphaville.plane.id.drksci.com/api/v1/github/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-delivery": delivery, "x-github-event": "repository", "x-hub-signature-256": await signature(body) },
    body,
  });
}

function env(store = deliveryStore()) {
  return {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_ALLOWED_REPOSITORIES: "drksci/id",
    GITHUB_ALLOWED_WORKSPACES: "alphaville.plane",
    GITHUB_WORKSPACE_MAP: JSON.stringify({ "drksci/id": "alphaville.plane" }),
    DELIVERY_STORE: store,
  };
}

test("runtime routes signed GitHub deliveries through the verifier and dedupes replay", async () => {
  const store = deliveryStore();
  const first = await handleRequest(await webhookRequest(), env(store));
  const second = await handleRequest(await webhookRequest(), env(store));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: true, delivery_id: "runtime-delivery-1", workspace: "alphaville.plane" });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "replayed_delivery" });
});

test("runtime webhook fails closed when signed-delivery configuration is incomplete", async () => {
  const response = await handleRequest(await webhookRequest("runtime-delivery-2"), { ...env(), GITHUB_WEBHOOK_SECRET: undefined });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "webhook_secret_unavailable" });
  const missingDedupe = await handleRequest(await webhookRequest("runtime-delivery-3"), { ...env(), DELIVERY_STORE: undefined });
  assert.equal(missingDedupe.status, 503);
  assert.deepEqual(await missingDedupe.json(), { error: "dedupe_unavailable" });
});
