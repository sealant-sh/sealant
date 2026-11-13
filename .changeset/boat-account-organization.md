---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A stored Boat account can be pointed at the wallet it bills after it is connected, without its key:
`boatAccounts.setOrganization(id, organization)` (`PUT /v1/boat-accounts/:id/organization`) takes an
organization's id or name, `personal`, or null to name none. The key report gains `wallets` (the
wallets a personal key's Boat account can bill, the active one marked) and `billing` (`pinned` with
its organization, `key-organization` for an organization's key, or `active-wallet`, with
`walletChanged` when the wallet it bills moved since an earlier report). A change is refused, with
the counts, while the account has VMs, runs still being settled, image builds or a full check's
leftovers in Boat. An account with saved images answers `organizationChange` and keeps billing the
old wallet until Core has deleted them there. A change where everything the account holds is in the
new wallet already is a relabel: nothing is deleted. For an account with no pin, Core finds each
saved image under the wallets its key can bill and deletes it there, refusing
`boat-account-images-unlocated` for one it cannot find; meanwhile creates, key rotations and full
checks are refused `boat-account-changing-organization`. An organization's key is refused
`boat-key-organization`. New optional fields: `BoatAccount.organizationChange`,
`BoatKeyReport.wallets` and `.billing`, and `unsettledRuns` on a conflict.
