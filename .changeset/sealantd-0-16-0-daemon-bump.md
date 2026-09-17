---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Needs sealantd 0.16.0 (sealant-sh/sealantd#82, #83): a daemon-only release where every PUT URL the
capture executor mints is bound to the length the PUT then sends — the single-key fallback mint
declared `0` before, which a registrar that signs an upload for an exact content length cannot serve
— and where `plan.get` may name `sources`, gzipped archives the daemon lays down beside the worktree
at boot and at every `capture.replan`, keyed by content and refused if they would land inside the
worktree. That is how a control plane gets a directory beside the repository in a capture-source
workspace, which mounts nothing from the host. No new API surface here: `@sealant/runtime-client`
and `@sealant/runtime-protocol` move to 0.16.0, and the baked daemon default for workspace images,
the MicroVM image and the Cloudflare bridge image is now `ghcr.io/sealant-sh/sealantd:0.16.0`.
