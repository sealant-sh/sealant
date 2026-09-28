---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Capture status and flush answers now carry `overdue` when a capture step on the executor is running
past its bound: the step, when it started, how long it has been running and its bound. The field
comes from sealantd's `CaptureStatusReport.overdue` and reaches SDK callers as
`WorkspaceCaptureStatus.overdue`. It is absent while nothing is past its bound, and from older
daemons. It reports a stuck step and is not a verdict; the step's own limit ends it.
