import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { type ReactNode } from "react";

import { REPO_URL } from "#/content";

export const Route = createFileRoute("/v3" as never)({
  component: CapabilityMatrixPage,
});

function Rx({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, scale: 0.98 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.25, ease: "easeOut", delay }}
    >
      {children}
    </motion.div>
  );
}

function Cap({
  num,
  title,
  desc,
  tags,
  big = false,
}: {
  num: string;
  title: string;
  desc: string;
  tags: readonly string[];
  big?: boolean;
}) {
  return (
    <div
      className={`group relative border-4 border-[var(--sw-ink)] bg-[var(--sw-panel)] p-5 transition-colors hover:bg-[var(--sw-accent)] ${big ? "md:col-span-2" : ""}`}
    >
      <div className="flex items-start justify-between">
        <span className="font-display text-[1.5rem] leading-none text-[var(--sw-accent)] group-hover:text-[var(--sw-ink)]">
          {num}
        </span>
        <span className="font-mono text-[0.48rem] uppercase tracking-[0.1em] text-[var(--sw-muted)] group-hover:text-[var(--sw-ink)]/70">
          {tags[0]}
        </span>
      </div>
      <h3 className="m-0 mt-3 font-display text-[1.25rem] uppercase leading-[0.95] text-[var(--sw-ink)]">
        {title}
      </h3>
      <p className="m-0 mt-2 text-[0.78rem] font-bold leading-[1.4] text-[var(--sw-ink)]/70 group-hover:text-[var(--sw-ink)]/90">
        {desc}
      </p>
      <div className="mt-3 flex flex-wrap gap-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="border-2 border-[var(--sw-ink)] px-1.5 py-0.5 font-mono text-[0.46rem] font-bold uppercase tracking-[0.04em] text-[var(--sw-ink)] group-hover:border-[var(--sw-ink)]/60"
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="v3-concrete relative border-b-4 border-[var(--sw-ink)] bg-[var(--sw-bg)]">
      <div className="v3-stripes h-3 w-full" aria-hidden="true" />
      <div className="relative mx-auto max-w-[1280px] px-6 py-12 sm:px-8 lg:py-16">
        <div className="flex items-end justify-between gap-6">
          <div>
            <span className="inline-block bg-[var(--sw-ink)] px-3 py-1 font-mono text-[0.56rem] font-bold uppercase tracking-[0.14em] text-[var(--sw-accent)]">
              The secure run layer
            </span>
            <h1 className="m-0 mt-4 font-display text-[3rem] uppercase leading-[0.88] tracking-tight text-[var(--sw-ink)] sm:text-[5rem] lg:text-[7rem]">
              SEALANT
            </h1>
            <p className="m-0 mt-2 max-w-[40ch] text-[0.88rem] font-bold leading-[1.3] text-[var(--sw-ink)]">
              Runs AI agents in isolated sandboxes. Records everything. Turns every run into a
              reviewable PR.
            </p>
          </div>
          <div className="hidden shrink-0 flex-col gap-2 lg:flex">
            <a
              className="border-4 border-[var(--sw-ink)] bg-[var(--sw-ink)] px-5 py-3 font-mono text-[0.68rem] font-bold uppercase tracking-wider text-[var(--sw-accent)] no-underline transition hover:bg-[var(--sw-accent)] hover:text-[var(--sw-ink)]"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              RUN AN ISSUE →
            </a>
            <a
              className="border-4 border-[var(--sw-ink)] bg-transparent px-5 py-3 text-center font-mono text-[0.68rem] font-bold uppercase tracking-wider text-[var(--sw-ink)] no-underline transition hover:bg-[var(--sw-ink)] hover:text-[var(--sw-accent)]"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              DOCS
            </a>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-2">
          {[
            "ISOLATED",
            "REPRODUCIBLE",
            "TRACKED",
            "REVIEWABLE",
            "SELF-HOSTED",
            "OPEN SOURCE",
            "RECORDER INSIDE",
            "POLICY-BOUND",
          ].map((tag) => (
            <span
              key={tag}
              className="border-2 border-[var(--sw-ink)] bg-[var(--sw-panel)] px-3 py-1.5 font-mono text-[0.56rem] font-bold uppercase tracking-[0.04em] text-[var(--sw-ink)]"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div className="v3-stripes h-3 w-full" aria-hidden="true" />
    </section>
  );
}

const capabilities: ReadonlyArray<{
  num: string;
  title: string;
  desc: string;
  tags: readonly string[];
  big?: boolean;
}> = [
  {
    num: "01",
    title: "Isolated sandboxes",
    desc: "Each run gets a fresh runtime. Torn down when done. Nothing persists.",
    tags: ["sandbox", "disposable"],
    big: true,
  },
  {
    num: "02",
    title: "Recorder inside",
    desc: "A binary inside the runtime captures every command, process, and file change.",
    tags: ["recorder", "evidence"],
    big: true,
  },
  {
    num: "03",
    title: "Run records",
    desc: "Every run produces a reviewable evidence trail.",
    tags: ["record"],
  },
  {
    num: "04",
    title: "Policy enforcement",
    desc: "Secrets, network, and approvals scoped per run.",
    tags: ["policy"],
  },
  {
    num: "05",
    title: "Scoped secrets",
    desc: "Injected at runtime, never baked into the image.",
    tags: ["secrets"],
  },
  {
    num: "06",
    title: "Network policy",
    desc: "Restrict outbound traffic. Control what the agent can reach.",
    tags: ["network"],
  },
  {
    num: "07",
    title: "gVisor / runsc",
    desc: "Stronger runtime isolation when you need a harder boundary.",
    tags: ["isolation"],
  },
  {
    num: "08",
    title: "Approval gates",
    desc: "Hold a run for a human decision before risky actions.",
    tags: ["approvals"],
  },
  {
    num: "09",
    title: "Reproducible images",
    desc: "Same spec, same image. Every time.",
    tags: ["reproducible"],
  },
  {
    num: "10",
    title: "Three OS families",
    desc: "Nix, Fedora, Arch. Pick your base.",
    tags: ["os"],
  },
  {
    num: "11",
    title: "Three harnesses",
    desc: "Codex, Claude Code, OpenCode. Or bring your own.",
    tags: ["harness"],
  },
  {
    num: "12",
    title: "Dotfiles",
    desc: "chezmoi, stow, or copy. The sandbox feels like your machine.",
    tags: ["personal"],
  },
  {
    num: "13",
    title: "SSH access",
    desc: "SSH into any sandbox. Use VS Code, Cursor, or terminal.",
    tags: ["access"],
  },
  {
    num: "14",
    title: "Run from anywhere",
    desc: "Web, GitHub, Slack, Linear, CLI, SDK, phone.",
    tags: ["trigger"],
  },
  {
    num: "15",
    title: "Validation",
    desc: "Tests, lint, typecheck, custom checks — part of the record.",
    tags: ["validation"],
  },
  {
    num: "16",
    title: "Risk flags",
    desc: "Auth touched, migration added, dependency changed — surfaced.",
    tags: ["risk"],
  },
  {
    num: "17",
    title: "SDK modules",
    desc: "Sandboxes, workflows, runtime, policies, harnesses — programmable.",
    tags: ["sdk"],
  },
  {
    num: "18",
    title: "Self-hosted",
    desc: "Your infra, your boundary, your control.",
    tags: ["self-hosted"],
  },
];

function Matrix() {
  return (
    <section className="v3-concrete border-b-4 border-[var(--sw-ink)] bg-[var(--sw-bg)]">
      <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="m-0 font-display text-[1.75rem] uppercase leading-none text-[var(--sw-ink)] sm:text-[2.5rem]">
            CAPABILITIES
          </h2>
          <span className="font-mono text-[0.56rem] font-bold uppercase tracking-[0.1em] text-[var(--sw-muted)]">
            18 / 18
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {capabilities.map((cap, i) => (
            <Rx key={cap.num} delay={(i % 4) * 0.03}>
              <Cap {...cap} />
            </Rx>
          ))}
        </div>
      </div>
    </section>
  );
}

const pains: ReadonlyArray<{ num: string; title: string; desc: string }> = [
  {
    num: "!",
    title: "AGENTS NEED BOUNDARIES",
    desc: "Running on a laptop gives the agent your files, secrets, and network. It needs a controlled place.",
  },
  {
    num: "!",
    title: "PRS NEED EVIDENCE",
    desc: "A diff and a summary is not enough. Reviewers need the execution trail — what ran, what changed, what failed.",
  },
  {
    num: "!",
    title: "RUNS NEED TO REPRODUCE",
    desc: "A diff without its environment is a guess. The exact repo ref, tooling, and policy must be recoverable.",
  },
];

function Pains() {
  return (
    <section className="border-b-4 border-[var(--sw-ink)] bg-[var(--sw-ink)]">
      <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-8">
        <h2 className="m-0 mb-6 font-display text-[1.75rem] uppercase leading-none text-[var(--sw-accent)] sm:text-[2.5rem]">
          THE PROBLEM
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          {pains.map((p) => (
            <div key={p.title} className="border-4 border-[var(--sw-accent)] p-5">
              <span className="font-display text-[2.5rem] leading-none text-[var(--sw-accent)]">
                {p.num}
              </span>
              <h3 className="m-0 mt-2 font-display text-[1.1rem] uppercase leading-[0.95] text-[var(--sw-panel)]">
                {p.title}
              </h3>
              <p className="m-0 mt-2 text-[0.82rem] font-bold leading-[1.4] text-[var(--sw-panel)]/75">
                {p.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const flowSteps: readonly string[] = [
  "TRIGGER",
  "POLICY",
  "SANDBOX",
  "RECORDER",
  "VALIDATION",
  "REVIEW",
];

function Flow() {
  return (
    <section className="v3-concrete border-b-4 border-[var(--sw-ink)] bg-[var(--sw-bg)]">
      <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-8">
        <h2 className="m-0 mb-6 font-display text-[1.75rem] uppercase leading-none text-[var(--sw-ink)] sm:text-[2.5rem]">
          THE FLOW
        </h2>
        <div className="flex flex-wrap items-stretch gap-0">
          {flowSteps.map((step, i) => (
            <div key={step} className="flex items-center">
              <div className="border-4 border-[var(--sw-ink)] bg-[var(--sw-panel)] px-4 py-3">
                <span className="font-mono text-[0.52rem] font-bold text-[var(--sw-accent)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="m-0 font-display text-[0.88rem] uppercase leading-none text-[var(--sw-ink)]">
                  {step}
                </p>
              </div>
              {i < flowSteps.length - 1 ? (
                <span
                  className="px-1 font-display text-[1.5rem] text-[var(--sw-ink)]"
                  aria-hidden="true"
                >
                  →
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <p className="m-0 mt-4 text-[0.82rem] font-bold leading-[1.4] text-[var(--sw-ink)]/70">
          Trigger → Policy → Sandbox → Recorder → Validation → Reviewable PR. Every step recorded.
          Every run reproducible.
        </p>
      </div>
    </section>
  );
}

function Sdk() {
  return (
    <section className="border-b-4 border-[var(--sw-ink)] bg-[var(--sw-panel)]">
      <div className="mx-auto grid max-w-[1280px] gap-8 px-6 py-12 sm:px-8 lg:grid-cols-[1fr_1fr]">
        <div>
          <h2 className="m-0 font-display text-[1.75rem] uppercase leading-none text-[var(--sw-ink)] sm:text-[2.5rem]">
            SDK
          </h2>
          <p className="mt-3 text-[0.88rem] font-bold leading-[1.4] text-[var(--sw-ink)]/75">
            Build your own workflows on the run layer. Sandboxes, issue workflows, runtime events,
            policies, harnesses — all programmable.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {["sandboxes", "issueWorkflows", "runtime", "policies", "harnesses", "sources"].map(
              (m) => (
                <span
                  key={m}
                  className="border-2 border-[var(--sw-ink)] bg-[var(--sw-bg)] px-2.5 py-1 font-mono text-[0.56rem] font-bold text-[var(--sw-ink)]"
                >
                  .{m}()
                </span>
              ),
            )}
          </div>
        </div>
        <div className="border-4 border-[var(--sw-ink)] bg-[var(--sw-bg)]">
          <div className="border-b-4 border-[var(--sw-ink)] bg-[var(--sw-ink)] px-3 py-1.5">
            <span className="font-mono text-[0.48rem] font-bold uppercase tracking-[0.14em] text-[var(--sw-accent)]">
              sealant.ts
            </span>
          </div>
          <pre className="m-0 overflow-x-auto px-4 py-4 font-mono text-[0.66rem] font-bold leading-[1.7] text-[var(--sw-ink)]">
            <code>{`const run = await sealant.issueWorkflows.run({
  repo: "acme/billing",
  issue: 482,
  harness: "codex",
  policy: "review-required",
});

await run.waitUntil("pr.ready");`}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="v3-concrete border-b-4 border-[var(--sw-ink)] bg-[var(--sw-accent)]">
      <div className="mx-auto max-w-[1280px] px-6 py-16 text-center sm:px-8">
        <h2 className="m-0 mx-auto max-w-[24ch] font-display text-[2rem] uppercase leading-[0.95] text-[var(--sw-ink)] sm:text-[3.5rem]">
          GIVE AI CODING WORK A PLACE TO RUN AND A RECORD TO TRUST.
        </h2>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <a
            className="border-4 border-[var(--sw-ink)] bg-[var(--sw-ink)] px-6 py-3 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-[var(--sw-accent)] no-underline transition hover:bg-transparent hover:text-[var(--sw-ink)]"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            RUN AN ISSUE →
          </a>
          <a
            className="border-4 border-[var(--sw-ink)] bg-transparent px-6 py-3 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-[var(--sw-ink)] no-underline transition hover:bg-[var(--sw-ink)] hover:text-[var(--sw-accent)]"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            READ THE DOCS
          </a>
        </div>
      </div>
    </section>
  );
}

function CapabilityMatrixPage() {
  return (
    <div className="design-v3">
      <main>
        <Hero />
        <Matrix />
        <Pains />
        <Flow />
        <Sdk />
        <Cta />
      </main>
    </div>
  );
}
