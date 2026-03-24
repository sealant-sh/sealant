# Packages

Shared libraries and reusable code live here.

The current package architecture is:

- `db`: shared SQLite database package for control-plane state, Drizzle schema, migrations, and
  repositories
- `auth`: shared Better Auth package for product-facing apps, backed by the shared database package
- `workspace-build-queue`: RabbitMQ transport package for queueing workspace image build jobs
- `workspace-composition`: core composition system with `UserWorkspaceSpec`, `WorkspaceBlueprint`,
  normalization/defaulting, executor contracts, executor selection, and build artifact definitions
- `os-integration-buildkit`: BuildKit-backed Arch, Fedora, and Nix workspace image compilation
- `package-standardization`: Repology-backed package resolution and normalization layer with
  cache-first lookups
- `runtime-adapters-api`: shared contract between the control plane and concrete runtime adapters,
  including Docker implementation and Kubernetes/K3s scaffolds
- `source-integrations`: source-provider integration logic such as GitHub repository selection, ref
  resolution, and access-related flows
- `ai-harness-integrations`: shared AI harness contracts and orchestration
- `registry-integration`: artifact registry publishing, tagging, and retrieval
