---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

`workspace.credentials.put()` and `release()` keep every login out of every process's arguments and
environment inside the workspace. The home script used to start `env -i … p0="$p0" … setpriv …`, so
each login was in `env`'s arguments for an instant and in the environment of the person's shell and
every command it ran (`/proc/<pid>/environ`), including the launch's own write into a
`credentialsHome` and a refresh's rewrite. The logins now travel on standard input at every step.

A Claude, Codex or GitHub login file in the home that is not a regular file, or that has another
hard link, is refused with `409` `home-unusable` naming the file, and nothing is written into it.
