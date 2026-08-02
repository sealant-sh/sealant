---
"@sealant/api-contracts": minor
---

Claude session credentials (`kind: "credentials-json"`) stay fresh instead of expiring whenever no
workspace happens to run. Refresh was coupled solely to run-exec jobs; now the official Claude Code
CLI/Agent SDK refreshes the session on three paths and the control plane persists the rotated file
newest-wins on `claudeAiOauth.expiresAt`: inference runs the CLI against a private per-invocation
`CLAUDE_CONFIG_DIR` holding the decrypted session file (refresh at point of use; setup-token
accounts keep the env-var path), a worker sweeper refreshes any active session account expiring
within 30 minutes every 15 minutes via a minimal one-turn exchange, and the workspace sync-back now
also runs on every container teardown path (stop, expiry reap) so interactive sessions no longer
lose rotated tokens. Every considered account logs exactly one sync outcome line. The compliance
rule is unchanged: Sealant never calls Anthropic's token endpoint.
