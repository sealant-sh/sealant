# Packages

Shared libraries and reusable code live here.

The current package architecture is:

- `workspace-composition`: core composition system with `UserWorkspaceSpec`, `WorkspaceBlueprint`,
  normalization/defaulting, executor contracts, executor selection, and build artifact definitions
- `os-integration-nix`: Nix-specific OS integration implementation for building concrete Nix-backed
  workspace artifacts
- `os-integration-fedora`: Fedora OS integration placeholder
- `os-integration-arch`: Arch OS integration placeholder
- `runtime-adapters-api`: shared contract between the control plane and concrete runtime adapters
- `runtime-adapter-docker`: Docker runtime adapter placeholder
- `runtime-adapter-k8s`: Kubernetes runtime adapter placeholder
- `runtime-adapter-k3s`: K3s runtime adapter placeholder
- `source-integrations`: source-provider integration logic such as GitHub repository selection, ref
  resolution, and access-related flows
- `ai-harness-integrations`: shared AI harness contracts and orchestration
- `registry-integration`: artifact registry publishing, tagging, and retrieval
