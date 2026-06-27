import { Button } from "@sealant/ui/components/ui/button";
import { cn } from "@sealant/ui/lib/utils";
import { Copy, Check } from "lucide-react";
import * as React from "react";

export interface OciLayer {
  mediaType: string;
  size: number;
  digest: string;
}

export interface ManifestDetailProps {
  repository: string;
  reference: string;
  digest?: string;
  contentType: string | null;
  manifest: unknown;
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncateDigest(digest: string, chars = 16): string {
  if (!digest.startsWith("sha256:")) return digest;
  return `sha256:${digest.slice(7, 7 + chars)}…`;
}

export function ManifestDetail({
  repository,
  reference,
  digest,
  contentType,
  manifest,
  className,
}: ManifestDetailProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopyDigest = React.useCallback(async () => {
    if (!digest) return;
    await navigator.clipboard.writeText(digest);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [digest]);

  const layers = getLayers(manifest);
  const totalSize = layers.reduce((sum, l) => sum + l.size, 0);

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {/* Image identity */}
      <div className="rounded-md border border-border bg-card p-6">
        <p className="ev-eyebrow mb-2">Image</p>
        <h2 className="break-all text-2xl font-semibold tracking-tight text-foreground">
          {repository}
          <span className="text-primary">:{reference}</span>
        </h2>
        {digest && (
          <div className="mt-3 flex items-center gap-2">
            <span className="truncate font-mono text-xs text-faint">{truncateDigest(digest)}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleCopyDigest}
              aria-label="Copy full digest"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
            </Button>
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
        <MetaCell label="Content type" value={contentType ?? "Unknown"} mono />
        <MetaCell label="Layers" value={String(layers.length)} />
        <MetaCell label="Total size" value={formatBytes(totalSize)} mono />
      </div>

      {/* Layers table */}
      {layers.length > 0 && (
        <div>
          <p className="ev-eyebrow mb-3">Layers</p>
          <div className="rounded-md border border-border">
            {/* Header */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border bg-muted/40 px-4 py-2">
              <span className="text-xs text-label">Digest</span>
              <span className="text-right text-xs text-label">Size</span>
              <span className="w-24 text-right text-xs text-label">Media type</span>
            </div>
            {layers.map((layer, i) => (
              <div
                key={layer.digest}
                className={cn(
                  "grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-2.5",
                  i < layers.length - 1 && "border-b border-border",
                )}
              >
                <span className="truncate font-mono text-xs text-faint">
                  {truncateDigest(layer.digest)}
                </span>
                <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatBytes(layer.size)}
                </span>
                <span className="w-24 truncate text-right font-mono text-xs text-faint">
                  {layer.mediaType.split("/").pop()?.replace("vnd.oci.image.layer.v1.", "") ??
                    layer.mediaType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Raw manifest JSON */}
      <div>
        <p className="ev-eyebrow mb-3">Raw manifest</p>
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-card p-4 font-mono text-xs leading-relaxed text-foreground">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      </div>
    </div>
  );
}

interface MetaCellProps {
  label: string;
  value: string;
  mono?: boolean;
}

function MetaCell({ label, value, mono }: MetaCellProps) {
  return (
    <div className="bg-card p-4">
      <p className="mb-1 text-xs text-label">{label}</p>
      <p className={cn("break-all text-sm text-foreground", mono && "font-mono text-faint")}>
        {value}
      </p>
    </div>
  );
}

function getLayers(manifest: unknown): OciLayer[] {
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "layers" in manifest &&
    Array.isArray((manifest as { layers: unknown }).layers)
  ) {
    return (manifest as { layers: OciLayer[] }).layers;
  }
  return [];
}
