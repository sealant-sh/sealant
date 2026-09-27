---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

`workspace.stop({ discardUnsaved: true })` (`POST /v1/workspaces/:id/stop` with
`discardUnsaved: true`) ends a workspace without saving its unsaved captures. The stop skips the
drain, the runtime is terminated at once, and the request is recorded. It is the owner's only way to
end a capture-sourced workspace that the control plane keeps because its work cannot be confirmed
saved. It is accepted on a workspace whose stop was already recorded. It is owner only and
irreversible. The workspace's `captureDrain` then reads `discarded`, with
`discard: { requestedBy, requestedAt }`. `captureDrain.state` also reads `stop-failed` when removing
the runtime failed (the control plane retries it) and `stopped` once the runtime was removed after
its drain.

Server-side (the packages ride the release train):

- Every Docker workspace container is created with its own stop timeout (`--stop-timeout`), so a
  plain `docker stop` from an operator, a host restart or Docker Desktop quitting waits for
  sealantd's final flush instead of killing it after 10 s. The timeout is
  `SEALANT_DOCKER_STOP_GRACE_SECONDS` (120 s), or `SEALANT_DOCKER_CAPTURE_STOP_GRACE_SECONDS` (3600
  s) for a capture-sourced workspace. Docker's own `shutdown-timeout` still bounds a daemon
  shutdown.
- Kubernetes capture-sourced Pods get `terminationGracePeriodSeconds` from
  `SEALANT_K8S_CAPTURE_TERMINATION_GRACE_SECONDS` (3600).
- Recording a run's changes no longer restages the workspace's git index. The diff is staged in a
  throwaway index, and the user's index keeps its exact bytes. This covers the worker's run exec and
  the SSH gateway's interactive runs.
- A stop records that it is under way before the runtime is asked to go. An exit observed after that
  is recorded as the planned stop (`stopped`), never `failed`.
- A stop whose launch-material cleanup fails still completes.
