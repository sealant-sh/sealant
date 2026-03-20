import * as React from "react"
import { Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export interface OciLayer {
  mediaType: string
  size: number
  digest: string
}

export interface ManifestDetailProps {
  repository: string
  reference: string
  digest?: string
  contentType: string | null
  manifest: unknown
  className?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function truncateDigest(digest: string, chars = 16): string {
  if (!digest.startsWith("sha256:")) return digest
  return `sha256:${digest.slice(7, 7 + chars)}…`
}

export function ManifestDetail({
  repository,
  reference,
  digest,
  contentType,
  manifest,
  className,
}: ManifestDetailProps) {
  const [copied, setCopied] = React.useState(false)

  const handleCopyDigest = React.useCallback(async () => {
    if (!digest) return
    await navigator.clipboard.writeText(digest)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [digest])

  const layers = getLayers(manifest)
  const totalSize = layers.reduce((sum, l) => sum + l.size, 0)

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {/* Image identity */}
      <div className="border border-border bg-card p-6">
        <p className="mb-2 font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted-foreground/60">
          IMAGE
        </p>
        <h2 className="font-display text-4xl leading-[0.88] uppercase tracking-[0.02em] text-foreground break-all">
          {repository}
          <span className="text-primary">:{reference}</span>
        </h2>
        {digest && (
          <div className="mt-3 flex items-center gap-2">
            <span className="font-mono text-xs text-foreground truncate">
              {truncateDigest(digest)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleCopyDigest}
              aria-label="Copy full digest"
                className="shrink-0 rounded-none border border-border text-muted-foreground hover:text-foreground"
              >
              {copied ? (
                <Check className="size-3 text-secondary" />
              ) : (
                <Copy className="size-3" />
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3">
        <MetaCell label="CONTENT TYPE" value={contentType ?? "UNKNOWN"} mono />
        <MetaCell label="LAYERS" value={String(layers.length)} />
        <MetaCell label="TOTAL SIZE" value={formatBytes(totalSize)} mono />
      </div>

      {/* Layers table */}
      {layers.length > 0 && (
        <div>
          <p className="mb-3 font-semibold text-[0.66rem] tracking-[0.12em] uppercase text-muted-foreground">
            LAYERS
          </p>
          <div className="border border-border">
            {/* Header */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border bg-muted/30 px-4 py-2">
              <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground/60">
                DIGEST
              </span>
              <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground/60 text-right">
                SIZE
              </span>
              <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground/60 text-right w-24">
                MEDIA TYPE
              </span>
            </div>
            {layers.map((layer, i) => (
              <div
                key={layer.digest}
                className={cn(
                  "grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 items-center",
                  i < layers.length - 1 && "border-b border-border"
                )}
              >
                <span className="font-mono text-xs text-foreground truncate">
                  {truncateDigest(layer.digest)}
                </span>
                <span className="font-mono text-xs text-muted-foreground text-right tabular-nums">
                  {formatBytes(layer.size)}
                </span>
                <Badge className="w-24 justify-center rounded-none border border-border bg-muted text-muted-foreground font-mono text-[9px] tracking-[0.11em] truncate">
                  {layer.mediaType.split("/").pop()?.replace("vnd.oci.image.layer.v1.", "") ?? layer.mediaType}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Raw manifest JSON */}
      <div>
        <p className="mb-3 font-semibold text-[0.66rem] tracking-[0.12em] uppercase text-muted-foreground">
          RAW MANIFEST
        </p>
        <pre className="overflow-auto max-h-80 border border-border bg-card p-4 font-mono text-xs text-foreground leading-relaxed">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      </div>
    </div>
  )
}

interface MetaCellProps {
  label: string
  value: string
  mono?: boolean
}

function MetaCell({ label, value, mono }: MetaCellProps) {
  return (
    <div className="bg-card p-4">
      <p className="mb-1 font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground/60">
        {label}
      </p>
      <p
        className={cn(
          "text-sm text-foreground break-all",
          mono && "font-mono"
        )}
      >
        {value}
      </p>
    </div>
  )
}

function getLayers(manifest: unknown): OciLayer[] {
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "layers" in manifest &&
    Array.isArray((manifest as { layers: unknown }).layers)
  ) {
    return (manifest as { layers: OciLayer[] }).layers
  }
  return []
}
