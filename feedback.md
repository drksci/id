# Feedback mirror and outbox contract

Could this run smoother? What were you trying to do?

This file defines the sanitized append format for `POST /api/v1/feedback`. It is a durable mirror
and outbox contract, not a place for credentials or raw request bodies. The deployment-owned
`FEEDBACK_ENABLED` flag controls whether the endpoint accepts new records.

Records are `drksci.id.feedback.v1`. Two optional structured nodes, `feedback_pre` (declared intent)
and `feedback_post` (closing report), sit alongside the existing flat fields (`expected_outcome`,
`observed_result`, `reproduction_steps`, `event`, `action`, `severity`, `message`, `context`,
`metadata`, `correlation_id`, `prompt_id`, `idempotency_key`). Either form may be used in one call.

## Sanitized record

Append one JSON object per line (or the equivalent structured row in `id-data`) with these fields:

```json
{"schema":"drksci.id.feedback.v1","correlation_id":"uuid","received_at":"2026-09-17T00:00:00Z","action":"onboarding","feedback_pre":{"objective":"open provider setup","expected_outcome":"provider setup opens"},"feedback_post":{"outcome":"partial","observed_result":"setup stopped","reproduction_steps":"1. Open onboarding 2. Review context","suggestion":"show the detected provider earlier"},"message":"short description","page_path":"/onboarding/","workspace":"workspace://drksci/id/dev","environment":"dev","status":"pending"}
```

`correlation_id`, `received_at`, `action`, `message`, `page_path`, and `status` are required.
`expected_outcome`, `observed_result`, `reproduction_steps`, `workspace`, and `environment` are
optional and must be bounded in length. Keep `page_path` path-only; never retain a query string,
referrer, cookie, authorization header, token, private key, password, or full webhook payload.
Apply the same redaction before writing D1, the outbox, logs, or the repository mirror.

## feedback_pre — declared intent

Written before or while the agent works. The node is allowlisted: any key outside this list is
rejected, not stored.

- `objective` (required when the node is present): one bounded sentence, what it was trying to
  achieve.
- `objectives` (optional): ordered array of the basic order of objectives, max 12 entries, 512
  chars each.
- `constraints` (optional): array of bounds, policy, or non-goals, max 12 entries, 512 chars each.
- `expected_outcome` (optional): what success would have looked like, up to 4096 chars.
- `context` (optional): object of scalar values.

## feedback_post — closing report

Written when the work closes. The node is allowlisted: any key outside this list is rejected.

- `outcome` (required when the node is present): one of `achieved`, `partial`, `not_achieved`,
  `blocked`, `unknown`.
- `observed_result` (optional), `reproduction_steps` (optional): up to 4096 chars each.
- `suggestion` (optional): the single change that would have helped most, up to 512 chars.
- `suggestions` (optional): array (max 12) of objects with allowed keys `kind` (`fix`,
  `improvement`, `documentation`, `tooling`, `policy`), `recommendation` (required, 512 chars),
  `confidence` (`low`, `medium`, `high`), and `evidence` (512 chars).
- `follow_ups` (optional): array of open questions or next checks, max 12 entries, 512 chars each.

`expected_outcome` may be supplied through `feedback_pre.expected_outcome` instead of the top-level
field, and `observed_result` / `reproduction_steps` may be supplied through `feedback_post`. Put each
value in exactly one place: the same value in both places is harmless, but two different values for
the same fact fail closed with `invalid_feedback` rather than silently picking a winner, so never send
two conflicting copies. A value is never estimated: if neither source provides it, the request is
rejected.

## Fill-in template

Copy this template and replace the placeholders. It contains placeholders only: never a token,
credential, hostname, or private datum.

```json
{"schema":"drksci.id.feedback.v1","feedback_pre":{"objective":"<one sentence: what you were trying to achieve>","objectives":["<first objective, in order>","<next objective>"],"constraints":["<bound, policy, or non-goal you were working within>"],"expected_outcome":"<what success would have looked like>"},"feedback_post":{"outcome":"achieved|partial|not_achieved|blocked|unknown","observed_result":"<what actually happened>","suggestion":"<the single change that would have helped most>","suggestions":[{"kind":"fix|improvement|documentation|tooling|policy","recommendation":"<specific, actionable change>","confidence":"low|medium|high","evidence":"<bounded, sanitized evidence>"}],"follow_ups":["<open question or next check>"]}}
```

## Lifecycle and endpoints

An agent may declare intent first and close the loop after finishing, or submit both nodes at once.

- `POST /api/v1/feedback` accepts `feedback_pre` and/or `feedback_post` in one call, or the legacy
  flat fields. Response: `{feedback_id, status, correlation_id, created_at}`.
- `POST /api/v1/feedback/{feedback_id}/complete` attaches the post node later. Body:
  `{"feedback_post": { ... }}`. Only the submitting subject may complete its own record; otherwise
  the call fails with `403 forbidden`. A second completion fails with `409
  feedback_already_completed`. Response: `{feedback_id, status, correlation_id, created_at,
  completed_at, feedback_post}`.
- MCP tool / JSON-RPC method `complete_feedback`, arguments `{feedback_id, feedback_post}`.
  `submit_feedback` also accepts `feedback_pre` and `feedback_post`.

## Sanitization and sensitive data

The nodes are allowlisted (unknown keys are rejected), every string is bounded in length, the total
node size is capped, and known secret shapes are redacted: private-key blocks, `ghp_` / `sk-` / JWT
shapes, `Bearer` tokens, and `authorization|api_key|token|secret|password|private_key = ...`.

Redaction is best effort. It cannot recognise private data that carries no recognisable shape, so
agents MUST NOT paste credentials, tokens, cookies, authorization headers, query strings, private
repository data, or tool output. MCP instructions, prompts, and tool results MUST NOT be included in
either node and MUST NOT contain sensitive data; the nodes carry goals, bounds, outcomes, and
suggestions only.

## Forwarding

Forwarding is Cloudflare-native and email-first. After a record is accepted, the Worker sends the
sanitized record through a Cloudflare Email Service `send_email` binding, not a third party:

```jsonc
"send_email": [{ "name": "EMAIL", "destination_address": "ops@yourdomain.com" }]
```

The binding's `destination_address` is the default configured address: when the Worker calls `send()`
with `to` null or undefined, that configured address is used. A binding may instead declare
`allowed_destination_addresses` / `allowed_sender_addresses`; with no restriction attribute it may
send to any verified destination in the account. The sender address must belong to a domain onboarded
to Email Service.

- The binding is read from `env.EMAIL` (alias `env.FEEDBACK_EMAIL`).
- The sender comes from the `FEEDBACK_FORWARD_FROM` deployment variable.
- An optional explicit recipient override comes from `FEEDBACK_FORWARD_TO`; when that override is
  unset the Worker passes `to: null` so the binding's default configured address is authoritative.
- The email body carries the sanitized record JSON (both nodes included), never a raw request body.
- Sender-side failures are recorded as safe codes only (for example `E_SENDER_NOT_VERIFIED`,
  `E_RECIPIENT_NOT_ALLOWED`, or a generic `email_send_failed`); provider messages and response
  bodies are never stored or logged.

Fallback: when no email binding or sender is configured and `FEEDBACK_FORWARD_URL` is set, the Worker
POSTs the same sanitized payload there, with `FEEDBACK_FORWARD_TOKEN` as a bearer credential when
present, under a bounded timeout.

Delivery is attempted once per lifecycle event (submit, and again when the post node is attached) and
never blocks or fails the accepted write. The outbox row moves from `pending` to `delivered` on a 2xx;
otherwise it stays `pending` with an incremented `attempts` count and a safe `last_error_code` (no
response body, no provider detail). When nothing is configured, nothing is forwarded and the row
stays `pending`; retry, replay, and poison handling remain operator-owned.

## Ownership and delivery

The Worker owns validation, correlation IDs, sanitization, and the live D1 outbox. The repository
mirror is owned by the deployment operator and receives sanitized records only after the normal
outbox write. `FEEDBACK_ENABLED` is a deployment flag; a disabled endpoint fails closed without
writing a partial record. Workspace, resource, and environment remain policy inputs and are never
inferred from a hostname alone.

Transient delivery failures retry with bounded exponential backoff and an idempotency key derived
from `correlation_id`. After the retry limit, move the record to a poison queue with a safe error
code and operator-visible reason. Never retry indefinitely, silently drop a record, or replace an
unknown value with an estimate. An operator may replay a poison record after fixing the cause; the
replay preserves the original correlation ID and audit trail.

Agents should send the smallest useful report through `/feedback/` or the documented endpoint.
They must omit secrets, tokens, credentials, local git credential-helper contents, and private
repository data. Keep the correlation ID for follow-up and use safe reproduction steps only.
