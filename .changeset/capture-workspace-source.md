---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A `capture` workspace source (sealantd ADR-0015):
`workspaces.create({ source: { kind: "capture", endpoint, worktreeId, token } })` launches a
workspace that mounts nothing and clones nothing — the daemon materialises the worktree from the
session channel onto the executor's own disk and ships captures back, so a session can run where no
host path exists and outlive any one executor. The create request carries the credential as
`captureToken`; the control plane seals it beside `secretEnv` and delivers it through the same boot
file as `SEALANT_CAPTURE_TOKEN`, never into the blueprint or a read response. A capture workspace
cannot be restarted in place. Runtime support: Docker (no workspace bind), Kubernetes (`emptyDir`
workspace root, no store claim) and Cloudflare (kept alive while live; planned stops now send
SIGTERM through `stop()` so the daemon can flush, with `destroy()` reserved for fencing).
