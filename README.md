# drksci / id

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/drksci/id)

A minimal identity, delegation, and approval gateway surface for `drksci/id`.
The runtime is intended to be deployed as the single Cloudflare Worker
`id-worker`; durable state is mirrored to `drksci/id-data`.

This starter is static and dependency-free. The public surface is in `public/`.

## One-click deploy (your own Cloudflare account)

Click the button above, or open
<https://deploy.workers.cloudflare.com/?url=https://github.com/drksci/id>, authorize
Cloudflare for GitHub, and this repository is built and deployed as a Worker in your
own account. You get a running instance on its `*.workers.dev` URL immediately: no
account ID, database ID, domain, or secret to fill in first.

`wrangler.jsonc` at the repository root is the template contract for that flow. It is
generic on purpose and contains none of this repository's operator values. What runs
straight away:

- the static discovery and documentation shell in `public/` (`/`, `/docs/`, `/catalog/`,
  `/idea/`, `/onboarding/`, `/feedback/`, `/carte/`, `/assist/`, `/.well-known/*`)
- `GET /healthz`, which returns `{"status":"ok"}`

What is deliberately not enabled, because it needs resources only you can create:

- **Durable state.** `GET /readyz` reports not ready and every stateful route under
  `/api/v1/*` fails closed until a D1 database exists. Create one
  (`npx wrangler d1 create id-data`), apply `migrations/`
  (`npx wrangler d1 migrations apply id-data --remote`), then uncomment the
  `d1_databases` block in `wrangler.jsonc` and paste your own database ID.
- **Authentication.** An unauthenticated deployment approves nothing. Put Cloudflare
  Access in front of it and set the access variables before any approval route is used.
  See [`infra/README.md`](infra/README.md) for the full secret and Access list.

Develop against the same contract locally:

```sh
npx wrangler dev --config wrangler.jsonc
```

## Deploying this repository (operator path)

The operator deployment is separate from the public template and uses
`infra/wrangler.toml` with explicit D1 IDs rendered from GitHub Environment variables.
One click deploys or updates it: **Actions → Deploy id-worker → Run workflow**, choosing
`dev`, `test`, `preview`, or `prod`. Pushes to `main` that touch the Worker, migrations,
or `public/` deploy `prod` automatically. The full setup, environment matrix, readiness
checks, and rollback procedure are in [`infra/README.md`](infra/README.md).

## Local preview

```sh
python3 -m http.server 8080 --directory public
```

Open <http://localhost:8080/>. No secrets are needed locally. These pages
provide discovery and documentation only until a gateway is configured.

## Notification contract

Production may optionally use Web Push with VAPID through the Worker and a
Durable Object. Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
`VAPID_SUBJECT` only in the deployment secret store. If push is unavailable,
fall back to Cloudflare Access authentication and OTP for the approved
operator, opening an authenticated approval URL.

Notifications never approve requests. They only open the approval page, where
the operator confirms the exact resource, scope, environment, and expiry.
