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
      <div className="border border-border rounded-md px-6 py-12 text-center">
        <p className="font-mono text-xs text-faint">No sandboxes found</p>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-md">
      {sandboxes.map((sandbox) => (
        <Link
          key={sandbox.sandboxId}
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: sandbox.sandboxId }}
          className="grid grid-cols-1 gap-3 border-b border-rule-faint px-4 py-3 no-underline transition-colors duration-200 last:border-b-0 hover:bg-muted/40 sm:grid-cols-[1.3fr_1fr_auto] sm:items-center"
        >
          <div>
            <p className="ev-eyebrow">Sandbox</p>
            <p className="mt-1 text-sm font-medium text-foreground">{sandbox.name}</p>
            <p className="mt-1 font-mono text-xs text-faint">{sandbox.sandboxId}</p>
          </div>

          <div>
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1 font-mono text-xs text-ink-2">{sandbox.repository ?? "Unknown"}</p>
            <p className="mt-1 font-mono text-xs text-faint">Tag: {sandbox.tag ?? "n/a"}</p>
          </div>

          <div className="flex items-center justify-between gap-3 sm:justify-end">
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
    <span className="inline-flex items-center gap-2 font-medium text-sm">
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
