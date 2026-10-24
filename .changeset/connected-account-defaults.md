---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A person's default connected account per provider is a choice, not the account named `default`.
`true` (`default` on the wire) resolves to it at workspace create, a credentials put, inference and
a profile binding; a person's first account for a provider is named `default` and becomes it, and
existing accounts named `default` already are.
`connectedAccounts.setDefault({ provider, accountId })`
(`PUT /v1/connected-accounts/defaults/:provider`) chooses another. Disconnecting the default leaves
none chosen (`connected-account-missing`); no other account is picked. `connect()` takes `accountId`
to replace one account and `makeDefault`, and `name: "default"` replaces the chosen default; without
a target it replaces the only account, and with several it fails with `reason`
`connected-account-ambiguous` and `candidateAccountIds`. `ConnectedAccount` carries `isDefault` and
`credentialRevision`, and `connectedAccounts.markInvalid(id, { revision })` marks nothing once the
credential has moved on (`outcome: "superseded"`). The SDK sends `accountId`, `makeDefault`,
`setDefault` and a `revision` only to a control plane that reports
`features().connectedAccountDefaults`, and otherwise throws `connected-account-defaults-unsupported`
before sending anything. `@sealant/api-contracts` exports `providerLoginEnvNames`, the environment
names each provider's CLI reads as a login (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`; `OPENAI_API_KEY`, `CODEX_API_KEY`).
