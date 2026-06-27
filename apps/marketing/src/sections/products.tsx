// The platform/products split as strategy. The platform is the substrate; each
// product is its own open-source repo built on the public SDK, tagged "by Sealant."
// Handoff is the one prominent card — the proof that the platform is real — with
// two visibly quieter roadmap cards (Verify, Repro) beneath it. No dark CodePanel
// here: the call box is the LIGHT mono box used elsewhere on the page.

import { ArrowRight } from "lucide-react";

import { Container, Eyebrow, REPO_URL, Reveal, SectionHead } from "#/components/primitives";

const PRIMITIVES = ["sandbox", "harness", "files", "checks", "artifacts", "record"];

function CallBox() {
  return (
    <div className="mt-6 rounded-2xl border border-rule bg-[var(--sw-sunken)] px-5 py-4 font-mono text-xs leading-[1.9] text-ink-2">
      <div>
        <span className="text-primary">const</span>
        <span> pr = </span>
        <span className="text-primary">await</span>
        <span> handoff.run(issue);</span>
      </div>
      <div className="mt-1 text-faint">{"// → opens a pull request"}</div>
    </div>
  );
}

function RoadmapCard({ name, pattern }: { name: string; pattern: string }) {
  return (
    <div className="rounded-3xl border border-border bg-background p-6 shadow-[var(--shadow-xs)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-foreground">
            {name}
          </h3>
          <span className="font-mono text-xs text-faint">by Sealant</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className="size-1.5 rounded-full bg-transparent ring-[1.5px] ring-[#b3b0a8]"
            aria-hidden="true"
          />
          <span className="font-mono text-xs text-muted-foreground">On the roadmap</span>
        </span>
      </div>
      <p className="mt-4 font-mono text-xs text-muted-foreground">{pattern}</p>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-5 inline-flex items-center gap-1 font-mono text-xs text-faint no-underline transition-colors hover:text-muted-foreground"
      >
        Follow on GitHub
        <ArrowRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

export function Products() {
  return (
    <section id="products" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>Built in the open</Eyebrow>}
          title="The platform is the point. The products are the proof."
          intro={<p>Each is its own open-source repo on the public SDK, tagged "by Sealant."</p>}
        />

        <Reveal className="mt-12 rounded-3xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)] sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <h3 className="font-display text-2xl font-semibold tracking-[-0.02em] text-foreground">
                Handoff
              </h3>
              <span className="font-mono text-xs text-faint">by Sealant</span>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-warning-dot" aria-hidden="true" />
              <span className="font-mono text-xs text-warning">Building now</span>
            </span>
          </div>

          <p className="mt-4 font-mono text-sm text-primary">task → verified change → PR</p>

          <p className="mt-4 max-w-[60ch] leading-relaxed text-muted-foreground">
            Give a coding harness an engineering task; get back the result, the changes, the checks,
            the artifacts, and the full execution record — in one reviewable handoff, ending in a
            pull request.
          </p>

          <p className="mt-5 font-mono text-xs text-faint">
            {PRIMITIVES.map((word, i) => (
              <span key={word}>
                {i > 0 ? <span className="px-1.5">·</span> : null}
                {word}
              </span>
            ))}
          </p>

          <CallBox />

          <p className="mt-6 text-foreground">If Handoff works, the platform is real.</p>

          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex items-center gap-1 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
          >
            Watch the repo
            <ArrowRight className="size-4" aria-hidden="true" />
          </a>
        </Reveal>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <RoadmapCard name="Verify" pattern="behavior → proof → test" />
          <RoadmapCard name="Repro" pattern="report → runnable case" />
        </div>
      </Container>
    </section>
  );
}
