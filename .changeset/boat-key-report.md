---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A Boat key is checked against Boat when it is stored, rotated or re-checked, and the check is kept
as a report: who the key is, which wallet it bills (personal or which organization), its permissions
and which of the ones Core needs are missing, when it expires, whether the wallet can start a VM now
and why not, its running and allowed VMs, and its saved snapshot slots. Each fact is observed, or
not observed with Boat's reason. `boatAccounts.create` takes `organization` (the Boat organization a
personal key bills, sent on every request for the account), a key that lacks a permission Core needs
is refused with `boat-key-missing-permissions` and the permissions named, `boatAccounts.check(id)`
checks a key again, and `list()` returns each account's last report and includes the install's own
key as `default`, which `rotateKey` and `remove` refuse (`boat-account-environment`). Whitespace
around a pasted key is trimmed.
