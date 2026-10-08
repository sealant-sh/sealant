/**
 * Idiomatic Effect-TS service wrapping the proven sealantd control transport (P3) and the
 * `@sealant/runtime-client` SDK (P5 of the sealantd -> sealant-core integration).
 *
 * Layering mirrors the established package idiom (see `packages/db/src/repositories/workspaces.ts`,
 * `packages/jobs/src/service.ts`, `packages/source-integrations/src/github/{service,layer}.ts`):
 *   - service contracts are plain `interface`s whose methods return `Effect.Effect<A, Error>`;
 *   - the public handle is a `Context.Tag` class; the implementation is wired with `Layer.effect`;
 *   - failures are `Schema.TaggedError`s funnelled through a `map*Error`/`with*Error` helper so no
 *     raw exceptions escape the Effect channel.
 *
 * What this adds on top of that idiom — and why it is new ground for the package:
 *   - `SealantTransport` is a *pluggable* seam. `open(target)` yields a scoped Node `Duplex` carrying
 *     the length-prefixed protobuf control frames. The live transport connects directly to a
 *     persisted host Unix socket when available and retains the P3
 *     `docker exec -i <ctr> socat - UNIX-CONNECT:<sock>` bridge as a fallback.
 *   - `SealantRuntime.connect(target)` is `Scope`-d: it acquires the transport + a `SealantClient`
 *     via `Effect.acquireRelease`, and the release finalizer closes the client (and, transitively,
 *     the transport child). This is the first scoped-resource service in the package; it follows the
 *     Effect resource-safety contract rather than ad-hoc `try/finally`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";

import type { ExecutorOrigin } from "@sealant/db";
import {
  SealantClient,
  SealantError as SdkSealantError,
  type Channel,
} from "@sealant/runtime-client";
import {
  CaptureClass as WireCaptureClass,
  CaptureFlushKind as WireCaptureFlushKind,
  SessionMode as WireSessionMode,
  type Capabilities,
  type CaptureReplanned,
  type CaptureStatusReport,
  type DotfilesApplied,
  type EventEnvelope,
  type ExecAccepted,
  type HealthReport,
} from "@sealant/runtime-protocol";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import type * as Scope from "effect/Scope";
import { WebSocket, createWebSocketStream } from "ws";

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/**
 * Addresses a single sealantd instance for a transport to reach. The shape is a discriminated union
 * so additional transports (ssh-gateway, k8s exec) can introduce their own variants without widening
 * the docker case.
 */
export type SealantTarget =
  | {
      readonly kind: "docker-exec";
      /** Container id or name to `docker exec` into. */
      readonly containerId: string;
      /** Absolute path of the control socket inside the container. */
      readonly socketPath: string;
    }
  | {
      readonly kind: "unix-socket";
      /** Absolute path of a control socket exposed on this host. */
      readonly socketPath: string;
    }
  | {
      /**
       * A WebSocket control frontend carrying the exact length-prefixed protobuf byte stream as
       * binary messages. Two authentication shapes, at least one REQUIRED — an unauthenticated
       * control connection is never opened:
       *
       *  - `tls`: client mTLS against sealantd's native `wss://…/control` frontend (Kubernetes,
       *    cluster-internal CA).
       *  - `auth`: a bearer token presented on the upgrade request, for endpoints where a trusted
       *    intermediary terminates auth before the daemon (the Cloudflare bridge Worker); the
       *    server certificate verifies against public PKI (or `tls.caPath` when also set).
       */
      readonly kind: "websocket";
      /** `wss://<service>.<namespace>.svc:<port>/control`, or the bridge's control URL. */
      readonly url: string;
      readonly tls?: SealantWebSocketClientTls | undefined;
      readonly auth?: { readonly bearerToken: string } | undefined;
      /**
       * Per-connection material minted at open time, for endpoints fronted by a platform proxy
       * that authenticates every connection with a short-lived credential of its own (AWS Lambda
       * MicroVMs: a ≤ 60-minute endpoint token carried as WebSocket subprotocols). Called once per
       * `open`; a rejection fails the open. Never a substitute for `tls` / `auth` — those
       * authenticate the control plane to the daemon side, this authenticates it to the proxy.
       */
      readonly prepare?: (() => Promise<WebSocketConnectMaterial>) | undefined;
    };

/** What `prepare` adds to one WebSocket upgrade: extra headers and/or subprotocols. */
export interface WebSocketConnectMaterial {
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly protocols?: readonly string[] | undefined;
}

/** Client-side mTLS material for the `websocket` target: PEM file paths, read at open time. */
export interface SealantWebSocketClientTls {
  /** CA bundle that signed the workspace server certificate. */
  readonly caPath: string;
  /** Control-plane client certificate (must carry the `clientAuth` EKU). */
  readonly certPath: string;
  readonly keyPath: string;
  /** Overrides SNI/verification name; defaults to the URL host. */
  readonly servername?: string;
}

// ---------------------------------------------------------------------------------------------
// Errors (Schema.TaggedError — matches packages/db + source-integrations idiom)
// ---------------------------------------------------------------------------------------------

/** Operations surfaced on the typed error channel, kept constrained for consistent metadata. */
const sealantOperationSchema = Schema.Literals([
  "open",
  "connect",
  "health",
  "capabilities",
  "exec",
  "writeStdin",
  "closeStdin",
  "signalProcess",
  "shutdown",
  "events",
  "openSession",
  "closeSession",
  "resizePty",
  "listSessions",
  "writeSessionInput",
  "attachSession",
  "openForward",
  "closeForward",
  "bindMount",
  "captureFlush",
  "captureStatus",
  "captureReplan",
  "dotfilesApply",
]);

export type SealantOperation = typeof sealantOperationSchema.Type;

/** The closed set of forward targets: workspace loopback, or the dind sidecar's alias. */
export type SealantForwardHost = "127.0.0.1" | "localhost" | "docker";

/**
 * Forward transport: a TCP byte stream (default), or connected UDP where one
 * channel frame is exactly one datagram — the conduit is message-framed end
 * to end, so boundaries survive the whole relay.
 */
export type SealantForwardProtocol = "tcp" | "udp";

/** Failure opening/holding the underlying transport (spawn failure, child exit, stream error). */
export class TransportError extends Schema.TaggedErrorClass<TransportError>()("TransportError", {
  operation: sealantOperationSchema,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A typed control error returned by the daemon (wraps the SDK's `SealantError`). */
export class SealantControlError extends Schema.TaggedErrorClass<SealantControlError>()(
  "SealantControlError",
  {
    operation: sealantOperationSchema,
    /** Stable daemon error code (numeric `ControlErrorCode`). */
    code: Schema.Number,
    message: Schema.String,
    detailJson: Schema.optional(Schema.String),
  },
) {}

/** Any other unexpected defect crossing the SDK boundary, kept on the typed channel. */
export class SealantUnexpectedError extends Schema.TaggedErrorClass<SealantUnexpectedError>()(
  "SealantUnexpectedError",
  {
    operation: sealantOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const sealantErrorSchema = Schema.Union([
  TransportError,
  SealantControlError,
  SealantUnexpectedError,
]);

/**
 * The daemon's capture status after a flush (wire `CaptureStatusReport`), with JSON-safe numbers:
 * `pending` and `fenced` are what a caller gates on before letting an executor go away.
 */
export interface CaptureFlushReport {
  readonly epoch: number;
  readonly worktreeId: string;
  readonly headN?: number | undefined;
  readonly pending: number;
  readonly stagedBytes: number;
  readonly uploadedObjects: number;
  readonly uploadedBytes: number;
  readonly registered: number;
  readonly fenced: boolean;
  readonly paused: boolean;
  readonly lastSnapUnixMs?: number | undefined;
  /**
   * Capture classes the registrar refused for the session's byte quota: nothing of these ships
   * until the next epoch or `capture.replan`. Non-empty means work is NOT being saved.
   */
  readonly refused: readonly CaptureClassName[];
  /**
   * The agreed FINAL semantics (sealantd `capture.flush` kind FINAL): true only when the daemon
   * quiesced every managed process, then snapshotted the small AND bulk classes, and registered
   * everything. The ONLY proof a capture-sourced executor may go away: `pending === 0` alone is
   * not (a daemon that never snapshotted bulk reports an empty queue). Absent from every daemon
   * that predates the field, which a consumer reads as not complete.
   */
  readonly complete?: boolean | undefined;
  /** Bytes staged on the executor that no upload has taken yet (sealantd `pending_bytes`). */
  readonly pendingBytes?: number | undefined;
  /** Of `pending`, the bulk captures still uploading (sealantd `pending_bulk`). */
  readonly pendingBulk?: number | undefined;
  /**
   * Why the last final flush is not complete (sealantd `incomplete_reason`): `not-final`,
   * `in-progress`, `processes-remain`, `sweep-unavailable`, `snapshot-failed`, `unreadable`,
   * `fenced`, `conflict`, `deadline`, `ship-failed`, `pending`, `sealing` (nothing pending, the
   * chain's seal not yet acknowledged: ask for FINAL again), `changed` (the disk changed after
   * the final flush's snap: not saved, ask for FINAL again), `store-fidelity` (the store cannot
   * hold every manifest feature the daemon writes: a FINAL never completes there), `internal`.
   * A class whose last
   * snap failed (`snaps`) is `snapshot-failed` too. Absent when complete, or from a daemon that
   * predates it. Every reason is not saved; only `complete: true` is.
   */
  readonly incompleteReason?: string | undefined;
  /**
   * Paths the last snap of each class could not read, summed over both classes (sealantd
   * `unreadable`). Never taken as deleted: an automatic snap carries the last captured content
   * forward, a final snap fails instead.
   */
  readonly unreadable?: number | undefined;
  /** Of `unreadable`, the paths whose last captured content was carried forward (`carried`). */
  readonly carried?: number | undefined;
  /**
   * The first unreadable paths, virtual (`tree/<path>`, `.git/<path>`, `harness/<path>`), small
   * class first (sealantd `unreadable_paths`, at most 20). Absent when none are reported.
   */
  readonly unreadablePaths?: readonly string[] | undefined;
  /**
   * A capture the registrar refused to register that the executor is working through
   * (`missing-objects`, `unrestorable`; sealantd `register_refused`). Nothing is dropped: its
   * objects are uploaded again and it is rebuilt from disk.
   */
  readonly registerRefused?: string | undefined;
  /** That refused capture's chain position (`register_refused_n`). */
  readonly registerRefusedN?: number | undefined;
  /** The first keys the registrar named as missing (`register_missing`, at most 20). */
  readonly registerMissing?: readonly string[] | undefined;
  /** Register refusals the daemon has seen since it started (`register_refusals`). */
  readonly registerRefusals?: number | undefined;
  /** The refused capture waits to be rebuilt from disk; nothing behind it registers first. */
  readonly repairing?: boolean | undefined;
  /**
   * A bulk build is in progress (`bulk_building`): its capture is not queued yet, so `pending`
   * does not count it. A drain is not done while this is true.
   */
  readonly bulkBuilding?: boolean | undefined;
  /**
   * Each captured class's snaps (sealantd `snaps`, `CaptureClassSnaps`): how many failed, and
   * the last one's error while it fails. A snap that fails stages nothing: what changed since the
   * last capture is on the executor's disk only. Absent from a daemon that predates it.
   */
  readonly snaps?: readonly CaptureClassSnaps[] | undefined;
  /**
   * Derived from `snaps` for consumers that read one error: the error of the class that has been
   * failing longest. Present means the executor's newest work is NOT being captured, whatever
   * `pending` says. Absent while no class's last snap failed.
   */
  readonly lastSnapError?: string | undefined;
  /** Derived from `snaps`: when the earliest current run of failed snaps began (Unix ms). */
  readonly snapFailingSinceUnixMs?: number | undefined;
  /** Derived from `snaps`: failed snaps of every class since the daemon started. */
  readonly snapsFailed?: number | undefined;
  /**
   * Where in the executor's own history this answer was made (decision 17): its epoch, launch,
   * boot, boot generation and an observation number that only grows within the boot, with the
   * capture head. Core
   * orders and supersedes evidence by it, never by its own clocks (`statusSupersedes`). Absent
   * from a daemon that predates the stamp: such answers cannot be ordered by position, and
   * evidence nothing else orders fails closed.
   */
  readonly origin?: ExecutorOrigin | undefined;
  /**
   * A capture step running past its bound (sealantd `overdue`, 31): what is running, since when,
   * for how long and against which bound. Present only while a step is past its bound; absent
   * from a daemon that predates it. Reported so a stuck capture is visible while it is stuck; it
   * is not a verdict — the step's own limit kills it and the snap fails (`snaps`).
   */
  readonly overdue?: CaptureOverdue | undefined;
  /**
   * The executor booted under an owner map (sealantd `owner_map`, 32). False from a daemon that
   * predates it.
   */
  readonly ownerMap?: boolean | undefined;
}

/** A capture step past its bound (wire `CaptureOverdue`). */
export interface CaptureOverdue {
  /** What is running, outermost first, `›`-separated (`small snap › git cat-file --batch-check`). */
  readonly step: string;
  /** When it started, Unix ms (display only: evidence is ordered by `origin`). */
  readonly startedUnixMs: number;
  /** How long it had been running when the answer was computed, ms. */
  readonly runningMs: number;
  /** How long it is expected to take at most, ms. */
  readonly boundMs: number;
}

/** One capture class's snaps (wire `CaptureClassSnaps`). */
export interface CaptureClassSnaps {
  readonly class: CaptureClassName;
  /** Snaps of this class that failed since the daemon started. */
  readonly snapsFailed: number;
  /** The last snap's error, while the last snap failed; absent once one succeeds. */
  readonly lastSnapError?: string | undefined;
  /** When the current run of failed snaps began (Unix ms), while the last snap failed. */
  readonly snapFailingSinceUnixMs?: number | undefined;
}

/**
 * The flat snap-failure fields derived from `snaps`: the error of the class failing longest (a
 * failing class that reports no start counts as the newest), the earliest start, and the sum of
 * failed snaps. Absent `snaps` derives nothing. Exported for the drain and tests.
 */
export const snapFailureSummary = (
  snaps: readonly CaptureClassSnaps[] | undefined,
): Pick<CaptureFlushReport, "lastSnapError" | "snapFailingSinceUnixMs" | "snapsFailed"> => {
  if (snaps === undefined) {
    return {};
  }
  const snapsFailed = snaps.reduce((sum, entry) => sum + entry.snapsFailed, 0);
  let longest: CaptureClassSnaps | undefined;
  for (const entry of snaps) {
    if (entry.lastSnapError === undefined) {
      continue;
    }
    const since = entry.snapFailingSinceUnixMs ?? Number.POSITIVE_INFINITY;
    const longestSince = longest?.snapFailingSinceUnixMs ?? Number.POSITIVE_INFINITY;
    if (longest === undefined || since < longestSince) {
      longest = entry;
    }
  }
  const earliest = snaps.reduce<number | undefined>(
    (min, entry) =>
      entry.lastSnapError === undefined || entry.snapFailingSinceUnixMs === undefined
        ? min
        : min === undefined
          ? entry.snapFailingSinceUnixMs
          : Math.min(min, entry.snapFailingSinceUnixMs),
    undefined,
  );
  return {
    snapsFailed,
    ...(longest?.lastSnapError === undefined ? {} : { lastSnapError: longest.lastSnapError }),
    ...(earliest === undefined ? {} : { snapFailingSinceUnixMs: earliest }),
  };
};

/**
 * What a `capture.flush` asks for. `final`: this executor is ending — the daemon stops admitting
 * processes, terminates and awaits every managed one, snapshots both classes, then ships until
 * nothing is pending, and reports `complete`. `suspend`: today's meaning (checkpoint / handoff;
 * processes keep running).
 *
 * After a final flush the daemon refuses exec, sessions, sftp, execution starts, binds and
 * replans for good: the executor is never reused, and whatever must be read from it (credential
 * sync-back) is read before.
 *
 * Sent as the wire's `CaptureFlushArgs { kind = 1, deadline_ms = 2, grace_ms = 3 }` (sealantd
 * 0.19.0). A daemon before 0.19.0 reads the message as empty and runs its only flush, whatever
 * `kind` says.
 */
export interface CaptureFlushRequest {
  readonly kind: "final" | "suspend";
  /** How long the daemon may take (wire `deadline_ms`). */
  readonly deadlineMs?: number;
  /**
   * Final only: how long managed processes get between SIGTERM and SIGKILL (wire `grace_ms`),
   * counted inside `deadlineMs`.
   */
  readonly graceMs?: number;
}

/** A capture class as the control plane names it (wire `CaptureClass`). */
export type CaptureClassName = "small" | "bulk";

const captureClassName = (value: WireCaptureClass): CaptureClassName | undefined =>
  value === WireCaptureClass.SMALL ? "small" : value === WireCaptureClass.BULK ? "bulk" : undefined;

/** Wire → report: uint64 fields arrive as bigint and become JSON-safe numbers. Exported for tests. */
export const captureFlushReportFromWire = (report: CaptureStatusReport): CaptureFlushReport => ({
  epoch: Number(report.epoch),
  worktreeId: report.worktreeId,
  ...(report.headN === undefined ? {} : { headN: Number(report.headN) }),
  pending: Number(report.pending),
  stagedBytes: Number(report.stagedBytes),
  uploadedObjects: Number(report.uploadedObjects),
  uploadedBytes: Number(report.uploadedBytes),
  registered: Number(report.registered),
  fenced: report.fenced,
  paused: report.paused,
  ...(report.lastSnapUnixMs === undefined ? {} : { lastSnapUnixMs: Number(report.lastSnapUnixMs) }),
  refused: report.refused.flatMap((value) => {
    const name = captureClassName(value);
    return name === undefined ? [] : [name];
  }),
  // Fields a newer daemon reports (sealantd 13-31, the origin stamp and `overdue` included). One
  // structural reader for every path (status, flush, a lost FINAL read again): a typed helper that
  // names fields one by one drops what it forgets (review 11: origin). The pinned wire
  // type does not declare them, so they are read structurally: a 0.18.2 message never carries
  // them and they stay absent (complete = unknown).
  ...optionalWireFields(report),
});

const wireCount = (value: unknown): number | undefined =>
  typeof value === "bigint" || typeof value === "number" ? Number(value) : undefined;

const wireText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const wireTexts = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const texts = value.filter((item): item is string => typeof item === "string");
  return texts.length === 0 ? undefined : texts;
};

/** A field `report` carries, read structurally; `undefined` when it does not carry it. */
const wireField = (report: object, key: string): unknown =>
  key in report ? Reflect.get(report, key) : undefined;

type OptionalWireField =
  | "complete"
  | "pendingBytes"
  | "pendingBulk"
  | "incompleteReason"
  | "unreadable"
  | "carried"
  | "unreadablePaths"
  | "registerRefused"
  | "registerRefusedN"
  | "registerMissing"
  | "registerRefusals"
  | "repairing"
  | "bulkBuilding"
  | "snaps"
  | "lastSnapError"
  | "snapFailingSinceUnixMs"
  | "snapsFailed"
  | "origin"
  | "overdue"
  | "ownerMap";

/** One wire `CaptureClassSnaps`, read structurally; `undefined` for an unknown class. */
const wireClassSnaps = (value: unknown): CaptureClassSnaps | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const classValue = wireField(value, "class");
  const name =
    classValue === WireCaptureClass.SMALL
      ? "small"
      : classValue === WireCaptureClass.BULK
        ? "bulk"
        : undefined;
  if (name === undefined) {
    return undefined;
  }
  const lastSnapError = wireText(wireField(value, "lastSnapError"));
  const snapFailingSinceUnixMs = wireCount(wireField(value, "snapFailingSinceUnixMs"));
  return {
    class: name,
    snapsFailed: wireCount(wireField(value, "snapsFailed")) ?? 0,
    ...(lastSnapError === undefined ? {} : { lastSnapError }),
    ...(snapFailingSinceUnixMs === undefined ? {} : { snapFailingSinceUnixMs }),
  };
};

/** Wire `snaps` (26); absent when the message does not carry it or carries no known class. */
const wireSnaps = (value: unknown): readonly CaptureClassSnaps[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const snaps = value.flatMap((item) => {
    const entry = wireClassSnaps(item);
    return entry === undefined ? [] : [entry];
  });
  return snaps.length === 0 ? undefined : snaps;
};

/**
 * Every CaptureStatusReport field past the pinned wire (sealantd 13–31), read structurally: a
 * field the message does not carry stays absent, never a default. The flat snap-failure fields
 * are derived from `snaps`.
 */
const optionalWireFields = (report: object): Pick<CaptureFlushReport, OptionalWireField> => {
  const complete = wireField(report, "complete");
  const repairing = wireField(report, "repairing");
  const bulkBuilding = wireField(report, "bulkBuilding");
  const ownerMap = wireField(report, "ownerMap");
  const pendingBytes = wireCount(wireField(report, "pendingBytes"));
  const pendingBulk = wireCount(wireField(report, "pendingBulk"));
  const unreadable = wireCount(wireField(report, "unreadable"));
  const carried = wireCount(wireField(report, "carried"));
  const registerRefusedN = wireCount(wireField(report, "registerRefusedN"));
  const registerRefusals = wireCount(wireField(report, "registerRefusals"));
  const snaps = wireSnaps(wireField(report, "snaps"));
  const incompleteReason = wireText(wireField(report, "incompleteReason"));
  const registerRefused = wireText(wireField(report, "registerRefused"));
  const unreadablePaths = wireTexts(wireField(report, "unreadablePaths"));
  const registerMissing = wireTexts(wireField(report, "registerMissing"));
  return {
    ...(typeof complete === "boolean" ? { complete } : {}),
    ...(pendingBytes === undefined ? {} : { pendingBytes }),
    ...(pendingBulk === undefined ? {} : { pendingBulk }),
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
    ...(unreadable === undefined ? {} : { unreadable }),
    ...(carried === undefined ? {} : { carried }),
    ...(unreadablePaths === undefined ? {} : { unreadablePaths }),
    ...(registerRefused === undefined ? {} : { registerRefused }),
    ...(registerRefusedN === undefined ? {} : { registerRefusedN }),
    ...(registerMissing === undefined ? {} : { registerMissing }),
    ...(registerRefusals === undefined ? {} : { registerRefusals }),
    ...(typeof repairing === "boolean" ? { repairing } : {}),
    ...(typeof bulkBuilding === "boolean" ? { bulkBuilding } : {}),
    ...(snaps === undefined ? {} : { snaps }),
    ...snapFailureSummary(snaps),
    ...wireOrigin(report),
    ...wireOverdue(wireField(report, "overdue")),
    ...(typeof ownerMap === "boolean" ? { ownerMap } : {}),
  };
};

/** The request as the wire's `CaptureFlushArgs`: kind, and deadline and grace when given. */
const captureFlushArgs = (request: CaptureFlushRequest | undefined) => ({
  kind: request?.kind === "final" ? WireCaptureFlushKind.FINAL : WireCaptureFlushKind.SUSPEND,
  ...(request?.deadlineMs === undefined
    ? {}
    : { deadlineMs: BigInt(Math.max(0, Math.round(request.deadlineMs))) }),
  ...(request?.graceMs === undefined
    ? {}
    : { graceMs: BigInt(Math.max(0, Math.round(request.graceMs))) }),
});

/**
 * Wire `overdue` (31): a capture step past its bound. Every field or none: a message that names
 * no step, or lacks any figure, reports nothing overdue.
 */
const wireOverdue = (value: unknown): Pick<CaptureFlushReport, "overdue"> => {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const step = wireText(wireField(value, "step"));
  const startedUnixMs = wireCount(wireField(value, "startedUnixMs"));
  const runningMs = wireCount(wireField(value, "runningMs"));
  const boundMs = wireCount(wireField(value, "boundMs"));
  if (
    step === undefined ||
    startedUnixMs === undefined ||
    runningMs === undefined ||
    boundMs === undefined
  ) {
    return {};
  }
  return { overdue: { step, startedUnixMs, runningMs, boundMs } };
};

/**
 * The executor-origin stamp a newer daemon puts on every status and FINAL answer (decision 17):
 * wire `launch` (27), `boot_id` (28), `boot_generation` (29) and `observation` (30), with the
 * report's own `epoch` and `head_n`. A stamp missing any of them orders nothing and is dropped.
 */
const wireOrigin = (report: object): Pick<CaptureFlushReport, "origin"> => {
  const epoch = wireCount(wireField(report, "epoch"));
  const launch = wireText(wireField(report, "launch"));
  const bootId = wireText(wireField(report, "bootId"));
  const bootGeneration = wireCount(wireField(report, "bootGeneration"));
  const observation = wireCount(wireField(report, "observation"));
  const headN = wireCount(wireField(report, "headN"));
  if (
    epoch === undefined ||
    launch === undefined ||
    bootId === undefined ||
    bootGeneration === undefined ||
    observation === undefined
  ) {
    return {};
  }
  return {
    origin: {
      epoch,
      launch,
      bootId,
      bootGeneration,
      observation,
      ...(headN === undefined ? {} : { headN }),
    },
  };
};

/**
 * The daemon's answer to `capture.replan` (wire `CaptureReplanned`), with JSON-safe numbers: the
 * worktree and epoch the executor now captures under, and what the delta materialise touched.
 * `unchanged` is the idempotent case (the plan answered the worktree and epoch already in force).
 */
export interface CaptureReplanReport {
  readonly worktreeId: string;
  readonly epoch: number;
  readonly headN?: number | undefined;
  readonly headCaptureId?: string | undefined;
  readonly filesWritten: number;
  readonly bytesWritten: number;
  readonly filesSkipped: number;
  readonly bytesSkipped: number;
  readonly removed: number;
  readonly unchanged: boolean;
}

/** Wire → report: uint64 fields arrive as bigint and become JSON-safe numbers. Exported for tests. */
export const captureReplanReportFromWire = (report: CaptureReplanned): CaptureReplanReport => ({
  worktreeId: report.worktreeId,
  epoch: Number(report.epoch),
  ...(report.headN === undefined ? {} : { headN: Number(report.headN) }),
  ...(report.headCaptureId === undefined ? {} : { headCaptureId: report.headCaptureId }),
  filesWritten: Number(report.filesWritten),
  bytesWritten: Number(report.bytesWritten),
  filesSkipped: Number(report.filesSkipped),
  bytesSkipped: Number(report.bytesSkipped),
  removed: Number(report.removed),
  unchanged: report.unchanged,
});

/** Union of everything that can fail on a `SealantRuntime`/`SealantSession` Effect. */
export type SealantError = typeof sealantErrorSchema.Type;

/**
 * Recognizes the SDK's `SealantError`. Prefers `instanceof`, but falls back to a structural check
 * (an `Error` named `SealantError` carrying a numeric `code`) so the typed control error survives a
 * module-instance boundary — e.g. a bundler/test runner that loads `@sealant/runtime-client` twice,
 * which would otherwise defeat `instanceof` across realms.
 */
const isSdkSealantError = (
  cause: unknown,
): cause is { readonly code: number; readonly message: string; readonly detailJson?: string } => {
  if (cause instanceof SdkSealantError) {
    return true;
  }

  return (
    cause instanceof Error &&
    cause.name === "SealantError" &&
    typeof (cause as { code?: unknown }).code === "number"
  );
};

/**
 * Unwraps Effect's wrapper for a rejected `Effect.tryPromise` (effect 4 tags it `UnknownError`;
 * effect 3 used `UnknownException`) so the original SDK rejection is classified, not the Effect
 * wrapper. The wrapper exposes the original rejection on its `cause` field.
 */
const unwrapEffectCause = (cause: unknown): unknown => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    (cause as { cause?: unknown }).cause !== undefined
  ) {
    const name = (cause as { name?: unknown }).name;

    if (name === "UnknownError" || name === "UnknownException") {
      return (cause as { cause: unknown }).cause;
    }
  }

  return cause;
};

/** Maps an unknown defect from the SDK boundary onto the typed `SealantError` channel. */
const mapSealantError = (operation: SealantOperation, rawCause: unknown): SealantError => {
  const cause = unwrapEffectCause(rawCause);

  if (
    cause instanceof TransportError ||
    cause instanceof SealantControlError ||
    cause instanceof SealantUnexpectedError
  ) {
    return cause;
  }

  if (isSdkSealantError(cause)) {
    return new SealantControlError({
      operation,
      code: cause.code,
      message: cause.message,
      ...(cause.detailJson === undefined ? {} : { detailJson: cause.detailJson }),
    });
  }

  return new SealantUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

/** Wraps an Effect so any defect is remapped onto the typed `SealantError` channel. */
const withSealantError = <A, R>(
  operation: SealantOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, SealantError, R> => {
  return effect.pipe(Effect.mapError((cause) => mapSealantError(operation, cause)));
};

// ---------------------------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------------------------

/**
 * Pluggable control-channel transport. `open` yields a `Duplex` carrying the raw, length-prefixed
 * protobuf control frames (NOT a PTY: framing is binary). The returned Duplex is `Scope`-bound — its
 * finalizer tears the underlying child/socket down.
 */
export interface SealantTransportService {
  readonly open: (target: SealantTarget) => Effect.Effect<Duplex, TransportError, Scope.Scope>;
}

export class SealantTransport extends Context.Service<SealantTransport, SealantTransportService>()(
  "@sealant/workspaces/SealantTransport",
) {}

/** A live control stream and the teardown operation owned by its enclosing Effect Scope. */
interface OpenTransport {
  readonly duplex: Duplex;
  readonly close: () => void;
}

const openUnixSocket = (socketPath: string) =>
  Effect.callback<OpenTransport, TransportError>((resume) => {
    const socket = createConnection(socketPath);

    const onConnect = () => {
      socket.off("error", onError);
      resume(
        Effect.succeed({
          duplex: socket,
          close: () => socket.destroy(),
        }),
      );
    };
    const onError = (cause: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause.message,
            cause,
          }),
        ),
      );
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);

    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  });

const openDockerExec = (target: Extract<SealantTarget, { readonly kind: "docker-exec" }>) =>
  Effect.callback<OpenTransport, TransportError>((resume) => {
    const child = spawn(
      "docker",
      ["exec", "-i", target.containerId, "socat", "-", `UNIX-CONNECT:${target.socketPath}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const onOpenError = (cause: Error) => {
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause.message,
            cause,
          }),
        ),
      );
    };
    const onSpawn = () => {
      child.off("error", onOpenError);
      const duplex = Duplex.from({
        readable: child.stdout as NodeJS.ReadableStream,
        writable: child.stdin as NodeJS.WritableStream,
      });
      const close = () => {
        duplex.destroy();
        child.kill("SIGKILL");
      };
      child.on("error", () => duplex.destroy());
      child.on("exit", () => duplex.destroy());
      resume(Effect.succeed({ duplex, close }));
    };

    child.once("error", onOpenError);
    child.once("spawn", onSpawn);

    return Effect.sync(() => {
      child.off("error", onOpenError);
      child.off("spawn", onSpawn);
      child.kill("SIGKILL");
    });
  });

/**
 * Open a `wss://` control connection with client-certificate authentication. `createWebSocketStream`
 * yields a Duplex whose bytes are exactly the binary message payloads, so the daemon's framing is
 * untouched and `SealantClient.fromStream` works unchanged. Nothing about the handshake (or its
 * failure) is logged here beyond the error message — TLS material never leaves this closure.
 */
/**
 * Build the `ws` client for a websocket target: TLS material and the bearer header from the
 * target, plus whatever `prepare` minted for this one connection. Shared with the plain
 * (callback-style) transport so the two openers cannot drift on auth. Throws on an
 * unauthenticated target.
 */
export const createControlWebSocket = (
  target: Extract<SealantTarget, { readonly kind: "websocket" }>,
  material: WebSocketConnectMaterial | undefined,
): WebSocket => {
  if (target.tls === undefined && target.auth === undefined) {
    throw new Error(
      "Refusing an unauthenticated websocket control connection: the target carries neither client TLS material nor a bearer token.",
    );
  }
  const tls = target.tls;
  const headers = {
    ...material?.headers,
    ...(target.auth === undefined ? {} : { authorization: `Bearer ${target.auth.bearerToken}` }),
  };
  const protocols = material?.protocols === undefined ? [] : [...material.protocols];
  return new WebSocket(target.url, protocols, {
    ...(tls === undefined
      ? {}
      : {
          ca: readFileSync(tls.caPath),
          cert: readFileSync(tls.certPath),
          key: readFileSync(tls.keyPath),
          ...(tls.servername === undefined ? {} : { servername: tls.servername }),
        }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    rejectUnauthorized: true,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  });
};

const openWebSocket = (target: Extract<SealantTarget, { readonly kind: "websocket" }>) =>
  Effect.gen(function* () {
    const material =
      target.prepare === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: target.prepare,
            catch: (cause) =>
              new TransportError({
                operation: "open",
                message: `preparing the websocket connection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          });
    return yield* connectWebSocket(target, material);
  });

const connectWebSocket = (
  target: Extract<SealantTarget, { readonly kind: "websocket" }>,
  material: WebSocketConnectMaterial | undefined,
) =>
  Effect.callback<OpenTransport, TransportError>((resume) => {
    let socket: WebSocket;
    try {
      socket = createControlWebSocket(target, material);
    } catch (cause) {
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        ),
      );
      return Effect.void;
    }

    const onOpenError = (cause: Error) => {
      socket.off("open", onOpen);
      resume(
        Effect.fail(
          new TransportError({
            operation: "open",
            message: cause.message,
            cause,
          }),
        ),
      );
    };
    const onOpen = () => {
      socket.off("error", onOpenError);
      const duplex = createWebSocketStream(socket, { allowHalfOpen: false });
      const close = () => {
        duplex.destroy();
        socket.terminate();
      };
      resume(Effect.succeed({ duplex, close }));
    };

    socket.once("error", onOpenError);
    socket.once("open", onOpen);

    return Effect.sync(() => {
      socket.off("error", onOpenError);
      socket.off("open", onOpen);
      socket.terminate();
    });
  });

const openTarget = (target: SealantTarget) => {
  switch (target.kind) {
    case "unix-socket":
      return openUnixSocket(target.socketPath);
    case "docker-exec":
      return openDockerExec(target);
    case "websocket":
      return openWebSocket(target);
  }
};

const controlTransport: SealantTransportService = {
  open: (target) =>
    withTransportError(
      "open",
      Effect.acquireRelease(openTarget(target), ({ close }) => Effect.sync(close)).pipe(
        Effect.map(({ duplex }) => duplex),
      ),
    ),
};

/**
 * Live control transport: persisted host Unix sockets, docker-exec fallback, and sealantd's
 * secure WebSocket frontend. One layer for every runtime adapter.
 */
export const ControlTransportLive = Layer.succeed(SealantTransport, controlTransport);

/** Narrower error wrapper for transport-only failures (defect -> typed `TransportError`). */
function withTransportError<A, R>(
  operation: SealantOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, TransportError, R> {
  return effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof TransportError
        ? cause
        : new TransportError({
            operation,
            message: cause instanceof Error ? cause.message : `${operation} failed.`,
            cause,
          }),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Runtime service
// ---------------------------------------------------------------------------------------------

/** Options accepted by `SealantSession.exec` (mirrors the SDK's `ExecOptions`). */
export interface SealantExecOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly executionId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly stdin?: boolean;
  readonly timeoutMillis?: number;
  readonly background?: boolean;
  /**
   * Run the process as this Linux user (a login name or a decimal uid; sealantd 0.20's
   * `ExecArgs.user`, capability `exec.user`). Only a daemon that reports `exec.user` knows the
   * field: an older one ignores it and would run the process as root, so a caller checks the
   * capability first (`liveProcessUserChannel`). Absent: the daemon's own user, as before.
   */
  readonly user?: string;
}

/** Options for opening a PTY session (mirrors the daemon's `OpenSessionArgs`). */
/**
 * How a session's leader is wired: a pseudoterminal (interactive shells, TUIs) or plain stdio
 * pipes with no tty (protocol processes such as JSON-RPC servers — stdout is the recorded output,
 * stderr is recorded as diagnostics only, `writeSessionInput` feeds stdin, resize is rejected).
 */
export type SealantSessionMode = "pty" | "pipe";

export interface SealantOpenSessionOptions {
  /** The run id, threaded as the daemon execution id so the session's events attribute to it. */
  readonly executionId?: string;
  /** The program the session runs (defaults to the daemon's configured shell, `/bin/bash`). */
  readonly shell?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly term?: string;
  /** Leader wiring; defaults to `pty`. */
  readonly mode?: SealantSessionMode;
  /** Run the leader as this Linux user (`OpenSessionArgs.user`; see `SealantExecOptions.user`). */
  readonly user?: string;
}

const toWireSessionMode = (mode: SealantSessionMode | undefined): WireSessionMode =>
  mode === "pipe" ? WireSessionMode.PIPE : WireSessionMode.PTY;

const fromWireSessionMode = (mode: WireSessionMode): SealantSessionMode =>
  mode === WireSessionMode.PIPE ? "pipe" : "pty";

/**
 * A person's dotfiles applied into their home, as their user (sealantd's `dotfiles.apply`, Mend's
 * ADR 0016 decision 11): `user` is a login name or a decimal uid (never root; the daemon refuses
 * it), its passwd home the target. At least one of `repository` and `archiveDir`; the repository
 * applies first, as at boot. Nothing here carries a credential: a repository is cloned with none.
 */
export interface SealantDotfilesApplyArgs {
  readonly user: string;
  readonly repository?: {
    readonly url: string;
    /** Branch or ref; absent clones the remote's default branch. */
    readonly reference?: string;
    readonly manager?: "auto" | "chezmoi" | "stow" | "copy";
    readonly target?: "home" | "config";
    readonly bootstrap: boolean;
    readonly bootstrapCommand?: string;
  };
  /** A directory of staged archives (`manifest.json` and `<index>.tar.gz`). */
  readonly archiveDir?: string;
  /** The execution the bootstrap's process belongs to (the run that records it). */
  readonly executionId?: string;
}

/** The daemon's answer: every file is applied; the bootstraps, if any, run as one process. */
export interface SealantDotfilesApplied {
  /** The login name applied as. */
  readonly user: string;
  /** The home applied into (the user's passwd home). */
  readonly home: string;
  /** The bootstrap process, started as the user; absent when no tree had one to run. */
  readonly bootstrap?: { readonly processId: string; readonly pid: number };
}

/** The daemon's accepted-session handle. */
export interface SealantSessionOpened {
  readonly sessionId: string;
  readonly processId: string;
  readonly pid: number;
}

/** One live PTY session as reported by `listSessions`. */
export interface SealantSessionSummary {
  readonly sessionId: string;
  readonly processId: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly mode: SealantSessionMode;
  readonly executionId?: string;
}

/**
 * A live, connected control session against one sealantd instance. All methods are
 * exception-free: failures land on the typed `SealantError` channel. The session's lifetime is the
 * `Scope` it was opened in — when that scope closes, the client and transport are released.
 */
export interface SealantSession {
  /** Round-trips a health probe; proves the control channel is live. */
  readonly health: Effect.Effect<HealthReport, SealantError>;
  /** Returns the daemon's advertised capabilities. */
  readonly capabilities: Effect.Effect<Capabilities, SealantError>;
  /** Starts a process; resolves with the accepted handle (processId, pid, ...). */
  readonly exec: (options: SealantExecOptions) => Effect.Effect<ExecAccepted, SealantError>;
  /** Writes bytes to a process's stdin. */
  readonly writeStdin: (processId: string, data: Uint8Array) => Effect.Effect<void, SealantError>;
  /** Half-close a process's stdin so `base64 -d`-style readers see EOF. */
  readonly closeStdin: (processId: string) => Effect.Effect<void, SealantError>;
  /** Delivers a signal to a process. */
  readonly signalProcess: (processId: string, signal: number) => Effect.Effect<void, SealantError>;
  /**
   * Opens a PTY-backed session. The session is DAEMON-OWNED, not connection-owned: it keeps
   * running when this control connection closes (only stream *attachments* are connection-scoped),
   * which is what lets the control plane drive sessions over short-lived per-request connections.
   */
  readonly openSession: (
    options: SealantOpenSessionOptions,
  ) => Effect.Effect<SealantSessionOpened, SealantError>;
  /** Closes a PTY session (hangs up the terminal; the daemon reaps the process group). */
  readonly closeSession: (sessionId: string) => Effect.Effect<void, SealantError>;
  /** Resizes a session's PTY. */
  readonly resizePty: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, SealantError>;
  /** Lists the live PTY sessions on this daemon. */
  readonly listSessions: Effect.Effect<readonly SealantSessionSummary[], SealantError>;
  /** Writes keystrokes to a session's PTY input. */
  readonly writeSessionInput: (
    sessionId: string,
    data: Uint8Array,
  ) => Effect.Effect<void, SealantError>;
  /**
   * Attaches a reliable output channel to a PTY session: byte-exact replay
   * from `fromSequence`, then live output, as one `AsyncIterable<Uint8Array>`.
   * The channel is CONNECTION-scoped — it dies with this control connection —
   * which is exactly what a held attach (WS bridge) wants: one connection, one
   * channel, torn down together.
   */
  readonly attachSession: (
    sessionId: string,
    options?: { readonly fromSequence?: bigint },
  ) => Effect.Effect<Channel, SealantError>;
  /**
   * Opens a raw TCP (or connected-UDP) forward INSIDE the workspace and returns its byte
   * channel. The target host is a CLOSED workspace-private set — the
   * container's own loopback, or `docker`: the workspace-scoped dind
   * sidecar's network alias, where inner `docker compose` publishes its
   * ports. Never an arbitrary host: that would be an in-container SSRF
   * primitive. Like an attach, the channel is CONNECTION-scoped: dropping
   * this control connection reaps the forward's socket and pumps daemon-side.
   */
  readonly openForward: (
    port: number,
    host?: SealantForwardHost,
    protocol?: SealantForwardProtocol,
  ) => Effect.Effect<{ readonly channelId: string; readonly channel: Channel }, SealantError>;
  /** Closes a forward explicitly — cheaper than waiting for connection teardown. */
  readonly closeForward: (channelId: string) => Effect.Effect<void, SealantError>;
  /**
   * Points a bindable mount's path at a subdirectory of its root (sealantd ADR-0014); an empty
   * subpath unbinds. The daemon validates the target and records the bind for its own restarts.
   */
  readonly bindMount: (mountPath: string, subpath: string) => Effect.Effect<void, SealantError>;
  /**
   * Capture, then ship and register everything staged (sealantd ADR-0015 `capture.flush`, the
   * suspend/terminate hook). `request.kind` says whether the executor is ending (`final`) or not
   * (`suspend`, the default); see `CaptureFlushRequest` for what the pinned wire sends. Only
   * answers on a capture-sourced workspace (`SEALANT_WORKSPACE_SOURCE=capture`).
   */
  readonly captureFlush: (
    request?: CaptureFlushRequest,
  ) => Effect.Effect<CaptureFlushReport, SealantError>;
  /**
   * The daemon's capture status (`capture.status`) without flushing: what a drain polls between
   * flushes to see the queue empty (`pending === 0`) or stop moving. Only answers on a
   * capture-sourced workspace.
   */
  readonly captureStatus: () => Effect.Effect<CaptureFlushReport, SealantError>;
  /**
   * Re-plan the capture (sealantd 0.15 `capture.replan`, the claim hook): the daemon asks the
   * session channel for its plan again with no worktree named, delta-materialises the answered
   * plan over what is on disk, rebases its staging identity onto the answered worktree and epoch,
   * drops foreign queue entries and lifts the fence. Idempotent (`unchanged: true`). Only answers
   * on a capture-sourced workspace.
   */
  readonly captureReplan: () => Effect.Effect<CaptureReplanReport, SealantError>;
  /**
   * Apply a person's dotfiles into their home, as their user (`dotfiles.apply`, sealantd 0.20):
   * answers once every file is applied; the bootstraps (`./install.sh`) then run as one managed
   * process of the user, whose events carry `executionId`. Only a daemon whose capabilities name
   * `dotfiles.user` knows the command.
   */
  readonly dotfilesApply: (
    args: SealantDotfilesApplyArgs,
  ) => Effect.Effect<SealantDotfilesApplied, SealantError>;
  /** Asks the daemon to shut down gracefully. */
  readonly shutdown: (graceMillis?: number) => Effect.Effect<void, SealantError>;
  /**
   * Telemetry as an Effect `Stream`. Adapts the SDK's async-iterator (`client.events()`); the SDK
   * ends the iterator on `client.close()`, which becomes normal stream completion here.
   */
  readonly events: Stream.Stream<EventEnvelope, SealantError>;
}

/** The runtime service: opens scoped sessions over whichever `SealantTransport` is provided. */
export interface SealantRuntimeService {
  /**
   * Opens the transport, builds a `SealantClient`, and registers a finalizer (via
   * `Effect.acquireRelease`) that closes the client. Resource-safe: closing the `Scope` releases the
   * client and the transport child in reverse order.
   */
  readonly connect: (
    target: SealantTarget,
  ) => Effect.Effect<SealantSession, SealantError, Scope.Scope>;
}

export class SealantRuntime extends Context.Service<SealantRuntime, SealantRuntimeService>()(
  "@sealant/workspaces/SealantRuntime",
) {}

/**
 * Drives a raw control command through the SDK's low-level `request()` and unwraps the outcome.
 * The session lifecycle commands (openSession/resizePty/closeSession/listSessions) have no typed
 * SDK sugar yet, so this mirrors the unwrap the SDK's typed methods perform internally: a daemon
 * `error` outcome becomes a `SealantControlError`, and a result-case mismatch is unexpected.
 */
const requestResult = (
  client: SealantClient,
  operation: SealantOperation,
  command: Parameters<SealantClient["request"]>[0],
  expect: string | undefined,
): Effect.Effect<unknown, SealantError> =>
  withSealantError(
    operation,
    Effect.tryPromise(async () => {
      const response = await client.request(command);
      const outcome = response.outcome?.outcome;
      if (outcome?.case === "error") {
        const error = outcome.value;
        throw new SealantControlError({
          operation,
          code: error.code,
          message: error.message || `control error (${String(error.code)})`,
          ...(error.detailJson === undefined || error.detailJson === ""
            ? {}
            : { detailJson: error.detailJson }),
        });
      }
      if (outcome?.case !== "ok") {
        throw new Error(`${operation}: control response had no outcome`);
      }
      if (expect === undefined) {
        return undefined;
      }
      const result = outcome.value.result;
      if (result.case !== expect) {
        throw new Error(`${operation}: expected result ${expect}, got ${String(result.case)}`);
      }
      return (result as { value: unknown }).value;
    }),
  );

const toEnvVars = (env: Readonly<Record<string, string>> | undefined) =>
  Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));

/** Builds the per-connection session handle around a connected `SealantClient`. */
const makeSession = (client: SealantClient): SealantSession => ({
  // `health`/`capabilities` are round-trip control requests that REJECT when the connection drops
  // (e.g. a flaky docker-exec bridge). Use `tryPromise` so the rejection lands on the typed
  // `SealantError` channel (retryable) — `Effect.promise` would turn it into a defect that escapes
  // `withSealantError` and bypasses `Effect.retry`.
  health: withSealantError(
    "health",
    Effect.tryPromise(() => client.health()),
  ),

  capabilities: withSealantError(
    "capabilities",
    Effect.tryPromise(() => client.getCapabilities()),
  ),

  exec: (options) =>
    options.user === undefined
      ? withSealantError(
          "exec",
          Effect.tryPromise(() =>
            client.exec({
              executable: options.executable,
              ...(options.args === undefined ? {} : { args: [...options.args] }),
              ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
              ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
              ...(options.timeoutMillis === undefined
                ? {}
                : { timeoutMillis: options.timeoutMillis }),
              ...(options.background === undefined ? {} : { background: options.background }),
            }),
          ),
        )
      : // The client's typed `exec` has no `user`: the same command, through the raw request.
        requestResult(
          client,
          "exec",
          {
            case: "exec",
            value: {
              executable: options.executable,
              args: options.args === undefined ? [] : [...options.args],
              ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
              ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              stdin: options.stdin ?? false,
              ...(options.timeoutMillis === undefined
                ? {}
                : { timeoutMillis: BigInt(options.timeoutMillis) }),
              background: options.background ?? false,
              user: options.user,
            },
          },
          "execAccepted",
        ).pipe(Effect.map((value) => value as ExecAccepted)),

  writeStdin: (processId, data) =>
    withSealantError(
      "writeStdin",
      Effect.tryPromise(() => client.writeStdin(processId, data)),
    ),

  closeStdin: (processId) =>
    requestResult(
      client,
      "closeStdin",
      { case: "closeStdin", value: { processId } },
      undefined,
    ).pipe(Effect.asVoid),

  signalProcess: (processId, signal) =>
    withSealantError(
      "signalProcess",
      Effect.tryPromise(() => client.signalProcess(processId, signal)),
    ),

  openSession: (options) =>
    requestResult(
      client,
      "openSession",
      {
        case: "openSession",
        value: {
          ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
          ...(options.shell === undefined ? {} : { shell: options.shell }),
          ...(options.args === undefined ? {} : { args: [...options.args] }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: toEnvVars(options.env),
          cols: options.cols,
          rows: options.rows,
          ...(options.term === undefined ? {} : { term: options.term }),
          mode: toWireSessionMode(options.mode),
          ...(options.user === undefined ? {} : { user: options.user }),
        },
      },
      "sessionOpened",
    ).pipe(
      Effect.map((value) => {
        const opened = value as { sessionId: string; processId: string; pid: number };
        return { sessionId: opened.sessionId, processId: opened.processId, pid: opened.pid };
      }),
    ),

  closeSession: (sessionId) =>
    requestResult(
      client,
      "closeSession",
      { case: "closeSession", value: { sessionId } },
      undefined,
    ).pipe(Effect.asVoid),

  resizePty: (sessionId, cols, rows) =>
    requestResult(
      client,
      "resizePty",
      { case: "resizePty", value: { sessionId, cols, rows } },
      undefined,
    ).pipe(Effect.asVoid),

  listSessions: requestResult(
    client,
    "listSessions",
    { case: "listSessions", value: {} },
    "sessionList",
  ).pipe(
    Effect.map((value) => {
      const list = value as {
        sessions: Array<{
          sessionId: string;
          processId: string;
          pid: number;
          cols: number;
          rows: number;
          mode: WireSessionMode;
          executionId?: string;
        }>;
      };
      return list.sessions.map((s) => ({
        sessionId: s.sessionId,
        processId: s.processId,
        pid: s.pid,
        cols: s.cols,
        rows: s.rows,
        mode: fromWireSessionMode(s.mode),
        ...(s.executionId === undefined ? {} : { executionId: s.executionId }),
      }));
    }),
  ),

  writeSessionInput: (sessionId, data) =>
    withSealantError(
      "writeSessionInput",
      Effect.tryPromise(() => client.writeSessionInput(sessionId, data)),
    ),

  attachSession: (sessionId, options) =>
    withSealantError(
      "attachSession",
      Effect.tryPromise(() =>
        client.attachSession(
          sessionId,
          options?.fromSequence === undefined ? {} : { fromSequence: options.fromSequence },
        ),
      ),
    ).pipe(Effect.map(({ channel }) => channel)),

  openForward: (port, host, protocol) =>
    withSealantError(
      "openForward",
      Effect.tryPromise(() => client.openForward(host ?? "127.0.0.1", port, undefined, protocol)),
    ).pipe(Effect.map(({ result, channel }) => ({ channelId: result.channelId, channel }))),

  closeForward: (channelId) =>
    withSealantError(
      "closeForward",
      Effect.tryPromise(() => client.closeForward(channelId)),
    ),
  bindMount: (mountPath, subpath) =>
    withSealantError(
      "bindMount",
      Effect.tryPromise(() => client.bindMount(mountPath, subpath)),
    ),
  captureFlush: (request) =>
    withSealantError(
      "captureFlush",
      Effect.tryPromise(async () => {
        // The typed client has no wrapper for this command yet; `request` is its generic seam.
        const response = await client.request({
          case: "captureFlush",
          value: captureFlushArgs(request),
        });
        const outcome = response.outcome?.outcome;
        if (outcome?.case === "error") {
          throw new SdkSealantError(outcome.value);
        }
        if (outcome?.case !== "ok") {
          throw new Error("capture.flush response had no outcome");
        }
        const result = outcome.value.result;
        if (result.case !== "captureStatus") {
          throw new Error(`expected result captureStatus, got ${String(result.case)}`);
        }
        return captureFlushReportFromWire(result.value);
      }),
    ),
  captureStatus: () =>
    requestResult(
      client,
      "captureStatus",
      { case: "captureStatus", value: {} },
      "captureStatus",
    ).pipe(Effect.map((value) => captureFlushReportFromWire(value as CaptureStatusReport))),
  captureReplan: () =>
    withSealantError(
      "captureReplan",
      Effect.tryPromise(async () => {
        // Same generic seam as captureFlush: the typed client has no wrapper for this command.
        const response = await client.request({ case: "captureReplan", value: {} });
        const outcome = response.outcome?.outcome;
        if (outcome?.case === "error") {
          throw new SdkSealantError(outcome.value);
        }
        if (outcome?.case !== "ok") {
          throw new Error("capture.replan response had no outcome");
        }
        const result = outcome.value.result;
        if (result.case !== "captureReplanned") {
          throw new Error(`expected result captureReplanned, got ${String(result.case)}`);
        }
        return captureReplanReportFromWire(result.value);
      }),
    ),

  dotfilesApply: (args) =>
    requestResult(
      client,
      "dotfilesApply",
      {
        case: "dotfilesApply",
        value: {
          user: args.user,
          ...(args.repository === undefined
            ? {}
            : {
                repository: {
                  url: args.repository.url,
                  ...(args.repository.reference === undefined
                    ? {}
                    : { reference: args.repository.reference }),
                  ...(args.repository.manager === undefined
                    ? {}
                    : { manager: args.repository.manager }),
                  ...(args.repository.target === undefined
                    ? {}
                    : { target: args.repository.target }),
                  bootstrap: args.repository.bootstrap,
                  ...(args.repository.bootstrapCommand === undefined
                    ? {}
                    : { bootstrapCommand: args.repository.bootstrapCommand }),
                },
              }),
          ...(args.archiveDir === undefined ? {} : { archiveDir: args.archiveDir }),
          ...(args.executionId === undefined ? {} : { executionId: args.executionId }),
        },
      },
      "dotfilesApplied",
    ).pipe(
      Effect.map((value) => {
        const applied = value as DotfilesApplied;
        return {
          user: applied.user,
          home: applied.home,
          ...(applied.bootstrap === undefined
            ? {}
            : {
                bootstrap: {
                  processId: applied.bootstrap.processId,
                  pid: applied.bootstrap.pid,
                },
              }),
        } satisfies SealantDotfilesApplied;
      }),
    ),

  shutdown: (graceMillis) =>
    withSealantError(
      "shutdown",
      Effect.tryPromise(() => client.shutdown(graceMillis)),
    ),

  // `Stream.fromAsyncIterable` pulls one event per `next()` (the SDK iterator is the backpressure
  // boundary). Iterator exhaustion (after `client.close()`) is normal completion; any throw is
  // remapped to the typed channel.
  events: Stream.fromAsyncIterable(client.events(), (cause) => mapSealantError("events", cause)),
});

/** Builds the runtime service around a resolved transport (captured once at layer construction). */
const makeSealantRuntime = (transport: SealantTransportService): SealantRuntimeService => ({
  connect: (target) =>
    Effect.gen(function* () {
      const duplex = yield* transport.open(target);

      // Acquire the SDK client over the transport; release closes it (and lets the transport
      // finalizer kill the child). Resource-safe regardless of how the scope unwinds.
      const client = yield* Effect.acquireRelease(
        withSealantError(
          "connect",
          Effect.sync(() => SealantClient.fromStream(duplex)),
        ),
        (c) => Effect.sync(() => c.close()),
      );

      return makeSession(client);
    }),
});

/**
 * Live `SealantRuntime` layer. Requires a `SealantTransport` in context (e.g.
 * `ControlTransportLive`); the transport is resolved once here, mirroring the
 * `Layer.effect` + `yield* DepTag` idiom in `packages/jobs/src/service.ts`.
 */
export const SealantRuntimeLive = Layer.effect(
  SealantRuntime,
  Effect.gen(function* () {
    const transport = yield* SealantTransport;

    return makeSealantRuntime(transport);
  }),
);

/** Convenience composition: the runtime service wired to the live control transport. */
export const SealantRuntimeControlLive = SealantRuntimeLive.pipe(
  Layer.provideMerge(ControlTransportLive),
);
