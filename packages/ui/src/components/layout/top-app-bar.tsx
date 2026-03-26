import { cn } from "@sealant/ui/lib/utils";
import { Link, linkOptions } from "@tanstack/react-router";
import * as React from "react";

export type SystemStatus = "online" | "degraded" | "offline";

interface TopAppBarProps {
  status?: SystemStatus;
  className?: string;
}

const statusConfig: Record<SystemStatus, { label: string; color: string }> = {
  online: { label: "ONLINE", color: "bg-foreground" },
  degraded: { label: "DEGRADED", color: "bg-muted-foreground" },
  offline: { label: "OFFLINE", color: "bg-red-500" },
};

export function TopAppBar({ status = "online", className }: TopAppBarProps) {
  const { label, color } = statusConfig[status];

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 flex h-16 items-center border-b-2 border-foreground bg-card px-6",
        className,
      )}
    >
      {/* Brand */}
      <Link
        to="/"
        className="flex shrink-0 items-center gap-3 no-underline"
        aria-label="Sealant home"
      >
        <span className="font-display text-3xl tracking-[0.04em] uppercase text-foreground">
          SEALANT
        </span>
      </Link>

      {/* Navigation */}
      <nav className="ml-10 flex items-center gap-1" aria-label="Main navigation">
        <TopNavLink to="/registry">REGISTRY</TopNavLink>
      </nav>

      {/* System status — right aligned */}
      <div className="ml-auto flex items-center gap-2">
        <div className={cn("h-2 w-2 rounded-full", color)} aria-hidden="true" />
        <span className="font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
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
      className="px-3 py-1.5 font-semibold text-[0.68rem] tracking-[0.12em] uppercase text-muted-foreground no-underline transition-colors duration-200 hover:text-foreground"
      activeProps={{
        className:
          "px-3 py-1.5 font-semibold text-[0.68rem] tracking-[0.12em] uppercase text-primary no-underline transition-colors",
      }}
    >
      {children}
    </Link>
  );
}
