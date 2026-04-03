import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/" as never)({
  component: MarketingPage,
});

function MarketingPage() {
  return (
    <main>
      <section className="border-b-2 border-ring bg-background text-foreground">
        <div
          className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-7xl grid-cols-1 px-6 lg:grid-cols-[6fr_5fr] lg:px-8"
          style={{
            background:
              "radial-gradient(circle at 3px 3px, color-mix(in oklab, var(--sw-rule) 5%, transparent) 3px, transparent 0) 0 0 / 24px 24px, var(--sw-bg)",
          }}
        >
          <div className="flex flex-col justify-center border-b border-border bg-transparent px-6 py-10 lg:border-r lg:border-b-0 lg:px-10 lg:py-14">
            <p className="inline-flex self-start bg-primary px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-primary-foreground">
              Open source // Sandboxes
            </p>
            <h1 className="m-0 mt-4 max-w-full font-display text-3xl uppercase sm:text-4xl lg:text-5xl">
              Enforce security & governance for sandboxed agents
            </h1>
            <p className="mt-6 max-w-2xl text-base text-foreground/85 sm:text-lg">
              Sealant is an open source control plane for creating sandboxes from real repository
              context.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a
                className="inline-flex min-h-9 items-center justify-center border border-primary bg-primary px-4 text-xs font-bold uppercase tracking-wider text-primary-foreground no-underline transition duration-200 hover:-translate-y-px hover:brightness-95"
                href="https://github.com/get-sealant/sealant"
                target="_blank"
                rel="noreferrer"
              >
                View GitHub
              </a>
              <a
                className="inline-flex min-h-9 items-center justify-center border border-ring bg-transparent px-4 text-xs font-bold uppercase tracking-wider text-foreground no-underline transition duration-200 hover:-translate-y-px hover:bg-accent/50"
                href="#details"
              >
                See scope
              </a>
            </div>
          </div>

          <aside
            className="grid grid-cols-1 border-border bg-transparent sm:grid-cols-2 lg:border-l"
            aria-label="Core capabilities"
          >
            <article className="flex flex-col border-b border-border px-5 py-6 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(n+3)]:border-b-0">
              <span
                className="mb-3 size-2 border border-primary bg-primary brightness-90"
                aria-hidden="true"
              />
              <p className="mb-5 self-end font-mono text-xs uppercase tracking-wider text-foreground/45">
                [01]
              </p>
              <p className="m-0 max-w-[8ch] font-display text-3xl uppercase tracking-wide leading-none text-foreground sm:text-4xl">
                Custom sandboxes
              </p>
              <p className="mt-3 max-w-sm text-sm leading-6 text-foreground/80">
                Launch a sandbox with your repo, packages, and startup commands. Connect over SSH or
                from your editor.
              </p>
            </article>

            <article className="flex flex-col border-b border-border px-5 py-6 sm:[&:nth-child(2n)]:border-r-0 lg:border-b lg:border-r lg:[&:nth-child(n+3)]:border-b-0">
              <span
                className="mb-3 size-2 border border-primary bg-primary brightness-90"
                aria-hidden="true"
              />
              <p className="mb-5 self-end font-mono text-xs uppercase tracking-wider text-foreground/45">
                [02]
              </p>
              <p className="m-0 max-w-[8ch] font-display text-3xl uppercase tracking-wide leading-none text-foreground sm:text-4xl">
                GitHub intake
              </p>
              <p className="mt-3 max-w-sm text-sm leading-6 text-foreground/80">
                Import GitHub app installations and use the synced repositories as sandbox sources.
              </p>
            </article>

            <article className="flex flex-col border-b border-border px-5 py-6 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:border-b-0">
              <span
                className="mb-3 size-2 border border-primary bg-primary brightness-90"
                aria-hidden="true"
              />
              <p className="mb-5 self-end font-mono text-xs uppercase tracking-wider text-foreground/45">
                [03]
              </p>
              <p className="m-0 max-w-[8ch] font-display text-3xl uppercase tracking-wide leading-none text-foreground sm:text-4xl">
                Clear status
              </p>
              <p className="mt-3 max-w-sm text-sm leading-6 text-foreground/80">
                See sandbox state, runtime details, attempts, and connection info in one place.
              </p>
            </article>

            <article className="flex flex-col px-5 py-6 sm:[&:nth-child(2n)]:border-r-0">
              <span
                className="mb-3 size-2 border border-primary bg-primary brightness-90"
                aria-hidden="true"
              />
              <p className="mb-5 self-end font-mono text-xs uppercase tracking-wider text-foreground/45">
                [04]
              </p>
              <p className="m-0 max-w-[8ch] font-display text-3xl uppercase tracking-wide leading-none text-foreground sm:text-4xl">
                Open source
              </p>
              <p className="mt-3 max-w-sm text-sm leading-6 text-foreground/80">
                Run Sealant yourself and keep the control plane inside your own environment.
              </p>
            </article>
          </aside>
        </div>
      </section>

      <section id="details" className="border-b-2 border-ring pt-1.5">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-12 sm:px-8">
          <div>
            <p className="m-0 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              What Sealant does
            </p>
            <h2 className="m-0 max-w-[16ch] font-display text-4xl uppercase tracking-wide leading-none sm:text-5xl lg:text-6xl">
              Simple sandbox control.
            </h2>
            <p>
              Sealant focuses on isolated environments, direct access, and visible lifecycle state.
            </p>
          </div>
          <ol
            className="m-0 list-none border-t border-border p-0"
            aria-label="Sealant capabilities"
          >
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                Sandbox spec
              </span>
              <p>
                Define source, packages, startup commands, and runtime settings in one sandbox spec.
              </p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                Direct access
              </span>
              <p>Connect to a running sandbox over SSH or open it from your editor.</p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                Build visibility
              </span>
              <p>
                Track queued, running, ready, failed, and cancelled states without leaving the app.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="border-b-2 border-ring">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-12 sm:px-8">
          <div>
            <p className="m-0 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              What is in scope
            </p>
            <h2 className="m-0 max-w-[16ch] font-display text-4xl uppercase tracking-wide leading-none sm:text-5xl lg:text-6xl">
              Be precise about issue workflows.
            </h2>
            <p>
              Issue workflow support should be framed as work in progress, not as a fully shipped
              end-to-end product today.
            </p>
          </div>
          <ol
            className="m-0 list-none border-t border-border p-0"
            aria-label="Issue workflow details"
          >
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                What exists now
              </span>
              <p>
                Sandbox lifecycle data, attempts, and runtime records are already modeled and
                exposed in the product.
              </p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                What is next
              </span>
              <p>
                Issue workflow reporting is in progress. The data model exists, but the full product
                surface is not shipped yet.
              </p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                Why that matters
              </span>
              <p>
                The product should promise inspectability only where the UI and APIs already support
                it.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section id="opensource" className="py-12 pb-16">
        <div className="mx-auto max-w-7xl px-6 sm:px-8">
          <p className="m-0 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Open Source
          </p>
          <h2 className="m-0 max-w-[16ch] font-display text-4xl uppercase tracking-wide leading-none sm:text-5xl lg:text-6xl">
            Own the control plane.
          </h2>
          <p>Inspect it, change it, and run it inside your own boundary.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              className="inline-flex min-h-9 items-center justify-center border border-primary bg-primary px-4 text-xs font-bold uppercase tracking-wider text-primary-foreground no-underline transition duration-200 hover:-translate-y-px hover:brightness-95"
              href="https://github.com/sealant-ops/sealant"
              target="_blank"
              rel="noreferrer"
            >
              Explore repository
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
