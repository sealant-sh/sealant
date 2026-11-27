---
"@sealant/sdk": patch
---

A session opened or a command run as a person's Linux user (`sessions.open` and `exec` with `user`)
continues the caller's trace, as do the connected-account, inference and credential calls that check
a control plane feature first: the trace is captured before the check. A caller whose spans nothing
exports (Effect's native tracer, or tracing turned off) sends no trace header and the SDK makes no
spans for it; an external span the caller set as its parent is still forwarded.
