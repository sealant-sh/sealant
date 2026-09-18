---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Credentials are bound to the destination they were issued for.

- A client-supplied `authRef` is now checked against its source URL: the installation token is
  minted only for `https://<GitHub host>/<owner>/<name>[.git]` of the repository the ref stands for.
  A grant on one installation could previously attach its token to a clone of any URL. A restart
  checks the recorded spec the same way and answers 409 when it names another destination, and
  server-minted sources use the GitHub host the install talks to, so reruns pass on GitHub
  Enterprise Server.
- `WorkspaceCaptureSource.transport` (`plaintext`, `channelCaPem`, `objectCaPem`) tells the
  workspace daemon how to dial the session channel and its object URLs. It needs a daemon with the
  capture transport policy (sealant-sh/sealantd#86); an older daemon ignores it. Without `transport`
  that daemon requires HTTPS with a publicly verifiable certificate and refuses to boot otherwise,
  so **a launcher that reaches its channel over plain HTTP on a private network must now send
  `transport: { plaintext: true }`**. The Cloudflare runtime does not support `transport`, and the
  control plane says so at create.
- The control plane refuses a capture endpoint that is not `http(s)`, embeds credentials, is plain
  HTTP beyond loopback without `transport.plaintext`, or falls outside the operator's
  `SEALANT_CAPTURE_ALLOWED_ENDPOINTS`. `SEALANT_CAPTURE_REFUSE_PLAINTEXT=true` vetoes plain HTTP
  whatever a launcher states.
