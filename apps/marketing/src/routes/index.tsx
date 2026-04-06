import { createFileRoute } from "@tanstack/react-router";
import { ClipboardClock, Container as ContainerIcon, Hammer } from "lucide-react";

export const Route = createFileRoute("/" as never)({
  component: MarketingPage,
});

function HeroWave() {
  return (
    <svg viewBox="0 0 56 20" className="h-10 w-20 shrink-0 text-foreground/55" aria-hidden="true">
      <path
        d="M1 10C6.4 10 6.4 2 11.8 2C17.2 2 17.2 18 22.6 18C28 18 28 2 33.4 2C38.8 2 38.8 18 44.2 18C49.6 18 49.6 10 55 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AnimatedHeroCta() {
  return (
    <div className="mt-6 flex w-fit items-center gap-5 text-foreground mx-auto">
      <Hammer className="size-16 shrink-0 [stroke-width:1.5px]" aria-hidden="true" />
      <HeroWave />
      <ContainerIcon className="size-16 shrink-0 [stroke-width:1.5px]" aria-hidden="true" />
      <HeroWave />
      <ClipboardClock className="size-16 shrink-0 [stroke-width:1.5px]" aria-hidden="true" />
    </div>
  );
}

function MarketingPage() {
  return (
    <main>
      <section className="relative overflow-hidden border-b-2 border-ring bg-background text-foreground">
        <div className="pointer-events-none absolute -left-52 -top-44 size-[36rem] rounded-full bg-primary/16 blur-[170px]" />
        <div className="pointer-events-none absolute -right-60 top-1/4 size-[44rem] rounded-full bg-primary/14 blur-[220px]" />
        <div className="relative mx-auto grid min-h-[calc(100svh-4rem)] w-full max-w-[1720px] px-6 sm:px-8 lg:grid-cols-[40px_710px_minmax(0,1fr)] lg:px-0">
          <div className="hidden lg:block" aria-hidden="true" />
          <div className="flex items-center py-16 lg:border-r lg:border-border lg:py-0">
            <div className="w-full py-10 text-center lg:pl-[42px] lg:pr-[15px] lg:py-0">
              <h1 className="m-0 mx-auto max-w-[487px] font-display text-[48px] uppercase leading-[48px] tracking-[0.48px]">
                The open platform for secure agents &amp; workflows
              </h1>
              <p className="mt-6 mx-auto max-w-[582px] text-base text-foreground/85 sm:text-[1.1rem]">
                A self-hosted platform for managing isolated sandboxes, tracking execution lineage,
                and building modular developer workflows.
              </p>
              <AnimatedHeroCta />
            </div>
          </div>
          <div className="hidden lg:block" aria-hidden="true" />
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
