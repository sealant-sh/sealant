/**
 * The worker's log, read the way an operator reads it (sealant#600's "What an operator sees"). The
 * worker writes two kinds of entry: Effect log lines, `[HH:MM:SS.mmm] LEVEL (#fiber): message`
 * with indented continuation lines, and `console.warn` / `console.error` blocks, which start at
 * column 0 with no time or level (`apps/worker/src/workers/workspaces.ts`).
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { HarnessStack } from "./stack.js";

const workerLog = (stack: Pick<HarnessStack, "scratch">) => join(stack.scratch, "worker.log");

/** Where the worker log ends now: read entries after it with `workerLogSince`. */
export const workerLogOffset = async (stack: Pick<HarnessStack, "scratch">) =>
  (await stat(workerLog(stack))).size;

/** The worker log's entries from byte `offset` on. A new entry starts at any unindented line. */
export const workerLogSince = async (stack: Pick<HarnessStack, "scratch">, offset: number) => {
  const file = await open(workerLog(stack), "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    await file.read(buffer, 0, buffer.length, offset);
    return splitEntries(buffer.toString("utf8"));
  } finally {
    await file.close();
  }
};

export const splitEntries = (text: string): string[] =>
  stripVTControlCharacters(text)
    .split(/\n(?=[^\s}\]])/)
    .filter((entry) => entry.trim() !== "");

const NAMES_A_RUN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** The entries that name the run, and those that name no run at all. */
export const entriesOf = (entries: readonly string[], runId: string) =>
  entries.filter((entry) => entry.includes(runId) || !NAMES_A_RUN.test(entry));

/** The worker's `console.warn` / `console.error` messages, which carry no level of their own. */
const CONSOLE_WARNING =
  /^(Workspace stop deferred to the reaper|Workspace stop failed|Boat (stop|allocation|resource) obligations remain|Stopping a retained Boat launch failed|Runtime exit reconciler tick failed|Retained executor recovery tick failed|Workspace expiry reaper tick failed|Boat allocation reconciliation tick failed|Workspace build job failed)/;

/** An entry at warning level or above. */
export const isWarningOrAbove = (entry: string) =>
  /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (WARN|ERROR|FATAL)\b/.test(entry) || CONSOLE_WARNING.test(entry);

/**
 * An entry that says a stop's pass did not finish (#600): an unknown removal outcome, a failed or
 * reissued removal, a removal an earlier pass issued and a later one found carried out, a nudge
 * that could not settle the run, an obligation the sweep cannot settle,
 * or a stop deferred for any reason but `busy` (the 30 s nudge took the run's claim first and
 * stopped it, which is allowed).
 */
export const isUnfinishedPass = (entry: string) =>
  /outcome nobody knows|Workspace stop failed|so it is issued again|issued earlier was carried out|this pass could not settle it|Boat stop obligations remain/.test(
    entry,
  ) ||
  (entry.startsWith("Workspace stop deferred to the reaper") && !/outcome: 'busy'/.test(entry));

/** The FINAL drains the worker recorded complete for the run, by which caller (`lifecycle stop`, `Boat convergence`, ...). */
export const completeFinals = (entries: readonly string[], runId: string) =>
  entries.flatMap((entry) => {
    const match = entry.match(
      new RegExp(`Capture drain \\(([^)]+)\\) · run ${runId}: saved · [^\\n]*final flush complete`),
    );
    return match === null ? [] : [match[1] ?? ""];
  });

/** An entry, cut to a readable length for a failure message. */
export const excerpt = (entry: string) => entry.slice(0, 600);
