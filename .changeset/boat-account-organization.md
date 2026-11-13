---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A personal Boat key is pinned when it is stored, to the wallet it bills then unless `organization`
names another, and can be pointed at another wallet afterwards without its key:
`boatAccounts.setOrganization(id, organization)` (`PUT /v1/boat-accounts/:id/organization`, an
organization's id or name, or `personal`; there is no unpin). Every object sealant makes in Boat is
recorded with the wallet it was made in, and every request about it names that wallet, so a change
waits for nothing and refuses no workspace: what the account makes next is made in the new wallet,
and what it made before stays in its own. An account connected before pins is pinned by the worker
to the wallet its key bills now; until then it starts nothing new (a workspace naming it is refused
with `code` `boat-account-wallet-unresolved`), its running sessions are not touched, and a rotation
pins it. The key report gains `wallets` (the wallets a personal key can bill, the active one marked)
and `billing` (`pinned` with its organization, `key-organization`, or `active-wallet` with
`walletChanged`). `BoatAccount.unreachable` and the new `BoatInstallKey.unreachable` name what a key
made before sealant recorded wallets that Boat has in none of its wallets: `savedImages`, and the
new optional `runs` and `builds`. New conflict code on the new route: `boat-key-organization`.
sealant now requires the key permission `account.read` (Boat's `/me`, limits and organization
discovery): without it sealant cannot see which wallet a key bills, and refuses to connect it
(`boat-key-missing-permissions`).
