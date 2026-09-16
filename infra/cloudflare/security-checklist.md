# Cloudflare edge security checklist

This is an operator-run configuration record. It is intentionally not an API call or Terraform
plan: no account, zone, hostname, rule ID, or credential is safe to guess in source.

## Access

- [ ] Create an Access application for `https://id.drksci.com/approve/*` and other human-only
      approval routes. Keep discovery, documentation, and health probes public.
- [ ] Require the approved operator identity provider and the smallest possible allowlist.
- [ ] Require an Access session for approval pages; do not treat a notification URL, bearer token,
      or request ID as proof of human authentication.
- [ ] Set session duration and device posture according to the operator policy; record chosen
      values in the release record.
- [ ] Confirm Access failure responses do not reveal request contents or token material.

## WAF and transport

- [ ] Attach the managed WAF ruleset to the `drksci.com` zone and review false positives against
      documented API request shapes.
- [ ] Block malformed methods and oversized bodies at the edge. Keep the API body limit aligned
      with the Worker validator.
- [ ] Enforce HTTPS and redirect HTTP to HTTPS. Enable HSTS only after HTTPS is verified for every
      intended hostname and dependency.
- [ ] Restrict CORS to approved human approval origins; do not use `*` for credentialed requests.
- [ ] Enable Security Events logging and retain the event identifier with any release incident.

## Rate limits

- [ ] Protect `POST /api/v1/access-requests` with per-IP and per-actor rules. Start with a bounded
      threshold appropriate to expected traffic, then tune from observed metrics.
- [ ] Protect approval and notification endpoints separately so request creation cannot exhaust
      human approval capacity.
- [ ] Return `429` with `Retry-After` when an edge rule fires and ensure retries are safe through
      an idempotency key.
- [ ] Confirm health and readiness probes remain available to the configured monitor.
- [ ] Test IPv4, IPv6, proxy-forwarded addresses, and authenticated actors; never trust an
      unvalidated client-supplied IP header.

## GitHub App webhooks

- [ ] Store the GitHub App private key and webhook secret separately with `wrangler secret put`;
      neither belongs in Git or GitHub Actions logs.
- [ ] Verify `X-Hub-Signature-256` over the raw request bytes with constant-time comparison before
      parsing JSON. Reject missing, malformed, or mismatched signatures with a generic response.
- [ ] Check `X-GitHub-Event`, `X-GitHub-Delivery`, App ID, installation ID, and repository binding
      against an explicit allowlist. Ignore unsupported event types without granting authority.
- [ ] Deduplicate delivery IDs in D1 before applying a state transition. A duplicate or replayed
      delivery must be harmless and must not create a second grant or approval.
- [ ] Bound body size and processing time at the edge. Persist only the minimum event fields needed
      for the audit trail, and redact tokens, private keys, and full webhook payloads from logs.
- [ ] Treat a `repository_dispatch` detector signal as an observation only; the Worker remains the
      authority and must not treat workflow output as proof of a valid webhook.

## Verification evidence

- [ ] Save rule names, scope, thresholds, and change timestamp in the release record.
- [ ] Exercise one allowed and one blocked request for Access, WAF, and rate limiting.
- [ ] Confirm logs contain request IDs and decision metadata but no credentials, VAPID private key,
      webhook secret, or full access token.
- [ ] Record the operator who made the change. This checklist does not claim remote configuration
      has been applied.
