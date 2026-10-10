---
"@sealant/sdk": patch
---

An image whose git does not trust the worktree no longer reads as able to run the per-person layout.
The image probe now records whether git trusts `/workspace/repo` whoever owns it (`safe.directory`
lists `*` or that path). Without that trust, `personLayout` is `unsupported`, missing
`git-safe-directory`. Under an owner map the worktree is a person's and `.git` is root's, so
sealantd's own restore failed at boot ("capture materialize failed: /workspace/repo is not a git
repository"). A custom base that cannot write `/etc/gitconfig` at build now falls back to the shared
layout instead. An image probed before this is `unknown` until it is built again. The probe script
is part of every image, so every image is built once more.
