---
"@sealant/sdk": patch
---

`workspaces.create()` without a `ref` now really does use the repository's default branch, as the option's docs always claimed. The SDK no longer lowers a missing `ref` to `"main"`, the blueprint schema keeps the workspace source `ref` truly optional instead of defaulting it, and the docker runtime adapter omits `SEALANT_WORKSPACE_REPO_REF` entirely when unset so sealantd's plain `git clone` resolves the remote HEAD. Previously every repository whose default branch isn't `main` (e.g. `master`) failed workspace boot with `fatal: Remote branch main not found in upstream origin`. Requires sealantd ≥ 0.5.1 in the workspace image for the no-ref path.
