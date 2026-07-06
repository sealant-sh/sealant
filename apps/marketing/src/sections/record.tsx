// §4 — THE RUN IS THE PRODUCT SURFACE. A Sealant run comes back with its evidence
// attached: the change, the commands, the checks, the artifacts, the source trail.
// Left column names what you query it for; the right column is the run record itself,
// the same evidence-review motif the webapp renders runs in. Illustrative.

import { Display, Eyebrow, Reveal } from "#/components/primitives";
import { CatalogEyebrow, RunRecord } from "#/components/run-record";

const SURFACES = [
  {
    title: "Full diff",
    body: "See exactly what changed, with file context and generated patches.",
  },
  {
    title: "Run audit",
    body: "Replay the ordered history of commands, output, processes, files, and artifacts.",
  },
  {
    title: "Evidence trail",
    body: "Link the result back to the sources, snapshots, browser traces, and commands used.",
  },
  {
    title: "Review questions",
    body: "Turn the ambiguous parts of a run into focused human review, not another wall of logs.",
  },
] as const;

export function RunSurface() {
  return (
    <section id="records" className="bg-panel py-24 lg:py-32">
      <div className="mx-auto w-full max-w-[1200px] px-6 sm:px-8">
        <Reveal>
          <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
            <div className="min-w-0">
              <Eyebrow>The run is the product surface</Eyebrow>
              <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
                Every run comes back with the evidence attached.
              </Display>
              <p className="mt-5 max-w-[54ch] text-lg leading-relaxed text-muted-foreground">
                A Sealant run is more than a transcript. It keeps the change, the commands, the
                checks, the artifacts, the source trail, and the observations that explain{" "}
                <span className="text-foreground">how the result was produced</span>.
              </p>

              <dl className="mt-9 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                {SURFACES.map((surface) => (
                  <div key={surface.title}>
                    <dt className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
                      {surface.title}
                    </dt>
                    <dd className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {surface.body}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="min-w-0">
              <CatalogEyebrow runId="ws_8m2k" events="184" className="mb-4" />
              <RunRecord
                variant="full"
                replay
                illustrative
                runId="ws_8m2k"
                capture="2026-06-25 · 14:02"
                status={{ word: "Completed · observed", tone: "observed" }}
                events={[
                  { seq: 1, offset: "00:00.000", name: "workspace.ready", provenance: "observed" },
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
          </div>
        </Reveal>
      </div>
    </section>
  );
}
