// THE CLIMAX — the most polished exhibit on the page. The definition lands as a
// kept record: process lifecycle, byte-exact I/O, file changes, network, and
// artifacts folded into one ordered, correlated, replayable stream. The right
// column is the biggest RunRecord; the three cards below name what you query it for.

import { Callout, Container, Display, InDevBadge, Reveal } from "#/components/primitives";
import { CatalogEyebrow, RunRecord } from "#/components/run-record";

const USES = [
  {
    title: "Show live progress",
    body: "Build status from typed events, not parsed text.",
  },
  {
    title: "Explain the outcome",
    body: "Connect the result to the commands and changes that produced it.",
  },
  {
    title: "Debug failed work",
    body: "See where it diverged and what changed just before.",
  },
] as const;

export function RecordClimax() {
  return (
    <section id="records" className="bg-panel py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <CatalogEyebrow runId="sbx_8m2k" events="184" />
                <InDevBadge>Inspector in development</InDevBadge>
              </div>
              <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
                A wall of terminal text is not a record.
              </Display>
              <p className="mt-5 max-w-[54ch] text-lg leading-relaxed text-muted-foreground">
                Sealant captures process lifecycle, byte-exact I/O, file changes, network, and
                artifacts as one ordered, correlated, replayable stream —{" "}
                <span className="text-foreground">queried, not parsed</span>.
              </p>
              <div className="mt-7 space-y-4">
                <Callout>
                  It reports; it does not judge. No scores. No safe-to-merge. You decide what the
                  evidence means.
                </Callout>
                <Callout>
                  Every fact carries how it was captured — Observed, Inferred, or Unknown. Replay is
                  a pure re-fold of an append-only log, not a promise to recreate arbitrary external
                  systems.
                </Callout>
              </div>
            </div>

            <RunRecord
              variant="full"
              replay
              illustrative
              runId="sbx_8m2k"
              capture="2026-06-25 · 14:02"
              status={{ word: "Completed · observed", tone: "observed" }}
              events={[
                { seq: 1, offset: "00:00.000", name: "sandbox.ready", provenance: "observed" },
                {
                  seq: 7,
                  offset: "00:14.628",
                  name: "process.exited",
                  detail: "pnpm install · exit 0",
                  provenance: "observed",
                },
                {
                  seq: 12,
                  offset: "00:17.406",
                  name: "file.modified",
                  detail: "src/checkout.ts",
                  provenance: "observed",
                },
                {
                  seq: 15,
                  offset: "00:19.880",
                  name: "file.renamed",
                  detail: "checkout.ts → checkout.ts.bak",
                  provenance: "inferred",
                },
                {
                  seq: 19,
                  offset: "00:22.041",
                  name: "net.request",
                  detail: "api.stripe.com",
                  provenance: "observed",
                },
                {
                  seq: 24,
                  offset: "00:24.802",
                  name: "process.exited",
                  detail: "14 tests passed",
                  provenance: "observed",
                },
              ]}
              diff={{
                file: "src/checkout.ts",
                lines: [
                  { sign: " ", text: "export async function checkout(cart) {" },
                  { sign: "-", text: "  return charge(cart.total)" },
                  { sign: "+", text: "  if (cart.isEmpty) throw new EmptyCartError()" },
                  { sign: " ", text: "  return charge(cart.total)" },
                ],
              }}
              footnote="184 events · 3 file changes · 4 artifacts"
            />
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-3 lg:mt-16">
            {USES.map((use) => (
              <div
                key={use.title}
                className="rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)]"
              >
                <h3 className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
                  {use.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{use.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
