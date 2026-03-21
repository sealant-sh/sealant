# Registry Integration

`@sealant/registry-integration` is the first registry-facing library package for Sealant.

It currently provides:

- a small Zot client for health checks, tag lookup, manifest inspection, and extension discovery
- a first publish helper that loads a docker-compatible image archive, retags it, and pushes it into
  Zot
- a local dev Zot deployment under `dev/zot/`

## Local dev registry

Start Zot locally:

```bash
docker compose -f packages/registry-integration/dev/zot/compose.yaml up -d
```

The registry listens on `http://127.0.0.1:5000` from the host.

The bundled config lives at `packages/registry-integration/dev/zot/config.json`.

## Library surface

Create a client in the core API and call it directly:

```ts
import { createZotRegistryClient } from "@sealant/registry-integration";

const registry = createZotRegistryClient({
  baseUrl: "http://zot:5000",
  pushRegistry: "127.0.0.1:5000",
});

await registry.ping();
await registry.publishOciImage({
  artifactPath: "/tmp/workspace-image.tar",
  repository: "sealant/workspaces/demo",
  tag: "opencode",
});
```

`baseUrl` is the HTTP address the calling process should use for Zot API requests.

`pushRegistry` is the host and port that should appear in pushed image references. This can differ
from `baseUrl` when the caller talks to Zot over an internal container network but the Docker daemon
needs a host-reachable registry address.

## Terminology

- `publish` means uploading an image into the registry
- `pull` means downloading an image from the registry
- `run` or `deploy` means starting something from that image on a runtime such as Docker,
  Kubernetes, Kata, or gVisor

This package currently handles the first part: publishing OCI images into Zot.

## Current publish behavior

`publishOciImage(...)` currently expects the artifact path to point at a docker-loadable image
archive, which matches the current Nix output from `@sealant/os-integration-nix`.

The helper runs:

1. `docker load -i <artifact>`
2. `docker tag <loaded-image> <pushRegistry>/<repository>:<tag>`
3. `docker push <pushRegistry>/<repository>:<tag>`

After the push completes, it resolves the manifest digest back from Zot and returns both tag and
digest references.

## Why Docker Is Involved Right Now

The current Nix executor already produces an OCI image in a form that Docker can import with
`docker load`. This package uses that existing handoff format as the shortest path to getting images
into Zot.

That Docker step is an implementation detail of the current upload flow, not a statement about the
final runtime target.

- the artifact being published is still an `oci-image`
- the registry still stores a standard image that other runtimes can pull
- Kubernetes, Kata, gVisor, and other OCI-capable runtimes are still valid downstream targets

In other words, Docker is just the current bridge between the Nix-produced image archive on disk and
the registry.

Future versions of this package can add other upload paths if a backend emits a different image
packaging format.

## End-to-End Example

At a high level, the control-plane flow looks like this:

1. an OS executor compiles a workspace blueprint and returns an `oci-image` artifact
2. the core API selects that artifact and calls `publishOciImage(...)`
3. this package uploads the image into Zot and returns canonical tag and digest references
4. a later runtime adapter can pull that stored image by reference and start the workspace

Example shape:

```ts
import { createZotRegistryClient } from "@sealant/registry-integration";
import type { OciImageBuildArtifact } from "@sealant/workspace-composition";

const registry = createZotRegistryClient({
  baseUrl: "http://zot:5000",
  pushRegistry: "127.0.0.1:5000",
});

const imageArtifact: OciImageBuildArtifact = {
  kind: "oci-image",
  name: "sealant-workspace-opencode",
  path: "/tmp/workspace-image.tar",
  reference: "sealant-workspace-opencode:opencode",
  loader: "docker-load",
};

if (imageArtifact.path === undefined) {
  throw new Error("Expected the executor to return a publishable image path.");
}

const published = await registry.publishOciImage({
  artifactPath: imageArtifact.path,
  repository: "sealant/workspaces/demo",
  tag: "opencode",
  sourceReference: imageArtifact.reference,
});

// `published.reference` can later be handed to a runtime adapter.
```
