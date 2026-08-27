---
"@sealant/sdk": patch
---

Server fix riding this release: `GET /v1/sessions/:id/output` and the SSE tail
(`/output/stream`) now serve pipe-mode sessions. Both filtered recorded chunks to the PTY
output stream kind only, so a protocol-mode harness opened over `openSession({ mode: "pipe" })`
— claude stream-json, codex app-server — looked permanently silent to every reader even though
its stdout was captured and stored. The read paths now accept the pty-out and stdout kinds
(one session only ever records one of them) and scope by the session's daemon id so a run's
other sessions never interleave. No SDK code change; `output()` simply starts returning data
for pipe sessions.
