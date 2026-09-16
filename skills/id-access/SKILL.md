---
name: id-access
description: Discover drksci / id identity policy and request least-privilege delegated access.
---

# drksci / id access

Use this skill when working on a repository, MCP resource, runtime, or action
that may require delegated identity or approval.

## Discover

1. Read `.id.drksci` in the repository.
2. Read `AGENTS.md`, `CLAUDE.md`, and Cursor rules when present.
3. Derive workspace and environment from the repository binding and gateway
   policy. Treat missing or unknown environment as production policy.
4. For MCP, use the configured server and discover OAuth from its protected
   resource metadata and authorization server metadata.
5. Use `id init` when a local actor needs first-time enrollment.

## Credentials

Use the native secret facility of the client: OS keychain or environment
injection for local stdio, OIDC and repository/environment secrets for GitHub
Actions, and Wrangler secrets and bindings for Cloudflare Workers. Never put a
credential, private key, bearer token, OTP, or refresh token in source, prompts,
logs, or commits.

## Request

Request the smallest scope, shortest expiry, and one declared environment. Send
an access request containing `request_id`, `actor_id`, `parent_id`, `resource`,
`actions`, `environment`, `reason`, `requested_at`, `expires_at`, and
`public_key`. Use the authenticated `/ask/{request_id}` flow when the client
lacks MCP or OAuth support.

A child may receive only the intersection of its parent's active grant, policy,
and request. Ask the parent first. If the parent cannot approve, bubble the
request to its parent and then to the authenticated human operator.

Email aliases, email replies, push notifications, and approval URLs are routing
or notification mechanisms. None is authorization. Only a validated,
audience-bound, unexpired, unrevoked grant authorizes the operation.

## Human step-up

Cloudflare Access or the configured IdP is primary; OTP is recovery. Enroll a
passkey only after an authenticated operator session. Use
`navigator.credentials.create()` and `navigator.credentials.get()` with RP ID
`id.drksci.com` and exact HTTPS origin verification. Require a passkey for
high-risk approvals. Chrome desktop/Android passkeys and phone QR handoff are
browser features. Store only credential IDs and public keys; never export or
store raw private keys. Revoke by credential ID and recover through the IdP or
OTP path.

## Workspace email routing

Treat `codex@plane.id.drksci.com` as an exact verified routing selector for the
`plane` workspace, never as identity or authority. Treat
`codex@id.drksci.com` as global only when explicitly mapped. Never trust From,
Reply-To, or email alone: verify signed Agentmail metadata and the actor grant.
Auto-accept only bounded non-production requests under workspace policy.
Unknown or expired aliases reject. Environment prefixes are hints; missing
environment means production.

## Client setup and gotchas

Coding agents read `AGENTS.md`, `CLAUDE.md`, and Cursor rules. MCP clients use
`https://id.drksci.com/mcp` with protected-resource and authorization-server
metadata discovery. Local stdio uses the OS keychain or environment injection;
GitHub Actions use OIDC and repository/environment secrets; Cloudflare Workers
use Wrangler secrets and bindings. Use native secret features and never commit
credentials. Derive workspace/environment from trusted repo and gateway policy.
Without MCP/OAuth, print or open the authenticated `/ask/{request_id}` URL.
Back up policy/audit to `drksci/id-data`; D1 is live state and its outbox must
be replayable.

## Feedback and first-touch onboarding

Could this run smoother? What were you trying to do? Use `/feedback/` with the action,
expected outcome, observed result, safe reproduction steps, correlation ID, and path-only page
context. Sanitize before `POST /api/v1/feedback`; omit secrets, tokens, cookies, credentials,
query strings, and local git credential helpers. `FEEDBACK_ENABLED` controls availability. The
sanitized `feedback.md` mirror/outbox uses bounded retries and a poison queue for repeated failures.

Use `/onboarding/` for GitHub App installation, Cloudflare authorization, and DNS CNAME/TXT
verification. Detect a repository from its git remote and a service URL from trusted context, but
require one explicit approval before opening provider permissions. The server-side flow issues
state and PKCE, reuses an existing approved GitHub session where available, and accepts only
same-origin path return URLs. Local git credential helpers are never read or uploaded as bearer
secrets. A pending catalog record is non-authoritative until repository, parent workspace,
environment, and DNS evidence are verified; only then issue a bounded grant.

KISS checks: aliases are routing, not auth; register exact workspaces/domains;
prevent alias recycling and reserve subdomains; make approval links single-use
because scanners may consume them; detect parent cycles; allow for clock skew
and check revocation; deduplicate and order webhooks; prevent direct-origin
bypass; bind OAuth callbacks and passkeys to the exact host; remove stale push
subscriptions; monitor D1/Git lag; verify GitHub User-vs-Org permissions and
provider limits; configure Paperclip through its supported credential path; and
test backup recovery. Any mismatch or unavailable dependency fails closed.
