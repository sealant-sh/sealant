/**
 * The evidence rail — the outcome beside the record that produced it. Changes shows the run's
 * diff with 2px edge marks (never flooded blocks); Network shows every host the run contacted,
 * aggregated; Event pins the full raw envelope of the selected moment, provenance included.
 * Missing capture is stated, never faked.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { parseUnifiedDiff } from "@/lib/run-record/diff";
import { captureMethodLabel, confidenceLabel } from "@/lib/run-record/enums";
import type { RecordNetworkActivity, RunRecordModel } from "@/lib/run-record/fold";
import { formatBytes } from "@/lib/run-record/format";
import { useTRPC } from "@/lib/trpc/react";

type RailTab = "changes" | "network" | "event";

interface RunChangesData {
  readonly files: readonly {
    readonly path: string;
    readonly change: "added" | "modified" | "deleted" | "renamed";
    readonly oldPath?: string | undefined;
  }[];
  readonly diff: string;
}

interface EvidenceRailProps {
  readonly runId: string;
  readonly changes: RunChangesData;
  readonly model: RunRecordModel;
  readonly selectedSequence?: string | undefined;
}

export function EvidenceRail({ runId, changes, model, selectedSequence }: EvidenceRailProps) {
  const [tab, setTab] = useState<RailTab>("changes");

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      <div className="flex gap-1 border-b border-rule-faint px-3 pt-2">
        {(
          [
            ["changes", "Changes"],
            ["network", "Network"],
            ["event", "Event"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`relative px-3 pt-1.5 pb-2.5 text-[12.5px] font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
              tab === key
                ? "text-primary after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:text-ink-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "changes" ? <ChangesTab changes={changes} /> : null}
      {tab === "network" ? <NetworkTab model={model} /> : null}
      {tab === "event" ? <EventTab runId={runId} sequence={selectedSequence} /> : null}
    </div>
  );
}

const CHANGE_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function ChangesTab({ changes }: { readonly changes: RunChangesData }) {
  const parsed = parseUnifiedDiff(changes.diff);

  if (changes.files.length === 0 && parsed.length === 0) {
    return (
      <p className="px-6 py-8 text-sm text-muted-foreground">
        No changes were captured for this run.
      </p>
    );
  }

  return (
    <div>
      <div className="divide-y divide-rule-faint">
        {changes.files.map((file) => {
          const stats = parsed.find((candidate) => candidate.path === file.path);
          return (
            <div
              key={file.path}
              className="flex items-baseline gap-3 px-6 py-2.5 font-mono text-xs"
            >
              <span className="w-3 shrink-0 text-muted-foreground">
                {CHANGE_LETTER[file.change] ?? "?"}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
              </span>
              {stats === undefined ? null : (
                <>
                  <span className="shrink-0 text-success">+{stats.additions}</span>
                  <span className="shrink-0 text-danger">−{stats.deletions}</span>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-4 px-4 pt-2 pb-4">
        {parsed.map((file) => (
          <div key={file.path} className="overflow-hidden rounded-[10px] border border-border">
            <div className="flex justify-between gap-3 border-b border-rule-faint bg-secondary px-3 py-1.5 font-mono text-[10.5px] text-label">
              <span className="truncate">{file.path}</span>
              <span className="shrink-0">captured after run · git · observed</span>
            </div>
            <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.7]">
              {file.lines.map((line, index) => (
                <div
                  key={index}
                  className={`px-3.5 whitespace-pre ${
                    line.sign === "hunk"
                      ? "py-1 text-faint"
                      : line.sign === "add"
                        ? "bg-[var(--sw-add-bg)] text-ink-2 shadow-[inset_2px_0_0_var(--sw-add-edge)]"
                        : line.sign === "del"
                          ? "bg-[var(--sw-del-bg)] text-ink-2 shadow-[inset_2px_0_0_var(--sw-del-edge)]"
                          : "text-ink-2"
                  }`}
                >
                  {line.sign === "add" ? "+" : line.sign === "del" ? "−" : " "}
                  {line.text}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NetworkTab({ model }: { readonly model: RunRecordModel }) {
  const rows: RecordNetworkActivity[] = [
    ...model.commands.flatMap((command) => command.network),
    ...model.unattributedNetwork,
  ];

  if (rows.length === 0) {
    return (
      <p className="px-6 py-8 text-sm text-muted-foreground">
        No network activity was captured for this run. Network capture may not have been enabled.
      </p>
    );
  }

  return (
    <div className="divide-y divide-rule-faint">
      {rows.map((net) => (
        <div
          key={`${net.host}:${net.port}:${net.firstSequence}`}
          className="flex items-baseline gap-3 px-6 py-3 font-mono text-xs"
        >
          <span className="min-w-0 flex-1 truncate text-foreground">
            {net.host}
            <span className="text-faint">:{net.port}</span>
          </span>
          <span className="shrink-0 text-muted-foreground">
            {net.requestCount > 0 ? `${net.requestCount} requests` : "observed"}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {formatBytes(net.bytesSent)} up · {formatBytes(net.bytesReceived)} down
          </span>
        </div>
      ))}
    </div>
  );
}

function EventTab({
  runId,
  sequence,
}: {
  readonly runId: string;
  readonly sequence?: string | undefined;
}) {
  const trpc = useTRPC();
  const { data, isPending, isError } = useQuery({
    ...trpc.run.event.queryOptions({ runId, sequence: sequence ?? "" }),
    enabled: sequence !== undefined,
  });

  if (sequence === undefined) {
    return (
      <p className="px-6 py-8 text-sm text-muted-foreground">
        Select a row in the record to pin its raw event here.
      </p>
    );
  }
  if (isPending) {
    return <p className="px-6 py-8 font-mono text-xs text-faint">loading event {sequence}…</p>;
  }
  if (isError || data === undefined) {
    return (
      <p className="px-6 py-8 text-sm text-muted-foreground">
        No stored event at sequence {sequence}.
      </p>
    );
  }

  const facts: readonly (readonly [string, string])[] = [
    ["event", data.eventId],
    ["sequence", data.sequence],
    ["kind", data.payloadCase],
    ["captured via", captureMethodLabel(data.captureMethod)],
    ["confidence", confidenceLabel(data.confidence)],
    ["runtime", data.runtimeId],
    ...(data.processId === undefined ? [] : [["process", data.processId] as const]),
    // observedAt is microseconds since epoch on the wire.
    ["observed at", new Date(Number(BigInt(data.observedAt) / 1000n)).toISOString()],
  ];

  return (
    <div>
      <dl className="divide-y divide-rule-faint">
        {facts.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_1fr] gap-3 px-6 py-2.5">
            <dt className="ev-eyebrow self-center">{label}</dt>
            <dd className="truncate font-mono text-xs text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="px-4 pt-1 pb-4">
        <pre className="max-h-96 overflow-auto rounded-[10px] border border-border bg-secondary px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
          {JSON.stringify(data.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}
