---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`workspaces.create({ resources: "none" })` (`spec.runtime.resources: "none"`) says a workspace will
never be linked to project resources. It is stored with the workspace and read again by every
restart. Omitted, a workspace may be linked, as before, on every runtime.

On Boat a workspace created with it is launched with no resource gateway, tunnel or in-VM resolver:
it is ready without the tunnel's handshake and DNS wait, and a Boat deployment that has no resource
gateway can run it. `scope.workspaces.link()` on such a workspace rejects with the new
`ResourceWorkspaceWithoutResourcesError` (409, `reason` `workspace-without-resources`) and changes
nothing; create the workspace again without the option and link that one, and it reaches the
resources from its next start. Docker and Kubernetes attach resources to a running workspace, so
they do not enforce the option: a later link works there as it does without it.

A Boat deployment with no resource gateway refuses a Boat workspace created without the option
before it is built: the workspace fails with `error.code` `gateway-unavailable`
(`WORKSPACE_GATEWAY_UNAVAILABLE_CODE`), and `ready()` rejects with that code.

A control plane older than the option rejects a create that sends it (its spec is strict).
