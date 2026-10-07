---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A person's dotfiles applied into their home of a running workspace (Mend's per-person layout):

- `workspace.dotfiles.apply({ onBehalfOf, user, home, repository?, archives? })` and
  `POST /v1/workspaces/:id/dotfiles` (service key only) take a create's dotfiles sources (a
  repository cloned with no credential, `https://` only and never with a credential in its URL, and
  up to 4 archives) and apply them with the workspace daemon's applier: the clone, chezmoi and stow
  as the user, then each tree's `./install.sh` as the user. `user` must exist and must not be root
  or in root's group, `home` must be its passwd home, and a home whose logins another person holds
  is refused (`home-held`). The run records `onBehalfOf` (`metadata.dotfiles`).
- Known limit: the daemon still unpacks archives and runs the `copy` manager as root inside the
  home, following links there, until its fix lands.
- The call resolves once every file is applied, with `bootstrap` running as the person (or `null`);
  `bootstrap.wait()` resolves with its exit code and output, read from the run the apply is recorded
  in (`harnessId` `dotfiles`). A bootstrap running past 30 minutes is stopped and the run fails.
- Refusals, nothing applied: `409` `dotfiles-user-unsupported` (the workspace's sealantd cannot
  apply as a user), `user-unknown`, `user-root`, `home-mismatch`, `home-unusable`, `home-held`,
  `workspace-not-running`; `400` for root, a home under `/workspace`, a URL with a credential, or
  nothing to apply; `403` without a service key. A failed apply rejects with `dotfiles_failed` and
  the daemon's words.
- Archives are staged root-only in the workspace over stdin and removed once the daemon answers; no
  archive's bytes reach a job row or the run's record.
