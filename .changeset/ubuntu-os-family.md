---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Ubuntu as a first-class workspace OS family: `workspaces.create({ os: "ubuntu" })` builds the
workspace image from `ubuntu:24.04` with apt-installed packages (cached, non-interactive), the same
baked harness CLIs, socat relay, and `sealantd boot` entrypoint as the other families. Package
standardization resolves portable package names against the Ubuntu 24.04 archive (`python` →
`python3`, `fd` → `fd-find`, `github-cli` → `gh`); packages the archive does not carry (`pnpm`,
`uv`, `mise`, `lazygit`) are reported unsupported at create time. The `resolvePackage` response's
`osSupport` now always carries an `ubuntu` entry, so an SDK at this version needs a control plane at
the same version.
