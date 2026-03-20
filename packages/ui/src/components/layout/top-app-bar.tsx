import * as React from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@/lib/utils"

export type SystemStatus = "online" | "degraded" | "offline"

interface TopAppBarProps {
  status?: SystemStatus
  className?: string
}

const statusConfig: Record<SystemStatus, { label: string; color: string }> = {
  online: { label: "ONLINE", color: "bg-emerald-400" },
  degraded: { label: "DEGRADED", color: "bg-amber-400" },
  offline: { label: "OFFLINE", color: "bg-red-500" },
}

export function TopAppBar({ status = "online", className }: TopAppBarProps) {
  const { label, color } = statusConfig[status]

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 flex h-20 items-center border-b border-border bg-card px-6",
        className
      )}
    >
      {/* Brand */}
      <Link
        to="/"
        className="flex shrink-0 items-center gap-3 no-underline"
        aria-label="Sealant home"
      >
        <span className="font-black text-xl tracking-[0.22em] uppercase text-foreground">
          SEALANT
        </span>
      </Link>

      {/* Navigation */}
      <nav className="ml-10 flex items-center gap-1" aria-label="Main navigation">
        <TopNavLink to="/registry">REGISTRY</TopNavLink>
      </nav>

      {/* System status — right aligned */}
      <div className="ml-auto flex items-center gap-2">
        <div
          className={cn("h-2 w-2 rounded-full", color)}
          aria-hidden="true"
        />
        <span className="font-mono text-xs tracking-widest text-muted-foreground">
          {label}
        </span>
      </div>
    </header>
  )
}

interface TopNavLinkProps {
  to: string
  children: React.ReactNode
}

function TopNavLink({ to, children }: TopNavLinkProps) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 font-black text-xs tracking-widest uppercase text-muted-foreground no-underline transition-colors hover:text-foreground"
      activeProps={{
        className:
          "px-3 py-1.5 font-black text-xs tracking-widest uppercase text-primary no-underline transition-colors",
      }}
    >
      {children}
    </Link>
  )
}
