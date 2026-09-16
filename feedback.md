# Feedback mirror and outbox contract

Could this run smoother? What were you trying to do?

This file defines the sanitized append format for `POST /api/v1/feedback`. It is a durable mirror
and outbox contract, not a place for credentials or raw request bodies. The deployment-owned
`FEEDBACK_ENABLED` flag controls whether the endpoint accepts new records.

## Sanitized record

Append one JSON object per line (or the equivalent structured row in `id-data`) with these fields:

```json
{"correlation_id":"uuid","received_at":"2026-09-17T00:00:00Z","action":"onboarding","expected_outcome":"provider setup opens","observed_result":"setup stopped","message":"short description","reproduction_steps":"1. Open onboarding 2. Review context","page_path":"/onboarding/","workspace":"workspace://drksci/id/dev","environment":"dev","status":"pending"}
```

`correlation_id`, `received_at`, `action`, `message`, `page_path`, and `status` are required.
`expected_outcome`, `observed_result`, `reproduction_steps`, `workspace`, and `environment` are
optional and must be bounded in length. Keep `page_path` path-only; never retain a query string,
referrer, cookie, authorization header, token, private key, password, or full webhook payload.
Apply the same redaction before writing D1, the outbox, logs, or the repository mirror.

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
