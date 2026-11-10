/**
 * The Boat host mode of the guest agent (`packages/workspaces/microvm-image/agent.mjs` with
 * `SEALANT_AGENT_HOST=boat`, its Boat-only logic in `microvm-image/boat-host.mjs`). On Boat the
 * VM is the workspace: the agent runs as a root systemd service on port 8080, sealantd runs as
 * PID 1 of its own PID namespace, and the routes the Lambda runtime shares (`/sealant/launch`,
 * `/sealant/health`, `/sealant/control`, `/sealant/recover`) keep their shapes from
 * `../microvm/agent-contract.ts`. This file states what Boat adds:
 *
 *   - the bind exchange (`boat-bind.mjs`, run by Core over Boat exec), the same
 *     `sealant-bootstrap-v1` wire the Python guest answered: Core keeps parsing it unchanged;
 *   - the typed recovery outcomes a durable launch record makes possible;
 *   - `POST /sealant/park`: close the workspace for parking and write a receipt;
 *   - `POST|GET /sealant/network`: bring up the workspace's WireGuard interface to the gateway.
 */
import { z } from "zod";

/** `SEALANT_AGENT_HOST` values the agent understands. */
export const AGENT_HOSTS = ["lambda", "boat"] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export const BOAT_AGENT_PARK_ROUTE = "/sealant/park";
export const BOAT_AGENT_NETWORK_ROUTE = "/sealant/network";

/** Where the agent keeps what must survive an agent restart on the same boot. */
export const BOAT_AGENT_DATA_DIR = "/var/lib/sealant/agent";
/** The image's manifest digest the bind request must name (`digest` field). */
export const BOAT_AGENT_MANIFEST_FILE = "/var/lib/sealant/agent/manifest.json";

/**
 * The files the Boat image copies in from `packages/workspaces/microvm-image/`, for the image
 * recipe: the agent and its Docker service, the Boat host module and the bind CLI (which carries
 * its own RSA-OAEP exchange). The agent starts from exactly these.
 */
export const BOAT_AGENT_FILES = [
  "microvm-image/agent.mjs",
  "microvm-image/docker-service.mjs",
  "microvm-image/boat-host.mjs",
  "microvm-image/boat-bind.mjs",
] as const;

/** The identity names Boat's receiver accepted; the bind CLI accepts exactly these. */
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
/** The one failure text the agent lets out: a reason code. */
export const boatAgentReasonSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const boatAgentIdentitySchema = z.strictObject({
  deployment_id: name,
  instance_id: name,
  disk_lineage: name,
});

/** What Core sends the bind CLI (`node boat-bind.mjs '<json>'`), unchanged from the Python guest. */
export const boatAgentBindRequestSchema = z.strictObject({
  format: z.literal("sealant-bootstrap-v1"),
  identity: boatAgentIdentitySchema,
  boot_id: uuid,
  manifest_digest: sha256Hex,
  operation_id: name,
  public_key: z.string().max(4096),
});
export type BoatAgentBindRequest = z.infer<typeof boatAgentBindRequestSchema>;

/** The bind CLI's stdout on success; `ciphertext` is the bearer under RSA-OAEP (label as before). */
export const boatAgentBindReplySchema = z.strictObject({
  format: z.literal("sealant-bootstrap-reply-v1"),
  identity: boatAgentIdentitySchema,
  boot_id: uuid,
  operation_id: name,
  ciphertext: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
  admission: z.literal("held"),
  boot: z.strictObject({ status: z.literal("compatible") }),
});
export type BoatAgentBindReply = z.infer<typeof boatAgentBindReplySchema>;

/** Why the bind CLI exited non-zero (its stderr holds exactly one of these). */
export const BOAT_AGENT_BIND_REFUSALS = [
  "bind-invalid-request",
  "bind-stale-boot",
  "bind-manifest-mismatch",
  "bind-invalid-public-key",
  "bind-identity-conflict",
  "bind-exchange-conflict",
  "bind-state-unknown",
] as const;

/** The public bind record (`<data dir>/bind.json`); the bearer itself lives on tmpfs only. */
export const boatAgentBindRecordSchema = z.strictObject({
  format: z.literal("sealant-agent-bind-v1"),
  boot_id: uuid,
  identity: boatAgentIdentitySchema,
  operation_id: name,
  public_key_sha256: sha256Hex,
  /** The bearer's digest, so a recovery after a reboot is refused as `recover-new-boot`. */
  bearer_sha256: sha256Hex,
});

/** The durable launch record (`<data dir>/launch.json`), written before sealantd starts. */
export const boatAgentLaunchRecordSchema = z.strictObject({
  format: z.literal("sealant-agent-launch-v1"),
  boot_id: uuid,
  run_id: z.string().trim().min(1),
  accepted_at: z.string().datetime(),
});

/** A refusal: `409 {reason}`. */
export const boatAgentRefusalSchema = z.strictObject({ reason: boatAgentReasonSchema });

export const BOAT_AGENT_RECOVER_REFUSALS = [
  "recover-new-boot",
  "recover-binding-conflict",
  "recover-state-unknown",
  "parked",
] as const;

/**
 * `POST /sealant/recover` on Boat. `nothing-to-save` names its basis: `no-launch` (this boot was
 * bound and never launched) or `daemon` (the recovery boot exited 76).
 */
export const boatAgentRecoverResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("running") }),
  z.strictObject({ outcome: z.literal("restarted") }),
  z.strictObject({
    outcome: z.literal("nothing-to-save"),
    basis: z.enum(["no-launch", "daemon"]),
    detail: z.string().optional(),
  }),
]);
export type BoatAgentRecoverResponse = z.infer<typeof boatAgentRecoverResponseSchema>;

export const boatAgentParkRequestSchema = z.strictObject({
  format: z.literal("sealant-agent-park-v1"),
  operationId: uuid,
});
export type BoatAgentParkRequest = z.infer<typeof boatAgentParkRequestSchema>;

/** The receipt file the park writes (`<data dir>/park-<operationId>.json`). */
export const boatAgentParkReceiptSchema = z.strictObject({
  format: z.literal("sealant-agent-park-receipt-v1"),
  operation_id: uuid,
  boot_id: uuid,
  run_id: z.string().nullable(),
  daemon: z.literal("stopped"),
  docker: z.enum(["stopped", "absent"]),
  closed_at: z.string().datetime(),
});

export const boatAgentParkResponseSchema = z.strictObject({
  outcome: z.literal("closed"),
  receipt: z.strictObject({
    path: z.string().min(1),
    sha256: sha256Hex,
    bytes: z.number().int().nonnegative(),
  }),
});
export type BoatAgentParkResponse = z.infer<typeof boatAgentParkResponseSchema>;

const wireguardKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

/** `POST /sealant/network`: today's `sealant-guest-network-v1` body, unchanged. */
export const boatAgentNetworkRequestSchema = z.strictObject({
  format: z.literal("sealant-guest-network-v1"),
  binding: z.unknown(),
  private_key: wireguardKey,
  public_key: wireguardKey,
  gateway_key: wireguardKey,
  endpoint: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/),
  port: z.number().int().min(1).max(65535),
  subnet: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/27$/),
});
export type BoatAgentNetworkRequest = z.infer<typeof boatAgentNetworkRequestSchema>;

export const BOAT_AGENT_NETWORK_REFUSALS = [
  "invalid-network-config",
  "invalid-network-key",
  "invalid-network-destination",
  "network-binding-conflict",
  "network-setup-unresolved",
  "network-command-refused",
] as const;

/** Mirrors the Python `guest_network.configure` reply. */
export const boatAgentNetworkResponseSchema = z.strictObject({
  format: z.literal("sealant-guest-network-status-v1"),
  binding: z.unknown(),
  receipt: sha256Hex,
  configured: z.literal(true),
  handshake: z.literal("unverified"),
});
export type BoatAgentNetworkResponse = z.infer<typeof boatAgentNetworkResponseSchema>;

/** `GET /sealant/network`: what the agent measured just now. */
export const boatAgentNetworkStatusSchema = z.strictObject({
  configured: z.boolean(),
  handshake: z.enum(["verified", "unverified"]),
  dns: z.enum(["udp-and-tcp", "unavailable"]),
  /**
   * The containers' network policy: `absent` without Docker, `applied` once it holds them to the
   * gateway's allowance. A Docker image is not ready while it is `pending` or `failed`.
   */
  docker_policy: z.enum(["absent", "pending", "applied", "failed"]),
});
export type BoatAgentNetworkStatus = z.infer<typeof boatAgentNetworkStatusSchema>;

/** The interface the agent owns in the VM's own namespace; Boat's `wg0` is never touched. */
export const BOAT_AGENT_WIREGUARD_INTERFACE = "sealant-wg";
export const BOAT_AGENT_GATEWAY_ADDRESS = "100.127.255.253";
export const BOAT_AGENT_CLIENT_ADDRESS = "100.127.255.254";
