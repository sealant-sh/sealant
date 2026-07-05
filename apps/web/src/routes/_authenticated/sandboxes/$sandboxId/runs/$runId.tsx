/**
 * The run record page — the durable, replayable evidence of one harness execution. One screen:
 * the prompt and status up top, the activity strip for orientation, the folded record on the
 * left, and the outcome (changes / network / raw events) beside it. `?seq=` deep-links an exact
 * moment; a failed run lands on its failing command.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import { ActivityStrip } from "@/components/run-record/activity-strip";
import { EvidenceRail } from "@/components/run-record/evidence-rail";
import { RecordList } from "@/components/run-record/record-list";
import {
  RecordingPulse,
  runStatusPresentation,
  StatusWord,
} from "@/components/run-record/status-word";
import type { RecordCommand } from "@/lib/run-record/fold";
import { foldRunRecord } from "@/lib/run-record/fold";
import { formatRunDuration, formatWallClock } from "@/lib/run-record/format";
import { useTRPC } from "@/lib/trpc/react";

/** Everything the record renders except ioChunk (fetched lazily as scrollback) and heartbeats. */
const RECORD_KINDS = [
  "runtimeStateChanged",
  "processStarted",
  "processExited",
  "fileChange",
  "fileSnapshotCompleted",
  "fileDiffAvailable",
  "networkRequest",
  "networkSourceObserved",
] as const;

const TIMELINE_LIMIT = 5000;

const isLive = (status: string | undefined): boolean => status === "running" || status === "queued";

const searchSchema = z.object({
  seq: z.string().min(1).optional(),
});

const timelineInput = (runId: string) => ({
  runId,
  kinds: [...RECORD_KINDS],
  limit: TIMELINE_LIMIT,
});

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/runs/$runId")({
  validateSearch: searchSchema,
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(
        context.trpc.run.byId.queryOptions({ runId: params.runId }),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.run.timeline.queryOptions(timelineInput(params.runId)),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.run.loss.queryOptions({ runId: params.runId }),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.run.changes.queryOptions({ runId: params.runId }),
      ),
    ]);
  },
  component: RunRecordPage,
});

function RunRecordPage() {
  const { sandboxId, runId } = Route.useParams();
  const { seq } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const trpc = useTRPC();

  // A live run polls until terminal (the SDK's stream() does the same; SSE replaces this later).
  const { data: run } = useSuspenseQuery({
    ...trpc.run.byId.queryOptions({ runId }),
    refetchInterval: (query) => (isLive(query.state.data?.status) ? 2000 : false),
  });
  const live = isLive(run.status);
  const { data: timeline } = useSuspenseQuery({
    ...trpc.run.timeline.queryOptions(timelineInput(runId)),
    refetchInterval: live ? 2000 : false,
  });
  const { data: loss } = useSuspenseQuery({
    ...trpc.run.loss.queryOptions({ runId }),
    refetchInterval: live ? 5000 : false,
  });
  const { data: changes } = useSuspenseQuery({
    ...trpc.run.changes.queryOptions({ runId }),
    refetchInterval: live ? 5000 : false,
  });

  const model = useMemo(
    () => foldRunRecord({ entries: timeline.items, loss }),
    [timeline.items, loss],
  );

  // A failed run lands on its failing command; otherwise the deep-linked seq (if any) wins.
  const selectedSequence = useMemo(() => {
    if (seq !== undefined) {
      return seq;
    }
    if (run.status === "failed") {
      const failing = [...model.commands]
        .reverse()
        .find((command) => command.exit?.exitCode !== undefined && command.exit.exitCode !== 0);
      return failing?.sequence;
    }
    return undefined;
  }, [seq, run.status, model.commands]);

  const selectCommand = (command: RecordCommand): void => {
    void navigate({ search: { seq: command.sequence }, replace: true });
  };

  const status = runStatusPresentation(run.status, run.exitCode);
  const duration = formatRunDuration(run.startedAt, run.finishedAt);
  const lossSummary = summarizeLoss(loss);

  return (
    <section className="space-y-6">
      <header>
        <p className="ev-eyebrow">
          <Link to="/sandboxes/$sandboxId" params={{ sandboxId }} className="hover:text-ink-2">
            {sandboxId}
          </Link>
          {" / runs"}
        </p>
        <div className="mt-3 flex items-center gap-2.5">
          {run.status === "running" ? (
            <RecordingPulse />
          ) : (
            <span
              className={`size-2 shrink-0 rounded-full ${
                run.status === "failed"
                  ? "bg-danger-dot shadow-[0_0_0_3px_color-mix(in_srgb,var(--sw-red)_20%,transparent)]"
                  : "bg-success-dot shadow-[0_0_0_3px_color-mix(in_srgb,var(--sw-green-dot)_22%,transparent)]"
              }`}
              aria-hidden="true"
            />
          )}
          <span className="font-mono text-xs font-medium text-ink-2">{run.runId}</span>
          <StatusWord tone={status.tone} word={status.word} />
        </div>
        <h1 className="mt-2.5 max-w-3xl font-display text-2xl font-semibold tracking-tight text-balance text-foreground sm:text-[27px]">
          {run.prompt ?? `${run.harnessId} run`}
        </h1>
        <p className="mt-3.5 flex flex-wrap gap-x-4.5 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>{run.harnessId}</span>
          {run.exitCode === undefined ? null : <span>exit {run.exitCode}</span>}
          {duration === undefined ? null : <span>{duration}</span>}
          {run.startedAt === undefined ? null : <span>{formatWallClock(run.startedAt)}</span>}
        </p>
        {run.errorMessage === undefined ? null : (
          <p className="mt-3 max-w-3xl rounded-r-lg bg-secondary py-2 pr-4 pl-3.5 text-[13px] text-danger shadow-[inset_2px_0_0_var(--sw-red)]">
            {run.errorMessage}
          </p>
        )}
        <p className="mt-4 border-t border-rule pt-3.5 font-mono text-xs text-muted-foreground">
          {model.stats.commandCount} commands · {model.stats.fileChangeCount} file changes ·{" "}
          {model.stats.hostCount} hosts contacted ·{" "}
          {lossSummary === undefined ? (
            <span>no recording loss</span>
          ) : (
            <span className="text-warning">{lossSummary}</span>
          )}
          {timeline.items.length >= TIMELINE_LIMIT ? (
            <span> · record truncated to the first {TIMELINE_LIMIT} events</span>
          ) : null}
        </p>
      </header>

      <ActivityStrip
        model={model}
        selectedSequence={selectedSequence}
        onSelectCommand={selectCommand}
      />

      <div className="grid items-start gap-6 xl:grid-cols-[58fr_42fr]">
        <RecordList
          runId={runId}
          model={model}
          selectedSequence={selectedSequence}
          onSelectCommand={selectCommand}
          emptyNote={
            run.status === "queued" || run.status === "running"
              ? "Nothing recorded yet — the record grows as the run executes."
              : "No telemetry was recorded for this run."
          }
        />
        <EvidenceRail
          runId={runId}
          changes={changes}
          model={model}
          selectedSequence={selectedSequence}
        />
      </div>
    </section>
  );
}

const summarizeLoss = (loss: {
  readonly droppedEventCount: string;
  readonly sequenceGapCount: number;
  readonly watchOverflowCount: number;
  readonly earlyClose: boolean;
}): string | undefined => {
  const parts: string[] = [];
  if (loss.droppedEventCount !== "0") {
    parts.push(`${loss.droppedEventCount} events dropped`);
  }
  if (loss.sequenceGapCount > 0) {
    parts.push(`${loss.sequenceGapCount} sequence ${loss.sequenceGapCount === 1 ? "gap" : "gaps"}`);
  }
  if (loss.watchOverflowCount > 0) {
    parts.push("file-watch overflow");
  }
  if (loss.earlyClose) {
    parts.push("recording ended early");
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
};
