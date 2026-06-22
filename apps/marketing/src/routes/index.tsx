import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleDot,
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

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

const REPO_URL = "https://github.com/get-sealant/sealant";

// ── Motion ──────────────────────────────────────────────────────────────────

const riseParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const riseChild: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();

  if (reduce) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────────

function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1200px] px-6 sm:px-8 ${className}`}>{children}</div>;
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs font-medium tracking-[0.04em] text-primary">
      <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
      {children}
    </span>
  );
}

function Display({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={`font-display font-semibold tracking-[-0.02em] text-foreground text-balance ${className}`}
    >
      {children}
    </h2>
  );
}

function PrimaryCTA({
  href,
  children,
  external = true,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 font-sans text-sm font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
    >
      {children}
    </a>
  );
}

function SecondaryCTA({
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
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-panel px-5 font-sans text-sm font-medium text-foreground no-underline shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[var(--shadow-sm)]"
    >
      {children}
    </a>
  );
}

// ── The signature: a run record that lifts off the canvas ─────────────────────

function RecordingPulse() {
  const reduce = useReducedMotion();
  return (
    <span className="relative inline-flex size-2.5 items-center justify-center" aria-hidden="true">
      {!reduce && (
        <motion.span
          className="absolute inset-0 rounded-full bg-primary"
          animate={{ scale: [1, 2.4], opacity: [0.5, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span className="relative size-2 rounded-full bg-primary" />
    </span>
  );
}

function EvidenceRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{label}</span>
      <span className="text-right font-mono text-xs text-ink-2">{children}</span>
    </div>
  );
}

function RunRecordCard() {
  const reduce = useReducedMotion();
  return (
    <div className="relative">
      {/* depth: a back panel peeking behind */}
      <div
        className="absolute -inset-x-3 -bottom-4 top-6 rounded-[1.75rem] border border-border bg-panel/60 shadow-[var(--shadow-sm)]"
        aria-hidden="true"
      />
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 24, rotateX: 6 }}
        animate={reduce ? {} : { opacity: 1, y: 0, rotateX: 0 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        className="relative overflow-hidden rounded-[1.75rem] border border-border bg-panel shadow-[var(--shadow-cobalt)]"
      >
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-5 py-4">
          <span className="inline-flex items-center gap-2.5">
            <RecordingPulse />
            <span className="font-mono text-xs text-ink-2">run · wf_482</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <span className="size-1.5 rounded-full bg-success-dot" aria-hidden="true" />
            Reviewable
          </span>
        </div>

        {/* objective */}
        <div className="px-5 pt-4">
          <p className="ev-eyebrow">Objective</p>
          <p className="mt-1.5 text-sm font-medium text-foreground">
            Fix retry handling for failed invoices
          </p>
        </div>

        {/* evidence */}
        <div className="mt-2 divide-y divide-rule-faint px-5">
          <EvidenceRow label="Repository">acme/billing · #482</EvidenceRow>
          <EvidenceRow label="Ref">main @ 8f3c20a</EvidenceRow>
          <EvidenceRow label="Tests">
            <span className="text-success">11 passed</span>
            <span className="text-faint"> · </span>
            <span className="text-danger">1 failed</span>
          </EvidenceRow>
        </div>

        {/* a diff peek — edge marks, not floods */}
        <div className="m-5 mt-3 overflow-hidden rounded-xl border border-border bg-background">
          <div className="border-b border-rule-faint px-3 py-2 font-mono text-[0.7rem] text-label">
            lib/invoice/round.ts
          </div>
          <div className="font-mono text-[0.72rem] leading-6">
            <div className="flex bg-[var(--sw-del-bg)]">
              <span className="w-0.5 shrink-0 bg-[var(--sw-del-edge)]" />
              <span className="w-5 shrink-0 text-center text-[var(--sw-del-edge)]">-</span>
              <span className="text-ink-2">return Math.round(amountMinor)</span>
            </div>
            <div className="flex bg-[var(--sw-add-bg)]">
              <span className="w-0.5 shrink-0 bg-[var(--sw-add-edge)]" />
              <span className="w-5 shrink-0 text-center text-[var(--sw-add-edge)]">+</span>
              <span className="text-ink-2">return roundHalfEven(amountMinor, scale)</span>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────────

function Hero() {
  const reduce = useReducedMotion();
  const parentMotion = reduce
    ? {}
    : { variants: riseParent, initial: "hidden" as const, animate: "show" as const };
  const childMotion = reduce ? {} : { variants: riseChild };
  return (
    <section className="relative overflow-hidden bg-[var(--sw-canvas)]">
      {/* soft cobalt glow + faint grid, very low contrast */}
      <div
        className="pointer-events-none absolute -top-40 right-[-10%] size-[42rem] rounded-full bg-[radial-gradient(circle,rgba(32,82,204,0.16),transparent_62%)] blur-2xl"
        aria-hidden="true"
      />
      <div
        className="sealant-dot-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_30%_20%,black,transparent_70%)]"
        aria-hidden="true"
      />
      <Container className="relative grid items-center gap-14 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-28">
        <motion.div {...parentMotion}>
          <motion.div {...childMotion}>
            <Eyebrow>The secure run layer for AI software work</Eyebrow>
          </motion.div>
          <motion.h1
            {...childMotion}
            className="mt-6 font-display text-[2.9rem] leading-[1.02] font-semibold tracking-[-0.03em] text-foreground text-balance sm:text-6xl lg:text-[4.1rem]"
          >
            Every AI run, a record
            <br />
            you can <span className="text-primary">actually trust</span>.
          </motion.h1>
          <motion.p
            {...childMotion}
            className="mt-6 max-w-[46ch] text-lg leading-relaxed text-muted-foreground"
          >
            Sealant runs repositories, issues, and agent tasks inside isolated sandboxes, records
            exactly what happened from inside the runtime, and turns every run into a fast,
            evidence-backed review.
          </motion.p>
          <motion.div
            {...childMotion}
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <PrimaryCTA href={REPO_URL}>
              Run an issue
              <ArrowUpRight
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
            </PrimaryCTA>
            <SecondaryCTA href="#review">
              See a run record
              <ArrowRight className="size-4" aria-hidden="true" />
            </SecondaryCTA>
          </motion.div>
          <motion.p
            {...childMotion}
            className="mt-8 font-mono text-xs text-faint"
          >
            Open source · self-hostable · GitHub-native
          </motion.p>
        </motion.div>

        <RunRecordCard />
      </Container>
    </section>
  );
}

// ── Problem ───────────────────────────────────────────────────────────────────

const painPoints: ReadonlyArray<{ readonly title: string; readonly body: string }> = [
  {
    title: "Agents need disposable environments",
    body: "Running an agent on a laptop hands it your files, your secrets, and your network. Runs need a controlled place that can be torn down after.",
  },
  {
    title: "Runs must be reproducible",
    body: "A diff without its environment is a guess. Reviewers need the exact repo ref, tooling, and policy a run used.",
  },
  {
    title: "PRs need evidence, not summaries",
    body: "A reviewer gets a diff and a blurb — but not what commands ran, what changed, what failed, or what access the agent had.",
  },
  {
    title: "Work starts from anywhere",
    body: "Issues arrive in GitHub, Linear, Slack, or your phone. Waiting to be at a laptop to kick off a run slows the whole loop.",
  },
];

function Problem() {
  return (
    <section id="problem" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <Reveal className="max-w-[58ch]">
          <Eyebrow>The problem</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            AI can write the code. Teams still have to trust the work.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            AI coding agents are powerful, but their work is often invisible. A reviewer sees a
            diff and a summary — not the environment it ran in, the commands it executed, what
            changed, what failed, and what access it had.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {painPoints.map((point, index) => (
            <Reveal key={point.title} delay={(index % 2) * 0.06}>
              <motion.div
                whileHover={{ y: -4 }}
                transition={{ duration: 0.2 }}
                className="h-full rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)] transition-shadow duration-200 hover:shadow-[var(--shadow-md)]"
              >
                <span className="font-mono text-sm text-faint">{`0${index + 1}`}</span>
                <h3 className="mt-4 text-lg font-semibold tracking-[-0.01em] text-foreground">
                  {point.title}
                </h3>
                <p className="mt-2.5 leading-relaxed text-muted-foreground">{point.body}</p>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}

// ── Core product: the pipeline ─────────────────────────────────────────────────

const pipelineStages: ReadonlyArray<{
  readonly step: string;
  readonly label: string;
  readonly items: ReadonlyArray<string>;
}> = [
  { step: "01", label: "Trigger", items: ["issue", "repo", "PR", "SDK", "phone"] },
  { step: "02", label: "Policy", items: ["secrets", "network", "tools", "approvals"] },
  { step: "03", label: "Sandbox", items: ["isolated runtime"] },
  { step: "04", label: "Recorder", items: ["commands", "processes", "files", "events"] },
  { step: "05", label: "Validation", items: ["tests", "lint", "typecheck", "checks"] },
  { step: "06", label: "Review", items: ["summary", "diff", "evidence"] },
];

function CoreProduct() {
  return (
    <section id="product" className="bg-panel py-24 lg:py-32">
      <Container>
        <Reveal className="max-w-[56ch]">
          <Eyebrow>The core product</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            Every run gets a sandbox and a recorder.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            A run starts from a repo, issue, PR, SDK call, or phone. Sealant launches an isolated
            sandbox, runs the human or AI workflow, and records the execution from inside the
            runtime.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pipelineStages.map((stage, index) => (
            <Reveal key={stage.step} delay={(index % 3) * 0.05}>
              <motion.div
                whileHover={{ y: -4 }}
                transition={{ duration: 0.2 }}
                className="group h-full rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)] transition-shadow duration-200 hover:shadow-[var(--shadow-md)]"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-primary">{stage.step}</span>
                  <span className="text-base font-semibold tracking-[-0.01em] text-foreground">
                    {stage.label}
                  </span>
                </div>
                <ul className="mt-4 flex flex-wrap gap-1.5">
                  {stage.items.map((item) => (
                    <li
                      key={item}
                      className="rounded-lg bg-muted px-2.5 py-1 font-mono text-[0.7rem] text-muted-foreground"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </motion.div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.1} className="mt-8">
          <p className="font-mono text-xs text-faint">
            Trigger&nbsp;→&nbsp;Policy&nbsp;→&nbsp;Sandbox&nbsp;→&nbsp;Recorder&nbsp;→&nbsp;Validation&nbsp;→&nbsp;Reviewable&nbsp;PR
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Security ────────────────────────────────────────────────────────────────

const securityCaps: ReadonlyArray<{
  readonly icon: typeof Shield;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    icon: Shield,
    label: "Disposable sandboxes",
    detail: "Each run gets a fresh runtime, torn down when the run ends. Nothing persists by default.",
  },
  {
    icon: Key,
    label: "Scoped repository access",
    detail: "A run sees only the repo and ref it was given. Access is resolved per run, not inherited.",
  },
  {
    icon: Lock,
    label: "Scoped secrets and SSH keys",
    detail: "Secrets are injected per run and scoped to the policy. They never live in the image.",
  },
  {
    icon: Network,
    label: "Network and runtime policy",
    detail: "Restrict outbound network, pick the isolation level, and bound what a run can do.",
  },
  {
    icon: Eye,
    label: "Per-run environment records",
    detail: "Every run records the environment it ran in: tooling, harness, policy, and runtime config.",
  },
  {
    icon: Lock,
    label: "Approval gates for risky actions",
    detail: "Hold a run for a human decision before risky changes, secret access, or PR creation.",
  },
];

function Security() {
  return (
    <section id="security" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <Reveal className="max-w-[56ch]">
          <Eyebrow>Security</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            Agents run with boundaries.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Sealant gives AI coding work a controlled place to execute. Each run can be isolated,
            scoped, observed, and shut down — without depending on a developer machine.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {securityCaps.map((cap, index) => {
            const Icon = cap.icon;
            return (
              <Reveal key={cap.label} delay={(index % 3) * 0.05}>
                <motion.div
                  whileHover={{ y: -4 }}
                  transition={{ duration: 0.2 }}
                  className="h-full rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)] transition-shadow duration-200 hover:shadow-[var(--shadow-md)]"
                >
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--sw-wash)] text-primary">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-base font-semibold tracking-[-0.01em] text-foreground">
                    {cap.label}
                  </h3>
                  <p className="mt-2 leading-relaxed text-muted-foreground">{cap.detail}</p>
                </motion.div>
              </Reveal>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

// ── Reproducibility ────────────────────────────────────────────────────────────

const fingerprint: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "Repository", value: "acme/billing" },
  { label: "Ref", value: "main @ 8f3c20a" },
  { label: "Sandbox image", value: "sha256:c1d9…" },
  { label: "Harness", value: "Codex / Claude Code / OpenCode" },
  { label: "Runtime", value: "Docker / Kubernetes" },
  { label: "Policy", value: "restricted network, scoped secrets" },
  { label: "Validation", value: "12 checks · 11 passed · 1 warning" },
];

function Reproducibility() {
  return (
    <section id="reproducibility" className="bg-panel py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Reproducibility</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            A run is a real artifact, not a chat transcript.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Sealant captures the inputs that matter: repo ref, issue context, environment profile,
            packages, runtime, harness, commands, logs, artifacts, validation, and final diff.
          </p>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            So teams can rerun, resume, compare, debug, and explain software work.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="overflow-hidden rounded-3xl border border-border bg-background shadow-[var(--shadow-md)]">
            <div className="flex items-center gap-2.5 border-b border-rule-faint px-6 py-4">
              <CircleDot className="size-4 text-primary" aria-hidden="true" />
              <span className="font-mono text-xs text-label">Run fingerprint</span>
            </div>
            <dl className="divide-y divide-rule-faint px-6">
              {fingerprint.map((row) => (
                <div key={row.label} className="grid grid-cols-[8rem_1fr] gap-3 py-3.5">
                  <dt className="font-mono text-[0.7rem] tracking-[0.02em] text-label">
                    {row.label}
                  </dt>
                  <dd className="font-mono text-xs leading-relaxed text-ink-2">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── PR review ─────────────────────────────────────────────────────────────────

const reviewRows: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }> = [
  { label: "Objective", value: "Fix retry handling for failed invoices" },
  { label: "Commands", value: "pnpm test · pnpm typecheck · pnpm lint" },
  { label: "Files changed", value: "3 files, grouped by intent" },
  {
    label: "Tests",
    value: (
      <span>
        <span className="text-success">11 passed</span>
        <span className="text-faint"> · </span>
        <span className="text-danger">1 failed</span>
        <span className="text-faint"> · 0 skipped</span>
      </span>
    ),
  },
  { label: "Agent notes", value: "Assumptions and uncertainties recorded by the agent" },
  { label: "Evidence", value: "Raw logs and runtime events, kept" },
];

function PrReview() {
  return (
    <section id="review" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>PR review</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            Review the run before you review the diff.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Sealant compresses review by showing what happened during the run: the objective, the
            commands, test results, file changes, risky areas, and validation status — in plain
            language, next to the evidence.
          </p>
          <div className="mt-8">
            <PrimaryCTA href={REPO_URL}>
              Open a run record
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </PrimaryCTA>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="overflow-hidden rounded-3xl border border-border bg-panel shadow-[var(--shadow-lg)]">
            <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-6 py-4">
              <span className="inline-flex items-center gap-2.5">
                <RecordingPulse />
                <span className="font-mono text-xs text-ink-2">run record · wf_482</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                <Check className="size-3.5" aria-hidden="true" />
                Reviewable
              </span>
            </div>
            <dl className="divide-y divide-rule-faint px-6">
              {reviewRows.map((row) => (
                <div key={row.label} className="grid grid-cols-[7.5rem_1fr] gap-3 py-3.5">
                  <dt className="font-mono text-[0.7rem] tracking-[0.02em] text-label">
                    {row.label}
                  </dt>
                  <dd className="text-sm leading-relaxed text-ink-2">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Run from anywhere ───────────────────────────────────────────────────────────

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
    <section id="anywhere" className="bg-panel py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Run from anywhere</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            Start work wherever the issue finds you.
          </Display>
          <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-muted-foreground">
            Kick off a sandbox or issue workflow from the web app, GitHub, Slack, Linear, the CLI,
            the SDK, or your phone. The run happens in Sealant infrastructure — not on your laptop.
          </p>
          <ul className="mt-7 flex flex-wrap gap-2">
            {["Web app", "GitHub", "Slack", "Linear", "CLI", "SDK", "Phone"].map((source) => (
              <li
                key={source}
                className="rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-xs text-muted-foreground"
              >
                {source}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mx-auto w-[17rem] rounded-[2.25rem] border border-border bg-background p-3 shadow-[var(--shadow-lg)]">
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-muted" aria-hidden="true" />
            <div className="space-y-2.5">
              {phoneNotifications.map((n) => {
                const Icon = n.icon;
                return (
                  <div
                    key={n.title}
                    className="rounded-2xl border border-rule-faint bg-panel px-4 py-3 shadow-[var(--shadow-xs)]"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
                        <Icon className="size-3.5" aria-hidden="true" />
                      </span>
                      <span className="text-xs font-medium text-foreground">{n.title}</span>
                    </div>
                    <p className="mt-1.5 pl-9 font-mono text-[0.7rem] text-muted-foreground">
                      {n.detail}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── SDK ─────────────────────────────────────────────────────────────────────

const sdkModules: ReadonlyArray<{
  readonly name: string;
  readonly icon: typeof Code2;
  readonly methods: ReadonlyArray<string>;
}> = [
  { name: "Sandboxes", icon: Layers, methods: ["create", "connect", "inspect", "stop"] },
  { name: "Issue Workflows", icon: GitPullRequest, methods: ["run", "observe", "validate", "report"] },
  { name: "Runtime Events", icon: Terminal, methods: ["commands", "output", "artifacts"] },
  { name: "Policies", icon: Shield, methods: ["secrets", "network", "approvals"] },
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
    <section id="sdk" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <Reveal className="max-w-[56ch]">
          <Eyebrow>SDK & platform</Eyebrow>
          <Display className="mt-5 text-[2.1rem] leading-[1.06] sm:text-4xl lg:text-5xl">
            Build your own workflows on the run layer.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Sealant exposes sandboxes, issue workflows, runtime events, profiles, policies, and
            harnesses as programmable modules.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-6 lg:grid-cols-[1fr_1fr] lg:gap-10">
          <Reveal className="grid gap-4 sm:grid-cols-2">
            {sdkModules.map((module) => {
              const Icon = module.icon;
              return (
                <motion.div
                  key={module.name}
                  whileHover={{ y: -4 }}
                  transition={{ duration: 0.2 }}
                  className="rounded-2xl border border-border bg-panel p-5 shadow-[var(--shadow-sm)] transition-shadow duration-200 hover:shadow-[var(--shadow-md)]"
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="size-4 text-primary" aria-hidden="true" />
                    <span className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                      {module.name}
                    </span>
                  </div>
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {module.methods.map((method) => (
                      <li
                        key={method}
                        className="rounded-md bg-muted px-2 py-0.5 font-mono text-[0.68rem] text-muted-foreground"
                      >
                        {method}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              );
            })}
          </Reveal>

          <Reveal delay={0.08}>
            <div className="overflow-hidden rounded-3xl border border-border bg-[#1c1c1f] shadow-[var(--shadow-lg)]">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                <span className="font-mono text-xs text-white/55">sealant.ts</span>
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-primary/70" />
                </div>
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.8rem] leading-[1.85]">
                <code>
                  {SDK_CODE_LINES.map((line, index) => (
                    <span key={index} className="block text-[#e6e6ea]">
                      {line.length === 0 ? " " : line}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section id="opensource" className="bg-panel py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="relative overflow-hidden rounded-[2.25rem] border border-border bg-[var(--sw-canvas)] px-8 py-16 text-center shadow-[var(--shadow-md)] sm:px-12 lg:py-24">
            <div
              className="pointer-events-none absolute inset-x-0 top-[-30%] mx-auto h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(32,82,204,0.14),transparent_60%)] blur-2xl"
              aria-hidden="true"
            />
            <div className="relative">
              <Display className="mx-auto max-w-[20ch] text-[2.3rem] leading-[1.05] sm:text-5xl lg:text-[3.5rem]">
                Give AI coding work a place to run and a record to trust.
              </Display>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <PrimaryCTA href={REPO_URL}>
                  Run an issue
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </PrimaryCTA>
                <SecondaryCTA href={REPO_URL} external>
                  <GitHubLogo className="size-4" />
                  Read the docs
                </SecondaryCTA>
              </div>
            </div>
          </div>
        </Reveal>
      </Container>
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
      <FinalCta />
    </main>
  );
}
