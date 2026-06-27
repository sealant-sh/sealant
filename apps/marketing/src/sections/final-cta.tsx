// The closer — adoption only. A centered panel makes the single ask (star, docs),
// then the page ends where the ambient run does: a quiet inert record whose playhead
// has reached run.completed. No verdict, no cobalt-lift, no decorative radial.

import { GitHubLogo } from "#/components/github";
import {
  Container,
  Display,
  Eyebrow,
  PrimaryCTA,
  REPO_URL,
  Reveal,
  SecondaryCTA,
  TrustLine,
} from "#/components/primitives";
import { RunRecord } from "#/components/run-record";

export function FinalCta() {
  return (
    <section id="start" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="mx-auto max-w-3xl rounded-[2.25rem] border border-border bg-panel px-8 py-16 text-center shadow-[var(--shadow-md)] sm:px-12 lg:py-24">
            <Eyebrow>Build on Sealant</Eyebrow>
            <Display className="mx-auto mt-5 max-w-[26ch] text-[2.1rem] sm:text-5xl lg:text-[3.25rem]">
              Give your next agent run a real environment — and a record worth reviewing.
            </Display>
            <p className="mx-auto mt-5 max-w-[52ch] text-lg leading-relaxed text-muted-foreground">
              Create a sandbox, run a harness, replay the record — in minutes.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <PrimaryCTA href={REPO_URL}>
                <GitHubLogo className="size-4" />
                GitHub
              </PrimaryCTA>
              <SecondaryCTA href={REPO_URL}>Read the docs</SecondaryCTA>
              <SecondaryCTA href={REPO_URL}>Run the demo</SecondaryCTA>
            </div>
            <TrustLine className="mt-7" />
            <RunRecord
              variant="inert"
              runId="run_sbx_8m2k"
              status={{ word: "Completed · observed", tone: "observed" }}
              events={[]}
              footnote="run.completed · 00:25.110 · 184 events"
              className="mx-auto mt-10 max-w-md text-left"
            />
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
