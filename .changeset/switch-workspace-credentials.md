---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A person's logins can be put into one home of a running workspace:
`workspace.credentials.put({ home, onBehalfOf, claude?, codex?, github? })`,
`POST /v1/workspaces/:id/credentials`
(`{ ownerUserId, onBehalfOfUserId, home, claude?, codex?, github? }`). Accounts resolve as at create
(`true` is the account named `default`); `null` removes that provider's login from the home. Core
writes copies (no refresh token, as a launch does) owned by the home's owner, mode `0600`, keeps
them refreshed there, and writes GitHub as `<home>/.config/gh/hosts.yml`. A home holds one person's
logins until it is released: a put naming anyone else is refused (`409 home-held`).
`workspace.credentials.release(home)` (`DELETE`) removes the files and the record;
`workspace.credentials.list()` (`GET`) lists the homes. A home is an absolute path outside
`/workspace` that exists and is reached without a symbolic link (`409 home-unusable` otherwise).
Puts, releases and refresh pushes into one home run under one row lock. Only a service key may call
these.
