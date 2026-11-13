---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`sealant.workspaces.runtimes()` (`GET /v1/workspaces/runtimes`) answers, before any create, which
runtimes the control plane launches workspaces on (`default` first, Boat only where it is
configured) and what each supports: `os` per family (`ubuntu`, `nix`, `arch`, `fedora`),
`customImage`, `hostDirectories`, `docker`, `gvisor`, `clusterEnv`, `gitSource`, `dotfilesArchives`,
`screen` with its CPU `architectures`, `reservedPorts` (Boat's guest agent holds 8080), `resources`
with `attach` (`live` or `next-start`), and `idleCost` (`{ charged, message }`). Each item is
`{ supported: true }` or `{ supported: false, message }`, with the sentence to show a person. New
types: `WorkspaceRuntimes`, `RuntimeSupport`, `RuntimeCapability`, `RuntimeUnsupported`,
`RuntimeArchitecture`, `WorkspaceRuntimeKind`.

The report and the create's refusals come from one table, so a create that asks a runtime for an
item the report marks unsupported is refused (`422`) with that item's sentence, before anything is
reserved. The refusal codes are unchanged. What changes:

- Boat refuses a `git` source (a `sourceSelection` included) and dotfiles archives at create
  (`runtime-requirement-unsupported`). Until now its worker refused them after the create was
  accepted.
- MicroVM and Cloudflare refuse host directories (a `mount` or `standby` source, `sources.mounts`)
  and gVisor (`runsc`) at create (`runtime-requirement-unsupported`), which their workers refused
  before.
- A restart checks the workspace's recorded spec against its runtime the same way, so it can also
  answer `WorkspaceRuntimeEnvReferencesUnsupportedError` and
  `WorkspaceDockerServiceUnsupportedError`.
- Messages: Boat names an OS family capitalized ("Boat supports Ubuntu and Nix; Fedora is
  unsupported.") and its host-directory refusal reads "Boat cannot bind directories from this
  deployment's own servers."; Docker refusals on Kubernetes, MicroVM and Cloudflare, and the
  Kubernetes-references refusal, are reworded in plain words without settings names.
