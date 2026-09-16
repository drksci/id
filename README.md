# drksci / id

A minimal identity, delegation, and approval gateway surface for `drksci/id`.
The runtime is intended to be deployed as the single Cloudflare Worker
`id-worker`; durable state is mirrored to `drksci/id-data`.

This starter is static and dependency-free. The public surface is in `public/`.

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
