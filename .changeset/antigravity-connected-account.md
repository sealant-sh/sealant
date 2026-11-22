---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Add `"antigravity"` as a connected-account and workspace-home credential provider for personal
Google OAuth logins (`~/.gemini/antigravity-cli/antigravity-oauth-token`). Workspaces receive a
stripped access-token-only copy without `refresh_token`, while the worker keeps the stored login
fresh via `agy models` and pushes rotated copies to running workspaces and homes.
