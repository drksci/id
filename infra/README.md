# `id-worker` deployment contract

This directory describes the intended Cloudflare deployment for `drksci/id`. The Worker is named
`id-worker`; durable D1 state is held in an environment-specific database corresponding to
`drksci/id-data`. The Worker entrypoint is `src/index.ts`, which delegates to the dependency-free
runtime in `src/runtime.js`; the static discovery/documentation
surface is exposed through Wrangler's `ASSETS` binding over `public/`. Because this config lives in
`infra/`, its paths are explicitly `../src/index.ts` and `../public`.

The repository root also carries `wrangler.jsonc`: the public one-click template contract used by
the `Deploy to Cloudflare` button, for anyone who wants to run their own copy in their own
Cloudflare account. It is deliberately generic — no operator hostnames, account ID, database ID, or
secrets — and deploys a separate Worker named `id-gateway` with only the `ASSETS` binding, so D1
state and authentication remain opt-in and fail closed until the operator of that copy adds them.
It is not this directory's contract: deploy the operator environments only with
`infra/wrangler.toml` (or its rendered equivalent) and never add operator values to the template.

The configuration is safe to commit. `infra/wrangler.toml` contains non-secret public settings and
explicit `${D1_DATABASE_ID_*}` variable references. CI renders a temporary config from GitHub
Environment variables before invoking Wrangler. It does not create Cloudflare resources, configure
DNS, or contain an account ID, database ID, API token, VAPID key, GitHub App private key, or webhook
secret.

## Environment matrix

| Wrangler environment | Worker name | D1 database | Intended use | Public hostname |
| --- | --- | --- | --- | --- |
| `prod` (default or `--env prod`) | `id-worker` | `id-data-prod` | production gateway | `https://id.drksci.com` |
| `dev` | `id-worker-dev` | `id-data-dev` | developer integration | `https://dev.id.drksci.com` |
| `test` | `id-worker-test` | `id-data-test` | isolated automated tests | `https://test.id.drksci.com` |
| `preview` | `id-worker-preview` | `id-data-preview` | pull request/manual preview | `https://id-preview.drksci.com` or the generated Wrangler preview URL |

Each environment has a separate D1 binding. Do not point a non-production environment at the
production database. Hostnames are intended routes; creating DNS records and routes requires an
operator with authority over the `drksci.com` zone. The renderer requires a distinct UUID-shaped ID
for each environment and fails closed when one is absent or malformed.

The deployment also sets an explicit policy identity in every environment. Production uses
`WORKSPACE=workspace://drksci/id/prod`; development, test, and preview use the corresponding
`workspace://drksci/id/<environment>` URI. `RESOURCE=github:drksci/id` identifies the verified
repository in every environment. Tokens and policy checks must carry matching workspace, resource,
and environment values; a hostname is only a selector.

## Workspace hostnames

The canonical nested form is `<child>.<parent>.id.drksci.com`; for example,
`alphaville.plane.id.drksci.com` selects the `alphaville` child inside the `plane` parent. Parse
the workspace chain right to left after removing the exact `id.drksci.com` suffix: the rightmost
remaining label is the root/parent, and each label to its left is the next child. A deeper chain is
`<grandchild>.<child>.<parent>.id.drksci.com`.

An optional friendly alias such as `alphaville.plane.drksci.com` is valid only when an operator has
explicitly provisioned that DNS record and certificate. It is a selector convenience and never an
authority boundary. Tokens and policy must carry the full canonical workspace chain, so an alias
cannot broaden or change access. Cross-workspace access requires an explicit grant.

Workspace labels must match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`: lowercase ASCII letters,
digits, and interior hyphens, one to 63 characters, with no leading/trailing hyphen. Reserve
`api`, `console`, `docs`, `idea`, `dev`, `test`, `preview`, `www`, `mcp`, `oauth`, and `status`
at every workspace depth. Hostname filtering is UX only; every query and token enforces the full
workspace chain and explicit environment.

Cloudflare DNS wildcards and certificates cover one label depth. `*.id.drksci.com` does not cover
`child.parent.id.drksci.com`; nested routing needs explicitly provisioned records or managed
per-parent wildcards such as `*.plane.id.drksci.com`, plus certificates/SANs for each depth. The
friendly alias uses a separate certificate/DNS record. For the single-label workspace route,
provision a proxied CNAME `*.id.drksci.com` targeting `id.drksci.com` or the assigned Workers
target. The nested workspace route is already part of the checked-in Worker routing contract, but
each deeper hostname still needs a matching per-parent route, wildcard, and certificate. Creating
or changing these DNS records requires an explicit Cloudflare DNS-write credential held by the
operator; no DNS credential or remote record is present in this repository. Keep a registry of
reserved labels and verified bindings before provisioning any wildcard.

## First operator setup

1. Create one D1 database per environment using the names in the matrix. Record each database ID
   as a GitHub Environment variable named `D1_DATABASE_ID_PROD`, `D1_DATABASE_ID_DEV`,
   `D1_DATABASE_ID_TEST`, or `D1_DATABASE_ID_PREVIEW`. The workflow renders a temporary Wrangler
   file from those explicit variables.
2. Set the Cloudflare account outside this repository. Use an environment variable named
   `CLOUDFLARE_ACCOUNT_ID` and a secret named `CLOUDFLARE_API_TOKEN`; never put either value in
   `wrangler.toml`.
3. Configure GitHub environments named `dev`, `test`, `preview`, and `prod`. Production should
   require reviewers and restrict deployment to the default branch.
4. Upload runtime secrets to the matching Worker environment with `wrangler secret put`:
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. The App private key and webhook secret
   are separate values and must be rotated independently.
5. Provision the deployment-owned Access configuration for each Worker environment. The explicit
   names `ACCESS_ISSUER`, `ACCESS_JWKS_URL`, and `ACCESS_AUDIENCE` remain supported. For the
   one-time setup, `ACCESS_TEAM_DOMAIN` may replace the first two: set it to the Cloudflare Access
   team domain (for example `team.example.cloudflareaccess.com`), and the Worker derives the issuer
   as `https://<team-domain>` and JWKS as
   `https://<team-domain>/cdn-cgi/access/certs`. The audience defaults to `id-worker` only when
   no audience is configured. Keep these values in the deployment secret/config store and out of
   this repository; an absent or invalid team domain still fails closed.
6. Apply D1 migrations from the worker implementation before the first deployment. When the
   implementation introduces migrations, add its migrations directory to this config and verify
   the migration list against the target database; retain the output as release evidence.
7. Configure Access, WAF, rate limiting, and the GitHub App webhook using
   [`cloudflare/security-checklist.md`](cloudflare/security-checklist.md) and
   [`github-app.example.yml`](github-app.example.yml).

The signed webhook boundary is implemented independently in `src/github-webhook.js` and exported
as `handleGitHubWebhook` for later route wiring. It accepts only signed, allowlisted deliveries and
requires a delivery store with an atomic `claim(delivery_id)` method. The handler is intentionally
not imported by `src/runtime.js` in this slice; route wiring must preserve the raw request body,
provide the deployment-owned allowlists, and pass a D1-backed deduplication store.

## Feedback, onboarding, and catalog

The static `/feedback/` page asks, “Could this run smoother? What were you trying to do?” and sends
only sanitized action context, expected outcome, observed result, safe reproduction steps,
`correlation_id`, and path-only `page_path` to `POST /api/v1/feedback` with browser credentials
omitted. `FEEDBACK_ENABLED` is an explicit deployment flag in each Wrangler environment; when
false, the endpoint must fail closed. The sanitized mirror/outbox format and bounded retry/poison
handling are defined in the repository-root [`feedback.md`](../feedback.md). Do not place secrets,
tokens, cookies, authorization headers, query strings, or local git credential-helper contents in a
report.

The `/onboarding/` page is a first-touch guide for GitHub App installation, Cloudflare
application/domain authorization, and DNS CNAME/TXT verification. It may display service URL and
repository hints, but a single explicit approval is required before any provider permission opens.
The server-side start flow owns state and PKCE, reuses an existing approved GitHub session when
available, and accepts same-origin path return URLs only. Approved provider actions may open the
`drksci/id` repository setup, the `drksci-id-worker` App installation, the Cloudflare dashboard,
or the deploy workflow; Wrangler remains the fallback. The `/catalog/` page describes service
types, capabilities, parent-child workspace bindings, and `verified`, `pending`, `unverified`, or
`disabled` states. Pending onboarding is descriptive and never grants access.

The optional `/assist/` page is a feedback analyst with deterministic fallback suggestions and an
optional Cloudflare Workers AI binding named `AI`. `ASSISTANT_ENABLED` is explicit in each Wrangler
environment. It reports recurring friction with confidence and evidence, but cannot grant access,
apply a rule, or mutate policy; applying any rule remains a separate authorized action.

The public shell is installable through `manifest.webmanifest` and `sw.js`. The service worker
caches the static discovery shell and hands an already-sanitized feedback POST to an offline outbox;
it never receives provider credentials. Browsers without an install prompt get the browser-menu
fallback. Keep the shell cache versioned when static contracts change and verify that an offline
feedback retry preserves its correlation ID without persisting secrets.

## Feedback relay (progressive rungs)

Feedback is a relay: the Worker accepts a sanitized record and forwards it to the deployment's
configured default address. Each rung below is additive; the rung you do not configure is invisible,
not broken.

1. **Default, no configuration.** Records are validated, redacted, written to D1, and mirrored to the
   outbox. Nothing leaves the Worker and nothing fails: the outbox row simply stays `pending`. No
   binding, secret, or variable is needed.
2. **Native email (preferred).** Forward through Cloudflare Email Service, which owns the destination
   address. Add a `send_email` binding with `destination_address` set to the operator's inbox, then
   set `FEEDBACK_FORWARD_FROM` to a sender on a domain onboarded to Email Service. The Worker calls
   `send()` with `to: null`, so the binding's configured address is authoritative. Set
   `FEEDBACK_FORWARD_TO` only to override that address explicitly. Bindings are not inherited by
   environments: add the binding to each environment that relays.
3. **HTTPS destination.** For deployments without Email Service, set `FEEDBACK_FORWARD_URL` (https
   only, no credentials in the URL) and, when the destination requires it, the
   `FEEDBACK_FORWARD_TOKEN` secret. Redirects are refused rather than followed, so a destination can
   never move a payload to plaintext http or off-site, and both transports are bounded by
   `FEEDBACK_FORWARD_TIMEOUT_MS` (default 5000, clamped to 100-30000). The payload is the same
   sanitized record. A malformed destination is recorded as a safe code and never fails or delays the
   accepted write.
4. **Operator-owned replay.** Delivery is attempted once per lifecycle event: on submit, and again
   when the closing `feedback_post` node is attached. `feedback_outbox` records `status`, `attempts`,
   `delivered_at`, and a safe `last_error_code` (never a provider message). Retry, replay, and poison
   handling stay with the operator and preserve the original `feedback_id` and correlation ID.

No rung forwards a raw request body, a header, a cookie, or a client address, and no rung makes the
accepted write wait on the destination.

## Deployment commands

Run these from the repository root after the worker entrypoint exists and the four D1 variables are
available in the shell:

```sh
python3 infra/render-wrangler-config.py --output infra/wrangler.generated.toml
npx --yes wrangler@4 deploy --config infra/wrangler.generated.toml --env dev
npx --yes wrangler@4 deploy --config infra/wrangler.generated.toml --env test
npx --yes wrangler@4 deploy --config infra/wrangler.generated.toml --env preview
npx --yes wrangler@4 deploy --config infra/wrangler.generated.toml --env prod
rm infra/wrangler.generated.toml
```

The GitHub workflow uses the same commands and references GitHub environment secrets. It requests
the GitHub OIDC permission so an operator can later replace the API-token exchange with a
Cloudflare-supported native federation action; the checked-in workflow currently uses the native
Wrangler `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secret names. It is a deployment
mechanism, not evidence that deployment has happened. A successful release includes the Worker
version, migration result, and authenticated readiness check. The workflow applies the shared
`../migrations` directory to the selected environment's D1 database before deploying the Worker.

## Readiness and rollback

Before promoting production, check:

- `GET /healthz` returns success without authentication and does not disclose secrets.
- `GET /readyz` confirms the Worker can reach its D1 binding and reports failure when migrations
  are missing.
- `GET /.well-known/agent-access.json` advertises the same issuer, environment, and endpoint
  contract as the deployment.
- A signed GitHub App webhook request is accepted, an invalid signature is rejected, and duplicate
  delivery IDs are harmless.
- Access approval remains human-authenticated and notifications cannot approve a request.

If a release fails, redeploy the last known-good Worker version using the Cloudflare dashboard or
the pinned version ID from the release record. Do not roll back D1 schema changes by deleting data;
use a forward migration or a documented restore procedure approved by the operator.
