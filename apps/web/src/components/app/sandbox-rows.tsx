import { Link } from "@tanstack/react-router";

type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

interface SandboxListItem {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly createdAt: string;
}

interface SandboxRowsProps {
  readonly sandboxes: readonly SandboxListItem[];
}

export function SandboxRows({ sandboxes }: SandboxRowsProps) {
  if (sandboxes.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-[var(--shadow-sm)]">
        <p className="font-mono text-xs text-faint">No sandboxes found</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      {sandboxes.map((sandbox) => (
        <Link
          key={sandbox.sandboxId}
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: sandbox.sandboxId }}
          className="group grid grid-cols-1 gap-4 border-b border-rule-faint px-6 py-5 no-underline transition-[transform,box-shadow,background-color] duration-200 last:border-b-0 hover:-translate-y-0.5 hover:bg-accent/40 hover:shadow-[var(--shadow-md)] sm:grid-cols-[1.3fr_1fr_auto] sm:items-center"
        >
          <div className="min-w-0">
            <p className="ev-eyebrow">Sandbox</p>
            <p className="mt-1.5 truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
              {sandbox.name}
            </p>
            <p className="mt-1 font-mono text-xs text-faint">{sandbox.sandboxId}</p>
          </div>

          <div className="min-w-0">
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1.5 truncate font-mono text-xs text-ink-2">
              {sandbox.repository ?? "Unknown"}
            </p>
            <p className="mt-1 font-mono text-xs text-faint">Tag: {sandbox.tag ?? "n/a"}</p>
          </div>

          <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-2">
            <SandboxStatusIndicator status={sandbox.status} />
            <span className="font-mono text-xs text-faint">
              {toRelativeTime(sandbox.createdAt)}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}

function SandboxStatusIndicator({ status }: { readonly status: SandboxStatus }) {
  const { dotClassName, textClassName, label } = statusPresentation(status);

  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span className={`size-2 shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
      <span className={textClassName}>{label}</span>
    </span>
  );
}

function statusPresentation(status: SandboxStatus): {
  readonly dotClassName: string;
  readonly textClassName: string;
  readonly label: string;
} {
  switch (status) {
    case "running":
      return { dotClassName: "bg-success-dot", textClassName: "text-success", label: "Running" };
    case "ready":
      return { dotClassName: "bg-success-dot", textClassName: "text-success", label: "Ready" };
    case "queued":
      return { dotClassName: "bg-warning-dot", textClassName: "text-warning", label: "Queued" };
    case "failed":
      return { dotClassName: "bg-danger-dot", textClassName: "text-danger", label: "Failed" };
    case "cancelled":
      return {
        dotClassName: "border-[1.5px] border-input bg-transparent",
        textClassName: "text-ink-2",
        label: "Cancelled",
      };
  }
}

function toRelativeTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (absMs < 60_000) {
    const seconds = Math.round(diffMs / 1000);
    return rtf.format(seconds, "second");
  }

  if (absMs < 3_600_000) {
    const minutes = Math.round(diffMs / 60_000);
    return rtf.format(minutes, "minute");
  }

  if (absMs < 86_400_000) {
    const hours = Math.round(diffMs / 3_600_000);
    return rtf.format(hours, "hour");
  }

  const days = Math.round(diffMs / 86_400_000);
  return rtf.format(days, "day");
}
