import { Button } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePage } from "@/components/app/workspace-page";

export const Route = createFileRoute("/_authenticated/profiles/create")({
  component: CreateProfilePage,
});

function CreateProfilePage() {
  return (
    <WorkspacePage
      kicker="Profiles"
      title="Create profile"
      description="Define a reusable profile once, then apply the same environment contract across repositories and runs."
    >
      <form className="grid gap-6 rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:grid-cols-2 sm:p-8">
        <label className="flex flex-col gap-2">
          <span className="ev-eyebrow">Profile name</span>
          <input
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            placeholder="Nightly refresh"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="ev-eyebrow">Environment</span>
          <input
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            placeholder="Staging"
          />
        </label>
        <label className="sm:col-span-2 flex flex-col gap-2">
          <span className="ev-eyebrow">Setup note</span>
          <textarea
            className="min-h-28 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            placeholder="List package, secret, and access assumptions."
          />
        </label>
        <div className="sm:col-span-2">
          <Button className="h-11 px-5">Create profile</Button>
        </div>
      </form>
    </WorkspacePage>
  );
}
