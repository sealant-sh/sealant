---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspaces run the sealantd prerelease 0.20.0-next.155 (`ghcr.io/sealant-sh/sealantd-next`, pinned
by digest). A capture leaves every harness login out of the harness home, including pi's, opencode's
and opencode's MCP server logins, under every person's saved directory too, and a restore never
writes one back. A restore gives each person's saved directory to their uid and the worktree to the
group. Executions, sessions and dotfiles can run as a given user, and a per-person executor leaves
no-new-privileges unset so every person's sudo works. A person's dotfiles are unpacked by root
outside every home and written as the person, so a link they planted cannot redirect them, and an
archive that unpacks to more than 256 MiB, or 64 MiB in one file, is refused. The daemon runs an
exec, a session or a dotfiles apply only as one of the owner map's people or a person in Mend's
reserved range (a uid in 40001-49999 whose primary group is 40000, so a person who joins after boot
runs), checking the passwd entry it resolves itself, and refuses root, root's group and anyone
outside the range. A restore writes files on every core, and a final flush reads on every core.
Upload URLs carry the SHA-256 of their bytes. The image fetches socat over HTTPS and checks it
against a pinned checksum. A process's `process.started` event carries the count and UTF-8 lengths
of its arguments (`argCount`, `argLengths`), never their text, so no argument reaches an event
subscriber or the daemon's spool, and spool segments an older daemon wrote are rewritten without it.
A failed lifecycle step is logged by its step, program and argument sizes, and a clone URL without
its credentials. A stable release refuses this pin until sealantd 0.20.0 is released and pinned.
