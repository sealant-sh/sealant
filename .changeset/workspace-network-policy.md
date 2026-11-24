---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace can now carry a network policy and brokered secrets. `workspaces.create()` takes
`networkPolicy` (`standard`: the public internet without private, metadata and host addresses;
`restricted`: only the hosts, mirrors and resources it lists), `brokeredSecrets` and
`brokeredSecretValues`. A brokered secret is one the workspace uses without holding it: the
workspace reads a placeholder from an environment variable, and its egress proxy puts the real
value in a named header only on HTTPS requests to the secret's bind hosts. Values are sealed, handed
only to the proxy, and never appear in the spec, the environment or any read.

A runtime that cannot enforce the policy refuses the create (`422`,
`runtime-requirement-unsupported`) instead of running with less; `workspaces.runtimes()` reports
what each runtime enforces under `networkPolicy`. Docker runs a `restricted` workspace, or one with
a brokered secret, behind an egress proxy of its own. `restricted` with Docker inside, and
`requireVmIsolation`, need a VM runtime: the new `host-vm` runtime (each workspace in its own VM on
the deployment's KVM host), Boat or MicroVM. `runtime: "host-vm"` is accepted by `create()`.

A workspace handle gains `applyNetworkPolicy()`, `revokeAccess()` and `networkPolicy()`
(`PUT`/`GET /v1/workspaces/:workspaceId/network-policy`,
`POST /v1/workspaces/:workspaceId/network-policy/revocations`). Each change answers its
`enforcement`: `enforced`, `pending` or `next-start`. Revocations are durable, survive restarts and
win over every later policy, so a revoked secret id stays revoked; grant it again under a new
`secretId`.

The SDK checks policies, secrets and values before sending anything, with the control plane's
rules and words (`invalid_network_policy`, `invalid_revocation`). The rules are exported from both
packages (`networkPolicyProblems`, `brokeredSecretsProblems`, `brokeredSecretValuesProblems`,
`needsEgressProxy`, `FORBIDDEN_BROKERED_HEADER_NAMES`; `@sealant/api-contracts/network-policy`),
with the `NetworkPolicy` and `BrokeredSecret` types. New SDK types: `ApplyNetworkPolicyOptions`,
`NetworkPolicyApplied`, `RevokeAccessOptions`, `AccessRevoked`, `NetworkPolicyEnforcement`,
`WorkspaceNetworkPolicy`, `WorkspaceAccessRevocation`. `@sealant/sdk/effect` adds
`applyWorkspaceNetworkPolicyOp`, `revokeWorkspaceAccessOp`, `getWorkspaceNetworkPolicyOp` and
re-exports `WorkspaceRuntimeRequirementUnsupportedError`.
