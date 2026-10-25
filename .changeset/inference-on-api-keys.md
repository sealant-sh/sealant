---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Inference runs on a Claude API key. The control plane writes the key to a private file and the
official Claude Code CLI reads it through an `apiKeyHelper`; the key is never in the CLI's
environment or arguments. Workspace create and a launch still refuse a Claude key with
`connected-account-unsupported`.

`inference.respond()` takes `allowedLogin: "subscription" | "any"` (default `any`). With
`subscription`, an account holding an API key is refused before the provider is asked: a
`SealantApiError` with `reason` `login-not-allowed`. The check reads the account the selection
resolved to, so `claude: true` pointing at a key is refused too. The SDK sends `allowedLogin` only
to a control plane that reports `features().inferenceAllowedLogin`, and otherwise throws
`inference-allowed-login-unsupported` before sending anything.

An exchange keeps one `receipt`, `{ accountId, revision, login }`, from its start. Every
continuation runs on it, even after the account is reconnected. `InferenceResponse.receipt` carries
it, and so does `SealantApiError.receipt` on an error after the account was resolved.

A key turns invalid only when the provider answers with an HTTP 401 status, never on an error's
words: `reason` `connected-account-refused` ("Your Claude API key ····a1b2 was refused by Anthropic.
It is marked invalid; connect a new key."). A 401 from a key replaced after the exchange started
marks nothing and answers `connected-account-superseded`. Subscriptions keep their behaviour.

Inference does not mark a refused key invalid in two cases. The Codex CLI reports a failed turn only
in words, so a refused Codex key is never marked invalid. A Claude key is not marked when the CLI
reports the refusal without Anthropic's 401 status. In both cases the error says the key "was not
accepted" and "is not marked invalid": if you revoked the key, connect a new one; otherwise check
the key with the provider.

Every Claude exchange runs with a private home of its own that holds only that exchange's login,
removed when the CLI exits, so a refused setup token no longer falls back to the login of the user
running the control plane.
