---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A person's dotfiles applied as their Linux user into their home of a running workspace (Mend's
per-person layout):

- `workspace.dotfiles.apply({ user, home, repository?, archives? })` and
  `POST /v1/workspaces/:id/dotfiles` take a create's dotfiles sources (a repository cloned with no
  credential, `https://` only, and up to 4 archives) and apply them with the workspace daemon's
  applier (chezmoi, stow or copy), every command as the user, then each tree's `./install.sh` as the
  user. `user` must exist and must not be root or in root's group, and `home` must be its passwd
  home; nothing is written into another home.
- The call resolves once every file is applied, with `bootstrap` running as the person (or `null`);
  `bootstrap.wait()` resolves with its exit code and output, read from the run the apply is recorded
  in (`harnessId` `dotfiles`). A bootstrap running past 30 minutes is stopped and the run fails.
- Refusals, nothing applied: `409` `dotfiles-user-unsupported` (the workspace's sealantd cannot
  apply as a user), `user-unknown`, `user-root`, `home-mismatch`, `home-unusable`,
  `workspace-not-running`; `400` for root, a home under `/workspace`, or nothing to apply. A failed
  apply rejects with `dotfiles_failed` and the daemon's words.
- Archives are staged root-only in the workspace over stdin and removed once the daemon answers; no
  archive's bytes reach a job row or the run's record.
