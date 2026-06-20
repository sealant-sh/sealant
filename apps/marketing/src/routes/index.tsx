import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  Code2,
  Eye,
  GitPullRequest,
  Key,
  Layers,
  Lock,
  Network,
  Shield,
  Terminal,
} from "lucide-react";
import { type ReactNode } from "react";

import { GitHubLogo } from "#/components/github";

export const Route = createFileRoute("/" as never)({
  component: HomePage,
});

const REPO_URL = "https://github.com/get-sealant/sealant";

function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-72px" }}
      transition={{ duration: 0.52, ease: "easeOut", delay }}
    >
      {children}
    </motion.div>
  );
}

function PrimaryLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      className="inline-flex min-h-11 items-center justify-center gap-2 bg-[var(--sw-accent)] px-5 text-sm font-bold uppercase tracking-[0.08em] text-white no-underline transition duration-200 hover:-translate-y-px hover:brightness-95 md:min-h-10"
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

function OutlineLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      className="inline-flex min-h-11 items-center justify-center gap-2 border border-[var(--sw-rule)] bg-transparent px-5 text-sm font-bold uppercase tracking-[0.08em] text-foreground no-underline transition duration-200 hover:bg-foreground hover:text-background md:min-h-10"
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 font-mono text-[0.72rem] uppercase tracking-[0.22em] text-muted-foreground">
      {children}
    </p>
  );
}

function SectionRail() {
  return (
    <span className="absolute inset-x-0 top-0 h-[3px] bg-[var(--sw-accent)]" aria-hidden="true" />
  );
}

function Panel({
  label,
  children,
  tone = "panel",
}: {
  label: string;
  children: ReactNode;
  tone?: "panel" | "bg";
}) {
  return (
    <div
      className={`relative border border-[var(--sw-soft-rule)] ${tone === "panel" ? "bg-[var(--sw-panel)]" : "bg-[var(--sw-bg)]"}`}
    >
      <SectionRail />
      <div className="border-b border-[var(--sw-soft-rule)] px-4 py-2.5">
        <p className="m-0 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </p>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center py-2 lg:py-0" aria-hidden="true">
      <ArrowRight className="size-5 rotate-90 text-[var(--sw-accent)] lg:rotate-0" />
    </div>
  );
}

function HeroSplitStory() {
  return (
    <div className="sealant-rise lg:pl-4" style={{ animationDelay: "120ms" }}>
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-stretch">
        <Panel label="Issue">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              acme/billing
            </span>
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-[var(--sw-accent)]">
              #482
            </span>
          </div>
          <p className="m-0 mt-2 text-[0.88rem] leading-6 text-foreground">Fix billing retry bug</p>
          <div className="mt-3 border-t border-[var(--sw-soft-rule)] pt-3">
            <p className="m-0 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-muted-foreground">
              Assigned to
            </p>
            <p className="m-0 mt-1 font-mono text-[0.72rem] text-foreground/85">Codex</p>
          </div>
        </Panel>

        <FlowArrow />

        <Panel label="Sandbox">
          <div className="flex items-center gap-1.5">
            <span
              className="sealant-status-running size-2 rounded-full bg-[var(--sw-accent)]"
              aria-hidden="true"
            />
            <span className="font-mono text-[0.58rem] uppercase tracking-[0.14em] text-[var(--sw-accent)]">
              Isolated runtime
            </span>
          </div>
          <div className="mt-3 space-y-1.5 font-mono text-[0.66rem] leading-5 text-foreground/75">
            <p className="m-0">
              <span className="text-muted-foreground">$</span> pnpm install
            </p>
            <p className="m-0">
              <span className="text-muted-foreground">$</span> pnpm test
            </p>
            <p className="m-0">
              <span className="text-muted-foreground">$</span> pnpm typecheck
            </p>
          </div>
          <div className="mt-3 border-t border-[var(--sw-soft-rule)] pt-2">
            <p className="m-0 font-mono text-[0.56rem] uppercase tracking-[0.12em] text-muted-foreground">
              Recorder active
            </p>
          </div>
        </Panel>

        <FlowArrow />

        <Panel label="Pull request + Run record">
          <p className="m-0 font-mono text-[0.66rem] text-foreground">
            fix: retry handling for failed invoices
          </p>
          <div className="mt-3 grid gap-1.5">
            {[
              { k: "Commands run", v: "14" },
              { k: "Files changed", v: "3" },
              { k: "Tests passed", v: "11 / 12" },
              { k: "Network", v: "restricted" },
              { k: "Secrets", v: "scoped" },
              { k: "Validation", v: "complete" },
            ].map((row) => (
              <div key={row.k} className="flex items-center justify-between gap-2">
                <span className="font-mono text-[0.58rem] uppercase tracking-[0.1em] text-muted-foreground">
                  {row.k}
                </span>
                <span className="font-mono text-[0.62rem] text-foreground/88">{row.v}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b-2 border-[var(--sw-rule)] bg-[var(--sw-bg)]">
      <div
        className="sealant-dot-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_28%_24%,black,transparent_72%)]"
        aria-hidden="true"
      />
      <div className="relative mx-auto grid max-w-[1320px] gap-12 px-6 py-16 sm:px-8 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-12 lg:py-20">
        <div className="sealant-rise">
          <Kicker>The secure run layer for AI software work</Kicker>
          <h1 className="m-0 mt-5 font-display text-[2.75rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4rem]">
            <span className="block">Secure AI coding runs.</span>
            <span className="block">
              Reviewable from <span className="text-[var(--sw-accent)]">first command</span>
            </span>
            <span className="block">to final PR.</span>
          </h1>
          <p className="mt-6 max-w-[50ch] text-[1.05rem] leading-7 text-foreground/82">
            Sealant runs repositories, issues, and agent tasks inside isolated sandboxes, records
            what happened inside the runtime, and turns every run into a fast, trustworthy review.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <PrimaryLink href={REPO_URL} external>
              Run an issue
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </PrimaryLink>
            <OutlineLink href="#review">
              View the execution record
              <ArrowRight className="size-4" aria-hidden="true" />
            </OutlineLink>
          </div>
        </div>

        <HeroSplitStory />
      </div>
    </section>
  );
}

const painPoints: ReadonlyArray<{ readonly title: string; readonly body: string }> = [
  {
    title: "Agents need secure, disposable environments",
    body: "Running an agent on a laptop gives it your files, your secrets, and your network. Runs need a controlled place they can be torn down after.",
  },
  {
    title: "Runs must be reproducible",
    body: "A diff without its environment is a guess. Reviewers need to know the exact repo ref, tooling, and policy a run used.",
  },
  {
    title: "PRs need evidence, not just summaries",
    body: "A reviewer gets a diff and a summary, but not the execution trail: what commands ran, what changed, what failed, what access the agent had.",
  },
  {
    title: "Work should start from anywhere",
    body: "Issues arrive in GitHub, Linear, Slack, or your phone. Waiting to be at a laptop to kick off a run slows the whole loop.",
  },
];

function Problem() {
  return (
    <section
      id="problem"
      className="relative border-b-2 border-[var(--sw-rule)] bg-[var(--sw-panel)]"
    >
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <Reveal className="max-w-[64ch]">
          <Kicker>The problem</Kicker>
          <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.25rem]">
            AI can write code. Teams still need to trust the work.
          </h2>
          <p className="mt-5 text-[1rem] leading-7 text-foreground/80">
            AI coding agents are powerful, but their work is often invisible. A reviewer gets a diff
            and a summary, but not the actual execution trail: what environment it ran in, what
            commands executed, what changed, what failed, what passed, and what access the agent
            had.
          </p>
        </Reveal>
        <div className="mt-10 grid gap-px border border-[var(--sw-soft-rule)] bg-[var(--sw-soft-rule)] md:grid-cols-2">
          {painPoints.map((point, index) => (
            <Reveal
              key={point.title}
              delay={(index % 2) * 0.05}
              className="bg-[var(--sw-panel)] p-6 lg:p-8"
            >
              <span className="font-display text-[2.25rem] leading-none text-[var(--sw-accent)]">
                {`0${index + 1}`}
              </span>
              <h3 className="m-0 mt-3 font-mono text-[0.8rem] uppercase tracking-[0.12em] text-foreground">
                {point.title}
              </h3>
              <p className="mt-3 text-[0.92rem] leading-6 text-foreground/75">{point.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const pipelineStages: ReadonlyArray<{
  readonly step: string;
  readonly label: string;
  readonly items: ReadonlyArray<string>;
}> = [
  { step: "01", label: "Trigger", items: ["issue", "repo", "PR", "SDK", "phone"] },
  { step: "02", label: "Policy", items: ["secrets", "network", "tools", "approvals"] },
  { step: "03", label: "Sandbox", items: ["isolated runtime"] },
  { step: "04", label: "Recorder", items: ["commands", "processes", "files", "output", "events"] },
  { step: "05", label: "Validation", items: ["tests", "lint", "typecheck", "custom checks"] },
  { step: "06", label: "Review", items: ["summary", "diff", "risk", "evidence"] },
];

function CoreProduct() {
  return (
    <section id="product" className="relative border-b-2 border-[var(--sw-rule)]">
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <Reveal className="max-w-[60ch]">
          <Kicker>The core product</Kicker>
          <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.5rem]">
            Every run gets a sandbox and a recorder.
          </h2>
          <p className="mt-5 text-[1rem] leading-7 text-foreground/80">
            A Sealant run starts from a repo, issue, PR, SDK call, or mobile action. Sealant
            launches an isolated sandbox, runs the human or AI workflow, and records the execution
            from inside the runtime.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-10">
          <div className="overflow-x-auto border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
            <div className="flex items-stretch gap-px bg-[var(--sw-soft-rule)] min-w-[860px]">
              {pipelineStages.map((stage, index) => (
                <div key={stage.step} className="flex flex-1 items-stretch">
                  <div className="flex-1 bg-[var(--sw-panel)] p-4">
                    <div className="flex items-center gap-2 border-b border-[var(--sw-soft-rule)] pb-2.5">
                      <span className="font-display text-[1.5rem] leading-none text-[var(--sw-accent)]">
                        {stage.step}
                      </span>
                      <span className="font-mono text-[0.7rem] uppercase tracking-[0.1em] text-foreground">
                        {stage.label}
                      </span>
                    </div>
                    <ul className="m-0 mt-2.5 list-none space-y-1 p-0">
                      {stage.items.map((item) => (
                        <li
                          key={item}
                          className="font-mono text-[0.6rem] leading-4 text-foreground/72"
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {index < pipelineStages.length - 1 ? (
                    <div
                      className="flex w-6 items-center justify-center bg-[var(--sw-panel)]"
                      aria-hidden="true"
                    >
                      <ArrowRight className="size-3.5 text-[var(--sw-accent)]" />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.12} className="mt-4">
          <p className="m-0 text-center font-mono text-[0.66rem] uppercase tracking-[0.16em] text-muted-foreground">
            Trigger → Policy → Sandbox → Recorder → Validation → Reviewable PR
          </p>
        </Reveal>
      </div>
    </section>
  );
}

const securityCaps: ReadonlyArray<{
  readonly icon: typeof Shield;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    icon: Shield,
    label: "Disposable sandboxes",
    detail:
      "Each run gets a fresh runtime, torn down when the run ends. Nothing persists by default.",
  },
  {
    icon: Key,
    label: "Scoped repository access",
    detail:
      "A run sees only the repo and ref it was given. Access is resolved per run, not inherited.",
  },
  {
    icon: Lock,
    label: "Scoped secrets and SSH keys",
    detail: "Secrets are injected per run and scoped to the policy. They do not live in the image.",
  },
  {
    icon: Network,
    label: "Network and runtime policy",
    detail:
      "Restrict outbound network, pick the runtime isolation level, and bound what the run can do.",
  },
  {
    icon: Eye,
    label: "Per-run environment records",
    detail:
      "Every run records the environment it ran in: tooling, harness, policy, and runtime config.",
  },
  {
    icon: Shield,
    label: "Stronger runtime isolation",
    detail:
      "Optional gVisor / runsc isolation for runs that need a harder boundary than the default.",
  },
  {
    icon: Lock,
    label: "Approval gates for risky actions",
    detail: "Hold a run for a human decision before risky changes, secret access, or PR creation.",
  },
];

function Security() {
  return (
    <section
      id="security"
      className="relative border-b-2 border-[var(--sw-rule)] bg-[var(--sw-panel)]"
    >
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <Reveal className="max-w-[60ch]">
          <Kicker>Security</Kicker>
          <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.25rem]">
            Agents run with boundaries.
          </h2>
          <p className="mt-5 text-[1rem] leading-7 text-foreground/80">
            Sealant gives AI coding work a controlled place to execute. Each run can be isolated,
            scoped, observed, and shut down without depending on a developer machine.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-10">
          <div className="border-y border-[var(--sw-rule)]">
            <table className="w-full border-collapse text-left">
              <tbody>
                {securityCaps.map((cap) => {
                  const Icon = cap.icon;
                  return (
                    <tr
                      key={cap.label}
                      className="border-b border-[var(--sw-soft-rule)] last:border-b-0"
                    >
                      <td className="w-12 border-r border-[var(--sw-soft-rule)] py-4 pl-5 align-middle">
                        <Icon className="size-4 text-[var(--sw-accent)]" aria-hidden="true" />
                      </td>
                      <td className="w-[14rem] border-r border-[var(--sw-soft-rule)] py-4 pl-4 pr-4 align-middle">
                        <span className="font-mono text-[0.74rem] uppercase tracking-[0.1em] text-foreground">
                          {cap.label}
                        </span>
                      </td>
                      <td className="py-4 pl-4 pr-5 align-middle">
                        <span className="text-[0.92rem] leading-6 text-foreground/78">
                          {cap.detail}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const fingerprint: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "Repository", value: "acme/billing" },
  { label: "Ref", value: "main@8f3c…" },
  { label: "Sandbox image", value: "sha256:…" },
  { label: "Harness", value: "Codex / Claude Code / OpenCode" },
  { label: "Runtime", value: "Docker / Kubernetes" },
  { label: "Policy", value: "restricted network, scoped secrets" },
  { label: "Validation", value: "12 checks · 11 passed · 1 warning" },
];

function Reproducibility() {
  return (
    <section id="reproducibility" className="relative border-b-2 border-[var(--sw-rule)]">
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:items-start lg:gap-16">
          <Reveal>
            <Kicker>Reproducibility</Kicker>
            <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.25rem]">
              A run is a real artifact, not a chat transcript.
            </h2>
            <p className="mt-5 text-[1rem] leading-7 text-foreground/80">
              Sealant captures the inputs that matter: repo ref, issue context, environment profile,
              packages, dotfiles, runtime, harness, commands, logs, artifacts, validation, and final
              diff.
            </p>
            <p className="mt-4 text-[1rem] leading-7 text-foreground/80">
              This lets teams rerun, resume, compare, debug, and explain software work.
            </p>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="relative border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
              <SectionRail />
              <div className="border-b border-[var(--sw-soft-rule)] px-5 py-3">
                <p className="m-0 font-mono text-[0.64rem] uppercase tracking-[0.18em] text-muted-foreground">
                  Run fingerprint
                </p>
              </div>
              <dl className="m-0 divide-y divide-[var(--sw-soft-rule)] p-0">
                {fingerprint.map((row) => (
                  <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-3 px-5 py-3.5">
                    <dt className="pt-0.5 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                      {row.label}
                    </dt>
                    <dd className="m-0 font-mono text-[0.74rem] leading-6 text-foreground/88">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const reviewRows: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }> = [
  { label: "Objective", value: "Fix retry handling for failed invoices" },
  { label: "Commands", value: "pnpm test · pnpm typecheck · pnpm lint" },
  { label: "Files changed", value: "3 files, grouped by intent" },
  {
    label: "Tests",
    value: (
      <span>
        <span className="text-foreground/88">11 passed</span>
        <span className="text-muted-foreground"> · </span>
        <span className="text-[var(--sw-accent)]">1 failed</span>
        <span className="text-muted-foreground"> · 0 skipped</span>
      </span>
    ),
  },
  {
    label: "Risk flags",
    value: (
      <span className="inline-flex flex-wrap gap-1.5">
        {["auth touched", "migration added", "dependency changed"].map((flag) => (
          <span
            key={flag}
            className="inline-flex items-center gap-1 border border-[var(--sw-accent)] px-1.5 py-0.5 font-mono text-[0.56rem] uppercase tracking-[0.08em] text-[var(--sw-accent)]"
          >
            <AlertTriangle className="size-2.5" aria-hidden="true" />
            {flag}
          </span>
        ))}
      </span>
    ),
  },
  { label: "Agent notes", value: "Assumptions and uncertainties recorded by the agent" },
  {
    label: "Evidence",
    value: "Raw logs and runtime events available",
  },
];

function PrReview() {
  return (
    <section
      id="review"
      className="relative border-b-2 border-[var(--sw-rule)] bg-[var(--sw-panel)]"
    >
      <div
        className="sealant-rule-grid pointer-events-none absolute inset-0 opacity-25 [mask-image:radial-gradient(ellipse_at_50%_0%,black,transparent_65%)]"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:items-start lg:gap-16">
          <Reveal>
            <Kicker>PR review</Kicker>
            <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.25rem]">
              Review the run before you review the diff.
            </h2>
            <p className="mt-5 text-[1rem] leading-7 text-foreground/80">
              Sealant compresses PR review by showing what happened during the run: the objective,
              plan, commands, test results, file changes, risky areas, unexplained edits, and
              validation status.
            </p>
            <div className="mt-7">
              <PrimaryLink href={REPO_URL} external>
                Open run record
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </PrimaryLink>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="relative border border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
              <SectionRail />
              <div className="flex items-center justify-between border-b border-[var(--sw-soft-rule)] px-5 py-3">
                <p className="m-0 font-mono text-[0.64rem] uppercase tracking-[0.18em] text-muted-foreground">
                  Run record · #wf_482
                </p>
                <span className="inline-flex items-center gap-1.5 font-mono text-[0.58rem] uppercase tracking-[0.12em] text-foreground/80">
                  <Check className="size-3" aria-hidden="true" />
                  Reviewable
                </span>
              </div>
              <dl className="m-0 divide-y divide-[var(--sw-soft-rule)] p-0">
                {reviewRows.map((row) => (
                  <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-3 px-5 py-3.5">
                    <dt className="pt-0.5 font-mono text-[0.58rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {row.label}
                    </dt>
                    <dd className="m-0 text-[0.84rem] leading-6 text-foreground/88">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const phoneNotifications: ReadonlyArray<{
  readonly icon: typeof Terminal;
  readonly title: string;
  readonly detail: string;
}> = [
  { icon: Terminal, title: "Run issue in sandbox", detail: "acme/billing · #482" },
  { icon: Key, title: "Approve secret access", detail: "STRIPE_SECRET_KEY" },
  { icon: Check, title: "Validation finished", detail: "11 / 12 checks passed" },
  { icon: GitPullRequest, title: "PR ready for review", detail: "fix: retry handling" },
];

function RunFromAnywhere() {
  return (
    <section id="anywhere" className="relative border-b-2 border-[var(--sw-rule)]">
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-20">
          <Reveal>
            <Kicker>Run from anywhere</Kicker>
            <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.25rem]">
              Start work wherever the issue finds you.
            </h2>
            <p className="mt-5 max-w-[48ch] text-[1rem] leading-7 text-foreground/80">
              Kick off a sandbox or issue workflow from the web app, GitHub, Slack, Linear, CLI,
              SDK, or your phone. The run happens in Sealant infrastructure, not on your laptop.
            </p>
            <ul className="m-0 mt-6 flex list-none flex-wrap gap-2 p-0">
              {["Web app", "GitHub", "Slack", "Linear", "CLI", "SDK", "Phone"].map((source) => (
                <li
                  key={source}
                  className="border border-[var(--sw-soft-rule)] px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-foreground/75"
                >
                  {source}
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="mx-auto w-[15rem] rounded-[1.75rem] border-2 border-[var(--sw-rule)] bg-[var(--sw-panel)] p-3 shadow-[0_24px_40px_-24px_rgba(0,0,0,0.4)]">
              <div
                className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--sw-soft-rule)]"
                aria-hidden="true"
              />
              <div className="space-y-2">
                {phoneNotifications.map((n) => {
                  const Icon = n.icon;
                  return (
                    <div
                      key={n.title}
                      className="border border-[var(--sw-soft-rule)] bg-[var(--sw-bg)] px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <Icon
                          className="size-3.5 shrink-0 text-[var(--sw-accent)]"
                          aria-hidden="true"
                        />
                        <span className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-foreground">
                          {n.title}
                        </span>
                      </div>
                      <p className="m-0 mt-1 pl-5 font-mono text-[0.56rem] text-muted-foreground">
                        {n.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

interface SdkModule {
  readonly name: string;
  readonly icon: typeof Code2;
  readonly methods: ReadonlyArray<string>;
}

const sdkModules: ReadonlyArray<SdkModule> = [
  { name: "Sandboxes", icon: Layers, methods: ["create", "connect", "inspect", "stop", "retry"] },
  {
    name: "Issue Workflows",
    icon: GitPullRequest,
    methods: ["run", "observe", "validate", "report"],
  },
  {
    name: "Runtime Events",
    icon: Terminal,
    methods: ["commands", "output", "process lifecycle", "artifacts"],
  },
  { name: "Policies", icon: Shield, methods: ["secrets", "network", "approvals", "permissions"] },
  {
    name: "Harnesses",
    icon: Code2,
    methods: ["Codex", "Claude Code", "OpenCode", "custom agents"],
  },
  { name: "Integrations", icon: Network, methods: ["GitHub first", "more providers later"] },
];

const SDK_CODE_LINES: ReadonlyArray<string> = [
  "const run = await sealant.issueWorkflows.run({",
  '  repo: "acme/billing",',
  "  issue: 482,",
  '  harness: "codex",',
  '  policy: "review-required",',
  "});",
  "",
  'await run.waitUntil("pr.ready");',
];

function Sdk() {
  return (
    <section id="sdk" className="relative border-b-2 border-[var(--sw-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <Reveal className="max-w-[64ch]">
          <Kicker>SDK and platform</Kicker>
          <h2 className="m-0 mt-4 font-display text-[2.5rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[4.25rem]">
            Build your own workflows on the run layer.
          </h2>
          <p className="mt-5 text-[1rem] leading-7 text-foreground/80">
            Sealant exposes sandboxes, issue workflows, runtime events, profiles, policies,
            registries, and harnesses as programmable modules.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <Reveal>
            <div className="grid gap-px border border-[var(--sw-soft-rule)] bg-[var(--sw-soft-rule)] sm:grid-cols-2">
              {sdkModules.map((module) => {
                const Icon = module.icon;
                return (
                  <div key={module.name} className="bg-[var(--sw-panel)] p-5">
                    <div className="flex items-center gap-2.5 border-b border-[var(--sw-soft-rule)] pb-3">
                      <Icon
                        className="size-4 shrink-0 text-[var(--sw-accent)]"
                        aria-hidden="true"
                      />
                      <span className="font-mono text-[0.74rem] uppercase tracking-[0.06em] text-foreground">
                        {module.name}
                      </span>
                    </div>
                    <ul className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
                      {module.methods.map((method) => (
                        <li
                          key={method}
                          className="border border-[var(--sw-soft-rule)] px-2 py-1 font-mono text-[0.58rem] tracking-[0.02em] text-foreground/72"
                        >
                          {method}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="relative border border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
              <SectionRail />
              <div className="flex items-center justify-between border-b border-[var(--sw-soft-rule)] px-4 py-2.5">
                <p className="m-0 font-mono text-[0.6rem] uppercase tracking-[0.16em] text-muted-foreground">
                  sealant.ts
                </p>
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="size-2.5 rounded-full bg-[#ffbd2e]" />
                  <span className="size-2.5 rounded-full bg-[#28c840]" />
                </div>
              </div>
              <pre className="m-0 overflow-x-auto px-4 py-4 font-mono text-[0.74rem] leading-[1.7] text-foreground/90">
                <code>
                  {SDK_CODE_LINES.map((line, index) => (
                    <span key={index} className="block">
                      {line.length === 0 ? "\u00A0" : line}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const architecturePoints: ReadonlyArray<string> = [
  "Control plane for lifecycle and policy",
  "Build workers for reproducible images",
  "Runtime adapters for Docker and Kubernetes",
  "SSH gateway for editor and terminal access",
  "Binary recorder inside the runtime",
  "Event stream and artifacts for review",
  "Contract-first API and SDK modules",
];

function Architecture() {
  return (
    <section id="architecture" className="relative border-b-2 border-[var(--sw-rule)]">
      <div className="mx-auto max-w-[1320px] px-6 py-16 sm:px-8 lg:py-24">
        <Reveal className="max-w-[60ch]">
          <Kicker>Architecture proof</Kicker>
          <h2 className="m-0 mt-4 font-display text-[2.25rem] uppercase leading-[0.9] tracking-[0.01em] text-foreground sm:text-[3rem] lg:text-[3.75rem]">
            Built for real execution, not demos.
          </h2>
        </Reveal>
        <Reveal delay={0.08} className="mt-10">
          <ul className="m-0 list-none divide-y divide-[var(--sw-soft-rule)] border-y border-[var(--sw-soft-rule)] p-0">
            {architecturePoints.map((point) => (
              <li key={point} className="flex items-start gap-3 py-3.5">
                <span
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--sw-accent)]"
                  aria-hidden="true"
                />
                <span className="text-[0.95rem] leading-6 text-foreground/82">{point}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section
      id="opensource"
      className="relative overflow-hidden border-b-2 border-[var(--sw-rule)] bg-[var(--sw-panel)]"
    >
      <div
        className="sealant-rule-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_70%_30%,black,transparent_70%)]"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-[1320px] px-6 py-20 text-center sm:px-8 lg:py-28">
        <Reveal>
          <h2 className="m-0 mx-auto max-w-[20ch] font-display text-[2.5rem] uppercase leading-[0.92] tracking-[0.01em] text-foreground sm:text-[3.5rem] lg:text-[5rem]">
            Give AI coding work a place to run and a record to trust.
          </h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PrimaryLink href={REPO_URL} external>
              Run an issue
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </PrimaryLink>
            <OutlineLink href={REPO_URL} external>
              <GitHubLogo className="size-4" />
              Read the docs
            </OutlineLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function MarketingPage() {
  return (
    <main>
      <Hero />
      <Problem />
      <CoreProduct />
      <Security />
      <Reproducibility />
      <PrReview />
      <RunFromAnywhere />
      <Sdk />
      <Architecture />
      <FinalCta />
    </main>
  );
}
