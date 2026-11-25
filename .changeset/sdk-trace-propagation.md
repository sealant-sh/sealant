---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

SDK calls now continue the caller's trace instead of starting a new one. A Promise call made inside
an Effect span continues that span; otherwise the new `traceContext` option (a function returning
`{ traceparent, tracestate? }`, read per call) or the active OpenTelemetry context is used, with no
dependency on any tracing package. With none of them, requests carry no trace header. Polling that
one call starts (`workspaces.create` waiting for ready, `ready()`, `events()`, `run.wait()`, record
and session output streams, `stop()`) stays in the trace the call started in, and session output
streams and resource `exec`/`backup` send `traceparent`/`tracestate` too. Each contract call runs in
a client span named `sealant.sdk.<group>.<endpoint>` whose only attributes are the IDs in its path;
when the caller's Effect tracer exports spans, these spans are made on it. The `fetch` option now
reaches every request, contract calls included (it only reached streams and resource calls before).
