# Packages

Shared libraries and reusable code live here.

The current package architecture is:

- `db`: shared SQLite database package for control-plane state, Drizzle schema, migrations, and
  repositories
- `auth`: shared Better Auth package for product-facing apps, backed by the shared database package
- `workspace-build-queue`: RabbitMQ transport package for queueing workspace image build jobs
- `workspace-composition`: core composition system with `UserWorkspaceSpec`, `WorkspaceBlueprint`,
  normalization/defaulting, executor contracts, executor selection, and build artifact definitions
- `os-integration-nix`: Nix-specific OS integration implementation for building concrete Nix-backed
  workspace artifacts
- `os-integration-fedora`: Fedora OS integration placeholder
- `os-integration-arch`: Arch OS integration placeholder
- `runtime-adapters-api`: shared contract between the control plane and concrete runtime adapters
- `runtime-adapter-docker`: Docker runtime adapter implementation for launching published images
- `runtime-adapter-k8s`: Kubernetes runtime adapter scaffold and contract wiring
- `runtime-adapter-k3s`: K3s runtime adapter scaffold and contract wiring
- `source-integrations`: source-provider integration logic such as GitHub repository selection, ref
  resolution, and access-related flows
- `ai-harness-integrations`: shared AI harness contracts and orchestration
- `registry-integration`: artifact registry publishing, tagging, and retrieval
