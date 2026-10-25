---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A Claude or Codex connected account can be an API key. `connect()` takes an Anthropic API key
(`sk-ant-api…`), an OpenAI key (`sk-…`), or a Codex `auth.json` whose login is a key, and stores an
account of kind `api-key` holding the key alone. A key in an `auth.json` is checked as a bare key
is: an Admin key, a key pasted under the other provider, and a broken or truncated key are refused
with the reason, and so is an `auth.json` holding both a ChatGPT login and a key without an
`auth_mode` saying which. An `auth_mode` decides first.
`connect({ login: "subscription" | "api-key" })` refuses a secret of the other class before anything
is stored ("That is a Claude subscription login, not an API key."). Without `accountId` or `name`, a
connect replaces the only account of the secret's login class, read from each stored login, so a key
added beside a subscription never replaces it: with none of that class it makes one named `api-key`
or `subscription`, and with several it fails with `connected-account-ambiguous`. The default moves
only as before. `ConnectedAccount.login` is `{ kind: "subscription" }` or
`{ kind: "api-key", suffix }` for Claude and Codex accounts, and
`connectedAccounts.listWithHistory()` answers the accounts with `hasApiKeyHistory`: whether the
owner ever stored a key, which a later replace with a subscription or an archive does not forget. A
control plane reports all of this as `features().connectedAccountLoginClass`; the SDK sends `login`
only to one that does, and otherwise throws `connected-account-login-class-unsupported` before
sending anything.

A Codex key runs as the file `codex login --with-api-key` writes, at the Codex slot of a home, a
launch and inference, where a key-only `auth.json` went before; Codex accounts stored as such an
`auth.json` are stored again as the key when the control plane starts. Workspace create and a launch
refuse a Claude key with `connected-account-unsupported`; a profile bound to one skips it at create,
as it skips an account that needs reconnecting. `InferenceConflictError` now carries a `code`.
Nothing refreshes a key, writes a login read back from a workspace over one, or pushes a refreshed
subscription into a workspace that was launched with a key. The control plane's traces, logs and
error reports replace a provider key by its shape, in a request's URL too; the worker's logs are not
covered.
