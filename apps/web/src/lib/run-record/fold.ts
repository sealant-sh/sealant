/**
 * The record fold — pure functions that turn a run's timeline (+ loss report) into the view
 * model the run record page renders. No I/O, no React; fully unit-testable.
 *
 * The command is the atom: `processStarted → (activity) → processExited` folds into one
 * RecordCommand, and file/network activity is attributed to the process that produced it —
 * by `processId` when the envelope carries one, else by containment in the most recently
 * opened command. High-frequency network events aggregate per host:port instead of rendering
 * as rows. Loss spans interleave into the record by sequence so a gap is shown where it
 * happened, not in a footnote.
 */
import type { RunLossReport, RunLossSpan, RunTimelineEntry } from "@sealant/validators";

import {
  exitReasonLabel,
  fileChangeKindLabel,
  networkSchemeLabel,
  runtimeStateLabel,
  STREAM_STDERR,
  type ExitReasonLabel,
  type FileChangeKindLabel,
  type NetworkSchemeLabel,
} from "./enums";

export interface RecordFileActivity {
  readonly sequence: string;
  readonly occurredAt: string;
  readonly kind: FileChangeKindLabel;
  readonly path: string;
  readonly renameFrom?: string;
  readonly certain: boolean;
  readonly captureMethod: number;
  readonly confidence: number;
}

/** Network activity aggregated per host:port — never one row per request. */
export interface RecordNetworkActivity {
  readonly host: string;
  readonly port: number;
  readonly scheme: NetworkSchemeLabel;
  readonly requestCount: number;
  readonly observedCount: number;
  readonly bytesSent: bigint;
  readonly bytesReceived: bigint;
  readonly firstSequence: string;
  readonly firstOccurredAt: string;
  readonly captureMethod: number;
  readonly confidence: number;
}

export interface RecordCommandExit {
  readonly sequence: string;
  readonly occurredAt: string;
  readonly exitCode?: number;
  readonly signal?: number;
  readonly reason: ExitReasonLabel;
  readonly durationMicros: bigint;
}

export interface RecordCommand {
  readonly type: "command";
  readonly sequence: string;
  readonly occurredAt: string;
  readonly processId?: string;
  readonly pid?: number;
  readonly executable: string;
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly cwd?: string;
  readonly exit?: RecordCommandExit;
  /** True while no processExited has been folded — a live or lost process. */
  readonly running: boolean;
  readonly stdoutBytes: bigint;
  readonly stderrBytes: bigint;
  readonly files: readonly RecordFileActivity[];
  readonly network: readonly RecordNetworkActivity[];
  readonly captureMethod: number;
  readonly confidence: number;
}

export interface RecordMarker {
  readonly type: "marker";
  readonly sequence: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly label: string;
  readonly captureMethod: number;
  readonly confidence: number;
  /** Present when the marker is an unattributed file change (rendered as its own row). */
  readonly file?: RecordFileActivity;
}

export interface RecordGap {
  readonly type: "gap";
  readonly kind: RunLossSpan["kind"];
  readonly sequence?: string;
  readonly toSequence?: string;
  readonly droppedCount?: string;
  readonly reason?: string;
  readonly label: string;
}

export type RecordItem = RecordCommand | RecordMarker | RecordGap;

export interface RunRecordStats {
  readonly eventCount: number;
  readonly commandCount: number;
  readonly fileChangeCount: number;
  readonly networkRequestCount: number;
  readonly hostCount: number;
}

export interface RunRecordModel {
  readonly items: readonly RecordItem[];
  readonly commands: readonly RecordCommand[];
  /** Network activity that no command could be blamed for (still shown, never dropped). */
  readonly unattributedNetwork: readonly RecordNetworkActivity[];
  readonly stats: RunRecordStats;
  /** Monotonic-clock bounds of the folded entries (strip geometry); absent for an empty record. */
  readonly bounds?: { readonly firstOccurredAt: bigint; readonly lastOccurredAt: bigint };
}

// ---------------------------------------------------------------------------------------------
// Safe payload accessors — `ref` is a protobuf JSON clone (enums as numbers, uint64s as strings).
// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const asOptionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const asBigInt = (value: unknown): bigint => {
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  return 0n;
};

const SHELL_SAFE = /^[A-Za-z0-9_/.:=@%+-]+$/;
const quoteArg = (arg: string): string =>
  arg.length > 0 && SHELL_SAFE.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
const formatCommandLine = (executable: string, args: readonly string[]): string =>
  [executable, ...args.map(quoteArg)].join(" ");

// ---------------------------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------------------------

interface CommandDraft {
  sequence: string;
  occurredAt: string;
  processId: string | undefined;
  pid: number | undefined;
  executable: string;
  args: string[];
  cwd: string | undefined;
  exit: RecordCommandExit | undefined;
  stdoutBytes: bigint;
  stderrBytes: bigint;
  files: RecordFileActivity[];
  network: Map<string, MutableNetwork>;
  captureMethod: number;
  confidence: number;
}

interface MutableNetwork {
  host: string;
  port: number;
  scheme: NetworkSchemeLabel;
  requestCount: number;
  observedCount: number;
  bytesSent: bigint;
  bytesReceived: bigint;
  firstSequence: string;
  firstOccurredAt: string;
  captureMethod: number;
  confidence: number;
}

const fileActivity = (
  entry: RunTimelineEntry,
  ref: Record<string, unknown>,
): RecordFileActivity => {
  const renameFrom = asString(ref.renameFrom);
  return {
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    kind: fileChangeKindLabel(asNumber(ref.kind)),
    path: asString(ref.path) ?? "",
    ...(renameFrom === undefined ? {} : { renameFrom }),
    certain: ref.certain === true,
    captureMethod: entry.captureMethod,
    confidence: entry.confidence,
  };
};

const accumulateNetwork = (
  bucket: Map<string, MutableNetwork>,
  entry: RunTimelineEntry,
  ref: Record<string, unknown>,
  mode: "request" | "observed",
): void => {
  const host = asString(ref.host) ?? "?";
  const port = asNumber(ref.port);
  const key = `${host}:${port}`;
  const existing = bucket.get(key);
  const bytesSent = asBigInt(ref.bytesSent);
  const bytesReceived = asBigInt(ref.bytesReceived);
  if (existing === undefined) {
    bucket.set(key, {
      host,
      port,
      scheme: networkSchemeLabel(asNumber(ref.scheme)),
      requestCount: mode === "request" ? 1 : 0,
      observedCount: mode === "observed" ? 1 : 0,
      bytesSent,
      bytesReceived,
      firstSequence: entry.sequence,
      firstOccurredAt: entry.occurredAt,
      captureMethod: entry.captureMethod,
      confidence: entry.confidence,
    });
    return;
  }
  if (mode === "request") {
    existing.requestCount += 1;
  } else {
    existing.observedCount += 1;
  }
  existing.bytesSent += bytesSent;
  existing.bytesReceived += bytesReceived;
};

const finishNetwork = (bucket: Map<string, MutableNetwork>): RecordNetworkActivity[] =>
  [...bucket.values()].toSorted((a, b) =>
    BigInt(a.firstSequence) < BigInt(b.firstSequence) ? -1 : 1,
  );

const finishCommand = (draft: CommandDraft): RecordCommand => ({
  type: "command",
  sequence: draft.sequence,
  occurredAt: draft.occurredAt,
  ...(draft.processId === undefined ? {} : { processId: draft.processId }),
  ...(draft.pid === undefined ? {} : { pid: draft.pid }),
  executable: draft.executable,
  args: draft.args,
  commandLine: formatCommandLine(draft.executable, draft.args),
  ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
  ...(draft.exit === undefined ? {} : { exit: draft.exit }),
  running: draft.exit === undefined,
  stdoutBytes: draft.stdoutBytes,
  stderrBytes: draft.stderrBytes,
  files: draft.files,
  network: finishNetwork(draft.network),
  captureMethod: draft.captureMethod,
  confidence: draft.confidence,
});

export interface FoldRunRecordInput {
  readonly entries: readonly RunTimelineEntry[];
  readonly loss?: RunLossReport;
}

export const foldRunRecord = (input: FoldRunRecordInput): RunRecordModel => {
  // items holds drafts positionally; commands are finalized at the end so late activity
  // (a fileChange arriving after processExited was already folded) still lands.
  const items: (CommandDraft | RecordMarker | RecordGap)[] = [];
  const byProcessId = new Map<string, CommandDraft>();
  const openStack: CommandDraft[] = [];
  const drafts: CommandDraft[] = [];
  const unattributedNetwork = new Map<string, MutableNetwork>();

  let fileChangeCount = 0;
  let networkRequestCount = 0;
  const hosts = new Set<string>();

  // Attribution: exact processId match first, else the most recently opened still-open command.
  const attributionTarget = (processId: string | undefined): CommandDraft | undefined => {
    if (processId !== undefined) {
      const exact = byProcessId.get(processId);
      if (exact !== undefined) {
        return exact;
      }
    }
    for (let index = openStack.length - 1; index >= 0; index -= 1) {
      const candidate = openStack[index];
      if (candidate !== undefined && candidate.exit === undefined) {
        return candidate;
      }
    }
    return undefined;
  };

  const closeCommand = (draft: CommandDraft, exit: RecordCommandExit): void => {
    draft.exit = exit;
    const stackIndex = openStack.indexOf(draft);
    if (stackIndex !== -1) {
      openStack.splice(stackIndex, 1);
    }
  };

  for (const entry of input.entries) {
    const ref = isRecord(entry.ref) ? entry.ref : {};
    switch (entry.kind) {
      case "processStarted": {
        const args = Array.isArray(ref.args) ? ref.args.map((value) => String(value)) : [];
        const draft: CommandDraft = {
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          processId: entry.processId,
          pid: asOptionalNumber(ref.pid),
          executable: asString(ref.executable) ?? "?",
          args,
          cwd: asString(ref.cwd),
          exit: undefined,
          stdoutBytes: 0n,
          stderrBytes: 0n,
          files: [],
          network: new Map(),
          captureMethod: entry.captureMethod,
          confidence: entry.confidence,
        };
        if (entry.processId !== undefined) {
          byProcessId.set(entry.processId, draft);
        }
        openStack.push(draft);
        drafts.push(draft);
        items.push(draft);
        break;
      }
      case "processExited": {
        const target = attributionTarget(entry.processId);
        const exitCode = asOptionalNumber(ref.exitCode);
        const signal = asOptionalNumber(ref.signal);
        const exit: RecordCommandExit = {
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(signal === undefined ? {} : { signal }),
          reason: exitReasonLabel(asNumber(ref.reason)),
          durationMicros: asBigInt(ref.durationMicros),
        };
        if (target !== undefined && target.exit === undefined) {
          closeCommand(target, exit);
        } else {
          // A process we never saw start (e.g. the boot keepalive killed at daemon shutdown).
          items.push({
            type: "marker",
            sequence: entry.sequence,
            occurredAt: entry.occurredAt,
            kind: entry.kind,
            label: `process exited (${exit.reason}${exit.exitCode === undefined ? "" : ` · exit ${exit.exitCode}`}) — start not recorded`,
            captureMethod: entry.captureMethod,
            confidence: entry.confidence,
          });
        }
        break;
      }
      case "ioChunk": {
        const target = attributionTarget(entry.processId);
        if (target !== undefined) {
          const bytes = asBigInt(ref.byteCount);
          if (asNumber(ref.stream) === STREAM_STDERR) {
            target.stderrBytes += bytes;
          } else {
            target.stdoutBytes += bytes;
          }
        }
        break;
      }
      case "fileChange": {
        fileChangeCount += 1;
        const activity = fileActivity(entry, ref);
        const target = attributionTarget(entry.processId);
        if (target !== undefined) {
          target.files.push(activity);
        } else {
          items.push({
            type: "marker",
            sequence: entry.sequence,
            occurredAt: entry.occurredAt,
            kind: entry.kind,
            label: `file ${activity.kind} ${activity.path}`,
            captureMethod: entry.captureMethod,
            confidence: entry.confidence,
            file: activity,
          });
        }
        break;
      }
      case "networkRequest":
      case "networkSourceObserved": {
        const mode = entry.kind === "networkRequest" ? "request" : "observed";
        if (mode === "request") {
          networkRequestCount += 1;
        }
        hosts.add(`${asString(ref.host) ?? "?"}:${asNumber(ref.port)}`);
        const target = attributionTarget(entry.processId);
        accumulateNetwork(target?.network ?? unattributedNetwork, entry, ref, mode);
        break;
      }
      case "runtimeStateChanged": {
        const state = runtimeStateLabel(asNumber(ref.state));
        const reason = asString(ref.reason);
        items.push({
          type: "marker",
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          kind: entry.kind,
          label: `runtime ${state}${reason === undefined ? "" : ` (${reason})`}`,
          captureMethod: entry.captureMethod,
          confidence: entry.confidence,
        });
        break;
      }
      case "fileSnapshotCompleted": {
        items.push({
          type: "marker",
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          kind: entry.kind,
          label: `file snapshot completed · ${asBigInt(ref.fileCount)} files under ${asString(ref.root) ?? "?"}`,
          captureMethod: entry.captureMethod,
          confidence: entry.confidence,
        });
        break;
      }
      case "fileDiffAvailable": {
        items.push({
          type: "marker",
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          kind: entry.kind,
          label: `file diff available · +${asBigInt(ref.added)} ~${asBigInt(ref.modified)} −${asBigInt(ref.deleted)} renamed ${asBigInt(ref.renamed)}`,
          captureMethod: entry.captureMethod,
          confidence: entry.confidence,
        });
        break;
      }
      // Heartbeats are daemon noise; drops/overflows surface as loss spans, not event rows.
      case "runtimeHeartbeat":
      case "telemetryDropped":
      case "fileWatchOverflow":
        break;
      default: {
        items.push({
          type: "marker",
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          kind: entry.kind,
          label: entry.summary,
          captureMethod: entry.captureMethod,
          confidence: entry.confidence,
        });
        break;
      }
    }
  }

  // Interleave loss spans by fromSequence; spans without one (early close) trail the record.
  const gaps: RecordGap[] = (input.loss?.spans ?? []).map((span) => ({
    type: "gap",
    kind: span.kind,
    ...(span.fromSequence === undefined ? {} : { sequence: span.fromSequence }),
    ...(span.toSequence === undefined ? {} : { toSequence: span.toSequence }),
    ...(span.droppedCount === undefined ? {} : { droppedCount: span.droppedCount }),
    ...(span.reason === undefined ? {} : { reason: span.reason }),
    label: gapLabel(span),
  }));

  const finalized: RecordItem[] = items.map((item) =>
    "type" in item ? item : finishCommand(item),
  );
  const merged = mergeBySequence(finalized, gaps);
  merged.push(...gaps.filter((gap) => gap.sequence === undefined));

  const commands = merged.filter((item): item is RecordCommand => item.type === "command");
  for (const command of commands) {
    for (const net of command.network) {
      hosts.add(`${net.host}:${net.port}`);
    }
  }

  const first = input.entries[0];
  const last = input.entries[input.entries.length - 1];

  return {
    items: merged,
    commands,
    unattributedNetwork: finishNetwork(unattributedNetwork),
    stats: {
      eventCount: input.entries.length,
      commandCount: commands.length,
      fileChangeCount,
      networkRequestCount,
      hostCount: hosts.size,
    },
    ...(first === undefined || last === undefined
      ? {}
      : {
          bounds: {
            firstOccurredAt: BigInt(first.occurredAt),
            lastOccurredAt: BigInt(last.occurredAt),
          },
        }),
  };
};

const gapLabel = (span: RunLossSpan): string => {
  switch (span.kind) {
    case "dropped_event":
      return `recording gap — ${span.droppedCount ?? "?"} events dropped${span.reason === undefined ? "" : ` (${span.reason})`}`;
    case "sequence_gap":
      return "recording gap — a span of events is missing from the log";
    case "watch_overflow":
      return "recording gap — file watching overflowed; some file changes were not captured";
    case "early_close":
      return "the recording ended before the runtime shut down cleanly";
  }
};

/** Stable merge of positioned gaps into the item list by sequence (items already ordered). */
const mergeBySequence = (items: RecordItem[], gaps: RecordGap[]): RecordItem[] => {
  const positioned = gaps
    .flatMap((gap) => (gap.sequence === undefined ? [] : [{ gap, at: BigInt(gap.sequence) }]))
    .toSorted((a, b) => (a.at < b.at ? -1 : 1));
  if (positioned.length === 0) {
    return [...items];
  }
  const merged: RecordItem[] = [];
  let index = 0;
  for (const item of items) {
    if (item.type !== "gap") {
      const itemSequence = BigInt(item.sequence);
      while (index < positioned.length) {
        const next = positioned[index];
        if (next === undefined || next.at > itemSequence) {
          break;
        }
        merged.push(next.gap);
        index += 1;
      }
    }
    merged.push(item);
  }
  for (; index < positioned.length; index += 1) {
    const next = positioned[index];
    if (next !== undefined) {
      merged.push(next.gap);
    }
  }
  return merged;
};
