---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Once the runtime has been asked to remove a capture executor, `capture.status()` and
`capture.flush()` for that workspace keep failing (500) without asking the daemon until the outcome
is known. This holds even if the worker that asked stops renewing its hold, because the request
cannot be withdrawn. If that worker is gone, the control plane checks the runtime. If the executor
is gone, it is recorded removed. If it is still there and the evidence has not changed, the removal
is issued again. If the evidence changed, the removal is dropped and the control plane decides
again. A status recorded in the meantime is kept as evidence and no longer cancels a removal already
issued. The deadline sweep now releases an executor's FINAL slot as soon as its FINAL is answered,
so a slow removal of one executor no longer delays another's first FINAL or the next sweep.
