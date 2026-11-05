import { z } from "zod";

import {
  BoatApiError,
  BoatSecret,
  boatDeletionIdSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  parseBoatUrl,
  type BoatDeletionId,
  type BoatResult,
  type BoatSandboxId,
  type BoatSnapshotName,
} from "./config.js";
import { parseBoatHostedControl, type BoatHostedControl } from "./connection.js";

const sandboxSchema = z.object({
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
});
/** Archived sandboxes can still have live writers during Boat's grace period. No state fences writers. */
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
const safeCodes = new Set([
  "unauthorized",
  "sandbox_not_found",
  "not_found",
  "snapshot_not_found",
  "rate_limited",
  "idempotency_in_progress",
  "idempotency_key_reused",
  "trial_saved_snapshots_not_allowed",
  "no_ready_machine",
  "machine_class_plan_required",
  "insufficient_balance",
]);
const codeSchema = z.object({ code: z.string() });
const stagingPathSchema = z
  .string()
  .regex(/^\/home\/user\/sealant-dev-boat-stream-[a-f0-9-]{36}\/[A-Za-z0-9._/-]+$/)
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."));

export interface BoatApi {
  create(input: {
    readonly marker: string;
    readonly idempotencyKey: string;
    readonly from?: BoatSnapshotName;
    readonly purpose?: "native-build";
    readonly ttlSeconds?: number;
  }): Promise<BoatResult<BoatSandbox>>;
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
  resume(id: BoatSandboxId): Promise<BoatResult<void>>;
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
}

export class HttpBoatApi implements BoatApi {
  readonly #credential: BoatSecret;
  readonly #base: string;
  readonly #timeout: number;

  private constructor(options: BoatApiOptions, base: string) {
    this.#credential = options.credential;
    this.#base = base;
    this.#timeout = options.timeoutMs ?? 90_000;
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
        (options.timeoutMs ?? 90_000) <= 0
      ) {
        return { ok: false, error: new BoatApiError("config", null, "invalid_config") };
      }
      return { ok: true, value: new HttpBoatApi(options, url.href) };
    } catch {
      return { ok: false, error: new BoatApiError("config", null, "invalid_config") };
    }
  }

  /** Reusing the same marker, key and source retries the same allocation for 24 hours. */
  create(input: {
    readonly marker: string;
    readonly idempotencyKey: string;
    readonly from?: BoatSnapshotName;
    readonly purpose?: "native-build";
    readonly ttlSeconds?: number;
  }): Promise<BoatResult<BoatSandbox>> {
    if (
      !z.uuid().safeParse(input.marker).success ||
      !z.uuid().safeParse(input.idempotencyKey).success ||
      !z
        .number()
        .int()
        .min(60)
        .max(1800)
        .safeParse(input.ttlSeconds ?? 900).success
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
        ttlSeconds: input.ttlSeconds ?? 900,
        noEnv: true,
        monitoring: false,
        labels: {
          "sealant-dev": "boat-stream",
          [input.purpose === "native-build" ? "sealant-build" : "sealant-spike"]: input.marker,
        },
        ...(input.from === undefined ? {} : { from: input.from }),
      },
      { "Idempotency-Key": input.idempotencyKey },
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
    try {
      const response = await fetch(url.value, {
        method: "PUT",
        body: Buffer.from(bytes),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeout),
      });
      await response.body?.cancel();
      return response.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: new BoatApiError("uploadFile", response.status, "upload_failed") };
    } catch {
      return { ok: false, error: new BoatApiError("uploadFile", null, "transport_error") };
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

  async resume(id: BoatSandboxId): Promise<BoatResult<void>> {
    const result = await this.#request("resume", "POST", `/sandboxes/${id}/resume`, successSchema, {
      ttlSeconds: 900,
      noEnv: true,
    });
    return result.ok ? { ok: true, value: undefined } : result;
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
    options?: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<BoatResult<T>> {
    let status: number | null = null;
    try {
      const response = await fetch(`${this.#base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#credential.reveal()}`,
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal:
          options?.signal === undefined
            ? AbortSignal.timeout(options?.timeoutMs ?? this.#timeout)
            : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
        redirect: "error",
      });
      status = response.status;
      const data: unknown = await response.json();
      if (!response.ok) {
        const parsed = codeSchema.safeParse(data);
        const code =
          parsed.success && safeCodes.has(parsed.data.code) ? parsed.data.code : "provider_error";
        return { ok: false, error: new BoatApiError(operation, status, code) };
      }
      const parsed = schema.safeParse(data);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: new BoatApiError(operation, status, "invalid_response") };
    } catch {
      return {
        ok: false,
        error: new BoatApiError(
          operation,
          status,
          status === null ? "transport_error" : "invalid_response",
        ),
      };
    }
  }
}
