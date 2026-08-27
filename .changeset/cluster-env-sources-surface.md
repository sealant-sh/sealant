---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Cluster env sources at the create boundary (cluster-env-sources design, phase 1 of 2).

- `workspaces.create` accepts `envFrom` — an ordered list of
  `{ kind: "secret" | "configmap", name }` naming Kubernetes objects in the platform's workspaces
  namespace whose keys become workspace environment, resolved by the platform worker at creation —
  and `kubernetes.serviceAccountName`, an explicit allowlisted trust grant for the workspace Pod.
- On a deployment whose effective runtime family is not Kubernetes, create refuses synchronously
  with the new typed error (`WorkspaceRuntimeEnvReferencesUnsupportedError`, HTTP 422, stable code
  `runtime-env-references-unsupported`). The stable code doubles as the SDK consumer's capability
  probe.
- This release carries the surface and the fail-closed gate only; worker-side resolution (label
  opt-in, both kinds, ordering semantics, the ServiceAccount allowlist) ships in the companion
  change — until it lands, Kubernetes launches with these fields are refused with an honest "not
  resolved by this platform build yet".
