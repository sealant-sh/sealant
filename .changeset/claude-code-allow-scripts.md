---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspace images install claude-code with `--allow-scripts=@anthropic-ai/claude-code`: recent npm
blocks install scripts by default, and claude-code's postinstall is what links its native binary —
without it every `claude` launch died with "claude native binary not installed" once the v0.20.0
plan-hash rotation rebuilt images. Codex was unaffected (no install script). Older npm treats the
unknown config as a warning; plan hashes rotate once so broken images rebuild. No API surface
changes; this release exists to rebuild workspace images.
