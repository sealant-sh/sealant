import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { type ReactNode } from "react";

import { REPO_URL } from "#/content";

export const Route = createFileRoute("/v4" as never)({
  component: CaseStudyPage,
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
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, ease: "easeOut", delay }}
    >
      {children}
    </motion.div>
  );
}

function Byline({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 font-mono text-[0.56rem] uppercase tracking-[0.22em] text-[var(--sw-accent)]">
      {children}
    </p>
  );
}

function Pull({ children, author }: { children: ReactNode; author: string }) {
  return (
    <blockquote className="relative mx-auto my-10 max-w-[44ch] border-l-3 border-[var(--sw-accent)] pl-6">
      <p className="m-0 font-display text-[1.5rem] italic leading-[1.3] text-[var(--sw-ink)]">
        {children}
      </p>
      <cite className="mt-3 block font-mono text-[0.58rem] uppercase tracking-[0.14em] not-italic text-[var(--sw-muted)]">
        — {author}
      </cite>
    </blockquote>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[62ch] text-[1.02rem] leading-[1.8] text-[var(--sw-ink)]/82 [&>p]:mt-4 [&>p:first-child]:mt-0">
      {children}
    </div>
  );
}

function Hero() {
  return (
    <section className="v4-paper border-b border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
      <div className="mx-auto max-w-[920px] px-6 py-20 sm:px-8 lg:py-28">
        <Byline>Case study — Acme Billing Engineering</Byline>
        <h1 className="m-0 mt-6 font-display text-[2.5rem] leading-[1.08] tracking-tight text-[var(--sw-ink)] sm:text-[3.5rem] lg:text-[4.5rem]">
          How the billing team shipped{" "}
          <em className="font-normal italic text-[var(--sw-accent)]">47 agent PRs</em> in 30 days
          with zero rollbacks.
        </h1>
        <div className="mt-8 flex items-center gap-4 border-y border-dotted border-[var(--sw-soft-rule)] py-4">
          <span
            className="size-8 rounded-full bg-gradient-to-br from-[var(--sw-accent)] to-[var(--sw-ink)]"
            aria-hidden="true"
          />
          <div>
            <p className="m-0 font-mono text-[0.62rem] text-[var(--sw-ink)]">
              Sarah Chen, Staff Engineer
            </p>
            <p className="m-0 font-mono text-[0.52rem] text-[var(--sw-muted)]">
              Published March 2026 · 6 min read
            </p>
          </div>
        </div>
        <p className="mt-8 max-w-[58ch] text-[1.15rem] leading-[1.7] text-[var(--sw-ink)]/78">
          The team was skeptical about AI-generated PRs. Three months later, they merge agent code
          faster than human code. Here's what changed.
        </p>
      </div>
    </section>
  );
}

function Setup() {
  return (
    <section className="v4-paper border-b border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[920px] px-6 py-16 sm:px-8 lg:py-20">
        <Rx>
          <Byline>Chapter 1 — The problem</Byline>
          <h2 className="m-0 mt-4 font-display text-[1.75rem] leading-[1.15] text-[var(--sw-ink)] sm:text-[2.25rem]">
            "We were merging diffs we didn't trust."
          </h2>
        </Rx>
        <div className="mt-6">
          <Prose>
            <p>
              The billing team at Acme had a problem. They'd started using Codex to draft fixes for
              bug tickets — 15 to 20 PRs a week. The code quality was decent. The review process was
              breaking.
            </p>
            <p>
              A reviewer would open a PR, see a 200-line diff and a one-paragraph summary.{" "}
              <em>Changed retry logic in invoice processor. Added tests.</em> That was it. No record
              of what the agent actually did. No way to know what commands it ran, what it tried
              that failed, whether it touched the auth layer or just the billing module.
            </p>
            <p>
              "We were merging diffs we didn't trust," Sarah told me. "Not because the code was bad
              — because we had no idea what happened inside the run. It was a black box."
            </p>
          </Prose>
        </div>

        <Pull author="Sarah Chen, Staff Engineer at Acme">
          The agent wrote good code. But we had no evidence trail. No way to know what it tried,
          what failed, what access it had. We were trusting a summary, not a record.
        </Pull>
      </div>
    </section>
  );
}

function Discovery() {
  return (
    <section className="v4-paper border-b border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
      <div className="mx-auto max-w-[920px] px-6 py-16 sm:px-8 lg:py-20">
        <Rx>
          <Byline>Chapter 2 — The shift</Byline>
          <h2 className="m-0 mt-4 font-display text-[1.75rem] leading-[1.15] text-[var(--sw-ink)] sm:text-[2.25rem]">
            What changed: every run got a sandbox and a recorder.
          </h2>
        </Rx>
        <div className="mt-6">
          <Prose>
            <p>
              The team deployed Sealant on their own infrastructure. The first change was simple:
              instead of running Codex on a developer laptop, every agent run launched inside an
              isolated Sealant sandbox.
            </p>
            <p>
              Each sandbox was built from a declarative spec — the repo, the packages, the dotfiles,
              the harness. Same inputs, same environment, every time. Secrets were scoped per run.
              Network was restricted. The agent couldn't see anything it wasn't given access to.
            </p>
            <p>But the real shift wasn't the sandbox. It was the recorder.</p>
          </Prose>
        </div>

        <div className="my-10 border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)] p-6">
          <p className="m-0 font-mono text-[0.56rem] uppercase tracking-[0.18em] text-[var(--sw-accent)]">
            What the recorder captured
          </p>
          <ul className="m-0 mt-4 list-none space-y-2 p-0">
            {[
              "Every command the agent ran, with output",
              "Every file change, with the diff",
              "Every process that started or stopped",
              "Test results, lint results, typecheck results",
              "What access the run had (secrets, network, repo refs)",
              "A risk assessment: auth touched, migration added, dependency changed",
            ].map((item) => (
              <li
                key={item}
                className="flex items-baseline gap-3 border-b border-dotted border-[var(--sw-soft-rule)] pb-2 last:border-b-0"
              >
                <span className="font-mono text-[0.52rem] text-[var(--sw-accent)]">→</span>
                <span className="text-[0.88rem] leading-[1.5] text-[var(--sw-ink)]/78">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <Prose>
          <p>
            Now when a PR landed, the reviewer didn't just see a diff. They saw a{" "}
            <em>run record</em> — the objective, the commands, the test results, the risk flags, and
            the full evidence trail. They could review the run before they reviewed the diff.
          </p>
        </Prose>
      </div>
    </section>
  );
}

function Results() {
  return (
    <section className="v4-paper border-b border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[920px] px-6 py-16 sm:px-8 lg:py-20">
        <Rx>
          <Byline>Chapter 3 — The results</Byline>
          <h2 className="m-0 mt-4 font-display text-[1.75rem] leading-[1.15] text-[var(--sw-ink)] sm:text-[2.25rem]">
            30 days. 47 PRs. Zero rollbacks.
          </h2>
        </Rx>

        <div className="mt-8 grid gap-4 border-y border-dotted border-[var(--sw-soft-rule)] py-8 sm:grid-cols-3">
          {[
            { metric: "47", label: "Agent PRs merged" },
            { metric: "0", label: "Rollbacks" },
            { metric: "3.2×", label: "Faster review time" },
          ].map((stat) => (
            <Rx key={stat.label}>
              <div className="text-center">
                <p className="m-0 font-display text-[3rem] italic leading-none text-[var(--sw-accent)]">
                  {stat.metric}
                </p>
                <p className="m-0 mt-2 font-mono text-[0.56rem] uppercase tracking-[0.14em] text-[var(--sw-muted)]">
                  {stat.label}
                </p>
              </div>
            </Rx>
          ))}
        </div>

        <div className="mt-8">
          <Prose>
            <p>
              The numbers speak for themselves, but Sarah was quick to point out that the metric
              that mattered most wasn't speed — it was trust.
            </p>
          </Prose>
        </div>

        <Pull author="Sarah Chen, Staff Engineer at Acme">
          The biggest win wasn't shipping faster. It was that reviewers started trusting agent PRs
          the same way they trust human PRs. Because they could see what happened inside the run.
        </Pull>

        <Prose>
          <p>
            The team now runs every agent task through Sealant — not just bug fixes, but feature
            work, refactors, and dependency upgrades. Each one gets a sandbox, a recorder, and a run
            record. Each one is reviewable from first command to final PR.
          </p>
        </Prose>
      </div>
    </section>
  );
}

const faqs: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Do I need to run Sealant on my own infra?",
    a: "Yes. Sealant is self-hosted by default. Your code, your secrets, and your runs stay inside your boundary.",
  },
  {
    q: "What AI harnesses does it support?",
    a: "Codex, Claude Code, and OpenCode today. You can also bring a custom harness through the SDK.",
  },
  {
    q: "What does the recorder actually capture?",
    a: "Every command, process, file change, test result, and runtime event. The full execution trail — not a summary.",
  },
  {
    q: "Can I restrict what the agent accesses?",
    a: "Yes. Each run gets a policy: scoped secrets, restricted network, approval gates for risky actions, and optional gVisor isolation.",
  },
  {
    q: "Is it open source?",
    a: "Yes. Sealant is open source and self-hostable. The SDK, runtime adapters, and harness integrations are all programmable.",
  },
];

function Faq() {
  return (
    <section className="v4-paper border-b border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
      <div className="mx-auto max-w-[920px] px-6 py-16 sm:px-8 lg:py-20">
        <Rx>
          <Byline>Q&A</Byline>
          <h2 className="m-0 mt-4 font-display text-[1.75rem] leading-[1.15] text-[var(--sw-ink)] sm:text-[2.25rem]">
            Common questions
          </h2>
        </Rx>
        <div className="mt-8">
          {faqs.map((faq, i) => (
            <Rx key={faq.q} delay={i * 0.04}>
              <div className="border-b border-dotted border-[var(--sw-soft-rule)] py-5">
                <h3 className="m-0 font-display text-[1.15rem] italic text-[var(--sw-ink)]">
                  {faq.q}
                </h3>
                <p className="mt-2 text-[0.92rem] leading-[1.6] text-[var(--sw-ink)]/75">{faq.a}</p>
              </div>
            </Rx>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="v4-paper border-b border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[920px] px-6 py-24 text-center sm:px-8">
        <Rx>
          <h2 className="m-0 mx-auto max-w-[24ch] font-display text-[2rem] leading-[1.2] text-[var(--sw-ink)] sm:text-[3rem]">
            Give AI coding work a place to run and a record to trust.
          </h2>
          <div className="mt-8 flex flex-wrap justify-center gap-6">
            <a
              className="inline-flex items-center gap-2 bg-[var(--sw-ink)] px-5 py-2.5 text-[0.88rem] font-medium text-[var(--sw-panel)] no-underline transition hover:bg-[var(--sw-accent)]"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              Run an issue
            </a>
            <a
              className="inline-flex items-center gap-2 border-b-2 border-[var(--sw-ink)] pb-0.5 text-[0.88rem] font-medium text-[var(--sw-ink)] no-underline transition hover:border-[var(--sw-accent)] hover:text-[var(--sw-accent)]"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              Read the docs
            </a>
          </div>
        </Rx>
      </div>
    </section>
  );
}

function CaseStudyPage() {
  return (
    <div className="design-v4">
      <main>
        <Hero />
        <Setup />
        <Discovery />
        <Results />
        <Faq />
        <Cta />
      </main>
    </div>
  );
}
