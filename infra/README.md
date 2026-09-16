# `id-worker` deployment contract

This directory describes the intended Cloudflare deployment for `drksci/id`. The Worker is named
`id-worker`; durable D1 state is held in an environment-specific database corresponding to
`drksci/id-data`. The Worker entrypoint is `src/index.ts`, which delegates to the dependency-free
runtime in `src/runtime.js`; the static discovery/documentation
surface is exposed through Wrangler's `ASSETS` binding over `public/`. Because this config lives in
`infra/`, its paths are explicitly `../src/index.ts` and `../public`.

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
friendly alias uses a separate certificate/DNS record. Keep a registry of reserved labels and
verified bindings before provisioning any wildcard.

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
5. Apply D1 migrations from the worker implementation before the first deployment. When the
   implementation introduces migrations, add its migrations directory to this config and verify
   the migration list against the target database; retain the output as release evidence.
6. Configure Access, WAF, rate limiting, and the GitHub App webhook using
   [`cloudflare/security-checklist.md`](cloudflare/security-checklist.md) and
   [`github-app.example.yml`](github-app.example.yml).

The signed webhook boundary is implemented independently in `src/github-webhook.js` and exported
as `handleGitHubWebhook` for later route wiring. It accepts only signed, allowlisted deliveries and
requires a delivery store with an atomic `claim(delivery_id)` method. The handler is intentionally
not imported by `src/runtime.js` in this slice; route wiring must preserve the raw request body,
provide the deployment-owned allowlists, and pass a D1-backed deduplication store.

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
