/**
 * The record — the folded, replayable history of the run. Commands are the atoms (mono command
 * line, duration, exit as dot + word), with attributed file/network activity nested beneath and
 * byte-exact scrollback one expansion away. Loss gaps render inline where they happened, amber
 * edge, plain words. Every machine fact is mono; every fact carries its provenance.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { captureMethodLabel, confidenceLabel } from "@/lib/run-record/enums";
import type {
  RecordCommand,
  RecordGap,
  RecordItem,
  RecordMarker,
  RunRecordModel,
} from "@/lib/run-record/fold";
import { formatBytes, formatMicros, formatOffset } from "@/lib/run-record/format";
import { useTRPC } from "@/lib/trpc/react";

import { StatusWord } from "./status-word";

interface RecordListProps {
  readonly runId: string;
  readonly model: RunRecordModel;
  readonly selectedSequence?: string | undefined;
  readonly onSelectCommand: (command: RecordCommand) => void;
  /** Rendered when the timeline is empty — an honest empty state, never a blank panel. */
  readonly emptyNote: string;
}

const provenance = (captureMethod: number, confidence: number): string =>
  `${captureMethodLabel(captureMethod)} · ${confidenceLabel(confidence)}`;

export function RecordList({
  runId,
  model,
  selectedSequence,
  onSelectCommand,
  emptyNote,
}: RecordListProps) {
  const first = model.bounds?.firstOccurredAt ?? 0n;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      <div className="flex items-baseline justify-between gap-3 border-b border-rule-faint px-6 py-4">
        <span className="ev-eyebrow">Record</span>
        <span className="font-mono text-[11px] text-faint">
          {model.stats.commandCount} commands · {model.stats.fileChangeCount} file changes ·{" "}
          {model.stats.hostCount} hosts
        </span>
      </div>

      {model.items.length === 0 ? (
        <p className="px-6 py-8 text-sm text-muted-foreground">{emptyNote}</p>
      ) : (
        <div className="divide-y divide-rule-faint">
          {model.items.map((item, index) => (
            <RecordRow
              key={item.type === "gap" ? `gap-${index}` : item.sequence}
              runId={runId}
              item={item}
              firstOccurredAt={first}
              selected={item.type === "command" && item.sequence === selectedSequence}
              onSelectCommand={onSelectCommand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RecordRow({
  runId,
  item,
  firstOccurredAt,
  selected,
  onSelectCommand,
}: {
  readonly runId: string;
  readonly item: RecordItem;
  readonly firstOccurredAt: bigint;
  readonly selected: boolean;
  readonly onSelectCommand: (command: RecordCommand) => void;
}) {
  if (item.type === "gap") {
    return <GapRow gap={item} />;
  }
  if (item.type === "marker") {
    return <MarkerRow marker={item} firstOccurredAt={firstOccurredAt} />;
  }
  return (
    <CommandRow
      runId={runId}
      command={item}
      firstOccurredAt={firstOccurredAt}
      selected={selected}
      onSelect={onSelectCommand}
    />
  );
}

function GapRow({ gap }: { readonly gap: RecordGap }) {
  return (
    <div className="px-6 py-3">
      <p className="rounded-r-lg bg-secondary py-2 pr-4 pl-3.5 text-[13px] text-warning shadow-[inset_2px_0_0_var(--sw-amber)]">
        {gap.label}
      </p>
    </div>
  );
}

function MarkerRow({
  marker,
  firstOccurredAt,
}: {
  readonly marker: RecordMarker;
  readonly firstOccurredAt: bigint;
}) {
  return (
    <div className="flex items-baseline gap-4 px-6 py-2.5 font-mono text-[11.5px] text-faint">
      <span className="w-[4.5rem] shrink-0">
        {formatOffset(marker.occurredAt, firstOccurredAt)}
      </span>
      <span className="min-w-0 truncate">{marker.label}</span>
      <span className="ml-auto shrink-0">
        {provenance(marker.captureMethod, marker.confidence)}
      </span>
    </div>
  );
}

function CommandRow({
  runId,
  command,
  firstOccurredAt,
  selected,
  onSelect,
}: {
  readonly runId: string;
  readonly command: RecordCommand;
  readonly firstOccurredAt: bigint;
  readonly selected: boolean;
  readonly onSelect: (command: RecordCommand) => void;
}) {
  const [expanded, setExpanded] = useState(selected);
  const exit = command.exit;
  const failed = exit?.exitCode !== undefined && exit.exitCode !== 0;
  const hasChildren =
    command.files.length > 0 || command.network.length > 0 || command.processId !== undefined;

  return (
    <div className={selected ? "bg-accent shadow-[inset_2px_0_0_var(--sw-accent)]" : undefined}>
      <button
        type="button"
        className="flex w-full items-baseline gap-4 px-6 py-3 text-left hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => {
          setExpanded((value) => !value);
          onSelect(command);
        }}
      >
        <span className="w-[4.5rem] shrink-0 font-mono text-[11.5px] text-faint">
          {formatOffset(command.occurredAt, firstOccurredAt)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium text-foreground">
          <span className="font-normal text-faint">$ </span>
          {command.commandLine}
        </span>
        {exit === undefined ? (
          <StatusWord tone="observed" word="running" />
        ) : (
          <>
            <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
              {formatMicros(exit.durationMicros)}
            </span>
            <StatusWord
              tone={failed ? "breakage" : "observed"}
              word={exit.exitCode === undefined ? exit.reason : `exit ${exit.exitCode}`}
            />
          </>
        )}
        <span className="shrink-0 text-faint" aria-hidden="true">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>

      {expanded && hasChildren ? (
        <div className="space-y-1 pr-6 pb-3 pl-[7.25rem]">
          {command.files.map((file) => (
            <div
              key={file.sequence}
              className="flex items-baseline gap-3 border-l border-rule py-1 pl-3.5 font-mono text-[11.5px] text-muted-foreground"
            >
              <span className="w-[6.5rem] shrink-0 text-ink-2">file.{file.kind}</span>
              <span className="min-w-0 truncate">
                {file.renameFrom === undefined ? file.path : `${file.renameFrom} → ${file.path}`}
              </span>
              <span className="ml-auto shrink-0 text-faint">
                {provenance(file.captureMethod, file.confidence)}
              </span>
            </div>
          ))}
          {command.network.map((net) => (
            <div
              key={`${net.host}:${net.port}`}
              className="flex items-baseline gap-3 border-l border-rule py-1 pl-3.5 font-mono text-[11.5px] text-muted-foreground"
            >
              <span className="w-[6.5rem] shrink-0 text-ink-2">net.request</span>
              <span className="min-w-0 truncate">
                {net.host}:{net.port}
                {net.requestCount > 0 ? ` · ${net.requestCount} requests` : " · observed"} ·{" "}
                {formatBytes(net.bytesReceived)} down
              </span>
              <span className="ml-auto shrink-0 text-faint">
                {provenance(net.captureMethod, net.confidence)}
              </span>
            </div>
          ))}
          {command.processId === undefined ? (
            <p className="border-l border-rule py-1 pl-3.5 font-mono text-[11px] text-faint">
              output not addressable — this process was recorded without a process id
            </p>
          ) : (
            <ScrollbackBlock runId={runId} processId={command.processId} failed={failed} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function ScrollbackBlock({
  runId,
  processId,
  failed,
}: {
  readonly runId: string;
  readonly processId: string;
  readonly failed: boolean;
}) {
  // A failed command almost always explains itself on stderr — land there.
  const [stream, setStream] = useState<"stdout" | "stderr">(failed ? "stderr" : "stdout");
  const trpc = useTRPC();
  const { data, isPending, isError } = useQuery(
    trpc.run.scrollback.queryOptions({ runId, processId, stream }),
  );

  const text = data === undefined ? "" : decodeBase64(data.contentBase64);

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-border">
      <div className="flex items-center gap-3 border-b border-rule-faint bg-secondary px-3 py-1.5 font-mono text-[10.5px] text-label">
        {(["stdout", "stderr"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setStream(candidate)}
            className={
              candidate === stream
                ? "font-medium text-ink-2"
                : "hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            }
          >
            {candidate}
          </button>
        ))}
        <span className="ml-auto">
          {data === undefined ? "" : `byte-exact · ${formatBytes(BigInt(data.byteCount))}`}
        </span>
      </div>
      <div className="max-h-80 overflow-auto px-3.5 py-2.5">
        {isPending ? (
          <p className="font-mono text-[11.5px] text-faint">reconstructing scrollback…</p>
        ) : isError ? (
          <p className="font-mono text-[11.5px] text-danger">failed to load scrollback</p>
        ) : text.length === 0 ? (
          <p className="font-mono text-[11.5px] text-faint">no recorded {stream} output</p>
        ) : (
          <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

const decodeBase64 = (contentBase64: string): string => {
  try {
    const binary = atob(contentBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
};
