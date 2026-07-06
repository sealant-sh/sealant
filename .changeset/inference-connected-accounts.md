---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Inference on connected accounts. New `inference` contract group: `POST /v1/inference/respond` runs
short, tool-calling inference loops on the caller's own subscription — the server resolves the
connected-account reference (same shape as workspace creation), decrypts, and invokes the OFFICIAL
Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN` (never raw model-API calls on stored credentials,
per the connected-accounts design's hard constraint). Caller-defined JSON-schema tools are exposed
to the model verbatim; tool calls park server-side and the CALLER executes them, posting results
back in a multi-turn session loop. Structured output rides the agent SDK's native json_schema output
format. SDK: `sealant.inference.respond(...)` (new exchange or continuation) + `inferenceRespondOp`
in the Effect core. Usage is attributed per account (`last_used_at`), and a live auth rejection
marks the account invalid. Claude accounts only; Codex inference is a stated follow-up.
