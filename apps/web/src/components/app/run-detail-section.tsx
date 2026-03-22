import type { ReactNode } from "react";

import { WorkspacePage } from "@/components/app/workspace-page";

type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

interface SandboxDetail {
  readonly sandboxId: string;
  readonly status: SandboxStatus;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
}

interface RunDetailSectionProps {
  readonly sandbox: SandboxDetail | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function RunDetailSection({
  sandbox,
  section,
  description,
  children,
}: RunDetailSectionProps) {
  if (sandbox === null) {
    return (
      <WorkspacePage
        kicker="Sandboxes"
        title="Sandbox not found"
        description="The selected sandbox does not exist in the current workspace view."
      />
    );
  }

  return (
    <WorkspacePage
      kicker="Sandbox Detail"
      title={`${sandbox.sandboxId} ${section}`}
      description={description}
      metrics={[
        { label: "Repository", value: sandbox.repository ?? "Unknown" },
        { label: "Tag", value: sandbox.tag ?? "n/a" },
        { label: "Status", value: sandbox.status },
      ]}
    >
      {children}
    </WorkspacePage>
  );
}
