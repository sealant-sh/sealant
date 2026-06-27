// One simple model — the whole platform reduces to two nouns. The sandbox is the
// live, disposable environment; the run is the durable record it leaves behind.
// Each card carries a LIGHT mono box (never a dark CodePanel) that destructures the
// noun into its members, so the model reads as plain TypeScript.

import { type ReactNode } from "react";

import { Container, Eyebrow, Reveal, SectionHead } from "#/components/primitives";

function MemberBox({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 rounded-2xl border border-rule bg-[var(--sw-sunken)] px-5 py-4 font-mono text-xs leading-[1.9] text-ink-2">
      {children}
    </div>
  );
}

export function Model() {
  return (
    <section id="model" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>One simple model</Eyebrow>}
          title="A sandbox you enter. A run you keep."
          intro={<p>Two nouns. Everything else serves them.</p>}
        />

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <Reveal className="rounded-3xl border border-border bg-background p-7 shadow-[var(--shadow-sm)]">
            <span className="ev-eyebrow text-faint">Live environment</span>
            <h3 className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em] text-foreground">
              The sandbox
            </h3>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              A real, disposable workspace around a real repo — code, harness, processes, files,
              services. SSH in when you need to.
            </p>
            <MemberBox>
              <div>
                <span>const &#123; </span>
                <span className="text-primary">harness</span>
                <span>,</span>
              </div>
              <div className="pl-[5.5ch]">
                <span className="text-primary">ssh</span>
                <span>,</span>
              </div>
              <div className="pl-[5.5ch]">
                <span className="text-primary">files</span>
                <span>,</span>
              </div>
              <div className="pl-[5.5ch]">
                <span className="text-primary">processes</span>
                <span>,</span>
              </div>
              <div>
                <span>&#125; = sandbox;</span>
              </div>
            </MemberBox>
          </Reveal>

          <Reveal className="rounded-3xl border border-border bg-background p-7 shadow-[var(--shadow-sm)]">
            <span className="ev-eyebrow text-faint">Durable output</span>
            <h3 className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em] text-foreground">
              The run
            </h3>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              What it produced, and the structured history of how it happened. Kept after the
              sandbox is gone.
            </p>
            <MemberBox>
              <div>
                <span>const &#123; </span>
                <span className="text-primary">result</span>
                <span>,</span>
              </div>
              <div className="pl-[5.5ch]">
                <span className="text-primary">changes</span>
                <span>,</span>
              </div>
              <div className="pl-[5.5ch]">
                <span className="text-primary">artifacts</span>
                <span>,</span>
              </div>
              <div className="pl-[5.5ch]">
                <span className="font-semibold text-primary">record</span>
                <span>,</span>
              </div>
              <div>
                <span>&#125; = run;</span>
              </div>
            </MemberBox>
          </Reveal>
        </div>

        <p className="mx-auto mt-10 max-w-[60ch] text-center text-lg text-foreground text-balance">
          The sandbox is where the work happens. The run is what you keep.
        </p>
      </Container>
    </section>
  );
}
