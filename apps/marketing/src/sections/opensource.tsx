// §9 — OPEN-SOURCE & SELF-HOSTED. Positive framing, not a fear/lock-in section: run
// the daemon in your own infra, bring the harnesses you trust, build products on the
// same public SDK. Three cards in the page's card idiom.

import { Boxes, Code2, LayoutTemplate } from "lucide-react";

import {
  Container,
  Eyebrow,
  type IconType,
  InstallCommand,
  Reveal,
  SectionHead,
} from "#/components/primitives";

interface Pillar {
  readonly icon: IconType;
  readonly title: string;
  readonly body: string;
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    icon: Code2,
    title: "Open source",
    body: "Inspect it, fork it, self-host it, and build on it.",
  },
  {
    icon: Boxes,
    title: "Harness-neutral",
    body: "Use OpenCode, custom agents, CI workers, or your own loop.",
  },
  {
    icon: LayoutTemplate,
    title: "Product-ready records",
    body: "Expose the run record through your own UI, PR flow, QA tool, or internal platform.",
  },
];

export function OpenSource() {
  return (
    <section id="open-source" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>Open-source and self-hosted</Eyebrow>}
          title="Run it where your code already lives."
          intro={
            <p>
              Sealant is open-source and self-hosted. Run the daemon inside your own infrastructure,
              connect the harnesses you already trust, and build products on top of the same public
              SDK.
            </p>
          }
        />
        <Reveal className="mx-auto mt-10 flex max-w-2xl flex-col items-center gap-3">
          <InstallCommand />
          <p className="text-center font-mono text-xs text-faint">
            A running Docker daemon with Compose v2 is the whole prerequisite — web on :3000, API on
            :4000, SSH gateway on :2222.
          </p>
        </Reveal>
        <Reveal className="mt-12 grid gap-5 sm:grid-cols-3">
          {PILLARS.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <div
                key={pillar.title}
                className="rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)]"
              >
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
                  <Icon className="size-4" />
                </span>
                <h3 className="mt-4 font-display text-lg font-semibold tracking-[-0.01em] text-foreground">
                  {pillar.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{pillar.body}</p>
              </div>
            );
          })}
        </Reveal>
      </Container>
    </section>
  );
}
