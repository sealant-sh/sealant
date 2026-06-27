import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/about")({ component: AboutPage });

const PLATFORM_FACTS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "Control plane", value: "private · authenticated" },
  { label: "Execution layer", value: "disposable sandboxes" },
  { label: "Source of truth", value: "recorded run evidence" },
];

function AboutPage() {
  return (
    <div className="space-y-8 p-8 lg:p-10">
      <header>
        <p className="ev-eyebrow">Platform brief</p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Sealant
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The secure run layer for AI software work — isolated sandboxes, recorded from inside the
          runtime, turned into evidence-backed review.
        </p>
      </header>

      <section className="rounded-2xl border border-border bg-popover p-8 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)] lg:p-10">
        <p className="ev-eyebrow">Overview</p>
        <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink-2">
          Sealant provisions isolated development environments from a private control plane.
          Repositories, build inputs, and runtime settings stay behind authentication while the
          execution layer remains disposable.
        </p>

        <dl className="mt-8 divide-y divide-rule-faint border-t border-rule-faint">
          {PLATFORM_FACTS.map((fact) => (
            <div
              key={fact.label}
              className="flex items-baseline justify-between gap-4 py-3.5"
            >
              <dt className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{fact.label}</dt>
              <dd className="text-right font-mono text-xs text-ink-2">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
