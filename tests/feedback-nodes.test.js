import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
FEEDBACK_OUTCOME,
FEEDBACK_STATUS,
FEEDBACK_TEMPLATE,
MCP_PROTOCOL,
MCP_TOOL,
SUBJECT_KIND,
completeFeedback,
forwardFeedback,
getFeedback,
handleRequest,
submitFeedback,
} from "../src/runtime.js";
import { D1Store } from "../src/storage.js";

const NOW = new Date("2026-09-17T00:00:00.000Z");
const policy = { workspace: "workspace://drksci/alphaville_foundary/dev", resource: "github:alphaville-foundry/alphaville_foundary", environment: "dev", approvers: ["human://approver"] };
const agent = { sub: "agent://feedback/nodes", kind: SUBJECT_KIND.AGENT, issuer: "https://id.drksci.com", audience: ["id-worker"], scopes: ["contents:read"], environment: "dev", parent_id: "agent://parent", expires_at: "2026-09-18T00:00:00.000Z", jti: "feedback-nodes-jti" };
const other = { ...agent, sub: "agent://feedback/other" };

class Store {
constructor() { this.idempotency = new Map(); this.feedback = new Map(); this.outbox = new Map(); this.marks = []; }
async getIdempotency(actor, key) { return this.idempotency.get(`${actor}:${key}`) || null; }
async putIdempotency(actor, key, value) { this.idempotency.set(`${actor}:${key}`, value); }
async createFeedback(record) { this.feedback.set(record.feedback_id, record); }
async createFeedbackWithIdempotency(record, response) {
this.feedback.set(record.feedback_id, record);
await this.putIdempotency(record.actor_subject_hash, record.idempotency_key, response);
this.outbox.set(`${record.feedback_id}:pre`, { feedback_id: record.feedback_id, feedback_pre: record.feedback_pre, feedback_post: record.feedback_post, status: "pending" });
}
async getFeedback(id) { return this.feedback.get(id) || null; }
async attachFeedbackPost(id, update, updatedAt) {
const record = this.feedback.get(id);
if (!record || record.feedback_post) return false;
this.feedback.set(id, { ...record, observed_result: update.observed_result, reproduction_steps: update.reproduction_steps, feedback_post: update.feedback_post, completed_at: updatedAt, updated_at: updatedAt });
return true;
}
async enqueueFeedbackOutbox(outboxId, record, createdAt) { this.outbox.set(outboxId, { feedback_id: record.feedback_id, feedback_pre: record.feedback_pre, feedback_post: record.feedback_post, status: "pending", created_at: createdAt }); }
async markFeedbackOutbox(outboxId, update) { this.marks.push({ outboxId, ...update }); if (this.outbox.has(outboxId)) this.outbox.set(outboxId, { ...this.outbox.get(outboxId), ...update }); }
}

function base(extra = {}) {
return { idempotency_key: "nodes-idem", correlation_id: "corr-nodes", prompt_id: "prompt-nodes", workspace: policy.workspace, environment: "dev", resource: policy.resource, event: "access.request", action: "request", severity: "info", message: "a bounded description", ...extra };
}

function auditDb(row) {
const statements = [];
return {
statements,
prepare(sql) {
const statement = { sql, values: [], bind(...values) { statement.values = values; return statement; }, async run() { return { meta: { changes: 1 } }; }, async first() { return row || null; }, async all() { return { results: [] }; } };
statements.push(statement);
return statement;
},
async batch() { return []; },
};
}

test("the published feedback template is placeholder-only and never carries a secret", () => {
const encoded = JSON.stringify(FEEDBACK_TEMPLATE);
assert.equal(FEEDBACK_TEMPLATE.schema, "drksci.id.feedback.v1");
assert.match(FEEDBACK_TEMPLATE.feedback_pre.objective, /^<.+>$/);
assert.match(FEEDBACK_TEMPLATE.feedback_post.outcome, /achieved/);
assert.deepEqual(Object.keys(FEEDBACK_TEMPLATE.feedback_pre), ["objective", "objectives", "constraints", "expected_outcome"]);
assert.ok(!/drksci\.com|authorization|bearer|gh[pousr]_|sk-|BEGIN /i.test(encoded));
assert.ok(Object.isFrozen(FEEDBACK_TEMPLATE));
});

test("feedback_pre declares intent and the record derives its bounded fields from it", async () => {
const store = new Store();
const response = await submitFeedback({
subject: agent,
store,
policy,
now: NOW,
env: { FEEDBACK_ENABLED: true },
randomId: () => "feedback_nodes_pre_123456",
feedback: base({
feedback_pre: { objective: "publish the one-click template", objectives: ["add wrangler config", "add deploy button"], constraints: ["no operator values"], expected_outcome: "a stranger can deploy with ghp_example and it works" },
}),
});
const record = store.feedback.get(response.feedback_id);
assert.equal(record.status, FEEDBACK_STATUS.OPEN);
assert.equal(record.feedback_pre.objective, "publish the one-click template");
assert.deepEqual(record.feedback_pre.objectives, ["add wrangler config", "add deploy button"]);
assert.deepEqual(record.feedback_pre.constraints, ["no operator values"]);
assert.match(record.expected_outcome, /\[REDACTED\]/);
assert.equal(record.observed_result, "", "an outcome that has not happened yet is left empty, never estimated");
assert.equal(record.reproduction_steps, "");
assert.equal(record.completed_at, undefined);
assert.ok(Object.isFrozen(record.feedback_pre));
});

test("feedback_post reports the outcome and structured suggestions, with secrets redacted", async () => {
const store = new Store();
const response = await submitFeedback({
subject: agent,
store,
policy,
now: NOW,
env: { FEEDBACK_ENABLED: true },
randomId: () => "feedback_nodes_post_123456",
feedback: base({
feedback_pre: { objective: "complete the deploy", objectives: ["deploy", "verify"] },
feedback_post: {
outcome: FEEDBACK_OUTCOME.PARTIAL,
observed_result: "the deploy stopped with Bearer abc123",
suggestion: "ship the template config first",
suggestions: [
{ kind: "fix", recommendation: "keep the operator config out of the template", confidence: "high", evidence: "k=sk-abcdef" },
{ recommendation: "document the D1 opt-in" },
],
follow_ups: ["does the button provision D1?"],
},
}),
});
const record = store.feedback.get(response.feedback_id);
assert.equal(record.feedback_post.outcome, FEEDBACK_OUTCOME.PARTIAL);
assert.match(record.feedback_post.observed_result, /Bearer \[REDACTED\]/);
assert.equal(record.observed_result, record.feedback_post.observed_result, "the flat field mirrors the node value it came from");
assert.equal(record.feedback_post.suggestions.length, 2);
assert.equal(record.feedback_post.suggestions[0].kind, "fix");
assert.equal(record.feedback_post.suggestions[0].confidence, "high");
assert.ok(!record.feedback_post.suggestions[0].evidence.includes("sk-abcdef"));
assert.deepEqual(record.feedback_post.suggestions[1], { recommendation: "document the D1 opt-in" });
assert.equal(record.completed_at, NOW.toISOString());
});

test("node validation fails closed on unknown keys, missing values, and unbounded lists", async () => {
const store = new Store();
const submit = (feedback) => submitFeedback({ subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_nodes_bad_123456", feedback });
const rejects = async (feedback, code = "invalid_feedback") => assert.rejects(() => submit(feedback), (error) => error.code === code);

await rejects(base({ feedback_pre: { objective: "x", instructions: "paste the whole prompt" } }));
await rejects(base({ feedback_pre: { objectives: ["an objective without an objective"] } }));
await rejects(base({ feedback_pre: { objective: "x", token: "abc" } }));
await rejects(base({ feedback_post: { observed_result: "no outcome" } }));
await rejects(base({ feedback_post: { outcome: "succeeded" } }));
await rejects(base({ feedback_post: { outcome: "achieved", suggestions: [{ recommendation: "x", severity: "high" }] } }));
await rejects(base({ feedback_post: { outcome: "achieved", suggestions: [{ kind: "rewrite", recommendation: "x" }] } }));
await rejects(base({ feedback_post: { outcome: "achieved", suggestions: [{ kind: "fix" }] } }));
await rejects(base({ feedback_post: { outcome: "achieved", follow_ups: Array.from({ length: 13 }, (_, index) => `follow up ${index}`) } }));
await rejects(base({ feedback_post: { outcome: "achieved", suggestions: Array.from({ length: 13 }, () => ({ recommendation: "x" })) } }));
await rejects(base({ feedback_pre: "not an object" }));
await rejects(base({ feedback_post: { outcome: "achieved", suggestions: "not an array" } }));
// Without either node the original contract still applies: the flat fields are required.
await rejects(base({ feedback_pre: undefined, expected_outcome: undefined, observed_result: undefined, reproduction_steps: undefined }));
// The same value in two places is harmless, two different values are a contradiction.
await rejects(base({ expected_outcome: "a grant is returned", feedback_pre: { objective: "x", expected_outcome: "a token is returned" } }));
await rejects(base({ observed_result: "one thing", feedback_post: { outcome: "achieved", observed_result: "another thing" } }));
const agreed = await submitFeedback({ subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_nodes_agree_123456", feedback: base({ expected_outcome: "a grant is returned", feedback_pre: { objective: "x", expected_outcome: "a grant is returned" } }) });
assert.equal(store.feedback.get(agreed.feedback_id).expected_outcome, "a grant is returned");
});

test("completeFeedback attaches the post node once, for its author only", async () => {
const store = new Store();
const opened = await submitFeedback({ subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_nodes_open_123456", feedback: base({ feedback_pre: { objective: "close the loop" } }) });
const post = { outcome: FEEDBACK_OUTCOME.ACHIEVED, suggestions: [{ kind: "improvement", recommendation: "keep the pre node short" }] };
await assert.rejects(() => completeFeedback({ feedbackId: opened.feedback_id, subject: other, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, post }), (error) => error.code === "forbidden");
await assert.rejects(() => completeFeedback({ feedbackId: opened.feedback_id, subject: agent, store, policy, now: NOW, env: {}, post }), (error) => error.code === "feature_disabled");
await assert.rejects(() => completeFeedback({ feedbackId: opened.feedback_id, subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, post: { outcome: "done" } }), (error) => error.code === "invalid_feedback");
const completed = await completeFeedback({ feedbackId: opened.feedback_id, subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, post });
assert.equal(completed.completed_at, NOW.toISOString());
assert.equal(completed.feedback_post.outcome, FEEDBACK_OUTCOME.ACHIEVED);
assert.ok(store.outbox.has(`${opened.feedback_id}:post`), "the closing report is its own outbox event");
const visible = await getFeedback({ feedbackId: opened.feedback_id, subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true } });
assert.equal(visible.feedback_pre.objective, "close the loop");
assert.equal(visible.feedback_post.outcome, FEEDBACK_OUTCOME.ACHIEVED);
await assert.rejects(() => completeFeedback({ feedbackId: opened.feedback_id, subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, post }), (error) => error.code === "feedback_already_completed");
});

test("forwarding uses the native email binding, which owns the destination address", async () => {
const sent = [];
const store = new Store();
const env = { EMAIL: { async send(message) { sent.push(message); } }, FEEDBACK_FORWARD_FROM: "id@example.com", FEEDBACK_ENABLED: true };
const response = await submitFeedback({ subject: agent, store, policy, now: NOW, env, randomId: () => "feedback_nodes_mail_123456", feedback: base({ feedback_pre: { objective: "reach the default address" } }) });
assert.equal(sent.length, 1);
assert.equal(sent[0].to, null, "a null recipient lets the binding use its configured default address");
assert.equal(sent[0].from, "id@example.com");
assert.match(sent[0].subject, /\[id feedback\]/);
assert.match(sent[0].text, /reach the default address/);
assert.ok(!/raw request body/i.test(sent[0].text));
assert.deepEqual(store.marks.map((mark) => [mark.outboxId, mark.status]), [[`${response.feedback_id}:pre`, "delivered"]]);
});

test("a provider refusal is recorded as a safe code and never fails the accepted write", async () => {
const store = new Store();
const failing = { EMAIL: { async send() { const error = new Error("E_SENDER_NOT_VERIFIED: sender domain not verified"); error.code = "E_SENDER_NOT_VERIFIED"; throw error; } }, FEEDBACK_FORWARD_FROM: "id@example.com" };
const response = await submitFeedback({ subject: agent, store, policy, now: NOW, env: { ...failing, FEEDBACK_ENABLED: true }, randomId: () => "feedback_nodes_fail_123456", feedback: base({ feedback_pre: { objective: "survive a failed forward" } }) });
assert.ok(store.feedback.has(response.feedback_id), "the record is durable even when forwarding fails");
assert.deepEqual(store.marks.map((mark) => [mark.status, mark.error_code]), [["pending", "E_SENDER_NOT_VERIFIED"]]);
assert.ok(!JSON.stringify(store.marks).includes("sender domain not verified"), "provider messages are never retained");
});

test("forwarding falls back to a bounded https destination and reports safe status codes", async () => {
const store = new Store();
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response("", { status: 202 }); };
try {
const delivered = await forwardFeedback({ schema: "drksci.id.feedback.v1", feedback_id: "feedback_forward_123456789", correlation_id: "corr", event: "e", action: "a", severity: "info", status: "open", message: "safe", feedback_pre: { objective: "goal" } }, { store, env: { FEEDBACK_FORWARD_URL: "https://feedback.example.com/inbox", FEEDBACK_FORWARD_TOKEN: "token-value", FEEDBACK_FORWARD_FROM: "" }, now: NOW, outboxId: "feedback_forward_123456789:pre" });
assert.deepEqual(delivered, { status: "delivered" });
assert.equal(calls[0].init.method, "POST");
assert.equal(calls[0].init.headers.authorization, "Bearer token-value");
assert.equal(calls[0].init.redirect, "manual", "a redirect must never be followed to another origin or scheme");
assert.match(calls[0].init.body, /"objective":"goal"/);
globalThis.fetch = async () => new Response("", { status: 503 });
const failed = await forwardFeedback({ feedback_id: "feedback_forward_123456789" }, { store, env: { FEEDBACK_FORWARD_URL: "https://feedback.example.com/inbox" }, now: NOW });
assert.deepEqual(failed, { status: "pending", error_code: "forward_http_503" });
globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
const unreachable = await forwardFeedback({ feedback_id: "feedback_forward_123456789" }, { store, env: { FEEDBACK_FORWARD_URL: "https://feedback.example.com/inbox" }, now: NOW });
assert.deepEqual(unreachable, { status: "pending", error_code: "forward_unreachable" });
// A redirect would resend the payload somewhere the operator never configured; it is refused.
globalThis.fetch = async () => new Response("", { status: 307, headers: { location: "http://plaintext.example.com/sink" } });
const redirected = await forwardFeedback({ feedback_id: "feedback_forward_123456789" }, { store, env: { FEEDBACK_FORWARD_URL: "https://feedback.example.com/inbox" }, now: NOW });
assert.deepEqual(redirected, { status: "pending", error_code: "forward_redirect_rejected" });
// A misconfigured destination is reported, never thrown: an accepted record must not fail because of
// a value only the operator can correct.
assert.deepEqual(await forwardFeedback({ feedback_id: "x" }, { store, env: { FEEDBACK_FORWARD_URL: "http://feedback.example.com/inbox" }, now: NOW }), { status: "pending", error_code: "forward_url_not_https" });
assert.deepEqual(await forwardFeedback({ feedback_id: "x" }, { store, env: { FEEDBACK_FORWARD_URL: "https://user:secret@feedback.example.com/inbox" }, now: NOW }), { status: "pending", error_code: "forward_url_credentials" });
assert.deepEqual(await forwardFeedback({ feedback_id: "x" }, { store, env: { FEEDBACK_FORWARD_URL: "not a url" }, now: NOW }), { status: "pending", error_code: "forward_url_invalid" });
} finally { globalThis.fetch = originalFetch; }
});

test("an unconfigured deployment forwards nothing and leaves the record pending", async () => {
const store = new Store();
const result = await forwardFeedback({ feedback_id: "feedback_unconfigured_1234", feedback_pre: { objective: "x" } }, { store, env: {}, now: NOW, outboxId: "feedback_unconfigured_1234:pre" });
assert.deepEqual(result, { status: "pending", error_code: "forward_not_configured" });
assert.deepEqual(store.marks, [], "nothing is marked when there is no destination");
});

test("D1 persistence stores both nodes, pins the pre outbox event, and tracks delivery", async () => {
const db = auditDb();
const store = new D1Store(db);
const record = { feedback_id: "feedback_d1_nodes_123456", actor_subject_hash: "sha256:abc", actor_kind: "agent", correlation_id: "c", prompt_id: "p", workspace: "w", environment: "dev", resource: "r", event: "e", action: "a", context: undefined, expected_outcome: "x", observed_result: "", reproduction_steps: "", severity: "info", message: "safe", metadata: {}, feedback_pre: { objective: "goal" }, feedback_post: undefined, completed_at: undefined, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: "open", idempotency_key: "i" };
await store.createFeedbackWithIdempotency(record, { feedback_id: record.feedback_id });
assert.equal(db.statements.length, 3);
const [feedbackInsert, outboxInsert] = db.statements;
assert.match(feedbackInsert.sql, /feedback_pre_json, feedback_post_json, completed_at/);
assert.ok(feedbackInsert.values.includes(JSON.stringify({ objective: "goal" })));
assert.ok(feedbackInsert.values.includes(null));
assert.equal(outboxInsert.values[0], `${record.feedback_id}:pre`);
assert.match(outboxInsert.values[2], /"objective":"goal"/);
const attach = db.statements.length;
assert.equal(await store.attachFeedbackPost(record.feedback_id, { feedback_post: { outcome: "achieved" }, observed_result: "observed", reproduction_steps: "steps" }, NOW.toISOString()), true);
const attachStatement = db.statements[attach];
assert.match(attachStatement.sql, /observed_result = \?, reproduction_steps = \?/, "the closing report must reconcile the flat mirrors in the same statement");
assert.equal(attachStatement.values[1], "observed");
await store.enqueueFeedbackOutbox(`${record.feedback_id}:post`, { ...record, feedback_post: { outcome: "achieved" } }, NOW.toISOString());
await store.markFeedbackOutbox(`${record.feedback_id}:post`, { status: "delivered", delivered_at: NOW.toISOString() });
const markSql = db.statements.at(-1).sql;
assert.match(markSql, /attempts = attempts \+ 1/);
const row = { feedback_id: record.feedback_id, actor_subject_hash: "sha256:abc", actor_kind: "agent", correlation_id: "c", prompt_id: "p", workspace: "w", environment: "dev", resource: "r", event: "e", action: "a", context_json: null, expected_outcome: "x", observed_result: "", reproduction_steps: "", severity: "info", message: "safe", metadata_json: "{}", feedback_pre_json: JSON.stringify({ objective: "goal" }), feedback_post_json: JSON.stringify({ outcome: "achieved" }), completed_at: NOW.toISOString(), created_at: NOW.toISOString(), updated_at: NOW.toISOString(), status: "open", idempotency_key: "i" };
const readBack = await new D1Store(auditDb(row)).getFeedback(record.feedback_id);
assert.deepEqual(readBack.feedback_pre, { objective: "goal" });
assert.deepEqual(readBack.feedback_post, { outcome: "achieved" });
assert.equal(readBack.completed_at, NOW.toISOString());
});

test("the discovery contract advertises the nodes, the completion route, and the relay", () => {
const discovery = JSON.parse(readFileSync(new URL("../public/.well-known/agent-access.json", import.meta.url), "utf8"));
const submit = discovery.feedback.submit;
assert.equal(submit.nodes.feedback_pre.required[0], "objective");
assert.deepEqual(submit.nodes.feedback_post.outcome_values, ["achieved", "partial", "not_achieved", "blocked", "unknown"]);
assert.deepEqual(submit.nodes.feedback_post.suggestion_keys, ["kind", "recommendation", "confidence", "evidence"]);
assert.equal(submit.complete.path, "/api/v1/feedback/{feedback_id}/complete");
assert.equal(submit.complete.mcp_tool, "complete_feedback");
assert.equal(submit.forwarding.binding_name, "EMAIL");
assert.equal(submit.forwarding.unconfigured.includes("nothing is forwarded"), true);
assert.ok(!JSON.stringify(submit).includes("${"));
});

test("a native email send that never settles is bounded and reported, not hung", async () => {
const store = new Store();
const started = Date.now();
const result = await forwardFeedback({ feedback_id: "feedback_timeout_123456789" }, { store, env: { EMAIL: { send: () => new Promise(() => {}) }, FEEDBACK_FORWARD_FROM: "id@example.com", FEEDBACK_FORWARD_TIMEOUT_MS: 100 }, now: NOW, outboxId: "feedback_timeout_123456789:pre" });
assert.deepEqual(result, { status: "pending", error_code: "email_send_timeout" });
assert.ok(Date.now() - started < 3000, "a hanging binding must not hang the forward");
assert.deepEqual(store.marks.map((mark) => mark.error_code), ["email_send_timeout"]);
});

test("a late email rejection is consumed and never escapes the relay", async () => {
const store = new Store();
const rejections = [];
const result = await forwardFeedback({ feedback_id: "feedback_late_1234567890" }, { store, env: { EMAIL: { send: () => new Promise((_, reject) => setTimeout(() => { const error = new Error("late"); error.code = "late_failure"; reject(error); rejections.push("raised"); }, 130)) }, FEEDBACK_FORWARD_FROM: "id@example.com", FEEDBACK_FORWARD_TIMEOUT_MS: 100 }, now: NOW });
assert.deepEqual(result, { status: "pending", error_code: "email_send_timeout" });
await new Promise((resolve) => setTimeout(resolve, 120));
assert.deepEqual(rejections, ["raised"], "the late rejection happened but did not surface");
});

test("completing a record reconciles the flat outcome fields and refuses contradictions", async () => {
const store = new Store();
const contradictory = await submitFeedback({ subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_nodes_recon_123456", feedback: base({ feedback_pre: { objective: "reconcile" }, observed_result: "first", reproduction_steps: "old" }) });
await assert.rejects(() => completeFeedback({ feedbackId: contradictory.feedback_id, subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, post: { outcome: "achieved", observed_result: "second", reproduction_steps: "new" } }), (error) => error.code === "invalid_feedback");
assert.equal(store.feedback.get(contradictory.feedback_id).feedback_post, undefined, "a contradictory report is never stored");
const clean = await submitFeedback({ subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, randomId: () => "feedback_nodes_recon_2_1234", feedback: base({ idempotency_key: "nodes-recon-2", feedback_pre: { objective: "reconcile cleanly" } }) });
await completeFeedback({ feedbackId: clean.feedback_id, subject: agent, store, policy, now: NOW, env: { FEEDBACK_ENABLED: true }, post: { outcome: "partial", observed_result: "second", reproduction_steps: "new" } });
const reconciled = store.feedback.get(clean.feedback_id);
assert.equal(reconciled.observed_result, "second", "the flat mirror is filled from the closing report");
assert.equal(reconciled.reproduction_steps, "new");
assert.equal(reconciled.feedback_post.observed_result, "second");
assert.equal(store.outbox.get(`${clean.feedback_id}:post`).feedback_post.observed_result, "second");
});

test("the node migration is additive only", () => {
const migration = readFileSync(new URL("../migrations/0004_feedback_pre_post.sql", import.meta.url), "utf8");
for (const column of ["feedback_pre_json", "feedback_post_json", "completed_at", "attempts", "delivered_at", "last_error_code"]) {
assert.ok(migration.includes(column), `${column} must be added by the node migration`);
}
assert.ok(migration.includes("ALTER TABLE feedback_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"));
assert.ok(!/\b(DROP|DELETE|TRUNCATE)\b/i.test(migration));
});

test("the HTTP route and MCP tool expose the pre/post flow end to end", async () => {
const store = new Store();
const env = { AUTHENTICATE: async () => ({ verified: true, claim: agent }), STORE: store, FEEDBACK_ENABLED: true, APP_ENV: "dev", WORKSPACE: policy.workspace, RESOURCE: policy.resource };
const post = (url, body) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const created = await handleRequest(post("https://id.drksci.com/api/v1/feedback", base({ feedback_pre: { objective: "submit through the route" } })), env);
assert.equal(created.status, 201);
const opened = await created.json();
const completed = await handleRequest(post(`https://id.drksci.com/api/v1/feedback/${opened.feedback_id}/complete`, { feedback_post: { outcome: "achieved" } }), env);
assert.equal(completed.status, 200);
assert.equal((await completed.json()).feedback_post.outcome, "achieved");
assert.equal((await handleRequest(post(`https://id.drksci.com/api/v1/feedback/${opened.feedback_id}/complete`, { feedback_post: { outcome: "achieved" } }), env)).status, 409);
assert.equal((await handleRequest(post("https://id.drksci.com/api/v1/feedback/feedback_absent_123456/complete", { feedback_post: { outcome: "achieved" } }), env)).status, 404);
assert.equal((await handleRequest(new Request(`https://id.drksci.com/api/v1/feedback/${opened.feedback_id}`), env)).status, 200);
const mcp = await handleRequest(post("https://id.drksci.com/mcp", { jsonrpc: "2.0", id: 7, method: MCP_PROTOCOL.TOOLS_CALL, params: { name: MCP_TOOL.SUBMIT_FEEDBACK, arguments: base({ idempotency_key: "nodes-mcp", feedback_pre: { objective: "submit through mcp" } }) } }), env);
assert.equal(mcp.status, 200);
const openedViaMcp = (await mcp.json()).result.feedback_id;
assert.ok(typeof openedViaMcp === "string" && openedViaMcp.length > 0);
const closedViaMcp = await handleRequest(post("https://id.drksci.com/mcp", { jsonrpc: "2.0", id: 8, method: MCP_PROTOCOL.TOOLS_CALL, params: { name: MCP_TOOL.COMPLETE_FEEDBACK, arguments: { feedback_id: openedViaMcp, feedback_post: { outcome: "blocked" } } } }), env);
assert.equal(closedViaMcp.status, 200);
assert.equal((await closedViaMcp.json()).result.feedback_post.outcome, "blocked");
assert.equal(store.feedback.get(openedViaMcp).feedback_post.outcome, "blocked");
});
