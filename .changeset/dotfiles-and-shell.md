---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Dotfiles and shell: `workspaces.create({ shell: "zsh", dotfiles: { repository, archives } })`.
`shell` installs the login shell and switches to it so shell dotfiles take effect. `dotfiles`
accepts a repository the platform clones (manager auto-detected: chezmoi / stow / copy, optional
bootstrap) and/or caller-resolved archives — gzipped tars applied at boot through the same manager
dispatch, the shape for dotfiles resolved host-side with the caller's own ssh identity or scanned
from the home directory. The repository applies first, then archives in order; everything applies
before the workspace reports ready, and a failing apply fails the launch loudly. Dotfiles ref
handling no longer assumes `main` (absent = the remote's default branch), chezmoi is provisioned on
every managed family (on Ubuntu 24.04 from the pinned upstream release — the archive has no
package), and client-supplied `authRef`s are now validated at create against the caller's GitHub
installation grants. Not supported with `baseImage`.
