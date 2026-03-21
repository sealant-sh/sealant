import { Button } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePage } from "@/components/app/workspace-page";
import { getRunById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/$runId/" as never)({
  loader: ({ params }: { params: { runId: string } }) => getRunById(params.runId),
  component: RunSummaryPage,
});

function RunSummaryPage() {
  const run = Route.useLoaderData() as ReturnType<typeof getRunById>;

  if (run === null) {
    return (
      <WorkspacePage
        kicker="Run Detail"
        title="Run not found"
        description="The selected run does not exist in the current workspace catalog."
      />
    );
  }

  return (
    <section className="overflow-hidden border border-border bg-card">
      <div className="h-1 w-full bg-primary" />

      <div className="grid gap-0 border-b border-border lg:grid-cols-[1fr_auto]">
        <div className="px-6 py-6 sm:px-8">
          <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
            Operational Log // Run Archive
          </p>
          <h1 className="mt-4 max-w-4xl font-display text-6xl leading-[0.86] tracking-[0.02em] text-foreground sm:text-7xl">
            {run.id} Fix mobile nav overflow
          </h1>
          <p className="mt-4 font-mono text-[0.72rem] text-muted-foreground">
            {run.repoId} / feat/mobile-fix-v2
          </p>
        </div>
        <div className="flex flex-col gap-3 border-t border-border p-6 sm:flex-row sm:border-l sm:border-t-0 sm:p-8 lg:flex-col">
          <Button className="h-11 px-5">Open Draft PR</Button>
          <Button variant="outline" className="h-11 px-5">
            Rerun
          </Button>
          <Button variant="outline" className="h-11 px-5">
            Continue with feedback
          </Button>
        </div>
      </div>

      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-card px-4 py-4">
          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">Status</p>
          <p className="mt-2 text-2xl font-semibold text-primary">Completed</p>
        </div>
        <div className="bg-card px-4 py-4">
          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            Duration
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground">2m 14s</p>
        </div>
        <div className="bg-card px-4 py-4">
          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            Profile
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground">Node Dev</p>
        </div>
        <div className="bg-card px-4 py-4">
          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            Harness
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground">OpenCode</p>
        </div>
      </div>

      <div className="grid gap-px border-border xl:grid-cols-[1.4fr_1fr]">
        <div className="border-r border-border">
          <section className="border-b border-border px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
              01 // Objective
            </p>
            <h2 className="mt-4 font-display text-4xl text-foreground sm:text-5xl">
              What was attempted
            </h2>
            <p className="mt-5 max-w-3xl text-xl leading-9 text-foreground/90">
              Fix mobile navigation overflow issues on small devices. The layout was previously
              breaking on viewports under 414px due to rigid width containers in the header
              component.
            </p>
            <div className="mt-7 inline-flex border border-border px-4 py-3 font-mono text-[0.7rem] tracking-[0.13em] text-muted-foreground">
              Linked issue: #492
            </div>
          </section>

          <div className="grid gap-px border-b border-border md:grid-cols-2">
            <section className="px-6 py-6 sm:px-8">
              <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
                02 // Changes overview
              </p>
              <div className="mt-6 grid grid-cols-3 gap-4">
                <div>
                  <p className="font-display text-6xl text-foreground">3</p>
                  <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                    Files
                  </p>
                </div>
                <div>
                  <p className="font-display text-6xl text-emerald-400">+42</p>
                  <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                    Additions
                  </p>
                </div>
                <div>
                  <p className="font-display text-6xl text-primary">-12</p>
                  <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                    Deletions
                  </p>
                </div>
              </div>
            </section>

            <section className="border-t border-border px-6 py-6 sm:px-8 md:border-t-0 md:border-l">
              <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
                03 // Validation summary
              </p>
              <div className="mt-5 border border-border">
                {[
                  ["system_tests", "Pass"],
                  ["lint_check", "Pass"],
                  ["type_validate", "Pass"],
                ].map(([check, status]) => (
                  <div
                    key={check}
                    className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
                  >
                    <p className="font-mono text-[0.65rem] tracking-[0.11em] text-foreground">
                      {check}
                    </p>
                    <span className="bg-emerald-900/35 px-2 py-1 font-mono text-[0.58rem] tracking-[0.12em] text-emerald-300">
                      {status}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
              04 // Assumptions
            </p>
            <ul className="mt-5 space-y-4 text-lg leading-8 text-foreground/90">
              <li>
                Assumed mobile breakpoint at 390px based on core design specs for iPhone 14/15
                series.
              </li>
              <li>
                Reused existing layout components to ensure atomic consistency with the main
                application shell.
              </li>
            </ul>
          </section>
        </div>

        <div>
          <section className="border-b border-border px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
              Critical warnings
            </p>
            <div className="mt-5 border border-primary/80 p-4">
              <p className="font-mono text-[0.7rem] tracking-[0.13em] text-primary">
                Large diff in layout.css (-20 lines)
              </p>
              <p className="mt-3 text-sm leading-7 text-foreground/80">
                Structural changes in layout.css may affect global stacking contexts. Visual
                regression testing on secondary screens is advised before merging.
              </p>
            </div>
          </section>

          <section className="px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-muted-foreground">
              Execution log
            </p>
            <div className="mt-5 border border-border">
              {[
                [
                  "14:22:01.042",
                  "Initialize environment",
                  "Docker image loaded: sealant/dev-node:latest",
                ],
                [
                  "14:23:14.211",
                  "Executing analysis",
                  "Parsing 142 source files for dependency mapping",
                ],
                ["14:24:02.883", "Applying patches", "Modified: src/components/layout/Header.tsx"],
                ["14:24:15.540", "Process finalized", "Exit code: 0. Summary generated."],
              ].map(([time, title, detail]) => (
                <div key={time} className="border-b border-border px-4 py-3 last:border-b-0">
                  <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                    {time}
                  </p>
                  <p className="mt-1 text-lg font-semibold text-foreground">{title}</p>
                  <p className="mt-1 text-sm text-foreground/70">{detail}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
