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
    <div className={cn("flex flex-col gap-0 rounded-md border border-border bg-card", className)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <p className="ev-eyebrow">Registry</p>
          <h3 className="mt-1 truncate text-lg font-semibold tracking-tight text-foreground">
            {name}
          </h3>
        </div>
        {hasBasicAuth ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-primary">
            <Lock className="size-3" />
            Authenticated
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <LockOpen className="size-3" />
            No auth
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-col gap-3 p-4">
        <DataRow label="Base URL" value={baseUrl} mono />
        <DataRow label="Push registry" value={pushRegistry} mono />
      </div>

      {/* Footer */}
      <div className="mt-auto border-t border-border p-4">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          render={<Link to="/registry/$registryId" params={{ registryId: id }} />}
        >
          Explore
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
      <span className="text-xs text-label">{label}</span>
      <span
        className={cn("truncate text-xs text-foreground", mono && "font-mono text-faint")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
