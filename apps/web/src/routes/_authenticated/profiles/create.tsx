import { Button } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxPage } from "@/components/app/sandbox-page";

export const Route = createFileRoute("/_authenticated/profiles/create")({
  component: CreateProfilePage,
});

function CreateProfilePage() {
  return (
    <SandboxPage
      kicker="Profiles"
      title="Create profile"
      description="Define a reusable profile once, then apply the same environment contract across repositories and runs."
    >
      <form className="grid gap-4 border border-border p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            Profile name
          </span>
          <input
            className="h-11 border border-border bg-background px-3 text-sm text-foreground focus:border-foreground focus:outline-none"
            placeholder="Nightly refresh"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            Environment
          </span>
          <input
            className="h-11 border border-border bg-background px-3 text-sm text-foreground focus:border-foreground focus:outline-none"
            placeholder="Staging"
          />
        </label>
        <label className="sm:col-span-2 flex flex-col gap-2">
          <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            Setup note
          </span>
          <textarea
            className="min-h-28 border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-foreground focus:outline-none"
            placeholder="List package, secret, and access assumptions."
          />
        </label>
        <div className="sm:col-span-2">
          <Button className="h-11 px-4">Create profile</Button>
        </div>
      </form>
    </SandboxPage>
  );
}
