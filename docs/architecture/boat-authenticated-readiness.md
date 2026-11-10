# Boat authenticated readiness

Boat remains unregistered. This layer provides an explicit worker launch and readiness owner, with
admission still held. It does not publish a ready runtime row or start sessions from a scanner.

`BoatReadiness.launch` requires the current bound allocation and an active run. It seals the launch
material once (`BoatExecution.stage`), prepares current resource networking
(`BoatResources.prepare`, which has the [guest agent](boat-guest-agent.md) configure its tunnel),
freezes the guest and gateway receipts in the execution record (`recordIsolation`), pushes the
launch to the agent (`launch`) and observes readiness (`readiness`). Each external boundary rechecks
allocation authority. Lost replies retain the original execution, keys and reservations.

## Launch

The launch is the agent's: `POST /sealant/launch` with the sealed material as the MicroVM launch
body (`version` 1, or 2 with the Docker service required when the blueprint asks for Docker; the
exchanged bearer as `controlToken`; the boot environment; the secret environment the agent writes
0600 before `sealantd boot`). The record moves `installed` to `issued` before the push and to
`running` after an accepted push or an adopted `409 already booted`: the agent's launch record is
durable per boot, so a push whose reply was lost is adopted, never repeated. The sealed launch
envelope is erased on `running`; the resume copy stays for recovery. A held execution refuses the
push.

## Readiness

Readiness is read the way the Lambda MicroVM adapter reads it, with Boat's tunnel added:

1. `GET /sealant/health` must say `booted` with the control socket accepting, and, on a Docker
   image, `services.docker` ready. A reported daemon exit or a failed Docker service is
   `guest-failed`: the launch is lost, not retried. Not booted yet is `agent-not-ready`.
2. `GET /sealant/network` must say the tunnel is configured, the gateway's handshake is verified and
   its resolver answered over UDP and TCP. Otherwise `agent-not-ready`.
3. The daemon itself, through the agent's control relay: `HEALTHY`, a runtime id, and the
   `exec.user`, `dotfiles.user`, `restore.owner_map` and `process.secret-env.v1` capabilities.

The execution record must be unchanged across the observation. The receipt names the runtime id, the
boot the launch was accepted on and a digest of the binding with the frozen isolation receipts; it
is an observation, never durable authority to admit a later request.

Launch has a 120-second bound. Only lost transport and an agent that is not ready yet retry, at most
twenty times at one-second intervals, for the push and for the observation; they never push a second
launch. Resource preparation during observation may reconcile attachments, but observation never
seals, freezes or pushes.

## Local proof

Migrated PostgreSQL cases (`allocation.db.test.ts`, `execution.db.test.ts`) exercise sealing, lost
replies, adoption, changed bindings, stops during network setup and readiness, gateway changes and
launch ordering against a fake agent. `agent-transport.test.ts` runs the same owner against the real
agent. These local proofs do not establish a live Boat session or the provider's HTTPS/WebSocket
path.
