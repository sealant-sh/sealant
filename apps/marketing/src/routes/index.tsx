import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/" as never)({
  component: MarketingPage,
});

function MarketingPage() {
  return (
    <main>
      <section className="border-b-2 border-ring bg-background text-foreground">
        <div className="marketing-hero flex mx-10 justify-center items-center grid min-h-[calc(100svh-4rem)] max-w-7xl px-6 lg:grid-cols-[6fr_5fr] lg:px-8">
          <div className="hero-copy flex flex-col justify-center border-b border-border bg-transparent px-6 py-10 lg:border-r lg:border-b-0 lg:px-10 lg:py-14">
            <p className="inline-flex self-start bg-primary px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-primary-foreground">
              Sealant
            </p>
            <h1 className="m-0 mt-4 max-w-full font-display text-3xl uppercase sm:text-4xl lg:text-5xl">
              The open platform for reproducible agentic work.
            </h1>
            <p className="mt-6 max-w-2xl text-base text-foreground/85 sm:text-lg">
              A self-hosted platform for managing isolated sandboxes, tracking execution lineage,
              and building modular developer workflows.
            </p>
            <div className="hero-copy__actions mt-7 flex flex-wrap gap-3">
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
                See platform
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="details" className="border-b-2 border-ring pt-1.5">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-12 sm:px-8">
          <div>
            <p className="m-0 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Platform overview
            </p>
            <h2 className="m-0 max-w-[16ch] font-display text-4xl uppercase tracking-wide leading-none sm:text-5xl lg:text-6xl">
              Reproducible software work, modeled as platform primitives.
            </h2>
            <p>
              Sealant centers sandboxes, executions, tracked work, and modular workflows on one
              self-hosted platform.
            </p>
          </div>
          <ol
            className="m-0 list-none border-t border-border p-0"
            aria-label="Sealant capabilities"
          >
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                The Core
              </span>
              <p>
                Two core primitives: fast, highly customizable sandboxes and reproducible software
                runs (executions). Sandboxes can be opened in a preferred editor or harness,
                shipping fully configured with custom dotfiles and specific tooling built in.
                Managed lifecycles, capability routing, and secure artifact storage form the
                foundational layer.
              </p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                Observability
              </span>
              <p>
                Sealant captures the complete lifecycle of every run. State transitions, raw logs,
                diffs, patches, and I/O lineage are tracked by default, generating a completely
                inspectable history of all sandbox activity.
              </p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                First-party modules
              </span>
              <p>
                Sealant ships with built-in functional components, starting with automated Issue
                Workflows. These features are built entirely on internal module boundaries to
                guarantee a genuinely extensible architecture from day one.
              </p>
            </li>
            <li className="grid items-start gap-3 border-b border-border py-4 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                SDK &amp; extensions
              </span>
              <p>
                An upcoming SDK will enable the creation of custom modules. Third-party modules will
                have the exact same access to core primitives, logging, and observability as the
                first-party modules. The architecture allows injecting custom hooks, swapping
                adapters, and building entirely new tools directly on the platform.
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
            Self-hosted by default.
          </h2>
          <p>
            Run Sealant inside your own boundary and build on an open platform for reproducible
            software work.
          </p>
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
