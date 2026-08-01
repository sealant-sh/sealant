---
"@sealant/api-contracts": minor
---

Claude connected accounts accept a second credential shape: the full Claude Code session credentials
file (the JSON contents of `~/.claude/.credentials.json`) pasted by the operator. Session-file
accounts (`kind: "credentials-json"`) are injected into workspaces as a
`$HOME/.claude/.credentials.json` file with mode 600 — mirroring codex's auth.json — instead of the
`CLAUDE_CODE_OAUTH_TOKEN` env var, present as the user's subscription (Anthropic treats setup tokens
as API auth, which credit-gates some models interactively), and are synced back after runs
newest-wins on `claudeAiOauth.expiresAt`. Existing `sk-ant-oat01-…` setup-token accounts keep
working unchanged; reconnecting can switch shapes in place.
