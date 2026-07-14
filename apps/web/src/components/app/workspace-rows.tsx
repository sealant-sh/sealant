import { Button } from "@sealant/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useTRPC } from "@/lib/trpc/react";

type WorkspaceStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "stopped";

interface WorkspaceListItem {
  readonly workspaceId: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly createdAt: string;
}

interface WorkspaceRowsProps {
  readonly workspaces: readonly WorkspaceListItem[];
}

export function WorkspaceRows({ workspaces }: WorkspaceRowsProps) {
  if (workspaces.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-[var(--shadow-sm)]">
        <p className="font-mono text-xs text-faint">No workspaces found</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      {workspaces.map((workspace) => (
        <Link
          key={workspace.workspaceId}
          to="/workspaces/$workspaceId"
          params={{ workspaceId: workspace.workspaceId }}
          className="group grid grid-cols-1 gap-4 border-b border-rule-faint px-6 py-5 no-underline transition-[transform,box-shadow,background-color] duration-200 last:border-b-0 hover:-translate-y-0.5 hover:bg-accent/40 hover:shadow-[var(--shadow-md)] sm:grid-cols-[1.3fr_1fr_auto] sm:items-center"
        >
          <div className="min-w-0">
            <p className="ev-eyebrow">Workspace</p>
            <p className="mt-1.5 truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
              {workspace.name}
            </p>
            <p className="mt-1 font-mono text-xs text-faint">{workspace.workspaceId}</p>
          </div>

          <div className="min-w-0">
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1.5 truncate font-mono text-xs text-ink-2">
              {workspace.repository ?? "Unknown"}
            </p>
            <p className="mt-1 font-mono text-xs text-faint">Tag: {workspace.tag ?? "n/a"}</p>
          </div>

          <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-2">
            <WorkspaceStatusIndicator status={workspace.status} />
            <span className="font-mono text-xs text-faint">
              {toRelativeTime(workspace.createdAt)}
            </span>
            {workspace.status === "ready" ? (
              <StopWorkspaceButton workspaceId={workspace.workspaceId} />
            ) : null}
          </div>
        </Link>
      ))}
    </div>
  );
}

// The row itself is a Link, so the quiet stop action must swallow the click before navigation.
function StopWorkspaceButton({ workspaceId }: { readonly workspaceId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stopWorkspaceMutation = useMutation(
    trpc.workspace.stop.mutationOptions({
      onSuccess: async () => {
        // The stop also changes the detail page and sidebar — invalidate the workspace family.
        await queryClient.invalidateQueries({ queryKey: trpc.workspace.pathKey() });
      },
    }),
  );

  return (
    <Button
      type="button"
      variant="ghost"
      className="h-7 px-2 text-xs text-muted-foreground"
      disabled={stopWorkspaceMutation.isPending}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        stopWorkspaceMutation.mutate({ workspaceId });
      }}
    >
      {stopWorkspaceMutation.isPending ? "Stopping" : "Stop"}
    </Button>
  );
}

function WorkspaceStatusIndicator({ status }: { readonly status: WorkspaceStatus }) {
  const { dotClassName, textClassName, label } = statusPresentation(status);

  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span className={`size-2 shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
      <span className={textClassName}>{label}</span>
    </span>
  );
}

function statusPresentation(status: WorkspaceStatus): {
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
    case "stopped":
      return {
        dotClassName: "border-[1.5px] border-input bg-transparent",
        textClassName: "text-ink-2",
        label: "Stopped",
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
