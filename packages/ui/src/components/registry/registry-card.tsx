import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ArrowRight, Lock, LockOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export interface RegistryCardProps {
  id: string
  name: string
  baseUrl: string
  pushRegistry: string
  hasBasicAuth: boolean
  className?: string
}

export function RegistryCard({
  id,
  name,
  baseUrl,
  pushRegistry,
  hasBasicAuth,
  className,
}: RegistryCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0 border border-border bg-card",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <p className="font-black text-xs tracking-widest uppercase text-muted-foreground">
            REGISTRY
          </p>
          <h3 className="mt-1 font-black text-base tracking-widest uppercase text-foreground truncate">
            {name.toUpperCase()}
          </h3>
        </div>
        <Badge
          className={cn(
            "shrink-0 rounded-none font-mono text-[10px] tracking-widest uppercase",
            hasBasicAuth
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
          )}
        >
          {hasBasicAuth ? (
            <span className="flex items-center gap-1">
              <Lock className="size-2.5" />
              AUTH
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <LockOpen className="size-2.5" />
              NO AUTH
            </span>
          )}
        </Badge>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-3 p-4">
        <DataRow label="BASE URL" value={baseUrl} mono />
        <DataRow label="PUSH REGISTRY" value={pushRegistry} mono />
      </div>

      {/* Footer */}
      <div className="mt-auto border-t border-border bg-muted/20 p-4">
        <Button
          variant="outline"
          size="sm"
          className="w-full rounded-none border-border font-black tracking-widest uppercase hover:bg-primary hover:text-primary-foreground hover:border-primary"
          render={
            <Link to="/registry/$registryId" params={{ registryId: id }} />
          }
        >
          EXPLORE
          <ArrowRight className="size-3.5" data-icon="inline-end" />
        </Button>
      </div>
    </div>
  )
}

interface DataRowProps {
  label: string
  value: string
  mono?: boolean
}

function DataRow({ label, value, mono }: DataRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-black tracking-widest uppercase text-muted-foreground/60">
        {label}
      </span>
      <span
        className={cn(
          "text-xs text-secondary truncate",
          mono && "font-mono"
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}
