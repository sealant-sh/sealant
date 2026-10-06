---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A person's logins can be put into one home of a running workspace:
`workspace.credentials.put({ home, onBehalfOf, uid?, gid?, claude?, codex?, github? })`,
`POST /v1/workspaces/:id/credentials`. Accounts resolve as at create (`true` is the account named
`default`) and are read under the home's lock; `null` removes that provider's login from the home.
Core writes copies (no refresh token; a Claude setup token as its credentials file) owned by the
home's owner, mode `0600`, keeps them refreshed there, and writes GitHub as
`<home>/.config/gh/hosts.yml`. With `uid` and `gid` a home that does not exist yet is made for them.
A home holds one person's logins until it is released: a put naming anyone else is refused
(`409 home-held`), and `/root` takes only the workspace owner's.
`workspace.credentials.release(home)` (`DELETE`) removes the files and the record;
`workspace.credentials.list()` (`GET`) lists the homes. Every write into a home is fenced in the
executor, under a lock there, so a late write from an earlier hold never lands. A write that waits
too long answers `409 home-busy` (retryable). Only a service key may call these.
