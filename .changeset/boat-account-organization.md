---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A personal Boat key is pinned when it is stored, to the wallet it bills then unless `organization`
names another, and can be pointed at another wallet afterwards without its key:
`boatAccounts.setOrganization(id, organization)` (`PUT /v1/boat-accounts/:id/organization`, an
organization's id or name, or `personal`; there is no unpin). Every object Core makes in Boat is
recorded with the wallet it was made in, and every request about it names that wallet, so a change
deletes nothing first and refuses no workspace; it is refused, with the counts, only while the
account has VMs, runs still being settled, image builds or a full check's leftovers in Boat. The key
report gains `wallets` (the wallets a personal key can bill, the active one marked) and `billing`
(`pinned` with its organization, `key-organization`, or `active-wallet` with `walletChanged`).
`BoatAccount.unreachable` names saved images Boat has in none of the key's wallets. New conflict
codes on the new route: `boat-key-organization`, `boat-account-wallet-unresolved`; a workspace
create refused for an account Core has not pinned yet carries `code`
`boat-account-wallet-unresolved`. New optional field `unsettledRuns` on a conflict.
