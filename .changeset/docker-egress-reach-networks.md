---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

With per-workspace Docker egress on (`SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS`), a resource such as
a project's database can join a workspace that is already running. It used to fail with
`cannot program address … because it conflicts with existing route`. The workspace now reaches that
one resource's network and still refuses every other private address, including other workspaces'
resource networks. When the resource network goes while the workspace is still running, the
workspace refuses its subnet again before the subnet is handed to anyone else. A workspace behind
its own egress proxy that runs Docker inside also launches again: its Docker service now joins the
workspace's isolated network before that service's guard runs.
