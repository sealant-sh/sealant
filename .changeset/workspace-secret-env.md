---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Secret environment variables on `workspaces.create({ secretEnv })` — the transient secret channel.

The map is validated by the exported `parseWorkspaceSecretEnv` (same grammar/bounds as `env`, same
platform-owned reservations, but secret-shaped names allowed; connected-account names stay
reserved), rides the create request beside the spec, is sealed with the install's credential key on
the build job, decrypted by the worker just before launch, staged as a `0600` boot file the
workspace daemon (sealantd ≥ 0.10.0) reads once, removed from the host the moment the workspace is
ready, and cleared from the job row when the launch settles. It never enters the blueprint, the
attempt snapshot, `docker run` argv, container env, or any read API; every value is masked in
captured process output; every process the platform starts in the workspace inherits it, winning
over `env` and container env for the same name. Platform-side restarts run without secret env by
design. The workspace image now bakes sealantd 0.10.0.
