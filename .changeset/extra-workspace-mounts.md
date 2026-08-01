---
"@sealant/sdk": minor
---

Workspace creation accepts additional caller-owned mounts beside the primary source:
`workspaces.create({ mounts: [{ hostPath, mountPath, readOnly }] })`. Extra mounts are read-only by
default and bind at a container path outside the working directory (e.g. `/workspace/ref/effect`) —
they widen what the workspace can see, not where its work product lands. Host paths ride the same
operator allowlist as mount sources (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`); the control plane rejects
container paths overlapping the working directory or the daemon control dir. Like the primary mount,
extra mount paths are caller-owned — never reprovisioned, never cleaned.
