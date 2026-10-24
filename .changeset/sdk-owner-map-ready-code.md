---
"@sealant/sdk": patch
---

`workspace.ready()` now rejects a launch the worker refused because its image cannot apply the owner
map, or because Core cannot tell whether it does, with the refusal's own code,
`owner-map-unsupported` or `owner-map-unverified`, instead of `workspace_not_ready`. Other launch
failures, a runtime's `unsupported-runtime-requirement` refusal included, still reject with
`workspace_not_ready`.
