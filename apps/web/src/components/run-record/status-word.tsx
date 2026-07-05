/**
 * Status as a dot + word (DESIGN.md §4) — never a filled pill, never a tinted row. Green only
 * for an observed result, red only for demonstrated breakage, amber for not-yet-run, a hollow
 * ring for a disposition not yet made.
 */

export type StatusTone = "observed" | "pending" | "breakage" | "open";

const TONE_CLASSES: Record<StatusTone, { dot: string; text: string }> = {
  observed: { dot: "bg-success-dot", text: "text-success" },
  pending: { dot: "bg-warning-dot", text: "text-warning" },
  breakage: { dot: "bg-danger-dot", text: "text-danger" },
  open: { dot: "border-[1.5px] border-input bg-transparent", text: "text-ink-2" },
};

export function StatusWord({ tone, word }: { readonly tone: StatusTone; readonly word: string }) {
  const classes = TONE_CLASSES[tone];
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium">
      <span className={`size-1.5 shrink-0 rounded-full ${classes.dot}`} aria-hidden="true" />
      <span className={classes.text}>{word}</span>
    </span>
  );
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const runStatusPresentation = (
  status: RunStatus,
  exitCode?: number,
): { tone: StatusTone; word: string } => {
  switch (status) {
    case "completed":
      return { tone: "observed", word: "Completed · observed" };
    case "failed":
      return {
        tone: "breakage",
        word: exitCode === undefined ? "Failed · observed" : `Failed · exit ${exitCode}`,
      };
    case "running":
      return { tone: "observed", word: "Recording" };
    case "queued":
      return { tone: "pending", word: "Queued" };
    case "cancelled":
      return { tone: "open", word: "Cancelled" };
  }
};

export function RecordingPulse() {
  return (
    <span
      className="relative inline-flex size-2.5 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      <span className="absolute inline-flex size-2.5 rounded-full bg-primary/40 motion-safe:animate-ping" />
      <span className="relative size-2 rounded-full bg-primary" />
    </span>
  );
}
