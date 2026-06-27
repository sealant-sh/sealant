// The adoption wedge. One runtime, many shapes of work: the create → run → replay
// call never moves — only the harness and the task change. The tab strip swaps the
// active job; the left call box holds the invariant call (repo/harness/prompt are the
// only literals that change), the right column is the RunRecord strip it produced.
// Default active = 0, fully rendered server-side (static-first).

import { useState } from "react";

import { SectionHead } from "#/components/primitives";
import { CatalogEyebrow, RunRecord, type RecordEvent } from "#/components/run-record";

interface Job {
  readonly key: string;
  readonly label: string;
  readonly repo: string;
  readonly harness: string;
  readonly prompt: string;
  readonly footnote: string;
  readonly tone: "observed" | "breakage";
  readonly statusWord: string;
  readonly events: ReadonlyArray<RecordEvent>;
}

const JOBS: ReadonlyArray<Job> = [
  {
    key: "fix-test",
    label: "Coding agent fixes a failing test",
    repo: "acme/storefront",
    harness: "opencode",
    prompt: "Fix the failing checkout tests",
    footnote: "3 files changed · 14 tests passed · observed",
    tone: "observed",
    statusWord: "Completed · observed",
    events: [
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
    ],
  },
  {
    key: "qa-checkout",
    label: "Autonomous QA drives a checkout flow in a browser",
    repo: "acme/storefront",
    harness: "playwright-agent",
    prompt: "Verify guest checkout works",
    footnote: "4 screenshots · flow completed · observed",
    tone: "observed",
    statusWord: "Completed · observed",
    events: [
      {
        seq: 4,
        offset: "00:03.118",
        name: "browser.navigated",
        detail: "/checkout",
        provenance: "observed",
      },
      {
        seq: 9,
        offset: "00:08.640",
        name: "browser.screenshot",
        detail: "step-3.png",
        provenance: "observed",
        thumb: true,
      },
      {
        seq: 14,
        offset: "00:12.902",
        name: "net.request",
        detail: "api.stripe.com",
        provenance: "observed",
      },
    ],
  },
  {
    key: "repro-ci",
    label: "Reproduce a failed CI run",
    repo: "acme/api",
    harness: "repro",
    prompt: "Reproduce CI job #4821",
    footnote: "failure reproduced · observed",
    tone: "breakage",
    statusWord: "Reproduced · observed",
    events: [
      {
        seq: 22,
        offset: "00:31.504",
        name: "process.exited",
        detail: "build failed · exit 1",
        provenance: "observed",
      },
    ],
  },
  {
    key: "dep-update",
    label: "Land a dependency update",
    repo: "acme/web",
    harness: "opencode",
    prompt: "Bump react to latest, fix breakage",
    footnote: "lockfile changed · checks observed",
    tone: "observed",
    statusWord: "Completed · observed",
    events: [
      {
        seq: 6,
        offset: "00:09.220",
        name: "file.modified",
        detail: "pnpm-lock.yaml",
        provenance: "observed",
      },
      {
        seq: 19,
        offset: "00:28.331",
        name: "process.exited",
        detail: "typecheck passed",
        provenance: "observed",
      },
    ],
  },
  {
    key: "flaky-build",
    label: "Investigate a flaky build",
    repo: "acme/api",
    harness: "opencode",
    prompt: "Find why test X is flaky",
    footnote: "3 of 50 runs failed · observed",
    tone: "observed",
    statusWord: "Completed · observed",
    events: [
      {
        seq: 50,
        offset: "01:42.770",
        name: "process.exited",
        detail: "47 passed · 3 failed",
        provenance: "inferred",
      },
    ],
  },
];

function CallBox({ repo, harness, prompt }: { repo: string; harness: string; prompt: string }) {
  return (
    <div className="rounded-xl border border-rule bg-[var(--sw-sunken)] p-4 font-mono text-xs leading-[1.8] text-ink-2">
      <div>
        <span className="text-primary">const</span>
        <span> run = </span>
        <span className="text-primary">await</span>
        <span> sealant.sandboxes</span>
      </div>
      <div>
        <span>{"  .create({ repository: "}</span>
        <span className="text-primary">{`"${repo}"`}</span>
        <span>{", harness: "}</span>
        <span className="text-primary">{`"${harness}"`}</span>
        <span>{" })"}</span>
      </div>
      <div>
        <span>{"  .harness.run("}</span>
        <span className="text-primary">{`"${prompt}"`}</span>
        <span>{");"}</span>
      </div>
      <div className="mt-1 text-faint">{"// → { result, changes, artifacts, record }"}</div>
    </div>
  );
}

export function Versatility() {
  const [active, setActive] = useState(0);
  const job = JOBS[active] ?? JOBS[0]!;

  return (
    <section id="jobs" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <div className="mx-auto w-full max-w-[1200px] px-6 sm:px-8">
        <SectionHead
          eyebrow={<CatalogEyebrow runId="sbx_8m2k" events="184" />}
          title="One runtime. Many shapes of work."
          intro={
            <p>
              The create → run → replay call doesn't move. Only the harness and the task change.
            </p>
          }
        />

        <div className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-b border-rule">
          {JOBS.map((entry, i) => {
            const isActive = i === active;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={isActive}
                className={`-mb-px flex items-center gap-2 border-b-2 pb-3 text-left font-mono text-xs transition-colors ${
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${isActive ? "bg-primary" : "bg-transparent"}`}
                  aria-hidden="true"
                />
                {entry.label}
              </button>
            );
          })}
        </div>

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
          <CallBox repo={job.repo} harness={job.harness} prompt={job.prompt} />
          <RunRecord
            variant="strip"
            runId="sbx_8m2k"
            status={{ word: job.statusWord, tone: job.tone }}
            events={job.events}
            footnote={job.footnote}
          />
        </div>
      </div>
    </section>
  );
}
