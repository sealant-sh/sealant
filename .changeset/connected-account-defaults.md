---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A person's default connected account per provider is a choice, not the account named `default`.
`true` (`default` on the wire) resolves to it at workspace create, a credentials put and inference;
a person's first account for a provider becomes it, and existing accounts named `default` already
are. `connectedAccounts.setDefault({ provider, accountId })`
(`PUT /v1/connected-accounts/defaults/:provider`) chooses another. Disconnecting the default leaves
none chosen (`connected-account-missing`); no other account is picked. `connect()` takes `accountId`
to replace one account and `makeDefault`; without a target it replaces the only account, and with
several it fails with `reason` `connected-account-ambiguous` and `candidateAccountIds`.
`ConnectedAccount` carries `isDefault` and `credentialRevision`, and
`connectedAccounts.markInvalid(id, { revision })` marks nothing once the credential has moved on
(`outcome: "superseded"`). `providerLoginEnvNames` lists the environment names each provider's CLI
reads as a login. Feature flag: `features().connectedAccountDefaults`.
