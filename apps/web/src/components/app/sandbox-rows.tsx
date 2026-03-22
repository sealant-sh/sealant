import { Badge } from "@sealant/ui";
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
      <div className="border border-border bg-muted/20 px-6 py-12 text-center">
        <p className="font-mono text-xs tracking-[0.12em] text-muted-foreground">
          No sandboxes found
        </p>
      </div>
    );
  }

  return (
    <div className="border border-border">
      {sandboxes.map((sandbox) => (
        <Link
          key={sandbox.sandboxId}
          to={`/sandboxes/${encodeURIComponent(sandbox.sandboxId)}` as never}
          className="grid grid-cols-1 gap-3 border-b border-border px-4 py-3 no-underline transition-[background-color,transform] duration-200 last:border-b-0 hover:bg-muted/40 sm:grid-cols-[1.3fr_1fr_auto] sm:items-center"
        >
          <div>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              Sandbox
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">{sandbox.name}</p>
            <p className="mt-1 font-mono text-[0.62rem] tracking-[0.11em] text-muted-foreground">
              {sandbox.sandboxId}
            </p>
          </div>

          <div>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              Repository
            </p>
            <p className="mt-1 font-mono text-xs text-foreground">
              {sandbox.repository ?? "Unknown"}
            </p>
            <p className="mt-1 font-mono text-[0.62rem] tracking-[0.11em] text-muted-foreground">
              Tag: {sandbox.tag ?? "n/a"}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <Badge className={badgeClassName(sandbox.status)}>{sandbox.status}</Badge>
            <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {toRelativeTime(sandbox.createdAt)}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}

function badgeClassName(status: SandboxStatus): string {
  if (status === "running") {
    return "rounded-none bg-primary text-primary-foreground font-mono text-[0.58rem] tracking-[0.11em]";
  }

  if (status === "failed") {
    return "rounded-none border border-border bg-muted text-foreground font-mono text-[0.58rem] tracking-[0.11em]";
  }

  if (status === "ready") {
    return "rounded-none border border-border bg-card text-foreground font-mono text-[0.58rem] tracking-[0.11em]";
  }

  if (status === "queued") {
    return "rounded-none border border-border bg-card text-muted-foreground font-mono text-[0.58rem] tracking-[0.11em]";
  }

  return "rounded-none border border-border bg-muted/30 text-muted-foreground font-mono text-[0.58rem] tracking-[0.11em]";
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
