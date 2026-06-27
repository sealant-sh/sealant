// The thesis strip — a thin full-width band, not a section. Type carries the
// argument: planners and harnesses decide what to do; Sealant owns where it runs
// and what happened. Below, the three primary nouns in mono. No record, no pills.

import { Container, Reveal } from "#/components/primitives";

export function ThesisStrip() {
  return (
    <section id="thesis" className="border-y border-border bg-panel">
      <Container className="py-12">
        <Reveal className="mx-auto max-w-[68ch] text-center">
          <p className="text-lg leading-snug text-foreground text-balance sm:text-xl">
            Planners and harnesses decide what to do. Sealant owns where it runs — and what actually
            happened.
          </p>
          <p className="mt-5 font-mono text-sm text-ink-2">
            sandbox <span className="text-faint">·</span> run <span className="text-faint">·</span>{" "}
            harness
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
