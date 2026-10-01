---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Claude and Codex logins have one refresher. Workspaces and inference calls get a copy that cannot
refresh (Claude's file without its refresh token, Codex's `auth.json` with a placeholder), so no
copy can rotate, spend or revoke the stored login. The worker refreshes each login through the
official CLI (Claude an hour before its access token expires, Codex a day before, one refresh per
login at a time across workers) and writes the new copy into every running workspace launched with
it; Claude Code and Codex pick it up without a restart. A refused refresh marks the account invalid.
Workspaces launched before this still have their rotations read back until they end.
