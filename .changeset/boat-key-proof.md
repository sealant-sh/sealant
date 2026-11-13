---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`boatAccounts.prove(boatAccountId)` runs a full check of a stored Boat account's key with a
throwaway VM: sealant starts the smallest VM, runs a command, publishes a port and saves a snapshot,
then deletes the snapshot and the VM, and answers each step as passed, refused (with Boat's reason),
not answered or not reached, with the VM starts it used and what Boat may still hold of it, which
sealant removes. It never leaves a VM or a snapshot behind for good, and a second check of the same
account while one runs is refused (`boat-proof-running`). `list()` carries each account's
`lastProof`.
