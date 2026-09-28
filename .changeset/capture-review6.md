---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

Capture evidence is ordered by the executor's own history, never by clocks.

- `WorkspaceCaptureStatus.origin` (optional, from `capture.status()` and `capture.flush()`): where
  in the executor's own history the answer was made —
  `{ epoch, launch, bootId, bootGeneration, observation, headN? }`, sealantd's stamp (wire fields
  27–30). Of the same epoch, launch and boot, order by `observation`; of the same epoch and launch
  and different boots whose generations are both above 0 and differ, by `bootGeneration` then
  `observation`; anything else cannot be ordered and must fail closed. Absent from a daemon that
  predates the stamp.
- `stop({ completion: { origin } })` (`StopWorkspaceRequest.completion.origin`, optional): the
  seal's position (the `final_seal`'s stamp). The control plane places a report that the work is not
  saved before the seal only by the executor's history (its head short of `captureN`, or its
  `origin` before the seal's); `sealedAt` is kept for display and no longer orders anything. Without
  `origin`, any such report at or past `captureN` revokes the seal. The accepted attestation reads
  back with its `origin` on the workspace's `captureDrain.completion`.
- A FINAL relayed by `capture.flush({ kind: "final" })` whose answer is lost, whose status is read
  again, and whose repeated FINAL loses its answer too now returns the last status the daemon gave,
  not the transport error: a received "not saved" is never turned into a lost answer.
- `capture.status()` and `capture.flush()` fail (500) without asking the daemon when the control
  plane cannot mark the observation in flight; an answer it receives but cannot record is still
  returned, and the executor it came from is kept until a later observation is recorded.
