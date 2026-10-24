---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A workspace forward can now hold back a fast producer.
`workspace.forward(port, { flow: "bounded" })` opens a TCP forward on `/forward/v2` and resolves
with a `BoundedWorkspaceForward`: a `readable` and a `writable` web stream, the `binding`, a
`closed` promise and `close()`. The workspace sends only as fast as `readable` is read: while
nothing reads it, Core stops reading the workspace runtime, and the runtime stops reading the
program. `writer.ready` waits, and `writer.desiredSize` is 0, while Core has granted no more upload
credit, so a producer that awaits `writer.ready` pulls nothing it cannot send. The forward resolves
once Core has granted the first credit. `writable.close()` half-closes toward the workspace, and
`readable` keeps delivering until the workspace closes its side. `Duplex.fromWeb(forward)` makes it
a Node stream. It accepts `host`, `signal` and `deadlineMs`, and rejects with a `ForwardDialError`
when the forward does not open. The old overload is unchanged, and its options cannot carry a
`flow`.

`closed` resolves with `{ kind: "end" }` when the workspace closed its side after it took everything
written to it. Otherwise it resolves with `{ kind: "reset", reason }`, and both streams fail at once
with a `ForwardResetError`, also while the caller is not reading: `writer.ready`, `writer.closed`
and `writable.close()` reject. A reset that Core sends, such as `runtime-lost` when the workspace
runtime fails, reaches the caller ahead of data it has not read. When the workspace ends the forward
before it took everything written, the reason is `workspace-ended`: `readable` still yields all that
the workspace sent, and the writer fails. A write after the workspace ended fails with the same
reason. `writer.abort()` and `close()` release a write that waits for credit.

The contracts add the frames that bound each direction after `ready`: `progress { bytes, frames }`
(cumulative bytes and frames consumed, as decimal strings), `fin { bytes, frames }` and
`reset { reason }`. Each direction has a window of `FORWARD_V2_WINDOW` (256 KiB and 32 frames) past
what its receiver consumed. A side sends no data before the other's first `progress`, and resets a
peer that sends past its window. Core sends a `progress` naming exactly what reached the workspace
before its `fin`. `ForwardFlow` keeps that account for either side, with no I/O, and grants credit
only when a `progress` is sent, so a side that holds acknowledgements back while its socket is
backed up holds its peer back too.
