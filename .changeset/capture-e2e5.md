---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A retained executor reads `retained`, and the drain and retention can be read without a stop.

- Workspace status and runtime status gain `retained` (`workspaceStatusSchema`,
  `workspaceRuntimeSchema.status`; SDK `WorkspaceStatus`, `WorkspaceRuntimeInfo.status`): the
  executor ended — or its capture launch failed after it started — with work on its disk not
  confirmed saved. It is kept, not dead: the control plane drains or recovers it with the capture
  token it was launched with, and the status reads `stopped` or `failed` again only once that ends.
  Keep the session's lease and token while it reads `retained`. An SDK that predates the value fails
  to decode such a workspace rather than reading it as ended.
- `ready()` fails at once on `retained`; `stop()` of a retained workspace answers `kept` with the
  drain at once (unless it discards, or its completion attestation was accepted).
- `workspace.captureDrain()` reads the drain and retention as last observed (state, retained and its
  recovery, the accepted completion, the executor it is about) without stopping anything; `null`
  when nothing was observed, which says nothing about whether the work is saved.
- `captureDrain.executor.launchId`: the launch identity the create named for that executor.

Server-side (the packages ride the release train): a retained executor's recovery starts the moment
it is retained and is retried after 10 s, doubling (`WORKSPACE_RECOVERY_SWEEP_INTERVAL_MS`, 5 s);
one stop of a capture executor at a time (a second finds the drain claim held and leaves it); a
drain of an executor that ended ends at once; an ended retained executor's Docker sidecar is
stopped; every capture executor bounds its shutdown final flush inside its stop grace
(`SEALANT_SHUTDOWN_FINAL_DEADLINE_MS`); a launch whose worker died before it recorded its executor
is found by its run, or ended `launch-lost` when nothing started (`WORKSPACE_LAUNCH_LEASE_MS`, 2
min); saved means `complete` with no `incompleteReason` (`unwatched` and unknown reasons ask for
FINAL again).
