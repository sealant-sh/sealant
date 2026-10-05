---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspaces run the sealantd prerelease 0.20.0-next.142 (`ghcr.io/sealant-sh/sealantd-next`, pinned
by digest). A capture leaves every harness login out of the harness home, including pi's, opencode's
and opencode's MCP server logins, and a restore never writes one back. A restore writes files on
every core, and a final flush reads on every core. Upload URLs carry the SHA-256 of their bytes. The
image fetches socat over HTTPS and checks it against a pinned checksum. A stable release refuses
this pin until sealantd 0.20.0 is released and pinned.
