---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`sealant.boatAccounts` keeps Boat API keys beside the control plane's default one (its env key), so
a product that serves several organizations can run each organization's Boat VMs in, and bill them
to, that organization's own Boat account. `create({ label, apiKey })` checks the key with Boat by
one read-only call and stores it sealed; `list()` returns
`{ boatAccountId, label, state, createdAt, keyRotatedAt }` and never a key;
`rotateKey(boatAccountId, apiKey)` refuses a key that cannot see the account's VMs and saved images
(`reason` `boat-key-cannot-see`); `remove(boatAccountId)` refuses while the account has workspaces
whose VMs Boat may still hold (`reason` `boat-account-in-use`), and otherwise answers
`state: "removing"` while the control plane deletes the saved images it built in the account. The
HTTP routes are `POST|GET /v1/boat-accounts`, `PUT /v1/boat-accounts/:boatAccountId/key` and
`DELETE /v1/boat-accounts/:boatAccountId`.

`workspaces.create({ runtime: "boat", boatAccountId })` (`spec.runtime.boatAccountId`) runs the
workspace in that account, restarts included. Omitted, it runs in the default account, as every
workspace did before. A control plane older than the option rejects a create that sends it (its spec
is strict).
