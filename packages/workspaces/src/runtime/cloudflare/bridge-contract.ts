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
 *  - The workspace source must be `git` — a `mount` source names a path on a filesystem the
 *    sandbox cannot see (the adapter's `supports()` rejects it before this contract is reached).
 */
import { z } from "zod";

import { credentialFileInjectionSchema, publishedImageSchema } from "../runtime-adapter.js";

export const BRIDGE_CONTRACT_VERSION = 1;

const envRecordSchema = z.record(z.string(), z.string());

export const bridgeGitSourceSchema = z.strictObject({
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
  source: bridgeGitSourceSchema,
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

export const bridgeStopResponseSchema = z.strictObject({
  outcome: z.enum(["stopped", "not-found"]),
});

export type BridgeStopResponse = z.infer<typeof bridgeStopResponseSchema>;

/** Error body every non-2xx bridge response carries (mirrors the API's message convention). */
export const bridgeErrorResponseSchema = z.strictObject({
  message: z.string().trim().min(1),
});
