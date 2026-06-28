/**
 * The `RunRecord` facade — the execution record as the SDK exposes it. Backed by the run/record
 * contract endpoints (`client.runs.*`), it maps the wire shapes to the public types: decimal-string
 * sequences become `bigint`, base64 scrollback becomes `Uint8Array`. `replay()`/`timeline()`/
 * `scrollback()`/`loss()`/`summary()` are live; `stream()` and the time-travel folds are typed but
 * reject until their read models land (Phase 2 / Phase 1).
 */
import type {
  Run as WireRun,
  RunLossReport,
  TimelineEntry as WireTimelineEntry,
} from "@sealant/api-contracts";

import {
  getRunLossOp,
  getRunOp,
  getRunScrollbackOp,
  getRunTimelineOp,
} from "../effect/operations.js";
import { SealantNotImplementedError } from "../errors.js";
import type {
  IoStream,
  LossReport,
  RunCommand,
  RunRecord,
  RunReplay,
  RunSummary,
  TimelineEntry,
} from "../types.js";
import type { SdkContext } from "./context.js";

// Live `stream()` is poll-backed for now: it tails the timeline endpoint until the run is terminal.
// The transport swaps to SSE over Postgres LISTEN/NOTIFY in Stage 5 behind this same signature.
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STREAM_POLL_INTERVAL_MS = 500;
const STREAM_TIMEOUT_MS = 30 * 60 * 1_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toTimelineEntry = (wire: WireTimelineEntry): TimelineEntry => ({
  sequence: BigInt(wire.sequence),
  kind: wire.kind,
  occurredAt: wire.occurredAt,
  data: { summary: wire.summary, ...(wire.ref === undefined ? {} : { ref: wire.ref }) },
});

const toLossReport = (wire: RunLossReport): LossReport => ({
  complete: !wire.earlyClose && wire.droppedEventCount === "0" && wire.sequenceGapCount === 0,
  // Pass boundaries through only when present — do not fabricate a {0, 0} span.
  spans: wire.spans.map((span) => ({
    ...(span.fromSequence === undefined ? {} : { fromSequence: BigInt(span.fromSequence) }),
    ...(span.toSequence === undefined ? {} : { toSequence: BigInt(span.toSequence) }),
  })),
});

// ---------------------------------------------------------------------------------------------
// Transcript reconstruction — turn the raw timeline into the terminal commands a human cares about.
// ---------------------------------------------------------------------------------------------

const STDERR_STREAM = 3; // StreamKind.STDERR (stdout is 2)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const SHELL_SAFE = /^[A-Za-z0-9_/.:=@%+-]+$/;
const quoteArg = (arg: string): string =>
  arg.length > 0 && SHELL_SAFE.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
const formatCommandLine = (executable: string, args: readonly string[]): string =>
  [executable, ...args.map(quoteArg)].join(" ");

const humanBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
const humanDuration = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

/**
 * Folds the timeline into the ordered list of terminal commands. Process boundaries are
 * `processStarted`/`processExited`; `ioChunk` byte counts accrue to the current command. Daemon noise
 * (`runtimeStateChanged`, and the boot foreground we never `processStarted`) is skipped naturally.
 */
export const reconstructCommands = (entries: readonly WireTimelineEntry[]): RunCommand[] => {
  const commands: RunCommand[] = [];
  let current:
    | { executable: string; args: string[]; cwd?: string; stdoutBytes: number; stderrBytes: number }
    | undefined;

  const flush = (exit?: { exitCode?: number; signal?: number; durationMs?: number }): void => {
    if (current === undefined) {
      return;
    }
    commands.push({
      executable: current.executable,
      args: current.args,
      command: formatCommandLine(current.executable, current.args),
      ...(current.cwd === undefined ? {} : { cwd: current.cwd }),
      ...(exit?.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
      ...(exit?.signal === undefined ? {} : { signal: exit.signal }),
      ...(exit?.durationMs === undefined ? {} : { durationMs: exit.durationMs }),
      stdoutBytes: current.stdoutBytes,
      stderrBytes: current.stderrBytes,
    });
    current = undefined;
  };

  for (const entry of entries) {
    const ref = isRecord(entry.ref) ? entry.ref : {};
    if (entry.kind === "processStarted") {
      flush();
      const args = ref["args"];
      current = {
        executable: typeof ref["executable"] === "string" ? ref["executable"] : "?",
        args: Array.isArray(args) ? (args as unknown[]).map((a) => String(a)) : [],
        ...(typeof ref["cwd"] === "string" ? { cwd: ref["cwd"] } : {}),
        stdoutBytes: 0,
        stderrBytes: 0,
      };
    } else if (entry.kind === "ioChunk" && current !== undefined) {
      const bytes = typeof ref["byteCount"] === "string" ? Number(ref["byteCount"]) : 0;
      if (ref["stream"] === STDERR_STREAM) {
        current.stderrBytes += bytes;
      } else {
        current.stdoutBytes += bytes;
      }
    } else if (entry.kind === "processExited") {
      flush({
        ...(typeof ref["exitCode"] === "number" ? { exitCode: ref["exitCode"] } : {}),
        ...(typeof ref["signal"] === "number" ? { signal: ref["signal"] } : {}),
        ...(typeof ref["durationMicros"] === "string"
          ? { durationMs: Math.round(Number(ref["durationMicros"]) / 1000) }
          : {}),
      });
    }
  }
  flush();
  return commands;
};

export const renderTranscript = (commands: readonly RunCommand[]): string => {
  if (commands.length === 0) {
    return "(no commands recorded)\n";
  }
  const blocks = commands.map((command) => {
    const io: string[] = [];
    if (command.stdoutBytes > 0) {
      io.push(`stdout ${humanBytes(command.stdoutBytes)}`);
    }
    if (command.stderrBytes > 0) {
      io.push(`stderr ${humanBytes(command.stderrBytes)}`);
    }
    const outcome =
      command.signal !== undefined
        ? `terminated (signal ${command.signal})`
        : command.exitCode === 0
          ? "completed (exit 0)"
          : command.exitCode !== undefined
            ? `failed (exit ${command.exitCode})`
            : "ended";
    const duration = command.durationMs === undefined ? "" : ` · ${humanDuration(command.durationMs)}`;
    return `  $ ${command.command}\n      ↳ ${[...io, outcome].join(" · ")}${duration}`;
  });
  return `${blocks.join("\n\n")}\n`;
};

export const makeRunRecord = (ctx: SdkContext, runId: string): RunRecord => {
  const fetchTimeline = (from?: bigint): Promise<readonly WireTimelineEntry[]> =>
    ctx.runtime.run(
      getRunTimelineOp(runId, from === undefined ? {} : { fromSequence: from.toString() }),
    );

  return {
    runId,

    replay: async (options) => {
      const wire = await fetchTimeline();
      const entries = wire.map(toTimelineEntry);
      if (options?.onEntry !== undefined) {
        for (const entry of entries) {
          options.onEntry(entry);
        }
      }
      const replay: RunReplay = {
        entries,
        at: (sequence) => {
          let found: TimelineEntry | undefined;
          for (const entry of entries) {
            if (entry.sequence <= sequence) {
              found = entry;
            } else {
              break;
            }
          }
          return found;
        },
      };
      return replay;
    },

    commands: async () => reconstructCommands(await fetchTimeline()),

    transcript: async () => renderTranscript(reconstructCommands(await fetchTimeline())),

    stream: (options) => {
      const ctxRun = ctx.runtime;
      async function* iterate(): AsyncGenerator<TimelineEntry> {
        let from = options?.from;
        const deadline = Date.now() + STREAM_TIMEOUT_MS;
        for (;;) {
          const wire = await ctxRun.run(
            getRunTimelineOp(runId, from === undefined ? {} : { fromSequence: from.toString() }),
          );
          for (const entry of wire) {
            const mapped = toTimelineEntry(entry);
            yield mapped;
            from = mapped.sequence + 1n;
          }
          // Stop once the run is terminal — with one final drain to catch entries written between the
          // last timeline fetch and the status check.
          const run = await ctxRun.run(getRunOp(runId));
          if (TERMINAL_RUN_STATUSES.has(run.status)) {
            const tail = await ctxRun.run(
              getRunTimelineOp(runId, from === undefined ? {} : { fromSequence: from.toString() }),
            );
            for (const entry of tail) {
              yield toTimelineEntry(entry);
            }
            return;
          }
          if (Date.now() > deadline) {
            return;
          }
          await delay(STREAM_POLL_INTERVAL_MS);
        }
      }
      return iterate();
    },

    timeline: (options) => {
      const run = ctx.runtime;
      async function* iterate(): AsyncGenerator<TimelineEntry> {
        const wire = await run.run(
          getRunTimelineOp(
            runId,
            options?.from === undefined ? {} : { fromSequence: options.from.toString() },
          ),
        );
        for (const entry of wire) {
          yield toTimelineEntry(entry);
        }
      }
      return iterate();
    },

    scrollback: (processId, stream: IoStream) => {
      const run = ctx.runtime;
      async function* iterate(): AsyncGenerator<Uint8Array> {
        const response = await run.run(getRunScrollbackOp(runId, { processId, stream }));
        const bytes = Buffer.from(response.contentBase64, "base64");
        if (bytes.byteLength > 0) {
          yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
      }
      return iterate();
    },

    loss: async () => toLossReport(await ctx.runtime.run(getRunLossOp(runId))),

    summary: async (): Promise<RunSummary> => {
      const run: WireRun = await ctx.runtime.run(getRunOp(runId));
      const timeline = await fetchTimeline();
      const durationMs =
        run.startedAt !== undefined && run.finishedAt !== undefined
          ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
          : undefined;
      return {
        runId,
        outcome: run.status === "completed" ? "completed" : "failed",
        entries: timeline.length,
        ...(durationMs === undefined ? {} : { durationMs }),
      };
    },

    fileTreeAt: () =>
      Promise.reject(
        new SealantNotImplementedError("record.fileTreeAt (file-tree fold arrives in Phase 1)"),
      ),

    processTreeAt: () =>
      Promise.reject(
        new SealantNotImplementedError(
          "record.processTreeAt (process-tree fold arrives in Phase 1)",
        ),
      ),
  };
};
