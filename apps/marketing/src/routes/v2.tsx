import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { type ReactNode } from "react";

import { REPO_URL } from "#/content";

export const Route = createFileRoute("/v2" as never)({
  component: RunWalkthroughPage,
});

function ScrollStep({
  children,
  label,
  step,
}: {
  children: ReactNode;
  label: string;
  step: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="relative border-l border-[var(--sw-rule)] pl-6 pb-16 last:pb-0 last:border-l-0"
    >
      <span
        className="absolute -left-[5px] top-0 size-2.5 rounded-full bg-[var(--sw-accent)]"
        aria-hidden="true"
      />
      <span className="absolute -left-14 top-[-0.25rem] font-mono text-[0.7rem] font-bold text-[var(--sw-accent)]">
        {step}
      </span>
      <p className="m-0 mb-3 font-mono text-[0.56rem] uppercase tracking-[0.18em] text-[var(--sw-muted)]">
        {label}
      </p>
      {children}
    </motion.div>
  );
}

function TermBlock({ children }: { children: ReactNode }) {
  return (
    <div className="v2-scanlines overflow-hidden rounded border border-[var(--sw-rule)] bg-[var(--sw-panel)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--sw-rule)] px-3 py-1.5">
        <span className="size-2 rounded-full bg-[#ff5f57]/60" />
        <span className="size-2 rounded-full bg-[#ffbd2e]/60" />
        <span className="size-2 rounded-full bg-[#28c840]/60" />
        <span className="ml-2 font-mono text-[0.52rem] uppercase tracking-[0.14em] text-[var(--sw-muted)]">
          sealant — run #wf_482
        </span>
      </div>
      <div className="px-4 py-3.5 font-mono text-[0.68rem] leading-[1.75] text-[var(--sw-ink)]/85">
        {children}
      </div>
    </div>
  );
}

function Comment({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 mt-3 max-w-[52ch] text-[0.82rem] leading-6 text-[var(--sw-muted)]">
      {children}
    </p>
  );
}

function Hero() {
  return (
    <section className="v2-scanlines relative border-b border-[var(--sw-rule)] bg-[var(--sw-bg)]">
      <div
        className="v2-grid-bg pointer-events-none absolute inset-0 opacity-30"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-[760px] px-6 py-20 text-center sm:py-28">
        <p className="m-0 font-mono text-[0.62rem] uppercase tracking-[0.22em] text-[var(--sw-accent)]">
          [ watch a run happen ]
        </p>
        <h1 className="m-0 mt-5 font-mono text-[1.75rem] font-bold leading-[1.15] text-[var(--sw-ink)] sm:text-[2.25rem]">
          This page <span className="text-[var(--sw-accent)]">is</span> a Sealant run.
          <br />
          Scroll to watch it happen.
        </h1>
        <p className="mx-auto mt-5 max-w-[48ch] font-mono text-[0.76rem] leading-6 text-[var(--sw-muted)]">
          No marketing sections. No feature grids. Just a real issue going through Sealant — from
          intake to pull request — with the recorder running the whole time.
        </p>
        <div className="mt-7 flex justify-center">
          <span className="font-mono text-[0.6rem] text-[var(--sw-accent)]">↓ scroll</span>
        </div>
      </div>
    </section>
  );
}

function Walkthrough() {
  return (
    <section className="v2-grid-bg relative border-b border-[var(--sw-rule)] bg-[var(--sw-bg)]">
      <div className="relative mx-auto max-w-[760px] px-6 py-16 sm:py-20">
        <ScrollStep step="01" label="Trigger — issue received from GitHub">
          <TermBlock>
            <p className="m-0 text-[var(--sw-accent)]">$ sealant run --issue acme/billing#482</p>
            <p className="m-0 mt-1 text-[var(--sw-muted)]">
              ↳ resolving issue #482 from github.com/acme/billing
            </p>
            <p className="m-0 text-[var(--sw-muted)]">↳ title: "Fix billing retry bug"</p>
            <p className="m-0 text-[var(--sw-muted)]">↳ labels: bug, payments, priority-high</p>
            <p className="m-0 mt-1 text-[var(--sw-accent)]">✓ issue resolved — creating run</p>
          </TermBlock>
          <Comment>
            A run starts from anywhere — a GitHub issue, a Linear ticket, an SDK call, a phone
            notification. Sealant pulls the issue context and creates a tracked run.
          </Comment>
        </ScrollStep>

        <ScrollStep step="02" label="Policy — access scoped for this run">
          <TermBlock>
            <p className="m-0 text-[var(--sw-muted)]"># resolving policy</p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">policy:</span> review-required
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">secrets:</span> STRIPE_SECRET_KEY (scoped,
              injected at runtime)
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">network:</span> restricted (no outbound
              except npm registry)
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">approvals:</span> required before PR
              creation
            </p>
            <p className="m-0 mt-1 text-[var(--sw-accent)]">✓ policy enforced</p>
          </TermBlock>
          <Comment>
            Every run gets a policy. Secrets are scoped — the agent sees only what this run needs.
            Network can be restricted. Risky actions require approval. The agent never inherits your
            laptop's access.
          </Comment>
        </ScrollStep>

        <ScrollStep step="03" label="Sandbox — isolated runtime launched">
          <TermBlock>
            <p className="m-0 text-[var(--sw-muted)]"># composing sandbox image</p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">repo:</span> acme/billing @ main (8f3c2a1)
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">os:</span> nix
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">packages:</span> nodejs, pnpm, postgresql
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">dotfiles:</span> chezmoi (applied)
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">harness:</span> codex
            </p>
            <p className="m-0 mt-1 text-[var(--sw-muted)]"># building image...</p>
            <p className="m-0 text-[var(--sw-muted)]"># publishing to registry...</p>
            <p className="m-0 text-[var(--sw-muted)]"># launching runtime (docker, runc)...</p>
            <p className="m-0 mt-1 text-[var(--sw-accent)]">✓ sandbox ready — sb_8f3a running</p>
          </TermBlock>
          <Comment>
            Sealant composes a reproducible image from the spec — repo, packages, dotfiles, harness.
            Same inputs, same image, every time. The sandbox is isolated, disposable, and torn down
            when the run ends.
          </Comment>
        </ScrollStep>

        <ScrollStep step="04" label="Recorder — capturing execution from inside">
          <TermBlock>
            <p className="m-0 text-[var(--sw-accent)]">
              $ recorder: active — capturing all execution
            </p>
            <p className="m-0 mt-1 text-[var(--sw-muted)]">
              [14:02:11] agent: reading issue context
            </p>
            <p className="m-0 text-[var(--sw-muted)]">
              [14:02:18] agent: exploring src/billing/retry.ts
            </p>
            <p className="m-0 text-[var(--sw-muted)]">
              [14:03:42] command: <span className="text-[var(--sw-ink)]">pnpm install</span>
            </p>
            <p className="m-0 text-[var(--sw-muted)]">
              [14:03:58] command: <span className="text-[var(--sw-ink)]">pnpm test</span>
            </p>
            <p className="m-0 text-[var(--sw-muted)]">[14:04:12] process: node (pid 142) started</p>
            <p className="m-0 text-[var(--sw-muted)]">
              [14:04:31] file: src/billing/retry.ts modified (+24 -8)
            </p>
            <p className="m-0 text-[var(--sw-muted)]">
              [14:04:33] file: src/billing/retry.test.ts modified (+31 -0)
            </p>
            <p className="m-0 text-[var(--sw-muted)]">
              [14:05:02] command: <span className="text-[var(--sw-ink)]">pnpm test</span>
            </p>
            <p className="m-0 mt-1 text-[var(--sw-accent)]">
              ✓ recorder: 14 commands, 3 files, 42 events captured
            </p>
          </TermBlock>
          <Comment>
            The recorder runs inside the sandbox. It captures every command, every process, every
            file change, every event. This is the execution trail — not a summary, not a chat
            transcript. The actual record of what happened.
          </Comment>
        </ScrollStep>

        <ScrollStep step="05" label="Validation — checks run against the changes">
          <TermBlock>
            <p className="m-0 text-[var(--sw-muted)]"># running validation checks</p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">tests:</span> 11 passed, 1 failed, 0 skipped
            </p>
            <p className="m-0 text-[var(--sw-muted)]">
              {" "}
              ↳ src/billing/retry.test.ts:42 — "should retry 3 times" failed
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">typecheck:</span> passed
            </p>
            <p className="m-0">
              <span className="text-[var(--sw-accent)]">lint:</span> passed (0 warnings)
            </p>
            <p className="m-0 mt-1 text-[var(--sw-accent)]">
              ⚠ validation: 11/12 passed — 1 warning (retry test)
            </p>
          </TermBlock>
          <Comment>
            Validation runs inside the sandbox — tests, typecheck, lint, custom checks. Results are
            part of the run record. A reviewer sees what passed, what failed, and what the agent did
            about it.
          </Comment>
        </ScrollStep>

        <ScrollStep step="06" label="Review — run record ready, PR linked">
          <TermBlock>
            <p className="m-0 text-[var(--sw-accent)]">$ sealant run record --run wf_482</p>
            <p className="m-0 mt-1 text-[var(--sw-muted)]">┌─────────────────────────────────┐</p>
            <p className="m-0 text-[var(--sw-muted)]">│ RUN RECORD — #wf_482 │</p>
            <p className="m-0 text-[var(--sw-muted)]">├─────────────────────────────────┤</p>
            <p className="m-0 text-[var(--sw-muted)]">│ objective: fix retry handling │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ commands: 14 │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ files: 3 changed (+55 -8) │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ tests: 11 pass · 1 fail │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ risk: auth touched │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ migration added │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ policy: review-required │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ evidence: full trace available │</p>
            <p className="m-0 text-[var(--sw-muted)]">├─────────────────────────────────┤</p>
            <p className="m-0 text-[var(--sw-muted)]">│ PR: #143 fix: retry handling │</p>
            <p className="m-0 text-[var(--sw-muted)]">│ status: awaiting review │</p>
            <p className="m-0 text-[var(--sw-muted)]">└─────────────────────────────────┘</p>
            <p className="m-0 mt-1 text-[var(--sw-accent)]">
              ✓ run complete — review the run, then review the diff
            </p>
          </TermBlock>
          <Comment>
            The run record is the reviewable artifact. A reviewer sees the objective, the commands,
            the test results, the risk flags, and the evidence — before they even look at the diff.
            This is what makes agent PRs trustworthy.
          </Comment>
        </ScrollStep>

        <ScrollStep step="07" label="What just happened">
          <div className="rounded border border-[var(--sw-accent)]/40 bg-[var(--sw-panel)] p-5">
            <p className="m-0 text-[0.92rem] leading-6 text-[var(--sw-ink)]/85">
              An issue went in. A controlled sandbox ran the agent. A recorder captured everything.
              Validation checked the work. A reviewable run record came out with a linked PR.
            </p>
            <p className="m-0 mt-3 text-[0.92rem] leading-6 text-[var(--sw-ink)]/85">
              That's Sealant. The secure run layer for AI software work.
            </p>
          </div>
        </ScrollStep>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="v2-scanlines border-b border-[var(--sw-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[760px] px-6 py-20 text-center">
        <h2 className="m-0 font-mono text-[1.5rem] font-bold leading-tight text-[var(--sw-ink)]">
          Run your first issue.
        </h2>
        <p className="mx-auto mt-4 max-w-[44ch] font-mono text-[0.76rem] leading-6 text-[var(--sw-muted)]">
          Open source, self-hosted, ready to go.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a
            className="inline-flex items-center gap-2 border border-[var(--sw-accent)] bg-[var(--sw-accent)] px-5 py-2.5 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-black no-underline transition hover:bg-transparent hover:text-[var(--sw-accent)]"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            $ run an issue
          </a>
          <a
            className="inline-flex items-center gap-2 border border-[var(--sw-rule)] px-5 py-2.5 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-[var(--sw-ink)] no-underline transition hover:border-[var(--sw-accent)] hover:text-[var(--sw-accent)]"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            {" >"} read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

function RunWalkthroughPage() {
  return (
    <div className="design-v2">
      <main>
        <Hero />
        <Walkthrough />
        <Cta />
      </main>
    </div>
  );
}
