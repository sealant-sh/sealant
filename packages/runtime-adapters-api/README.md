# Runtime Adapters API

`@sealant/runtime-adapters-api` defines the shared launch contract between the control plane and
runtime adapter implementations, and exports the built-in runtime adapter classes.

## What it provides

- adapter ids and support/launch schemas
- a minimal runtime-launch blueprint contract
- `RuntimeAdapter` interface (`supports`, `launch`)
- runtime adapter selection helper with `auto` + `prefer/require` behavior
- `DockerRuntimeAdapter` implementation
- `K8sRuntimeAdapter` scaffold
- `K3sRuntimeAdapter` scaffold

## Selection behavior

- `target.runtime.family = auto`: use `defaultAdapterId`
- explicit runtime with `mode = require`: must select that adapter
- explicit runtime with `mode = prefer`: try requested adapter first, then fallback to default
  adapter

## Typical flow

1. OS executor compiles a blueprint into an OCI artifact.
2. Registry integration publishes that artifact and returns canonical references.
3. Runtime adapter selection picks a concrete adapter from the normalized runtime target.
4. The selected adapter launches the published image.
