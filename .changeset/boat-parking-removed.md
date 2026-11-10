---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Boat snapshot parking is removed. Workspace details no longer carry `captureDrain.preservation`, and
`@sealant/api-contracts` no longer exports `workspacePreservationSchema` or `WorkspacePreservation`;
no tagged release carried them. Stopping a Boat workspace is the final drain, then the VM's removal.
A VM whose final drain is incomplete is kept until the drain completes or the owner discards it, and
resuming is a new workspace from the project snapshot and the captured worktree.
`captureDrain.retained`, with `retained.recoverable`, is unchanged for every runtime.
