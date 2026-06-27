// EXHIBIT A — the hero. Definition first, then the argument, shown as a kept run.
// The right column is the RunRecord Exhibit (NOT a dark CodePanel): the canonical
// one-liner resolves into the record it returns. Static-legible; the page opens on
// sandbox.ready.

import { motion, useReducedMotion } from "framer-motion";
import { Star } from "lucide-react";

import { GitHubLogo } from "#/components/github";
import {
  PrimaryCTA,
  REPO_URL,
  riseChild,
  riseParent,
  SecondaryCTA,
  TrustLine,
} from "#/components/primitives";
import { RUN_ID } from "#/components/run-header";
import { RunRecord } from "#/components/run-record";

const CALL = [
  ["const", " run = ", "await", " sealant.sandboxes"],
  ["", "  .create({ repository, harness })", "", ""],
  ["", "  .harness.run(prompt);", "", ""],
];

function CallBox() {
  return (
    <div className="rounded-xl border border-rule bg-[var(--sw-sunken)] px-4 py-3.5 font-mono text-xs leading-[1.8] text-ink-2">
      {CALL.map((parts, i) => (
        <div key={i}>
          <span className="text-primary">{parts[0]}</span>
          <span>{parts[1]}</span>
          <span className="text-primary">{parts[2]}</span>
          <span>{parts[3]}</span>
        </div>
      ))}
      <div className="mt-1 text-faint">{"// → { result, changes, artifacts, record }"}</div>
    </div>
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  const parent = reduce
    ? {}
    : { variants: riseParent, initial: "hidden" as const, animate: "show" as const };
  const child = reduce ? {} : { variants: riseChild };

  return (
    <section className="relative overflow-hidden bg-[var(--sw-canvas)]">
      <div
        className="sealant-dot-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_30%_20%,black,transparent_70%)]"
        aria-hidden="true"
      />
      <div className="mx-auto grid w-full max-w-[1200px] items-center gap-12 px-6 py-20 sm:px-8 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16 lg:py-28">
        <motion.div className="min-w-0" {...parent}>
          <motion.div {...child}>
            <span className="ev-eyebrow inline-flex items-center gap-2 text-primary">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
              Open-source runtime for AI dev agents
            </span>
          </motion.div>
          <motion.h1
            {...child}
            className="mt-6 font-display text-[2.5rem] leading-[1.05] font-semibold tracking-[-0.03em] text-foreground text-balance sm:text-5xl lg:text-[3.4rem]"
          >
            The runtime under your agent.
          </motion.h1>
          <motion.p
            {...child}
            className="mt-4 font-display text-xl leading-[1.2] font-medium tracking-[-0.01em] text-ink-2 sm:text-2xl"
          >
            A sandbox to work in, a recorded run to keep.
          </motion.p>
          <motion.p
            {...child}
            className="mt-6 max-w-[54ch] text-lg leading-relaxed text-muted-foreground"
          >
            Your agent decides what to do. Nothing gives that work somewhere real to happen — or
            tells you what actually happened. Sealant is the open-source, self-hosted runtime that
            does both: one call spins up a real sandbox around your repo, runs your harness in it,
            and hands back a <span className="text-foreground">structured run you can replay</span>.
            Bring your own agent. Keep your code. Read the evidence yourself.
          </motion.p>
          <motion.div {...child} className="mt-9 flex flex-wrap items-center gap-3">
            <PrimaryCTA href={REPO_URL}>
              <GitHubLogo className="size-4" />
              Star on GitHub
            </PrimaryCTA>
            <SecondaryCTA href={REPO_URL}>Read the quickstart</SecondaryCTA>
          </motion.div>
          <motion.div {...child}>
            <TrustLine className="mt-7" />
          </motion.div>
        </motion.div>

        <div className="min-w-0 space-y-3">
          <CallBox />
          <div className="flex items-center gap-2 pl-1 font-mono text-[0.68rem] text-faint">
            <Star className="size-3 text-primary" aria-hidden="true" />
            resolves to the run it produced
          </div>
          <RunRecord
            lift
            replay
            runId={RUN_ID}
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
                seq: 18,
                offset: "00:24.802",
                name: "process.exited",
                detail: "14 tests passed",
                provenance: "observed",
              },
              { seq: 21, offset: "00:25.110", name: "run.completed", provenance: "observed" },
            ]}
            diff={{
              file: "src/checkout.ts",
              lines: [
                { sign: " ", text: "export async function checkout(cart) {" },
                { sign: "-", text: "  return charge(cart.total)" },
                { sign: "+", text: "  if (cart.isEmpty) throw new EmptyCartError()" },
                { sign: "+", text: "  return charge(cart.total)" },
              ],
            }}
            footnote="184 events · 3 files changed · 4 artifacts"
          />
        </div>
      </div>
    </section>
  );
}
