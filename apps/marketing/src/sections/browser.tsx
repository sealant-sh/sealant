// The differentiator, honestly in-progress. A headless browser the harness drives
// inside the sandbox — its evidence interleaved into the same run as everything else.
// No fake browser-chrome mockup: the proof is the evidence rows under one run id.

import { Callout, Container, Display, Eyebrow, InDevBadge, Reveal } from "#/components/primitives";
import { RunRecord } from "#/components/run-record";

export function BrowserEvidence() {
  return (
    <section id="browser" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <Eyebrow>Browsing as evidence</Eyebrow>
              <InDevBadge />
            </div>
            <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
              The agent needs the web. The web should leave evidence.
            </Display>
            <p className="mt-5 max-w-[54ch] text-lg leading-relaxed text-muted-foreground">
              A headless Chromium the harness drives inside the sandbox — auth flows, UI checks —
              captured into the same run: screenshots, DOM snapshots, navigations, and the network
              it generated.
            </p>
            <Callout className="mt-7">
              It composes primitives we already have — the tunneling channel, the artifact store,
              the egress proxy. In progress, and we say so.
            </Callout>
          </Reveal>

          <div className="min-w-0">
            <RunRecord
              variant="full"
              illustrative
              runId="sbx_8m2k"
              status={{ word: "Recording · observed", tone: "observed" }}
              events={[
                {
                  seq: 31,
                  offset: "00:31.204",
                  name: "browser.navigated",
                  detail: "/login",
                  provenance: "observed",
                },
                {
                  seq: 34,
                  offset: "00:33.860",
                  name: "browser.screenshot",
                  detail: "auth-step.png",
                  thumb: true,
                  provenance: "observed",
                },
                {
                  seq: 39,
                  offset: "00:38.115",
                  name: "dom.snapshot",
                  detail: "checkout form",
                  provenance: "observed",
                },
                {
                  seq: 42,
                  offset: "00:41.077",
                  name: "net.request",
                  detail: "api.stripe.com",
                  provenance: "observed",
                },
                {
                  seq: 45,
                  offset: "00:43.902",
                  name: "dom.assertion",
                  detail: "cart total visible · not run",
                  provenance: "inferred",
                },
              ]}
              footnote="12 navigations · 4 screenshots · 1 not run"
            />
          </div>
        </div>
      </Container>
    </section>
  );
}
