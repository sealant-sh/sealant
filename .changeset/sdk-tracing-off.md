---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

A caller with Effect's tracer off (`References.TracerEnabled`) or propagation off
(`Tracer.DisablePropagation`) sends no `traceparent` or `b3` on any SDK request, and the SDK never
forwards a disabled span (IDs `noop`) as a parent. Before, a process with telemetry off still sent
its in-memory spans' context, or a malformed `traceparent` of `noop` IDs.
