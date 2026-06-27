// The model strip — a thin full-width band, not a section. The whole loop on one
// line: create a sandbox, run a harness, replay the record, review the change. One
// supporting line names the shapes of work it fits. No record, no pills.

import { ArrowRight } from "lucide-react";

import { Container, Reveal } from "#/components/primitives";

const STEPS = [
  "Create a sandbox",
  "Run a harness",
  "Replay the record",
  "Review the change",
] as const;

export function ModelStrip() {
  return (
    <section id="model" className="border-y border-border bg-panel">
      <Container className="py-12">
        <Reveal className="mx-auto max-w-[72ch] text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
            {STEPS.map((step, i) => (
              <span key={step} className="inline-flex items-center gap-3">
                <span className="text-base font-medium text-foreground sm:text-lg">{step}</span>
                {i < STEPS.length - 1 ? (
                  <ArrowRight className="size-4 text-primary" aria-hidden="true" />
                ) : null}
              </span>
            ))}
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            One runtime model for code agents, QA agents, CI repros, dependency updates, and custom
            harnesses.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
