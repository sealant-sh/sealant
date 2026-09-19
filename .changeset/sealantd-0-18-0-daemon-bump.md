---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Needs sealantd 0.18.0 (sealant-sh/sealantd#91, #93). The repository of a capture-source workspace
gets the remotes its control plane names: `plan.get` may answer `remotes` (a name and a URL each),
and the daemon sets them after it materializes the head, at boot and at every `capture.replan`. The
daemon builds that repository itself, so until now it had none, and `git push origin` or
`git fetch origin` failed inside every captured session with "'origin' does not appear to be a git
repository". A registrar that answers no `remotes` is unchanged. The daemon also sends the reply to
`runtime.gracefulShutdown` before it exits: the Unix control frontend now joins its live
connections, where the reply used to race the process exit and the client saw its connection close.

Daemon-only, with no new API surface. `@sealant/runtime-client` and `@sealant/runtime-protocol` move
to ^0.18.0, and the baked daemon default for workspace images, the MicroVM image and the Cloudflare
bridge image is `ghcr.io/sealant-sh/sealantd:0.18.0`.
