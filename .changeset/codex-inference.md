---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Codex inference on connected accounts: `/v1/inference/respond` (and `sealant.inference.respond`) now
accepts `credentials: { codex: true | "<name>" }` and runs the exchange through the official Codex
CLI against a private per-invocation `CODEX_HOME`, on the caller's own OpenAI subscription. `model`
passes through verbatim on both arms. The rotated auth.json is read back at end of exchange and
persisted newest-wins, exactly like the workspace sync-back. Tool-less v1: caller-defined `tools`
stay claude-only (a codex exchange with tools is a 400), `maxTurns` is claude-only, and a
profile-only selection prefers the profile's claude binding before falling back to its codex
binding. Selecting both providers in one exchange is now an explicit 400.
