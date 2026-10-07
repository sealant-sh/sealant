---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A process runs as a person's Linux user (Mend ADR 0016):

- `exec(argv, { user })` and `sessions.open(argv, { user })` now start the process as that user,
  through the workspace's sealantd (`exec.user`, 0.20.0-next.150 and later): their uid, groups,
  `HOME`, umask 0002, a private `TMPDIR` and `XDG_RUNTIME_DIR`, the image's person environment, and
  none of the daemon's logins. Only a person in Mend's range (a uid in 40001–49999 whose primary
  group is `mend`, never root), on a workspace whose sealantd reports `exec.user`. Anything else is
  refused before anything starts (`409`, code `user-unsupported`), the message saying why: the
  workspace's sealantd doesn't run processes as another user, the user is not in range, or it does
  not exist yet. An exec as a user whose executor does not answer the check is a `502`.
- A process as a user has its own routes: `POST /v1/workspaces/:id/exec-as-user` and
  `POST /v1/sessions/as-user` (`execWorkspaceAsUserRequestSchema`,
  `createSessionAsUserRequestSchema`, `user` required). A control plane from before them answers
  `404`, never runs the process as root; `user` on `/exec` and `/v1/sessions` is refused (`409`
  `user-unsupported`). The SDK uses them whenever `user` is set.
- The run records the user: `user` on the run resource. Nothing else of the process is stored.
- `workspace.processUser()` (and `launch.processUser` after `ready()`) reads whether a workspace
  can: `supported`, `unsupported` or `unknown`, from the sealantd of the image its latest launch
  booted. On the wire: `processUser` on every workspace read.
- `sealant.features()` reports what the control plane can do, so a client detects it instead of
  reading the version (`0.0.0` on a self-built control plane): `processUser` (now `true`),
  `dotfilesApply`, `credentialsPartialPut`, `credentialsPiOpencode` and `captureOwnerMap`. On the
  wire: the index's `features`; a feature an older control plane does not name is `false`.
