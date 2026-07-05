/**
 * The activity strip — the whole run on one time axis: command spans, file ticks, network ticks,
 * loss bands. Orientation, not decoration: clicking a bar selects that command in the record.
 * Color only where earned — red for a demonstrated failure, cobalt for the selection, an amber
 * hatch for a recording gap; everything else stays neutral ink.
 */
import type { RecordCommand, RunRecordModel } from "@/lib/run-record/fold";
import { formatOffset } from "@/lib/run-record/format";

interface ActivityStripProps {
  readonly model: RunRecordModel;
  readonly selectedSequence?: string | undefined;
  readonly onSelectCommand: (command: RecordCommand) => void;
}

interface Geometry {
  readonly leftPct: number;
  readonly widthPct: number;
}

const geometry = (from: bigint, to: bigint, first: bigint, total: bigint): Geometry => {
  if (total <= 0n) {
    return { leftPct: 0, widthPct: 100 };
  }
  const left = Number(((from - first) * 10_000n) / total) / 100;
  const width = Number(((to - from) * 10_000n) / total) / 100;
  return { leftPct: Math.min(Math.max(left, 0), 100), widthPct: Math.max(width, 0.4) };
};

const safeBigInt = (value: string): bigint => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

export function ActivityStrip({ model, selectedSequence, onSelectCommand }: ActivityStripProps) {
  const bounds = model.bounds;
  if (bounds === undefined || model.commands.length === 0) {
    return null;
  }
  const first = bounds.firstOccurredAt;
  const total = bounds.lastOccurredAt - bounds.firstOccurredAt;

  const fileTicks = model.commands.flatMap((command) => command.files);
  const networkTicks = model.commands.flatMap((command) => command.network);

  return (
    <div className="rounded-2xl border border-border bg-card px-6 py-5 shadow-[var(--shadow-sm)]">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <span className="ev-eyebrow">Activity</span>
        <span className="font-mono text-[11px] text-faint">click a span to jump the record</span>
      </div>

      <div className="grid grid-cols-[2.75rem_1fr] items-center gap-y-2">
        <span className="font-mono text-[10.5px] text-label">cmd</span>
        <div className="relative h-6">
          <div className="absolute inset-x-0 top-1/2 h-px bg-rule-faint" aria-hidden="true" />
          {model.commands.map((command) => {
            const start = safeBigInt(command.occurredAt);
            const end =
              command.exit === undefined
                ? bounds.lastOccurredAt
                : safeBigInt(command.exit.occurredAt);
            const { leftPct, widthPct } = geometry(start, end, first, total);
            const failed = command.exit?.exitCode !== undefined && command.exit.exitCode !== 0;
            const selected = selectedSequence === command.sequence;
            return (
              <button
                key={command.sequence}
                type="button"
                onClick={() => onSelectCommand(command)}
                title={command.commandLine}
                aria-label={`Jump to ${command.commandLine}`}
                className={`absolute inset-y-0.5 rounded-[4px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                  selected
                    ? "bg-primary/25 shadow-[inset_2px_0_0_var(--sw-accent)]"
                    : failed
                      ? "bg-[var(--sw-red)]/20 shadow-[inset_2px_0_0_var(--sw-red)] hover:bg-[var(--sw-red)]/30"
                      : "bg-foreground/15 hover:bg-foreground/25"
                }`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            );
          })}
        </div>

        {fileTicks.length > 0 ? (
          <>
            <span className="font-mono text-[10.5px] text-label">file</span>
            <div className="relative h-3.5">
              <div className="absolute inset-x-0 top-1/2 h-px bg-rule-faint" aria-hidden="true" />
              {fileTicks.map((file) => {
                const { leftPct } = geometry(
                  safeBigInt(file.occurredAt),
                  safeBigInt(file.occurredAt),
                  first,
                  total,
                );
                return (
                  <span
                    key={file.sequence}
                    title={`${file.kind} ${file.path}`}
                    className="absolute top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-[1.5px] bg-foreground/40"
                    style={{ left: `${leftPct}%` }}
                  />
                );
              })}
            </div>
          </>
        ) : null}

        {networkTicks.length > 0 ? (
          <>
            <span className="font-mono text-[10.5px] text-label">net</span>
            <div className="relative h-3.5">
              <div className="absolute inset-x-0 top-1/2 h-px bg-rule-faint" aria-hidden="true" />
              {networkTicks.map((net) => {
                const { leftPct } = geometry(
                  safeBigInt(net.firstOccurredAt),
                  safeBigInt(net.firstOccurredAt),
                  first,
                  total,
                );
                return (
                  <span
                    key={`${net.host}:${net.port}:${net.firstSequence}`}
                    title={`${net.host}:${net.port} · ${net.requestCount} requests`}
                    className="absolute top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40"
                    style={{ left: `${leftPct}%` }}
                  />
                );
              })}
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-[2.75rem_1fr]">
        <span />
        <div className="relative h-4 border-t border-rule">
          <span className="absolute top-1 left-0 font-mono text-[10px] text-faint">00:00.000</span>
          <span className="absolute top-1 right-0 font-mono text-[10px] text-faint">
            {formatOffset(bounds.lastOccurredAt.toString(), first)}
          </span>
        </div>
      </div>
    </div>
  );
}
