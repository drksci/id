# `id-worker` deployment contract

This directory describes the intended Cloudflare deployment for `drksci/id`. The Worker is named
`id-worker`; durable D1 state is held in an environment-specific database corresponding to
`drksci/id-data`. The runtime entrypoint is `src/runtime.js`, and the static discovery/documentation
surface is exposed through Wrangler's `ASSETS` binding over `public/`. Because this config lives in
`infra/`, its paths are explicitly `../src/runtime.js` and `../public`.

The configuration is safe to commit. `infra/wrangler.toml` contains non-secret public settings and
explicit `REPLACE_WITH_*` placeholders. It does not create Cloudflare resources, configure DNS, or
contain an account ID, database ID, API token, VAPID key, GitHub App private key, or webhook secret.

## Environment matrix

| Wrangler environment | Worker name | D1 database | Intended use | Public hostname |
| --- | --- | --- | --- | --- |
| `prod` (default or `--env prod`) | `id-worker` | `id-data-prod` | production gateway | `https://id.drksci.com` |
| `dev` | `id-worker-dev` | `id-data-dev` | developer integration | `https://dev.id.drksci.com` |
| `test` | `id-worker-test` | `id-data-test` | isolated automated tests | `https://test.id.drksci.com` |
| `preview` | `id-worker-preview` | `id-data-preview` | pull request/manual preview | `https://id-preview.drksci.com` or the generated Wrangler preview URL |

Each environment has a separate D1 binding. Do not point a non-production environment at the
production database. Hostnames are intended routes; creating DNS records and routes requires an
operator with authority over the `drksci.com` zone.

## Workspace hostnames

The scoped UI/API view may use `<workspace>.id.drksci.com`, derived from a verified repository
binding. Hostname filtering is a UX aid and never an authority boundary. Reserve the slugs
`api`, `console`, `docs`, `idea`, `dev`, `test`, `preview`, and other platform-owned names.
Every query and token must enforce both workspace and environment, with the environment explicit in
the token and policy. Cross-workspace access requires an explicit grant.

## First operator setup

1. Create one D1 database per environment using the names in the matrix. Record each database ID
   in the deployment system, then replace only the matching placeholder in a controlled release
   copy.
2. Set the Cloudflare account outside this repository. Use repository or environment secrets named
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; never put either value in `wrangler.toml`.
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

## Deployment commands

Run these from the repository root after the worker entrypoint exists:

```sh
cd infra
npx --yes wrangler@4 deploy --env dev
npx --yes wrangler@4 deploy --env test
npx --yes wrangler@4 deploy --env preview
npx --yes wrangler@4 deploy --env prod
```

The GitHub workflow uses the same commands and references GitHub environment secrets. It requests
the GitHub OIDC permission so an operator can later replace the API-token exchange with a
Cloudflare-supported native federation action; the checked-in workflow currently uses the native
Wrangler `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secret names. It is a deployment
mechanism, not evidence that deployment has happened. A successful release includes the Worker
version, migration result, and authenticated readiness check.

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
