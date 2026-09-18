---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A Claude credentials file is stored as its `claudeAiOauth` grant alone. The file Claude Code writes
is `{ claudeAiOauth, mcpOAuth }`, and the `mcpOAuth` half holds refresh tokens for whichever MCP
servers the person authorized on their own machine. Connecting stored the document whole, so those
third-party tokens reached the control plane's database and every workspace that attached the
account; a rotated file read back by the sync-back worker could bring them back again.

Both ends now narrow: `POST /v1/connected-accounts` seals the grant and records the sections it left
out as `metadata.droppedSections`, and the workspace sync-back drops an `mcpOAuth` section a
rotation hands back. Nothing about the grant changes, so a workspace's Claude Code still has the
refresh token it rotates with, and a document with nothing to drop is stored byte for byte as it
arrived. A client that narrows before sending sees no difference; one that does not is stored narrow
anyway.
