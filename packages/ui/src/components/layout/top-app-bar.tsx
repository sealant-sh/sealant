import { cn } from "@sealant/ui/lib/utils";
import { Link, linkOptions } from "@tanstack/react-router";
import * as React from "react";

export type SystemStatus = "online" | "degraded" | "offline";

interface TopAppBarProps {
  status?: SystemStatus;
  className?: string;
}

const statusConfig: Record<SystemStatus, { label: string; dot: string; text: string }> = {
  online: { label: "Online", dot: "bg-success-dot", text: "text-success" },
  degraded: { label: "Degraded", dot: "bg-warning-dot", text: "text-warning" },
  offline: { label: "Offline", dot: "bg-danger-dot", text: "text-danger" },
};

export function TopAppBar({ status = "online", className }: TopAppBarProps) {
  const { label, dot, text } = statusConfig[status];

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 flex h-16 items-center border-b border-border bg-card px-6",
        className,
      )}
    >
      {/* Brand */}
      <Link
        to="/"
        className="flex shrink-0 items-center gap-3 no-underline"
        aria-label="Sealant home"
      >
        <span className="text-lg font-semibold tracking-tight text-foreground">Sealant</span>
      </Link>

      {/* Navigation */}
      <nav className="ml-10 flex items-center gap-1" aria-label="Main navigation">
        <TopNavLink to="/registry">Registry</TopNavLink>
      </nav>

      {/* System status — right aligned */}
      <div className="ml-auto flex items-center gap-2">
        <div className={cn("h-1.5 w-1.5 rounded-full", dot)} aria-hidden="true" />
        <span className={cn("font-mono text-xs", text)}>{label}</span>
      </div>
    </header>
  );
}

interface TopNavLinkProps {
  to: "/registry";
  children: React.ReactNode;
}

function TopNavLink({ to, children }: TopNavLinkProps) {
  const options = linkOptions({ to });

  return (
    <Link
      {...options}
      className="px-3 py-1.5 text-[13px] text-muted-foreground no-underline transition-colors duration-200 hover:text-foreground"
      activeProps={{
        className:
          "px-3 py-1.5 text-[13px] font-medium text-primary no-underline transition-colors",
      }}
    >
      {children}
    </Link>
  );
}
