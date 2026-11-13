import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { fetch as undiciFetch, getGlobalDispatcher, type RequestInit } from "undici";
import { z } from "zod";

import {
  BoatApiError,
  BoatOwnership,
  BoatBuildOwnership,
  BoatSecret,
  boatDeletionIdSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  parseBoatUrl,
  parseBoatLifetime,
  type BoatDeletionId,
  type BoatResult,
  type BoatSandboxId,
  type BoatSnapshotName,
  type BoatLifetime,
} from "./config.js";
import { parseBoatHostedControl, type BoatHostedControl } from "./connection.js";
import { classifyBoatRefusal } from "./failure.js";

/** Only an explicit null deadline without a contradictory TTL verifies disabled auto-stop. */
export type BoatAutoStop =
  | { readonly kind: "disabled" }
  | { readonly kind: "scheduled"; readonly at: string }
  | { readonly kind: "unverified" };

const sandboxSchema = z
  .object({
    hydrated: z.boolean().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    id: boatSandboxIdSchema,
    state: z.enum([
      "init",
      "provisioning",
      "provisioned",
      "cloning",
      "ready",
      "idle",
      "running",
      "archiving",
      "archived",
      "error",
      "cancelled",
    ]),
    archiveAfter: z.iso.datetime({ offset: true }).nullable().optional(),
    ttlSeconds: z.number().int().min(1).max(2592000).nullable().optional(),
    snapshots: z.boolean().optional(),
    monitoring: z.boolean().optional(),
    dataExpiredAt: z.iso.datetime({ offset: true }).nullable().optional(),
    stoppedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    stop: z
      .object({ status: z.enum(["pending", "failing", "completed", "superseded"]) })
      .nullable()
      .optional(),
  })
  .transform((sandbox) => {
    const autoStop: BoatAutoStop =
      sandbox.archiveAfter === null &&
      (sandbox.ttlSeconds === undefined || sandbox.ttlSeconds === null)
        ? { kind: "disabled" }
        : typeof sandbox.archiveAfter === "string" && sandbox.ttlSeconds !== null
          ? { kind: "scheduled", at: sandbox.archiveAfter }
          : { kind: "unverified" };
    return { ...sandbox, autoStop };
  });
/** Creation success preserves allocation identity even when auto-stop is unverified. No provider state fences writers. */
export type BoatSandbox = z.infer<typeof sandboxSchema>;

const deletionSchema = z.object({
  id: boatDeletionIdSchema,
  kind: z.literal("sandbox"),
  targetId: boatSandboxIdSchema,
  status: z.enum(["pending", "processing", "blocked", "completed"]),
});
export type BoatDeletion = z.infer<typeof deletionSchema>;

const snapshotSchema = z.object({
  name: boatSnapshotNameSchema,
  status: z.enum(["saving", "ready", "failed"]),
  sourceSandboxId: boatSandboxIdSchema,
  snapshotId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
  createdAt: z.iso.datetime(),
});
export type BoatSavedSnapshot = z.infer<typeof snapshotSchema>;

const commandSchema = z.object({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});
export type BoatCommand = z.infer<typeof commandSchema>;

// Undici's transport timers must not preempt the request budget. Borrow the pool
// without changing any other caller's timers.
const boatFetch = (url: string | URL, options: RequestInit, timeoutMs: number) =>
  undiciFetch(url, {
    ...options,
    dispatcher: getGlobalDispatcher().compose(
      (dispatch) => (input, handler) =>
        dispatch(
          {
            ...input,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
          },
          handler,
        ),
    ),
  });

const successSchema = z.object({ ok: z.literal(true) });
const sandboxResponse = successSchema
  .extend({ sandbox: sandboxSchema })
  .transform((value) => value.sandbox);
const snapshotResponse = successSchema
  .extend({ snapshot: snapshotSchema })
  .transform((value) => value.snapshot);
const deletionResponse = successSchema
  .extend({ operation: deletionSchema })
  .transform((value) => value.operation);
/**
 * The Boat permission (key action) each of sealant's calls needs, by the operation name its errors
 * carry. The list of permissions sealant requires of a key is derived from this, so it cannot drift
 * from the calls the client makes. `deleteSandbox` needs `sandbox.delete`, not
 * `sandbox.delete-own`: after a rotation the new key deletes VMs the old key created.
 */
export const BOAT_OPERATION_PERMISSIONS = {
  create: "sandbox.create",
  discover: "sandbox.read",
  verify: "sandbox.read",
  get: "sandbox.read",
  execute: "exec",
  commandStatus: "exec",
  stopCommand: "exec",
  writeFile: "file.write",
  uploadUrl: "file.write",
  host: "host",
  stop: "sandbox.stop",
  resume: "sandbox.resume",
  deleteSandbox: "sandbox.delete",
  getDeletion: "sandbox.read",
  saveSnapshot: "snapshot.write",
  getSnapshot: "snapshot.read",
  deleteSnapshot: "snapshot.write",
} as const satisfies Record<string, string>;
export type BoatOperation = keyof typeof BOAT_OPERATION_PERMISSIONS;
const permissionFor = (operation: string): string | undefined =>
  Object.entries(BOAT_OPERATION_PERMISSIONS).find(([name]) => name === operation)?.[1];
const stagingPathSchema = z
  .string()
  .regex(/^\/home\/user\/sealant-dev-boat-stream-[a-f0-9-]{36}\/[A-Za-z0-9._/-]+$/)
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."));

/** Production allocations require full identity. Build and proof allocations remain bounded. */
export type BoatCreateInput = {
  readonly idempotencyKey: string;
  readonly from?: BoatSnapshotName;
} & (
  | {
      readonly lifetime: Extract<BoatLifetime, { readonly kind: "production-session" }>;
      readonly ownership: BoatOwnership;
    }
  | {
      readonly lifetime: Extract<BoatLifetime, { readonly kind: "bounded" }>;
      /** Replay the recorded body version. Version 1 predates explicit snapshot/privacy fields. */
      readonly requestVersion: 1 | 2;
      readonly marker: string;
      /** `key-proof`: a full check's throwaway VM, labelled `sealant-key-proof` with the marker. */
      readonly purpose?: "native-build" | "key-proof";
    }
  | {
      readonly lifetime: Extract<BoatLifetime, { readonly kind: "bounded" }>;
      readonly requestVersion: 3;
      readonly buildOwnership: BoatBuildOwnership;
    }
);

/** Positive adoption requires a complete inventory. No match never establishes absence. */
export type BoatDiscovery =
  | {
      readonly kind: "found";
      readonly ownership: BoatOwnership | BoatBuildOwnership;
      readonly sandbox: BoatSandbox;
    }
  | { readonly kind: "unknown"; readonly reason: "no-positive-evidence" }
  | {
      readonly kind: "unknown";
      readonly reason: "inventory-unavailable";
      readonly error: BoatApiError;
    }
  | {
      readonly kind: "conflict";
      readonly ownership: BoatOwnership | BoatBuildOwnership;
      readonly matches: readonly BoatSandbox[];
    };

const ownershipLabels = (identity: BoatOwnership) => ({
  "sealant-runtime": "boat",
  "sealant-deployment": identity.deploymentId,
  "sealant-workspace": identity.workspaceId,
  "sealant-run": identity.runId,
  "sealant-instance": identity.runtimeInstanceId,
  "sealant-attempt": identity.launchAttemptId,
  "sealant-source": identity.sourceId,
});
/** Version 3 labels bind the complete reservation, never a correlation tag alone. */
export const boatBuildOwnershipLabels = (
  identity: BoatBuildOwnership,
): Readonly<Record<string, string>> => {
  const { key, buildId, publicationId } = identity.reservation;
  return {
    "sealant-dev": "boat-stream",
    "sealant-runtime": "boat",
    "sealant-owner": identity.owner,
    "sealant-build": buildId,
    "sealant-publication": publicationId,
    "sealant-deployment": key.deploymentId,
    "sealant-scope-kind": key.scope.kind,
    "sealant-scope": key.scope.kind === "owner" ? key.scope.ownerUserId : key.scope.domainId,
    "sealant-recipe": key.recipeHash,
    "sealant-assets": key.assetsHash,
    "sealant-runtime-hash": createHash("sha256").update(JSON.stringify(key.runtime)).digest("hex"),
    "sealant-platform": key.platform,
  };
};
const inventoryResponse = successSchema.extend({
  sandboxes: z.array(sandboxSchema),
  pageInfo: z
    .object({
      nextCursor: z.string().min(1).nullable(),
      hasMore: z.boolean(),
      limit: z.number().int().min(1).max(200),
    })
    .refine((page) => page.hasMore === (page.nextCursor !== null)),
});

export interface BoatApi {
  create(input: BoatCreateInput): Promise<BoatResult<BoatSandbox>>;
  /** Reads all cursor pages and verifies every ownership label locally. Never issues create. */
  discover(ownership: BoatOwnership | BoatBuildOwnership): Promise<BoatDiscovery>;
  get(id: BoatSandboxId): Promise<BoatResult<BoatSandbox>>;
  execute(
    id: BoatSandboxId,
    command: string,
    options?: {
      readonly timeoutSeconds?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BoatResult<BoatCommand>>;
  writeFile(
    id: BoatSandboxId,
    path: string,
    content: BoatSecret | string,
  ): Promise<BoatResult<void>>;
  uploadFile(id: BoatSandboxId, path: string, bytes: Uint8Array): Promise<BoatResult<void>>;
  hostControl(id: BoatSandboxId): Promise<BoatResult<BoatHostedControl>>;
  stop(id: BoatSandboxId): Promise<BoatResult<void>>;
  /** Returns a fresh observation. An accepted resume alone does not verify lifetime or liveness. */
  resume(id: BoatSandboxId, lifetime: BoatLifetime): Promise<BoatResult<BoatSandbox>>;
  deleteSandbox(id: BoatSandboxId): Promise<BoatResult<BoatDeletion>>;
  getDeletion(id: BoatDeletionId): Promise<BoatResult<BoatDeletion>>;
  saveSnapshot(id: BoatSandboxId, name: BoatSnapshotName): Promise<BoatResult<BoatSavedSnapshot>>;
  getSnapshot(name: BoatSnapshotName): Promise<BoatResult<BoatSavedSnapshot>>;
  deleteSnapshot(name: BoatSnapshotName): Promise<BoatResult<void>>;
}

export interface BoatApiOptions {
  readonly credential: BoatSecret;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /**
   * The Boat organization every request bills (its id or name; `X-Boat-Org`). Absent: a personal
   * key bills its account's active wallet, which `boat org switch` changes at any time.
   */
  readonly organization?: string;
}

/** A Boat organization as `X-Boat-Org` takes it: an id (`team_…`), a name, or `personal`. */
export const boatOrganizationSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/)
  .refine((value) => value.trim() === value);

/**
 * The permissions sealant requires of every Boat key: one for each of the client's calls
 * ({@link BOAT_OPERATION_PERMISSIONS}), so the list cannot drift from the calls it makes.
 */
export const BOAT_REQUIRED_PERMISSIONS: readonly string[] = [
  ...new Set(Object.values(BOAT_OPERATION_PERMISSIONS)),
].toSorted();

const looseObject = <S extends z.ZodRawShape>(shape: S) => z.object(shape).loose();
const meResponse = looseObject({
  user: looseObject({
    id: z.string().optional(),
    login: z.string().optional(),
    displayName: z.string().nullable().optional(),
    serviceAccount: z.boolean().optional(),
    accountStatus: z.string().optional(),
    suspended: z.boolean().optional(),
    closed: z.boolean().optional(),
  }),
});
export type BoatMe = z.infer<typeof meResponse>["user"];
const orgsResponse = looseObject({
  orgs: z.array(
    looseObject({
      id: z.string(),
      name: z.string().optional(),
      type: z.string().optional(),
      role: z.string().optional(),
      active: z.boolean().optional(),
    }),
  ),
});
export type BoatOrg = z.infer<typeof orgsResponse>["orgs"][number];
const limitsResponse = looseObject({
  canStart: z.boolean(),
  blockedReason: z.string().nullable().optional(),
  startBlockedReason: z.string().nullable().optional(),
  billingStatus: z.string().optional(),
  activeSandboxes: z.number().int().nonnegative(),
  maxActiveSandboxes: z.number().int().nonnegative(),
  teamId: z.string().optional(),
  teamRole: z.string().optional(),
});
export type BoatLimits = z.infer<typeof limitsResponse>;
const apiKeysResponse = looseObject({
  apiKeys: z.array(
    looseObject({
      id: z.string(),
      name: z.string().optional(),
      keyPrefix: z.string(),
      keyLastFour: z.string(),
      teamId: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
      neverExpires: z.boolean().optional(),
      expired: z.boolean().optional(),
      expiringSoon: z.boolean().optional(),
      scope: looseObject({
        expiresAt: z.string().nullable().optional(),
        actions: z.array(z.string()).optional(),
        sandboxes: z.union([z.literal("*"), z.array(z.string())]).optional(),
        environments: z.union([z.literal("*"), z.array(z.string())]).optional(),
      }).optional(),
    }),
  ),
  catalog: looseObject({
    presets: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
});
export type BoatApiKeys = z.infer<typeof apiKeysResponse>;
const snapshotsResponse = looseObject({
  allowance: looseObject({
    included: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
  }),
});
export type BoatSnapshotAllowance = z.infer<typeof snapshotsResponse>["allowance"];

export class HttpBoatApi implements BoatApi {
  readonly #credential: BoatSecret;
  readonly #base: string;
  readonly #timeout: number;
  readonly #organization: string | undefined;

  private constructor(options: BoatApiOptions, base: string) {
    this.#credential = options.credential;
    this.#base = base;
    this.#timeout = options.timeoutMs ?? 90_000;
    this.#organization = options.organization;
  }

  static create(options: BoatApiOptions): BoatResult<HttpBoatApi> {
    try {
      const url = new URL(options.baseUrl ?? "https://boat.dev/api/v1");
      const local =
        url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/api/v1";
      if (
        (url.href !== "https://boat.dev/api/v1" && !local) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        !Number.isInteger(options.timeoutMs ?? 90_000) ||
        (options.timeoutMs ?? 90_000) <= 0 ||
        (options.organization !== undefined &&
          !boatOrganizationSchema.safeParse(options.organization).success)
      ) {
        return { ok: false, error: new BoatApiError("config", null, "invalid_config") };
      }
      return { ok: true, value: new HttpBoatApi(options, url.href) };
    } catch {
      return { ok: false, error: new BoatApiError("config", null, "invalid_config") };
    }
  }

  /** Only the durable allocation owner may retry the same body/key within Boat's 24-hour guarantee. */
  create(input: BoatCreateInput): Promise<BoatResult<BoatSandbox>> {
    const ttl = parseBoatLifetime(input.lifetime);
    if (!ttl.ok) return Promise.resolve(ttl);
    const production = "ownership" in input;
    const build = "buildOwnership" in input;
    if (
      !z.uuid().safeParse(input.idempotencyKey).success ||
      (production
        ? !(input.ownership instanceof BoatOwnership) ||
          input.lifetime.kind !== "production-session"
        : build
          ? !(input.buildOwnership instanceof BoatBuildOwnership) ||
            input.requestVersion !== 3 ||
            input.lifetime.kind !== "bounded"
          : !z.uuid().safeParse(input.marker).success ||
            input.lifetime.kind !== "bounded" ||
            (input.requestVersion !== 1 && input.requestVersion !== 2))
    ) {
      return Promise.resolve({
        ok: false,
        error: new BoatApiError("create", null, "invalid_input"),
      });
    }
    return this.#request(
      "create",
      "POST",
      "/sandboxes",
      sandboxResponse,
      {
        type: "small",
        ttlSeconds: ttl.value,
        noEnv: true,
        monitoring: false,
        ...(production || build || input.requestVersion === 2
          ? { snapshots: true, visibility: "private" }
          : {}),
        labels: production
          ? ownershipLabels(input.ownership)
          : build
            ? boatBuildOwnershipLabels(input.buildOwnership)
            : input.purpose === "key-proof"
              ? { "sealant-key-proof": input.marker }
              : {
                  "sealant-dev": "boat-stream",
                  [input.purpose === "native-build" ? "sealant-build" : "sealant-spike"]:
                    input.marker,
                },
        ...(input.from === undefined ? {} : { from: input.from }),
      },
      { "Idempotency-Key": input.idempotencyKey },
    );
  }

  /** A positive page cannot authorize adoption while any later page remains unavailable. */
  async discover(ownership: BoatOwnership | BoatBuildOwnership): Promise<BoatDiscovery> {
    const expected =
      ownership instanceof BoatBuildOwnership
        ? boatBuildOwnershipLabels(ownership)
        : ownershipLabels(ownership);
    const matches = new Map<BoatSandboxId, BoatSandbox>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const query = new URLSearchParams({ limit: "200" });
      for (const [key, value] of Object.entries(expected)) query.append("label", `${key}=${value}`);
      if (cursor !== null) query.set("cursor", cursor);
      const page = await this.#request("discover", "GET", `/sandboxes?${query}`, inventoryResponse);
      if (!page.ok) return { kind: "unknown", reason: "inventory-unavailable", error: page.error };
      for (const sandbox of page.value.sandboxes) {
        if (Object.entries(expected).every(([key, value]) => sandbox.labels?.[key] === value))
          matches.set(sandbox.id, sandbox);
      }
      cursor = page.value.pageInfo.nextCursor;
      if (cursor === null) break;
      if (seenCursors.has(cursor))
        return {
          kind: "unknown",
          reason: "inventory-unavailable",
          error: new BoatApiError("discover", null, "repeated_cursor"),
        };
      seenCursors.add(cursor);
    }
    const complete = [...matches.values()];
    const first = complete[0];
    if (first === undefined) return { kind: "unknown", reason: "no-positive-evidence" };
    return complete.length === 1
      ? { kind: "found", ownership, sandbox: first }
      : { kind: "conflict", ownership, matches: complete };
  }

  /**
   * The VMs a full check created (`sealant-key-proof` = its marker), from every page of Boat's
   * list. `unknown`: Boat did not answer completely. An empty list is not proof of absence right
   * after the create; the caller decides how long to wait before it trusts one.
   */
  async findKeyProof(
    marker: string,
  ): Promise<
    | { readonly kind: "listed"; readonly sandboxes: readonly BoatSandbox[] }
    | { readonly kind: "unknown"; readonly error: BoatApiError }
  > {
    const found: BoatSandbox[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: "200" });
      query.append("label", `sealant-key-proof=${marker}`);
      if (cursor !== null) query.set("cursor", cursor);
      const listed = await this.#request(
        "discover",
        "GET",
        `/sandboxes?${query}`,
        inventoryResponse,
      );
      if (!listed.ok) return { kind: "unknown", error: listed.error };
      for (const sandbox of listed.value.sandboxes)
        if (sandbox.labels?.["sealant-key-proof"] === marker) found.push(sandbox);
      cursor = listed.value.pageInfo.nextCursor;
      if (cursor === null) return { kind: "listed", sandboxes: found };
    }
    return { kind: "unknown", error: new BoatApiError("discover", null, "repeated_cursor") };
  }

  /**
   * Whether Boat accepts the key, by one read-only call that names no VM: the first page of the
   * VMs sealant labels as its own. It never creates, changes or deletes anything. A key Boat
   * refuses answers its typed error (401, 403); nothing about the key is in the error.
   */
  async verifyCredential(): Promise<BoatResult<void>> {
    const query = new URLSearchParams({ limit: "1" });
    query.append("label", "sealant-runtime=boat");
    const page = await this.#request("verify", "GET", `/sandboxes?${query}`, inventoryResponse);
    return page.ok ? { ok: true, value: undefined } : page;
  }

  /** Who the key is (`GET /me`). Read-only. */
  async me(): Promise<BoatResult<BoatMe>> {
    const result = await this.#request("me", "GET", "/me", meResponse);
    return result.ok ? { ok: true, value: result.value.user } : result;
  }

  /** The organizations the key's account belongs to (`GET /orgs`). Read-only. */
  async orgs(): Promise<BoatResult<readonly BoatOrg[]>> {
    const result = await this.#request("orgs", "GET", "/orgs", orgsResponse);
    return result.ok ? { ok: true, value: result.value.orgs } : result;
  }

  /** The billed wallet's limits (`GET /limits`), for the organization this client names. */
  limits(): Promise<BoatResult<BoatLimits>> {
    return this.#request("limits", "GET", "/limits", limitsResponse);
  }

  /** The account's keys (`GET /api-keys`): metadata only, never a secret. Read-only. */
  apiKeys(): Promise<BoatResult<BoatApiKeys>> {
    return this.#request("apiKeys", "GET", "/api-keys", apiKeysResponse);
  }

  /** The wallet's saved snapshot allowance (`GET /saved-snapshots`). Read-only. */
  async snapshotAllowance(): Promise<BoatResult<BoatSnapshotAllowance>> {
    const result = await this.#request(
      "listSnapshots",
      "GET",
      "/saved-snapshots",
      snapshotsResponse,
    );
    return result.ok ? { ok: true, value: result.value.allowance } : result;
  }

  /** Whether `entry` (from {@link apiKeys}) is this client's own key, by its prefix and last four. */
  isOwnKey(entry: { readonly keyPrefix: string; readonly keyLastFour: string }): boolean {
    const key = this.#credential.reveal();
    return (
      entry.keyPrefix.length > 0 &&
      entry.keyLastFour.length === 4 &&
      key.startsWith(entry.keyPrefix) &&
      key.endsWith(entry.keyLastFour)
    );
  }

  get(id: BoatSandboxId): Promise<BoatResult<BoatSandbox>> {
    return this.#request(
      "get",
      "GET",
      `/sandboxes/${id}`,
      sandboxResponse.refine((value) => value.id === id),
    );
  }

  /** Commands are never retried: an interrupted response can leave guest work running. */
  execute(
    id: BoatSandboxId,
    command: string,
    options?: {
      readonly timeoutSeconds?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BoatResult<BoatCommand>> {
    const seconds = options?.timeoutSeconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
      return Promise.resolve({
        ok: false,
        error: new BoatApiError("execute", null, "invalid_timeout"),
      });
    }
    if (seconds > 30) return this.#executeDetached(id, command, seconds, options?.signal);
    return this.#request(
      "execute",
      "POST",
      `/sandboxes/${id}/commands`,
      successSchema.extend(commandSchema.shape),
      { command, timeoutSeconds: seconds },
      undefined,
      {
        timeoutMs: Math.max(this.#timeout, seconds * 1000 + 15_000),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  }

  async #executeDetached(
    id: BoatSandboxId,
    command: string,
    seconds: number,
    cancellation?: AbortSignal,
  ): Promise<BoatResult<BoatCommand>> {
    const deadline = AbortSignal.timeout(seconds * 1000);
    const signal =
      cancellation === undefined ? deadline : AbortSignal.any([deadline, cancellation]);
    const started = await this.#request(
      "execute",
      "POST",
      `/sandboxes/${id}/commands`,
      successSchema.extend({ processId: z.number().int().positive().safe() }),
      { command, detached: true, timeoutSeconds: seconds },
      undefined,
      { timeoutMs: this.#timeout, signal },
    );
    // A lost start has no safe process handle. Never replay it; the caller owns VM reconciliation.
    if (!started.ok) return started;
    const processId = started.value.processId;
    const path = `/sandboxes/${id}/commands/${processId}`;
    const output = z.string().refine((value) => Buffer.byteLength(value) <= 8 * 1024 ** 2);
    const statusSchema = successSchema.extend({
      processId: z.literal(processId),
      status: z.enum(["running", "exited", "lost"]),
      known: z.boolean().optional(),
      running: z.boolean(),
      exitCode: z.number().int().nullable(),
      stdout: output,
      stderr: output,
      stdoutTruncated: z.literal(false).optional(),
      stderrTruncated: z.literal(false).optional(),
    });
    let finished = false;
    let tracked = true;
    try {
      for (;;) {
        const result = await this.#request(
          "commandStatus",
          "GET",
          path + "?tailBytes=8388608",
          statusSchema,
          undefined,
          undefined,
          { timeoutMs: Math.min(this.#timeout, 15_000), signal },
        );
        if (!result.ok) {
          // A status read may be repeated. Starting the command may not.
          if (result.error.code !== "transport_error" || signal.aborted) return result;
        } else {
          const status = result.value;
          if (status.status === "lost" || status.known === false) {
            tracked = false;
            return { ok: false, error: new BoatApiError("commandStatus", 200, "command_lost") };
          }
          if (!status.running && status.status === "exited") {
            finished = true;
            return {
              ok: true,
              value: {
                exitCode: status.exitCode,
                timedOut: false,
                stdout: status.stdout,
                stderr: status.stderr,
              },
            };
          }
          if (status.status !== "running" || !status.running || status.exitCode !== null)
            return { ok: false, error: new BoatApiError("commandStatus", 200, "invalid_response") };
        }
        await delay(1000, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      if (!finished && tracked) {
        // Cancellation gets its own bounded stop attempt. A missing receipt remains ambiguous;
        // the failure still reaches the caller's canonical exact VM cleanup. Never retry DELETE.
        await this.#request(
          "stopCommand",
          "DELETE",
          path,
          successSchema.extend({
            processId: z.literal(processId),
            running: z.literal(false),
            signaled: z.boolean(),
          }),
          undefined,
          undefined,
          { timeoutMs: 15_000 },
        );
      }
    }
  }

  async writeFile(
    id: BoatSandboxId,
    path: string,
    content: BoatSecret | string,
  ): Promise<BoatResult<void>> {
    if (!stagingPathSchema.safeParse(path).success)
      return { ok: false, error: new BoatApiError("writeFile", null, "invalid_path") };
    const result = await this.#request(
      "writeFile",
      "PUT",
      `/sandboxes/${id}/files`,
      successSchema,
      {
        path,
        content: content instanceof BoatSecret ? content.reveal() : content,
        encoding: "utf8",
      },
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async uploadFile(id: BoatSandboxId, path: string, bytes: Uint8Array): Promise<BoatResult<void>> {
    if (!stagingPathSchema.safeParse(path).success)
      return { ok: false, error: new BoatApiError("uploadFile", null, "invalid_path") };
    const signed = await this.#request(
      "uploadUrl",
      "POST",
      `/sandboxes/${id}/files/upload-url`,
      successSchema.extend({ url: z.string(), method: z.literal("PUT"), path: z.string() }),
      { path, ttlSeconds: 60 },
    );
    if (!signed.ok) return signed;
    const url = parseBoatUrl(signed.value.url);
    if (!url.ok || signed.value.path !== path)
      return { ok: false, error: new BoatApiError("uploadFile", null, "invalid_provider_url") };
    let status: number | null = null;
    try {
      const response = await boatFetch(
        url.value,
        {
          method: "PUT",
          body: Buffer.from(bytes),
          redirect: "error",
          signal: AbortSignal.timeout(this.#timeout),
        },
        this.#timeout,
      );
      status = response.status;
      await response.body?.cancel();
      return response.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: new BoatApiError("uploadFile", response.status, "upload_failed") };
    } catch (error) {
      return { ok: false, error: new BoatApiError("uploadFile", status, "transport_error", error) };
    }
  }

  async hostControl(id: BoatSandboxId): Promise<BoatResult<BoatHostedControl>> {
    const result = await this.#request(
      "host",
      "POST",
      `/sandboxes/${id}/host`,
      successSchema.extend({ url: z.string(), isProtected: z.literal(true) }),
      { port: 8080, public: false, localhost: false },
    );
    return result.ok ? parseBoatHostedControl(result.value.url) : result;
  }

  /** Archive can retain a live machine; this is not termination or a writer fence. */
  async stop(id: BoatSandboxId): Promise<BoatResult<void>> {
    const result = await this.#request("stop", "POST", `/sandboxes/${id}/stop`, successSchema, {});
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async resume(id: BoatSandboxId, lifetime: BoatLifetime): Promise<BoatResult<BoatSandbox>> {
    const ttl = parseBoatLifetime(lifetime);
    if (!ttl.ok) return ttl;
    const result = await this.#request("resume", "POST", `/sandboxes/${id}/resume`, successSchema, {
      type: "small",
      ttlSeconds: ttl.value,
      noEnv: true,
    });
    return result.ok ? this.get(id) : result;
  }

  deleteSandbox(id: BoatSandboxId): Promise<BoatResult<BoatDeletion>> {
    return this.#request(
      "deleteSandbox",
      "DELETE",
      `/sandboxes/${id}`,
      deletionResponse,
      undefined,
      { "X-Ascii-Confirm-Delete": id },
    );
  }

  getDeletion(id: BoatDeletionId): Promise<BoatResult<BoatDeletion>> {
    return this.#request("getDeletion", "GET", `/deletion-operations/${id}`, deletionResponse);
  }

  /** Saved snapshots have no labels field; ownership requires a unique name and recorded source. */
  saveSnapshot(id: BoatSandboxId, name: BoatSnapshotName): Promise<BoatResult<BoatSavedSnapshot>> {
    return this.#request("saveSnapshot", "POST", "/saved-snapshots", snapshotResponse, {
      sandboxId: id,
      name,
    });
  }

  getSnapshot(name: BoatSnapshotName): Promise<BoatResult<BoatSavedSnapshot>> {
    return this.#request("getSnapshot", "GET", `/saved-snapshots/${name}`, snapshotResponse);
  }

  async deleteSnapshot(name: BoatSnapshotName): Promise<BoatResult<void>> {
    const result = await this.#request(
      "deleteSnapshot",
      "DELETE",
      `/saved-snapshots/${name}`,
      successSchema.extend({ name: z.literal(name), status: z.literal("deleted") }),
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async #request<T>(
    operation: string,
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    extra?: Record<string, string>,
    options?: {
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BoatResult<T>> {
    let status: number | null = null;
    try {
      const response = await boatFetch(
        `${this.#base}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.#credential.reveal()}`,
            "Content-Type": "application/json",
            ...(this.#organization === undefined ? {} : { "X-Boat-Org": this.#organization }),
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal:
            options?.signal === undefined
              ? AbortSignal.timeout(options?.timeoutMs ?? this.#timeout)
              : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
          redirect: "error",
        },
        options?.timeoutMs ?? this.#timeout,
      );
      status = response.status;
      const data: unknown = await response.json();
      if (!response.ok) {
        const permission = permissionFor(operation);
        const boat = classifyBoatRefusal({
          operation,
          status,
          body: data,
          retryAfterHeader: response.headers.get("retry-after"),
          ...(permission === undefined ? {} : { permission }),
          secrets: [this.#credential.reveal()],
        });
        // Boat's own code, bounded to its shape; `provider_error` when it sent none.
        return {
          ok: false,
          error: new BoatApiError(
            operation,
            status,
            boat.code ?? "provider_error",
            undefined,
            boat,
          ),
        };
      }
      const parsed = schema.safeParse(data);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: new BoatApiError(operation, status, "invalid_response") };
    } catch (error) {
      const transport = new BoatApiError(operation, status, "transport_error", error);
      const malformed = new Set(["unknown", "Error", "SyntaxError", "RangeError"]);
      return {
        ok: false,
        error:
          status === null || (transport.causeClass !== null && !malformed.has(transport.causeClass))
            ? transport
            : new BoatApiError(operation, status, "invalid_response", error),
      };
    }
  }
}
