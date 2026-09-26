---
title: Workspace Packages
description:
  The package ids a workspace blueprint may ask for, and what each one installs on every managed OS
  family.
---

A blueprint names packages by id in `tooling.packages`. On a managed OS family (`fedora`, `arch`,
`ubuntu`, `nix`) the id is looked up in Sealant's package catalog, and the image build installs what
the catalog says for that family. An id the catalog does not know is refused when the workspace is
created (`400`, naming the id and the catalog), not minutes later as a failed build. A custom base
image (`target.os.family: custom`) takes any name its own package manager knows.

Three kinds of entry:

- **A repository package**, in the family's own name. This is the first choice.
- **A pinned upstream release**, where the family's repositories have no package, or lag the
  architecture (Arch Linux ARM carries no `mise`). The build downloads the archive for the machine's
  architecture, checks its SHA-256 against the pinned value before unpacking, and installs the
  binaries to `/usr/local/bin` (a zsh plugin's script to its own directory under
  `/usr/local/share`). The version and the checksum move together, by pull request to Sealant.
- **npm**, for a tool a family does not package but npm does (`pnpm` on Ubuntu).

Where a repository installs a binary under another name, the build links the name the blueprint
asked for (`fd` for Debian's `fdfind`, `bat` for its `batcat`).

Every entry was built and run on every family, on ARM64 Lambda MicroVMs, on 2026-09-21, except the
shell prompt's six (`starship`, `direnv`, `eza` and the three zsh plugins), added on 2026-09-26:
those were built from the catalog in x86_64 containers of every family, and their ARM64 packages
checked in each family's repositories.

| Package                        | fedora                    | arch                           | ubuntu                     | nix                            |
| ------------------------------ | ------------------------- | ------------------------------ | -------------------------- | ------------------------------ |
| `bash`                         | `bash`                    | `bash`                         | `bash`                     | `bash`                         |
| `bat`                          | `bat`                     | `bat`                          | `bat`                      | `bat`                          |
| `bubblewrap`                   | `bubblewrap`              | `bubblewrap`                   | `bubblewrap`               | `bubblewrap`                   |
| `chezmoi`                      | `chezmoi`                 | `chezmoi`                      | `curl` `ca-certificates`   | `chezmoi`                      |
| `curl`                         | `curl`                    | `curl`                         | `curl`                     | `curl`                         |
| `direnv`                       | `direnv`                  | `direnv`                       | `direnv`                   | `direnv`                       |
| `eza`                          | `eza`                     | `eza`                          | `eza`                      | `eza`                          |
| `fd`                           | `fd-find`                 | `fd`                           | `fd-find`                  | `fd`                           |
| `fd-find`                      | `fd-find`                 | `fd`                           | `fd-find`                  | `fd`                           |
| `fish`                         | `fish`                    | `fish`                         | `fish`                     | `fish`                         |
| `fzf`                          | `fzf`                     | `fzf`                          | `fzf`                      | `fzf`                          |
| `git`                          | `git`                     | `git`                          | `git`                      | `gitMinimal`                   |
| `github-cli`                   | `gh`                      | `github-cli`                   | `gh`                       | `gh`                           |
| `htop`                         | `htop`                    | `htop`                         | `htop`                     | `htop`                         |
| `jq`                           | `jq`                      | `jq`                           | `jq`                       | `jq`                           |
| `lazygit`                      | release 0.65.1            | `lazygit`                      | release 0.65.1             | `lazygit`                      |
| `mise`                         | release 2026.9.12         | release 2026.9.12              | release 2026.9.12          | `mise`                         |
| `neovim`                       | `neovim`                  | `neovim`                       | `neovim`                   | `neovim`                       |
| `nodejs`                       | `nodejs` `npm`            | `nodejs` `npm`                 | `nodejs` `npm`             | `nodejs`                       |
| `pnpm`                         | `nodejs` `npm` `pnpm`     | `nodejs` `npm` `pnpm`          | `nodejs` `npm`, npm `pnpm` | `nodejs` `pnpm`                |
| `python`                       | `python3`                 | `python`                       | `python3`                  | `python3`                      |
| `ripgrep`                      | `ripgrep`                 | `ripgrep`                      | `ripgrep`                  | `ripgrep`                      |
| `starship`                     | release 1.26.0            | `starship`                     | release 1.26.0             | `starship`                     |
| `stow`                         | `stow`                    | `stow`                         | `stow`                     | `stow`                         |
| `tar`                          | `tar`                     | `tar`                          | `tar`                      | `gnutar`                       |
| `tmux`                         | `tmux`                    | `tmux`                         | `tmux`                     | `tmux`                         |
| `uv`                           | `uv`                      | `uv`                           | release 0.12.17            | `uv`                           |
| `zsh`                          | `zsh`                     | `zsh`                          | `zsh`                      | `zsh`                          |
| `zsh-autosuggestions`          | `zsh-autosuggestions`     | `zsh-autosuggestions`          | `zsh-autosuggestions`      | `zsh-autosuggestions`          |
| `zsh-history-substring-search` | release 1.1.0             | `zsh-history-substring-search` | release 1.1.0              | `zsh-history-substring-search` |
| `zsh-syntax-highlighting`      | `zsh-syntax-highlighting` | `zsh-syntax-highlighting`      | `zsh-syntax-highlighting`  | `zsh-syntax-highlighting`      |

A zsh plugin is a script to source, and each family puts it somewhere else. On nix the profile is
`/root/.nix-profile`, a link to `/nix/var/nix/profiles/default`.

| Plugin script                      | fedora, ubuntu                                                                   | arch                                                                                   | nix                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `zsh-autosuggestions.zsh`          | `/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh`                         | `/usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh`                   | `/root/.nix-profile/share/zsh-autosuggestions/zsh-autosuggestions.zsh`                   |
| `zsh-syntax-highlighting.zsh`      | `/usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh`                 | `/usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh`           | `/root/.nix-profile/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh`           |
| `zsh-history-substring-search.zsh` | `/usr/local/share/zsh-history-substring-search/zsh-history-substring-search.zsh` | `/usr/share/zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh` | `/root/.nix-profile/share/zsh-history-substring-search/zsh-history-substring-search.zsh` |

The source of this table is `packages/workspaces/src/buildkit/package-catalog.ts`.
