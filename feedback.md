# Feedback endpoint

Could this run smoother? What were you trying to do?

This file documents `POST /api/v1/feedback` as it is implemented. It is an endpoint contract and a
place to record what is *not* built, so the next reader is not misled by machinery that does not
exist. Credentials and raw request bodies never belong here.

## Record

The endpoint accepts one JSON object. These fields are required and are rejected with
`invalid_feedback` (400) when absent — see `src/runtime.js`, `submitFeedback`:

| Field | Notes |
| --- | --- |
| `correlation_id` | bounded string; keep it for follow-up |
| `prompt_id` | bounded string |
| `idempotency_key` | required; a repeated key by the same actor returns the original record |
| `event` | bounded string |
| `action` | bounded string |
| `expected_outcome` | redacted, bounded |
| `observed_result` | redacted, bounded |
| `reproduction_steps` | redacted, bounded |
| `severity` | must be one of `debug`, `info`, `warning`, `error`, `critical` |
| `message` | redacted, bounded |

`workspace`, `environment` and `resource` come from the request body or fall back to policy, and are
then checked against policy. `metadata` is restricted to a fixed key allowlist
(`component`, `operation`, `route`, `error_code`, `provider`, `attempt`, `duration_ms`,
`status_code`, `context`) and bounded to 8 KiB; `context` accepts scalars only.

The response contains `feedback_id`, `correlation_id`, `status` and `created_at`. `status` begins at
`open`; the other states are `acknowledged`, `resolved` and `dismissed`.

Never send a query string, referrer, cookie, authorization header, token, private key, password, or a
full webhook payload. `expected_outcome`, `observed_result`, `reproduction_steps` and `message` are
passed through `redactSecrets` on write, but that is a backstop, not permission to send them.

## Access

**The endpoint authenticates its caller.** `handleRequest` calls `authenticateAny` before
`submitFeedback`, so a request without a Cloudflare Access JWT is rejected with 401.

This matters for the public `/feedback/` page, which POSTs with `credentials: "omit"`. As it stands
that page cannot submit, and the service worker queues the report and retries against the 401. Both
are open questions rather than settled behaviour; see the note below.

`FEEDBACK_ENABLED` is a deployment flag. When it is false the endpoint fails closed without writing a
partial record.

## What is not built

Recorded here deliberately, because each of these was previously documented as though it existed:

- **No repository mirror.** No `drksci/id-data` repository exists, and nothing exports sanitized
  records anywhere. `DURABLE_REPOSITORY` names it in `infra/wrangler.toml` in every environment, but
  no code reads it.
- **No retry, backoff or poison queue.** Writes to `feedback_outbox` always use the status `pending`;
  nothing drains it, transitions it, or retries it. There is no replay path.
- **No delivery guarantee.** Because the outbox is never drained, a stored record is stored and
  nothing more. Do not read this endpoint as a delivery contract.

The intended replacement is an evolver-owned inbox: `id` hands sanitized reports to the evolver and
keeps no feedback state of its own. That work is tracked in `drksci/id-evolver`, and until it lands
these gaps are the accurate description of what runs today.

## For agents

Send the smallest useful report, keep the returned `correlation_id`, and use safe reproduction steps
only. Omit secrets, tokens, credentials, local git credential-helper contents, and private repository
data. A report is a report — nothing here approves, grants or changes policy.
