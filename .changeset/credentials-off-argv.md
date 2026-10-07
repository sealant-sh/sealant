---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

`workspace.credentials.put()` and `release()` keep every login out of every process's arguments and
environment inside the workspace. The home script used to start `env -i … p0="$p0" … setpriv …`, so
each login was in `env`'s arguments for an instant and in the environment of the person's shell and
every command it ran (`/proc/<pid>/environ`), including the launch's own write into a
`credentialsHome` and a refresh's rewrite. The logins now travel on standard input at every step,
and a shell's temporary file for one never lands where the workspace's `TMPDIR` points.

A Claude, Codex or GitHub login file in the home that is not a regular file, or that has another
hard link, is refused with `409` `home-unusable` naming the file, and nothing is written into it. A
`partial: true` put leaves such a provider out with `reason` `login-file-unusable` and writes the
rest, as it already did for pi's and opencode's files, and a refresh does the same for the file it
cannot write, so one bad file never keeps the home's other logins stale.
