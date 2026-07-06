---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Rename the product's core noun from `sandbox` to `workspace` across the public API and SDK.
"Workspace" is the honest, industry-standard name for the live, disposable environment a harness
works in — Sealant does not provide a hardened security sandbox, so the old name over-promised
containment. The `run` and `harness` nouns are unchanged.

Concretely, this changes web and API routes from `/sandboxes` to `/workspaces`, renames the SDK
surface (`sealant.sandboxes` → `sealant.workspaces`, and the `sandbox` handle to `workspace`),
switches the SSH username prefix from `sbx-` to `ws-`, adds a rename-only database migration for the
workspace tables and columns, and renames the internal `@sealant/sandboxes` package to
`@sealant/workspaces`.
