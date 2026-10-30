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
resolved to, so `claude: true` pointing at a key is refused too, and so is a Codex auth.json that
holds a key. A refusal spends no launch. The SDK sends `allowedLogin: "subscription"` only to a
control plane that reports `features().inferenceAllowedLogin`, and otherwise throws
`inference-allowed-login-unsupported` before sending anything; `any` is what an older control plane
does anyway.

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
accepted" and "is not marked invalid", followed by the CLI's own words: if you revoked the key,
connect a new one; otherwise check the key with the provider.

Every Claude exchange runs with a private home of its own that holds only that exchange's login,
removed when the CLI exits, so a refused setup token no longer falls back to the login of the user
running the control plane. The Claude and Codex CLIs get an environment built from nothing but the
host's path, temp dir, locale and proxy settings: a cloud-provider switch, a base URL, custom
headers or a secret in the control plane's environment no longer reaches them. A failed Codex turn
now answers with the CLI's own error words, redacted, where it answered with the CLI's log lines.

Inference redacts the login's secrets and key-shaped values from everything it returns, property
names and tool names included, and from every error, an account name or selection included. A
continuation that names an unknown or repeated `toolCallId` delivers none of its results and keeps
the exchange, so the same batch with the right ids continues it.
