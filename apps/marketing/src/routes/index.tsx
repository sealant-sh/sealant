import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Bug,
  Check,
  Cloud,
  Code2,
  Cpu,
  Database,
  Eye,
  Gauge,
  GitPullRequest,
  KeyRound,
  Laptop,
  Layers,
  ListTree,
  Lock,
  Network,
  Radio,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import { type ComponentType, type ReactNode } from "react";

import { GitHubLogo } from "#/components/github";

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

const REPO_URL = "https://github.com/get-sealant/sealant";
const DOCS_URL = "https://github.com/get-sealant/sealant";

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
  if (reduce) return <div className={className}>{children}</div>;
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

function SectionHead({
  eyebrow,
  title,
  intro,
  className = "max-w-[58ch]",
}: {
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  className?: string;
}) {
  return (
    <Reveal className={className}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-5xl">{title}</Display>
      {intro ? (
        <div className="mt-5 space-y-4 text-lg leading-relaxed text-muted-foreground">{intro}</div>
      ) : null}
    </Reveal>
  );
}

function PrimaryCTA({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
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

// Elevated mono "evidence" panel chrome.
function MonoPanel({
  label,
  right,
  children,
  className = "",
  lift = false,
}: {
  label: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  lift?: boolean;
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-3xl border border-border bg-panel ${
        lift ? "shadow-[var(--shadow-cobalt)]" : "shadow-[var(--shadow-md)]"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-5 py-3.5">
        <span className="font-mono text-xs tracking-[0.02em] text-label">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function MonoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-3">
      <span className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{label}</span>
      <span className="min-w-0 font-mono text-xs leading-relaxed break-words text-ink-2">
        {children}
      </span>
    </div>
  );
}

// ── Hero code panel — SDK + event capture (the signature) ─────────────────────

const HERO_CODE: ReadonlyArray<{ readonly t: string; readonly tone?: "comment" | "accent" }> = [
  { t: "// run an agent in a sandbox, record the execution", tone: "comment" },
  { t: "const sandbox = await sdk.sandboxes.create({ repository, harness })" },
  { t: "" },
  { t: "const execution = await sdk.executions.start({" },
  { t: "  sandboxId: sandbox.id," },
  { t: "  objective: `Resolve issue #${issue.number} and open a PR`," },
  { t: "})" },
  { t: "" },
  { t: "const task = await sdk.harnesses.runTask({ sandboxId: sandbox.id, harness })" },
  { t: "" },
  { t: "// every action becomes a structured, replayable event", tone: "comment" },
  { t: "for (const command of task.commands) await execution.command(command)" },
  { t: "for (const change of task.fileChanges) await execution.fileChange(change)" },
  { t: "for (const check of task.validations) await execution.validation(check)" },
  { t: "" },
  { t: 'await execution.complete({ outcome: "succeeded" })' },
  { t: "const analysis = await sdk.executions.analyze(execution.id)", tone: "accent" },
];

const HERO_EVENTS: ReadonlyArray<{ readonly k: string; readonly v: string; readonly dot: string }> =
  [
    { k: "command", v: "pnpm test checkout", dot: "bg-faint" },
    { k: "file.change", v: "src/checkout.ts", dot: "bg-warning-dot" },
    { k: "validation", v: "typecheck · passed", dot: "bg-success-dot" },
  ];

function HeroCode() {
  const reduce = useReducedMotion();
  return (
    <div className="relative">
      <div
        className="absolute -inset-x-3 -bottom-4 top-6 rounded-[1.75rem] border border-border bg-panel/60 shadow-[var(--shadow-sm)]"
        aria-hidden="true"
      />
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 24 }}
        animate={reduce ? {} : { opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        className="relative min-w-0 overflow-hidden rounded-[1.75rem] border border-border bg-[#1c1c1f] shadow-[var(--shadow-cobalt)]"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <span className="font-mono text-xs text-white/55">issue-to-pr.ts</span>
          <span className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-primary/70" />
          </span>
        </div>

        <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.78rem] leading-[1.75]">
          <code>
            {HERO_CODE.map((line, i) => (
              <span
                key={i}
                className={`block ${
                  line.tone === "comment"
                    ? "text-white/40"
                    : line.tone === "accent"
                      ? "text-[#9db4f0]"
                      : "text-[#e6e6ea]"
                }`}
              >
                {line.t.length === 0 ? " " : line.t}
              </span>
            ))}
          </code>
        </pre>

        <div className="border-t border-white/10 px-5 py-4">
          <p className="font-mono text-[0.62rem] tracking-[0.1em] text-white/40 uppercase">
            Execution record
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {HERO_EVENTS.map((e) => (
              <li key={e.k} className="flex items-center gap-3 font-mono text-xs">
                <span className={`size-1.5 shrink-0 rounded-full ${e.dot}`} aria-hidden="true" />
                <span className="text-[#9db4f0]">{e.k}</span>
                <span className="ml-auto truncate pl-3 text-white/45">{e.v}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-2 border-t border-white/10 px-5 py-3">
          <Activity className="size-3.5 text-primary" aria-hidden="true" />
          <span className="font-mono text-xs text-white/55">Replayable · analyzable · summarizable</span>
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
      <div
        className="pointer-events-none absolute -top-40 right-[-10%] size-[42rem] rounded-full bg-[radial-gradient(circle,rgba(32,82,204,0.16),transparent_62%)] blur-2xl"
        aria-hidden="true"
      />
      <div
        className="sealant-dot-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_30%_20%,black,transparent_70%)]"
        aria-hidden="true"
      />
      <Container className="relative grid min-h-[calc(100svh-4rem)] items-center gap-12 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
        <motion.div className="min-w-0" {...parentMotion}>
          <motion.div {...childMotion}>
            <Eyebrow>Record, replay &amp; analyze agent executions</Eyebrow>
          </motion.div>
          <motion.h1
            {...childMotion}
            className="mt-6 font-display text-[2.6rem] leading-[1.04] font-semibold tracking-[-0.03em] text-foreground text-balance sm:text-5xl lg:text-[3.6rem]"
          >
            Give AI agents a real environment — and a{" "}
            <span className="text-primary">replayable record</span> of everything they do.
          </motion.h1>
          <motion.p
            {...childMotion}
            className="mt-6 max-w-[52ch] text-lg leading-relaxed text-muted-foreground"
          >
            Sealant runs the agent in a sandbox and records the execution as structured data —
            every command, tool call, file change, and validation. A complete, replayable record
            you can analyze and summarize, not a wall of logs.
          </motion.p>
          <motion.div {...childMotion} className="mt-9 flex flex-wrap items-center gap-3">
            <PrimaryCTA href={REPO_URL}>
              Start building
              <ArrowUpRight
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
            </PrimaryCTA>
            <SecondaryCTA href={DOCS_URL} external>
              Read the documentation
              <ArrowRight className="size-4" aria-hidden="true" />
            </SecondaryCTA>
          </motion.div>
          <motion.p {...childMotion} className="mt-8 font-mono text-xs text-faint">
            TypeScript SDK · Structured execution record · Replay, analyze, summarize
          </motion.p>
        </motion.div>

        <div className="min-w-0">
          <HeroCode />
          <p className="mt-5 text-center font-mono text-xs text-faint">
            Each execution is captured as a structured event stream — stream it live, replay it after.
          </p>
        </div>
      </Container>
    </section>
  );
}

// ── Problem ───────────────────────────────────────────────────────────────────

const problemCards: ReadonlyArray<{
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: Boxes,
    title: "Environment",
    body: "Give software a persistent workspace with real files, terminals, commands, and long-running services.",
  },
  {
    icon: Gauge,
    title: "Control",
    body: "Start, inspect, interrupt, and terminate work without losing track of child processes or leaving resources behind.",
  },
  {
    icon: Activity,
    title: "Record",
    body: "Capture the execution as a structured record — commands, tool calls, file changes, and validations — that you can replay, analyze, and summarize.",
  },
];

function Problem() {
  return (
    <section id="problem" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="The problem"
          title="Developer agents need more than a shell."
          intro={
            <>
              <p>
                Real engineering work crosses terminals, background servers, process trees, files,
                local services, network requests, credentials, timeouts, signals, and cleanup.
              </p>
              <p>
                Building all of that around an agent or developer tool means assembling a sandbox,
                process supervisor, terminal service, policy layer, observability system, and
                artifact store.
              </p>
              <p className="text-foreground">
                Sealant is that layer — the sandbox, the supervision, and the structured execution
                record, from one SDK.
              </p>
            </>
          }
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {problemCards.map((card, i) => {
            const Icon = card.icon;
            return (
              <Reveal key={card.title} delay={(i % 3) * 0.05}>
                <div className="h-full rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]">
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--sw-wash)] text-primary">
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold tracking-[-0.01em] text-foreground">
                    {card.title}
                  </h3>
                  <p className="mt-2.5 leading-relaxed text-muted-foreground">{card.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

// ── Core concept ────────────────────────────────────────────────────────────

const runPrimitives = [
  "Sandbox",
  "Harness",
  "Commands",
  "Files",
  "Network",
  "Tool calls",
  "Validations",
  "Record",
];

function FlowLabel({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-lg border border-border bg-panel px-4 py-2 font-mono text-xs text-ink-2 shadow-[var(--shadow-xs)]">
      {children}
    </span>
  );
}

function CoreConcept() {
  return (
    <section id="core-concept" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Core concept"
          title="Every execution runs inside a sandbox."
          intro={
            <>
              <p>
                A sandbox is an isolated dev environment built from a repository and a harness. The
                work performed inside it is captured as an execution — a structured record of every
                command, file change, and validation.
              </p>
              <p>
                Your application can stream the execution live, intervene when needed, and keep the
                record after it ends.
              </p>
            </>
          }
        />

        <Reveal delay={0.08} className="mt-14">
          <div className="flex flex-col items-center gap-3 text-center">
            <FlowLabel>Your product</FlowLabel>
            <ArrowRight className="size-4 rotate-90 text-faint" aria-hidden="true" />
            <FlowLabel>Sealant SDK or API</FlowLabel>
            <ArrowRight className="size-4 rotate-90 text-faint" aria-hidden="true" />

            <div className="w-full max-w-2xl rounded-3xl border border-border bg-background p-6 shadow-[var(--shadow-md)] sm:p-8">
              <p className="ev-eyebrow text-center">Execution · sandbox</p>
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {runPrimitives.map((p) => (
                  <span
                    key={p}
                    className="rounded-lg border border-rule-faint bg-panel px-3 py-2.5 text-center font-mono text-xs text-ink-2"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>

            <ArrowRight className="size-4 rotate-90 text-faint" aria-hidden="true" />
            <div className="flex flex-wrap justify-center gap-2">
              {["Record", "Replay", "Analysis", "Summary", "Artifacts"].map((o) => (
                <span
                  key={o}
                  className="rounded-lg bg-[var(--sw-wash)] px-3 py-1.5 font-mono text-xs text-primary"
                >
                  {o}
                </span>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.12} className="mt-12">
          <div className="mx-auto flex max-w-3xl items-start gap-4 rounded-2xl border-l-2 border-l-primary bg-background py-5 pr-6 pl-5 shadow-[var(--shadow-sm)]">
            <p className="text-base leading-relaxed text-foreground">
              Model the work as one execution with a full record — not a sequence of independent
              shell calls.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── How it works ─────────────────────────────────────────────────────────────

function HowItWorks() {
  return (
    <section id="how" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead eyebrow="How it works" title="From an objective to a replayable execution record." />

        <div className="mt-14 grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
          <Reveal className="min-w-0 space-y-10">
            <Step
              n="01"
              title="Create the environment"
              body="Start from a repository, project profile, or prepared workspace. Configure the services, access, and boundaries the work requires."
            />
            <Step
              n="02"
              title="Execute real developer work"
              body="Run commands, open interactive terminals, start background processes, provide input, and keep application services alive across multiple operations."
            />
            <Step
              n="03"
              title="Observe and control"
              body="Stream structured events while the work is happening. React to output, inspect process state, enforce timeouts, send signals, or stop the complete process group."
            />
            <Step
              n="04"
              title="Retain the result"
              body="Store logs, file changes, artifacts, and the ordered execution history. Make them available for review, debugging, comparison, or later product workflows."
            />
          </Reveal>

          <Reveal delay={0.1} className="min-w-0 lg:pt-12">
            <MonoPanel
              label="01 · example configuration"
              right={<span className="font-mono text-[0.7rem] text-faint">start-execution.ts</span>}
            >
              <div className="space-y-4 px-5 py-5">
                <MonoRow label="Repository">acme/storefront</MonoRow>
                <MonoRow label="Branch">feature/checkout-fix</MonoRow>
                <div className="border-t border-rule-faint pt-3.5">
                  <p className="ev-eyebrow">Services</p>
                  <ul className="mt-2 space-y-1.5 font-mono text-xs text-ink-2">
                    <li className="flex items-center gap-2">
                      <Check className="size-3.5 text-success" aria-hidden="true" /> PostgreSQL
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-3.5 text-success" aria-hidden="true" /> Redis
                    </li>
                  </ul>
                </div>
                <div className="border-t border-rule-faint pt-3.5">
                  <p className="ev-eyebrow">Access</p>
                  <ul className="mt-2 space-y-1.5 font-mono text-xs text-ink-2">
                    <li className="flex items-center gap-2">
                      <Check className="size-3.5 text-success" aria-hidden="true" /> GitHub
                      development app
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-3.5 text-success" aria-hidden="true" /> Stripe test
                      environment
                    </li>
                  </ul>
                </div>
                <div className="border-t border-rule-faint pt-3.5">
                  <MonoRow label="Policy">Approved network hosts only</MonoRow>
                </div>
              </div>
            </MonoPanel>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex gap-5">
      <span className="font-mono text-sm text-primary">{n}</span>
      <div className="min-w-0">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
        <p className="mt-2 leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

// ── Capabilities grid ──────────────────────────────────────────────────────────

const capabilities: ReadonlyArray<{
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: Cpu,
    title: "Process supervision",
    body: "Start foreground and background commands, track their process trees, enforce timeouts, send signals, and clean up child processes reliably.",
  },
  {
    icon: Terminal,
    title: "Interactive terminals",
    body: "Open PTY-backed sessions for tools that expect a real terminal rather than a basic command-execution endpoint.",
  },
  {
    icon: ScrollText,
    title: "Standard input and output",
    body: "Capture stdin, stdout, and stderr as structured, ordered events while retaining their original relationship to the execution.",
  },
  {
    icon: Layers,
    title: "Filesystem observation",
    body: "Watch the workspace and produce before-and-after diffs showing what the work created, modified, or removed.",
  },
  {
    icon: Network,
    title: "Network observation",
    body: "Record proxied network activity and make external interactions part of the execution history.",
  },
  {
    icon: Activity,
    title: "Structured events",
    body: "Consume process, terminal, filesystem, network, and lifecycle activity through a consistent event model.",
  },
  {
    icon: Database,
    title: "Durable history",
    body: "Persist the event log and replay a completed execution without relying on transient terminal output.",
  },
  {
    icon: KeyRound,
    title: "Secret protection",
    body: "Redact configured secret values from captured output before they become logs or artifacts.",
  },
  {
    icon: RefreshCw,
    title: "Runtime lifecycle",
    body: "Run Sealant as PID 1 in a container and manage the full lifecycle of the work inside — startup, supervision, and clean shutdown.",
  },
  {
    icon: Code2,
    title: "SDK and protocol access",
    body: "Integrate through the TypeScript SDK or build directly against the local Protobuf control protocol.",
  },
];

function Capabilities() {
  return (
    <section id="capabilities" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Capabilities"
          title="The primitives developer products repeatedly rebuild."
        />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((cap, i) => {
            const Icon = cap.icon;
            return (
              <Reveal key={cap.title} delay={(i % 3) * 0.04}>
                <div className="h-full rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
                    <Icon className="size-4.5" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold tracking-[-0.01em] text-foreground">
                    {cap.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{cap.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

// ── Differentiation ────────────────────────────────────────────────────────────

const comparison: ReadonlyArray<readonly [string, string]> = [
  ["Execute a command", "Supervise complete development workflows"],
  ["Return stdout", "Emit structured execution events"],
  ["One process per request", "Persistent processes and interactive sessions"],
  ["Ephemeral console output", "Durable logs, artifacts, and timelines"],
  ["Limited workspace visibility", "Before-and-after filesystem changes"],
  ["Caller handles cleanup", "Process-group and child cleanup"],
  ["Execution succeeds or fails", "Inspectable history of how it succeeded or failed"],
];

function Differentiation() {
  return (
    <section id="compare" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Differentiation"
          title="The sandbox is commodity. The record isn't."
          intro={
            <p>
              A sandbox gives code somewhere to run. Sealant records the execution as structured
              events you can replay and analyze.
            </p>
          }
        />

        <Reveal delay={0.08} className="mt-12">
          <div className="overflow-hidden rounded-3xl border border-border bg-panel shadow-[var(--shadow-md)]">
            <div className="hidden grid-cols-2 border-b border-rule-faint sm:grid">
              <div className="px-6 py-4">
                <p className="ev-eyebrow">Basic command sandbox</p>
              </div>
              <div className="border-l border-rule-faint bg-[var(--sw-wash)] px-6 py-4">
                <p className="font-mono text-xs font-medium tracking-[0.04em] text-primary uppercase">
                  Sealant
                </p>
              </div>
            </div>
            <div className="divide-y divide-rule-faint">
              {comparison.map(([basic, sealant]) => (
                <div key={sealant} className="grid sm:grid-cols-2">
                  <div className="flex items-start gap-2.5 px-6 py-4 max-sm:pb-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                    <span className="text-sm text-muted-foreground">{basic}</span>
                  </div>
                  <div className="flex items-start gap-2.5 px-6 py-4 max-sm:pt-0 sm:border-l sm:border-rule-faint sm:bg-[color-mix(in_oklab,var(--sw-wash)_55%,transparent)]">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="text-sm font-medium text-foreground">{sealant}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Observability ──────────────────────────────────────────────────────────────

const timeline: ReadonlyArray<readonly [string, string, "info" | "ok" | "net" | "file"]> = [
  ["00:00.000", "Execution started", "info"],
  ["00:00.184", "Workspace ready", "info"],
  ["00:01.102", "Process started: pnpm install", "info"],
  ["00:14.638", "Process exited: status 0", "ok"],
  ["00:15.021", "Process started: pnpm dev", "info"],
  ["00:16.412", "Port 3000 available", "ok"],
  ["00:18.705", "File modified: src/checkout.ts", "file"],
  ["00:20.018", "Process started: pnpm test checkout", "info"],
  ["00:24.322", "Network request: api.stripe.test", "net"],
  ["00:28.119", "Test suite passed", "ok"],
  ["00:29.406", "Execution completed", "ok"],
];

const obsTabs = ["Timeline", "Processes", "Terminal", "Files", "Network", "Artifacts"];

function Observability() {
  return (
    <section id="observability" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Observability"
          title="Every execution is one ordered timeline."
          intro={
            <p>
              Sealant turns low-level execution activity into structured, ordered events. Your
              product can present the right level of detail — from a one-line summary to the full
              event-by-event record.
            </p>
          }
        />

        <Reveal delay={0.08} className="mt-12">
          <div className="overflow-hidden rounded-3xl border border-border bg-background shadow-[var(--shadow-md)]">
            <div className="flex gap-1 overflow-x-auto border-b border-rule-faint px-3 py-2.5">
              {obsTabs.map((tab, i) => (
                <span
                  key={tab}
                  className={`shrink-0 rounded-lg px-3 py-1.5 font-mono text-xs ${
                    i === 0
                      ? "bg-[var(--sw-wash)] text-primary"
                      : "text-muted-foreground"
                  }`}
                >
                  {tab}
                </span>
              ))}
            </div>
            <div className="overflow-x-auto px-5 py-5">
              <ul className="min-w-[26rem] space-y-2">
                {timeline.map(([t, label, kind]) => (
                  <li key={t + label} className="flex items-center gap-4 font-mono text-xs">
                    <span className="shrink-0 text-faint tabular-nums">{t}</span>
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        kind === "ok"
                          ? "bg-success-dot"
                          : kind === "net"
                            ? "bg-primary"
                            : kind === "file"
                              ? "bg-warning-dot"
                              : "bg-faint"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="text-ink-2">{label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>

      </Container>
    </section>
  );
}

// ── Policy & access ────────────────────────────────────────────────────────────

const policyNow: ReadonlyArray<{
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: KeyRound,
    title: "Governed secrets",
    body: "Expose approved credentials through controlled references and redact configured values from captured output.",
  },
  {
    icon: Network,
    title: "Network boundaries",
    body: "Control which external services an execution may contact, and record the requests it makes.",
  },
  {
    icon: Lock,
    title: "Filesystem boundaries",
    body: "Restrict the locations a workflow may read or modify.",
  },
  {
    icon: ListTree,
    title: "Recorded in the execution",
    body: "Keep the actions performed, policies applied, and exceptions granted as part of the execution record.",
  },
];

function PolicyAccess() {
  return (
    <section id="policy" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Policy & access"
          title="Scoped access and redacted secrets — not raw credentials."
          intro={
            <p>
              Define the environment's permitted resources before execution begins. Provide approved
              service access while keeping secret values out of prompts, logs, and generated
              artifacts.
            </p>
          }
        />

        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {policyNow.map((cap, i) => {
            const Icon = cap.icon;
            return (
              <Reveal key={cap.title} delay={(i % 2) * 0.05}>
                <div className="flex h-full gap-4 rounded-2xl border border-border bg-panel p-6 shadow-[var(--shadow-sm)]">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
                    <Icon className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold tracking-[-0.01em] text-foreground">
                      {cap.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{cap.body}</p>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={0.1} className="mt-10">
          <div className="rounded-2xl border border-dashed border-border bg-panel/60 p-6">
            <p className="ev-eyebrow">Coming to the managed platform</p>
            <h3 className="mt-2 text-base font-semibold tracking-[-0.01em] text-foreground">
              Action policies
            </h3>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Require approval before sensitive commands, dependency changes, or other high-risk
              operations — with the decision retained in the execution record.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Build with Sealant (use cases) ──────────────────────────────────────────────

const useCases: ReadonlyArray<{
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: Terminal,
    title: "Coding agents",
    body: "Give an agent terminals, processes, files, networked development services, and a complete history of its work.",
  },
  {
    icon: ShieldCheck,
    title: "Autonomous QA",
    body: "Start the application, exercise it with development tools, connect user actions to server behavior, and retain reviewable evidence.",
  },
  {
    icon: Bug,
    title: "Bug reproduction",
    body: "Recreate reported conditions, execute exact commands, collect artifacts, and package the failure as a rerunnable case.",
  },
  {
    icon: RefreshCw,
    title: "CI debugging",
    body: "Preserve failed execution state, inspect what changed, rerun selected commands, and compare successful and failed executions.",
  },
  {
    icon: Workflow,
    title: "Internal developer automation",
    body: "Safely automate migrations, repository maintenance, dependency updates, release preparation, and other environment-dependent workflows.",
  },
];

function BuildWith() {
  return (
    <section id="use-cases" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Build with Sealant"
          title="What teams build on Sealant."
        />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map((uc, i) => {
            const Icon = uc.icon;
            return (
              <Reveal key={uc.title} delay={(i % 3) * 0.04}>
                <div className="h-full rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
                    <Icon className="size-4.5" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold tracking-[-0.01em] text-foreground">
                    {uc.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{uc.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

// ── Product family ──────────────────────────────────────────────────────────────

const products: ReadonlyArray<{
  readonly name: string;
  readonly body: string;
  readonly cta: string;
}> = [
  {
    name: "Sealant Verify",
    body: "Exercise expected behavior in the real application and turn a successful flow into reviewable proof and a reusable test.",
    cta: "Explore Verify",
  },
  {
    name: "Sealant Repro",
    body: "Turn bug reports and failed executions into executable cases another developer can immediately rerun.",
    cta: "Explore Repro",
  },
  {
    name: "Sealant Handoff",
    body: "Delegate engineering work and receive a tested change plus the execution record showing how it was made.",
    cta: "Explore Handoff",
  },
];

function ProductFamily() {
  return (
    <section id="products" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Product family"
          title="Products we built on Sealant."
          intro={
            <p>Verify, Repro, and Handoff are built on the same SDK you would use.</p>
          }
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {products.map((p, i) => (
            <Reveal key={p.name} delay={(i % 3) * 0.05}>
              <div className="flex h-full flex-col rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]">
                <h3 className="font-display text-xl font-semibold tracking-[-0.01em] text-foreground">
                  {p.name}
                </h3>
                <p className="mt-3 grow leading-relaxed text-muted-foreground">{p.body}</p>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 inline-flex items-center gap-1.5 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
                >
                  {p.cta}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.12} className="mt-10">
          <div className="rounded-2xl border-l-2 border-l-primary bg-panel py-5 pr-6 pl-5 shadow-[var(--shadow-sm)]">
            <p className="text-base leading-relaxed text-foreground">
              Each is a Sealant module — a packaged workflow. The SDK gives you the primitives to
              build your own.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Integration ──────────────────────────────────────────────────────────────

const integrations: ReadonlyArray<{
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: Code2,
    title: "TypeScript SDK",
    body: "Create sandboxes and executions, control processes, open terminal sessions, consume events, and retrieve artifacts from a TypeScript application.",
  },
  {
    icon: Terminal,
    title: "Local Protobuf protocol",
    body: "Drive the runtime directly from another language over its Protobuf-based control protocol. Schema is internal for now.",
  },
  {
    icon: Activity,
    title: "Event consumers",
    body: "Stream execution activity into your own interface, database, policy engine, or observability system.",
  },
  {
    icon: GitPullRequest,
    title: "Artifact integrations",
    body: "Attach execution results to pull requests, issues, support tickets, test reports, or internal developer portals.",
  },
];

const SDK_CODE_LINES: ReadonlyArray<string> = [
  "export const issueToPr: SealantModule = {",
  '  key: "issue-to-pr",',
  "",
  "  async run({ sdk }, input) {",
  "    const sandbox = await sdk.sandboxes.create({",
  "      repository: input.repository,",
  "      harness: input.harness,",
  "    });",
  "",
  "    const execution = await sdk.executions.start({",
  "      sandboxId: sandbox.id,",
  "      objective: `Resolve issue #${input.issue.number} and open a PR`,",
  "    });",
  "",
  "    const task = await sdk.harnesses.runTask({",
  "      sandboxId: sandbox.id,",
  "      harness: input.harness.id,",
  "    });",
  "",
  "    // record every action as a structured execution event",
  "    for (const command of task.commands) await execution.command(command);",
  "    for (const change of task.fileChanges) await execution.fileChange(change);",
  "    for (const check of task.validations) await execution.validation(check);",
  "",
  '    await execution.complete({ outcome: task.pullRequestUrl ? "succeeded" : "partial" });',
  "",
  "    const analysis = await sdk.executions.analyze(execution.id);",
  "    const summary = await sdk.llms.summarizeExecution({ analysis, audience: \"user\" });",
  "",
  "    return { executionId: execution.id, analysis, summary, pr: task.pullRequestUrl };",
  "  },",
  "};",
];

function Integration() {
  return (
    <section id="integration" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead eyebrow="Integration" title="Integrate at the level your product needs." />
        <div className="mt-14 grid gap-6 lg:grid-cols-[1fr_1fr] lg:gap-10">
          <Reveal className="grid min-w-0 gap-4 sm:grid-cols-2">
            {integrations.map((it) => {
              const Icon = it.icon;
              return (
                <div
                  key={it.title}
                  className="rounded-2xl border border-border bg-background p-5 shadow-[var(--shadow-xs)]"
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="size-4 text-primary" aria-hidden="true" />
                    <span className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                      {it.title}
                    </span>
                  </div>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{it.body}</p>
                </div>
              );
            })}
          </Reveal>

          <Reveal delay={0.08} className="min-w-0">
            <div className="overflow-hidden rounded-3xl border border-border bg-[#1c1c1f] shadow-[var(--shadow-lg)]">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                <span className="font-mono text-xs text-white/55">modules/issue-to-pr.ts</span>
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-primary/70" />
                </div>
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.8rem] leading-[1.8]">
                <code>
                  {SDK_CODE_LINES.map((line, index) => (
                    <span key={index} className="block text-[#e6e6ea]">
                      {line.length === 0 ? " " : line}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
            <p className="mt-4 font-mono text-xs text-faint">
              Illustrative module — the SDK surface is still in design.
            </p>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

// ── Local & managed ────────────────────────────────────────────────────────────

function Deployment() {
  return (
    <section id="deploy" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Local &amp; self-managed"
          title="The same SDK and execution record, local or self-hosted."
        />

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          <Reveal>
            <div className="h-full rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)]">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--sw-wash)] text-primary">
                <Laptop className="size-5" />
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-[-0.01em] text-foreground">
                Local runtime
              </h3>
              <p className="mt-2.5 leading-relaxed text-muted-foreground">
                Develop against Sealant on your own machine or inside an environment you control.
                Keep source code and development services inside your infrastructure.
              </p>
            </div>
          </Reveal>

          <Reveal delay={0.05}>
            <div className="h-full rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)]">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--sw-wash)] text-primary">
                <Server className="size-5" />
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-[-0.01em] text-foreground">
                Self-managed environments
              </h3>
              <p className="mt-2.5 leading-relaxed text-muted-foreground">
                Place the runtime inside your existing container or workspace system while retaining
                the Sealant control and event model.
              </p>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="flex h-full flex-col rounded-2xl border border-dashed border-border bg-panel/60 p-7">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Cloud className="size-5" />
              </span>
              <p className="ev-eyebrow mt-5">Managed platform — coming later</p>
              <p className="mt-2.5 grow leading-relaxed text-muted-foreground">
                Join the design program for managed workspaces, durable artifacts, concurrency, and
                team controls.
              </p>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-5 inline-flex items-center gap-1.5 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
              >
                Join the platform program
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.12} className="mt-10">
          <p className="text-base text-muted-foreground">
            Build locally; the same model runs self-hosted — no rewrite.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Project context ────────────────────────────────────────────────────────────

function ProjectContext() {
  return (
    <section id="context" className="bg-panel py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-16">
        <Reveal className="min-w-0">
          <Eyebrow>Project context</Eyebrow>
          <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-5xl">
            Reuse project setup across executions.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Associate repositories with reusable setup, services, verification commands, conventions,
            and approved access. New executions begin from established project knowledge instead of
            rediscovering the environment each time.
          </p>
          <p className="mt-4 leading-relaxed text-muted-foreground">
            Project context stays explicit, versioned, and reviewable — a file in the repo, not a
            hidden memory store.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="min-w-0">
          <MonoPanel
            label="project profile"
            right={<span className="font-mono text-[0.7rem] text-faint">acme/storefront</span>}
          >
            <div className="space-y-4 px-5 py-5">
              <div>
                <p className="ev-eyebrow">Setup</p>
                <ul className="mt-2 space-y-1 font-mono text-xs text-ink-2">
                  <li>pnpm install</li>
                  <li>pnpm db:migrate</li>
                </ul>
              </div>
              <div className="border-t border-rule-faint pt-3.5">
                <MonoRow label="Services">PostgreSQL · Redis</MonoRow>
                <MonoRow label="Checks">Lint · Typecheck · Unit · E2E</MonoRow>
              </div>
              <div className="border-t border-rule-faint pt-3.5">
                <p className="ev-eyebrow">Conventions</p>
                <ul className="mt-2 space-y-1 font-mono text-xs text-ink-2">
                  <li>docs/architecture.md</li>
                  <li>docs/testing.md</li>
                </ul>
              </div>
              <div className="border-t border-rule-faint pt-3.5">
                <p className="ev-eyebrow">Approved access</p>
                <ul className="mt-2 space-y-1 font-mono text-xs text-ink-2">
                  <li>GitHub development app</li>
                  <li>Stripe test environment</li>
                </ul>
              </div>
            </div>
          </MonoPanel>
        </Reveal>
      </Container>
    </section>
  );
}

// ── Developer experience ────────────────────────────────────────────────────────

const dxPoints: ReadonlyArray<{
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly body: string;
}> = [
  {
    icon: Cpu,
    title: "Machine-readable by default",
    body: "Execution activity is emitted as structured events rather than only human-formatted terminal text.",
  },
  {
    icon: Eye,
    title: "Human-inspectable when needed",
    body: "The same data can power timelines, terminal playback, change summaries, debugging interfaces, and audit views.",
  },
  {
    icon: Radio,
    title: "Independent of the agent",
    body: "Keep the environment, policies, and execution record stable even as models and agent frameworks change.",
  },
];

function DeveloperExperience() {
  return (
    <section id="dx" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Developer experience"
          title="Structured data first, human views on top."
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {dxPoints.map((d, i) => {
            const Icon = d.icon;
            return (
              <Reveal key={d.title} delay={(i % 3) * 0.05}>
                <div className="h-full rounded-2xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)]">
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--sw-wash)] text-primary">
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mt-5 text-base font-semibold tracking-[-0.01em] text-foreground">
                    {d.title}
                  </h3>
                  <p className="mt-2 leading-relaxed text-muted-foreground">{d.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>

      </Container>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section id="cta" className="bg-panel py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="relative overflow-hidden rounded-[2.25rem] border border-border bg-[var(--sw-canvas)] px-8 py-16 text-center shadow-[var(--shadow-md)] sm:px-12 lg:py-24">
            <div
              className="pointer-events-none absolute inset-x-0 top-[-30%] mx-auto h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(32,82,204,0.14),transparent_60%)] blur-2xl"
              aria-hidden="true"
            />
            <div className="relative">
              <Eyebrow>Build on Sealant</Eyebrow>
              <Display className="mx-auto mt-5 max-w-[20ch] text-[2.1rem] leading-[1.06] sm:text-5xl lg:text-[3.25rem]">
                Start recording your agents&apos; executions.
              </Display>
              <p className="mx-auto mt-5 max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
                Run an agent in a sandbox and get a replayable, analyzable execution record —
                commands, file changes, network, and validations — from one TypeScript SDK.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <PrimaryCTA href={REPO_URL}>
                  Start building
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </PrimaryCTA>
                <SecondaryCTA href={REPO_URL} external>
                  <GitHubLogo className="size-4" />
                  View on GitHub
                </SecondaryCTA>
              </div>
              <p className="mt-7 font-mono text-xs text-faint">
                Begin with the local runtime and TypeScript SDK.
              </p>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

function MarketingPage() {
  return (
    <main className="overflow-x-clip">
      <Hero />
      <Problem />
      <CoreConcept />
      <HowItWorks />
      <Capabilities />
      <Differentiation />
      <Observability />
      <PolicyAccess />
      <BuildWith />
      <ProductFamily />
      <Integration />
      <Deployment />
      <ProjectContext />
      <DeveloperExperience />
      <FinalCta />
    </main>
  );
}
