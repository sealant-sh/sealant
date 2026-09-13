/**
 * The wire contract between the cloudflare runtime adapter (control-plane side) and the bridge
 * Worker (deploy/cloudflare). One home, consumed by both ends, versioned explicitly: the bridge
 * rejects a `version` it does not speak instead of guessing.
 *
 * Design constraints the contract encodes:
 *
 *  - Sandboxes can only run images baked into the bridge's deployment (Cloudflare Containers
 *    declare images at deploy time), so `image` is informational — the bridge records what the
 *    control plane *built* and answers with the runtime class it actually launched. Divergence is
 *    visible, never silent.
 *  - There is no shared filesystem, so everything Docker passes as host directories rides inline:
 *    secret env as a map, credential files and dotfiles archives as base64. The transport is the
 *    bridge's authenticated HTTPS; nothing lands in argv or image layers.
 *  - The workspace source is `git` or `capture` — a `mount` source names a path on a filesystem
 *    the sandbox cannot see (the adapter's `supports()` rejects it before this contract is
 *    reached). A capture source (sealantd ADR-0015) mounts nothing: the daemon materialises the
 *    worktree from the session channel onto the sandbox disk, and its credential rides
 *    `secretEnv` like every other secret. `kind` defaults to `git` so a v1 payload still parses.
 */
import { z } from "zod";

import { credentialFileInjectionSchema, publishedImageSchema } from "../runtime-adapter.js";

export const BRIDGE_CONTRACT_VERSION = 1;

const envRecordSchema = z.record(z.string(), z.string());

export const bridgeGitSourceSchema = z.strictObject({
  kind: z.literal("git").default("git"),
  url: z.string().trim().min(1),
  /** Absent means the remote's default branch (sealantd clones HEAD, never assumes `main`). */
  ref: z.string().trim().min(1).optional(),
  /** HTTP token auth resolved by the worker; never persisted by the bridge. */
  auth: z
    .strictObject({
      username: z.string().trim().min(1),
      token: z.string().trim().min(1),
    })
    .optional(),
});

export const bridgeCaptureSourceSchema = z.strictObject({
  kind: z.literal("capture"),
  /** The session channel the daemon registers with (`SEALANT_CAPTURE_ENDPOINT`). */
  endpoint: z.string().trim().min(1),
  /** Absent for a standby executor: the daemon takes the worktree from the channel's plan answer. */
  worktreeId: z.string().trim().min(1).optional(),
});

// Git first: a payload without `kind` resolves as git; a capture payload fails the git shape (no
// `url`, wrong literal) and falls through.
export const bridgeSourceSchema = z.union([bridgeGitSourceSchema, bridgeCaptureSourceSchema]);

export const bridgeDotfilesSchema = z.strictObject({
  /** The staged manifest.json, verbatim. */
  manifestJson: z.string().min(1),
  archives: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1),
        contentBase64: z.string().min(1),
      }),
    )
    .min(1),
});

export const bridgeLaunchRequestSchema = z.strictObject({
  version: z.literal(BRIDGE_CONTRACT_VERSION),
  /** Deterministic per-run identity: a redelivered launch adopts, never duplicates. */
  runId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
  principalId: z.string().trim().min(1).optional(),
  source: bridgeSourceSchema,
  /** What the control plane built/published for this blueprint; informational on Cloudflare. */
  image: publishedImageSchema,
  /** Plain launch env (blueprint env, then platform env, then credential env — later wins). */
  env: envRecordSchema,
  /** Secret env: injected into the sandbox environment and seeded into sealantd's redactor. */
  secretEnv: envRecordSchema.optional(),
  credentialFiles: z.array(credentialFileInjectionSchema).optional(),
  dotfiles: bridgeDotfilesSchema.optional(),
});

export type BridgeLaunchRequest = z.infer<typeof bridgeLaunchRequestSchema>;
/** The wire shape the adapter builds: `source.kind` may be omitted for git (defaulted on parse). */
export type BridgeLaunchRequestInput = z.input<typeof bridgeLaunchRequestSchema>;

export const bridgeLaunchResponseSchema = z.strictObject({
  /** The bridge-side identity of the sandbox (Durable Object id); stop addresses this. */
  resourceId: z.string().trim().min(1),
  /** Human-readable name the bridge chose (defaults to the resourceId when omitted). */
  reference: z.string().trim().min(1).optional(),
  status: z.enum(["pending", "running", "ready"]),
  /** The authenticated control endpoint (`wss://…`) proxying to sealantd in the sandbox. */
  controlEndpoint: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.startsWith("wss://"), "must be wss://"),
});

export type BridgeLaunchResponse = z.infer<typeof bridgeLaunchResponseSchema>;

/**
 * How a stop reaches the sandbox. `planned` (the default) sends SIGTERM and leaves the daemon its
 * grace window to flush captures; `fence` destroys the sandbox outright (SIGKILL) and is reserved
 * for confirmed-termination fencing before a replacement claims the worktree.
 */
export const bridgeStopModeSchema = z.enum(["planned", "fence"]);
export type BridgeStopMode = z.infer<typeof bridgeStopModeSchema>;

export const bridgeStopResponseSchema = z.strictObject({
  outcome: z.enum(["stopped", "not-found"]),
});

export type BridgeStopResponse = z.infer<typeof bridgeStopResponseSchema>;

/** Error body every non-2xx bridge response carries (mirrors the API's message convention). */
export const bridgeErrorResponseSchema = z.strictObject({
  message: z.string().trim().min(1),
});
