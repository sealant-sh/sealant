import { Badge } from "@sealant/ui/components/ui/badge";
import { Button } from "@sealant/ui/components/ui/button";
import { cn } from "@sealant/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Lock, LockOpen } from "lucide-react";
import * as React from "react";

export interface RegistryCardProps {
  id: string;
  name: string;
  baseUrl: string;
  pushRegistry: string;
  hasBasicAuth: boolean;
  className?: string;
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
    <div className={cn("flex flex-col gap-0 border border-border bg-card", className)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <p className="font-semibold text-[0.66rem] tracking-[0.12em] uppercase text-muted-foreground">
            REGISTRY
          </p>
          <h3 className="mt-1 font-display text-3xl tracking-[0.02em] uppercase leading-[0.88] text-foreground truncate">
            {name.toUpperCase()}
          </h3>
        </div>
        <Badge
          className={cn(
            "shrink-0 rounded-none border font-mono text-[10px] tracking-[0.12em] uppercase",
            hasBasicAuth
              ? "bg-primary text-primary-foreground"
              : "border-border bg-muted text-muted-foreground",
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
      <div className="mt-auto border-t border-border bg-muted/30 p-4">
        <Button
          variant="outline"
          size="sm"
          className="w-full border-border"
          render={<Link to="/registry/$registryId" params={{ registryId: id }} />}
        >
          EXPLORE
          <ArrowRight className="size-3.5" data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}

interface DataRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function DataRow({ label, value, mono }: DataRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-muted-foreground/60">
        {label}
      </span>
      <span className={cn("text-xs text-foreground truncate", mono && "font-mono")} title={value}>
        {value}
      </span>
    </div>
  );
}
