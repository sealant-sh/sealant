---
"@sealant/sdk": minor
---

The control plane fails closed (no SDK surface change; the packages ride the release train). The API
now refuses to start when `SEALANT_SERVICE_KEYS` is unset. Missing configuration used to mean "serve
every `/v1` route to anyone who can reach the port".

- The one exception is explicit and for development: `SEALANT_ALLOW_OPEN_API=true`, honoured only
  when `NODE_ENV` is not `production`. Every published image sets `NODE_ENV=production`. `pnpm dev`
  sets the exception for the API it starts on loopback.
- The web app is now a service principal: it presents `CORE_API_SERVICE_KEY` server-side.
  `install.sh` generates `SEALANT_WEB_SERVICE_KEY`, and the self-host compose file hands it to the
  web app and prepends it to the API's `SEALANT_SERVICE_KEYS`. **An existing self-host install must
  re-run `install.sh` (or add `SEALANT_WEB_SERVICE_KEY` to `.env`) before upgrading**; compose says
  so when it is missing.
- Helm chart 0.3.0: `SEALANT_SERVICE_KEYS` is a required key of the secret, and the web app reads
  `SEALANT_WEB_SERVICE_KEY` from it. **Add both to the secret before upgrading**; the web key must
  be one of the service keys.
- The session surface (`/v1/sessions/*`, `/v1/workspaces/:id/forward`) no longer reads "no
  `Authorization` header" as a trusted caller. The transport gate admits that surface on any bearer,
  including a `?token=` the handlers did not read, so a request with a junk `?token=` and an
  asserted `ownerUserId` was served as that owner. It is now refused, and the output stream accepts
  a user access token as `?token=`.
- `POST /v1/github/webhooks` passes the transport gate on its own: GitHub cannot present a bearer,
  and the handler verifies the delivery's signature. With service keys set it was answered 401
  before that check could run.
- A service key is read from `?token=` on the session surface only, where a browser cannot set a
  header. It is no longer accepted from a URL on any other route.
- The web server refuses to start in production without `CORE_API_SERVICE_KEY`.
