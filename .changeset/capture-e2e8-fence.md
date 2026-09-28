---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

An executor whose status request was cut off no longer waits out the request's whole fence before
a complete FINAL can release it. Before, when a caller of `capture.status()` or `capture.flush()`
went away, or a deadline sweep's bounded read ran out, while the answer was being recorded, that
observation stayed in flight for up to 56 minutes. Every stop in that window kept the executor, even
after it answered `complete`.

The control plane now always records an answer it received, whoever interrupts. An answer it cannot
record ends its observation at once, because no answer can arrive after the request is over. The
next observation of that executor then settles it. An observation whose request is still out is
honoured as before: nothing is removed while its answer could still arrive unrecorded.
