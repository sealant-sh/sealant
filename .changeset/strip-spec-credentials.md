---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Strip the create-payload `credentials` key from the workspace spec before it reaches the build job.
The SDK folds `credentials` into the spec it sends; the api lowers it into `runtime.credentialRefs`
but previously left the raw key in place, and the worker's strict blueprint schema rejected it —
killing every `mount` + `credentials` create at `parseWorkspaceBlueprint` ("Unrecognized key:
credentials"). Mount-sourced workspaces with connected-account credentials now build.
