import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  Cloud,
  Cpu,
  Database,
  FileText,
  Folder,
  GitBranch,
  Globe,
  KeyRound,
  Laptop,
  Network,
  Server,
  Terminal,
} from "lucide-react";
import { type ComponentType, type ReactNode } from "react";

import { GitHubLogo } from "#/components/github";

export const Route = createFileRoute("/")({
  component: MarketingPage,
});

const REPO_URL = "https://github.com/get-sealant/sealant";

// ── Motion ────────────────────────────────────────────────────────────────────

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

// ── Primitives ──────────────────────────────────────────────────────────────

function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1200px] px-6 sm:px-8 ${className}`}>{children}</div>;
}

function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-mono text-xs font-medium tracking-[0.06em] uppercase ${
        dark ? "text-[#9db4f0]" : "text-primary"
      }`}
    >
      <span className={`size-1.5 rounded-full ${dark ? "bg-[#9db4f0]" : "bg-primary"}`} aria-hidden="true" />
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
  className = "max-w-[56ch]",
}: {
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  className?: string;
}) {
  return (
    <Reveal className={className}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
        {title}
      </Display>
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

function InDevBadge() {
  return (
    <span className="inline-flex items-center rounded-md bg-[var(--sw-wash)] px-2 py-0.5 font-mono text-[0.62rem] font-medium tracking-[0.08em] text-primary uppercase">
      In development
    </span>
  );
}

function DownArrow({ dark = false }: { dark?: boolean }) {
  return (
    <div className="flex justify-center py-2.5" aria-hidden="true">
      <ArrowDown className={`size-5 ${dark ? "text-white/30" : "text-faint"}`} />
    </div>
  );
}

// A dark code / terminal panel.
function CodePanel({
  title,
  children,
  lift = false,
  footer,
}: {
  title: string;
  children: ReactNode;
  lift?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-2xl border border-border bg-[#1c1c1f] ${
        lift ? "shadow-[var(--shadow-cobalt)]" : "shadow-[var(--shadow-lg)]"
      }`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
        <span className="font-mono text-xs text-white/55">{title}</span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-primary/70" />
        </span>
      </div>
      <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.8rem] leading-[1.7]">
        <code>{children}</code>
      </pre>
      {footer}
    </div>
  );
}

function Code({ lines }: { lines: ReadonlyArray<string> }) {
  return (
    <>
      {lines.map((text, i) => {
        const member = /^\s{2,}[A-Za-z_]\w*,?$/.test(text);
        return (
          <span key={i} className={`block ${member ? "text-[#9db4f0]" : "text-[#e6e6ea]"}`}>
            {text === "" ? " " : text}
          </span>
        );
      })}
    </>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────────

const HERO_CODE = [
  "const sandbox = await sealant.sandboxes.create({",
  '  repository: "acme/storefront",',
  '  harness: "opencode",',
  "});",
  "",
  "const { harness, ssh, files, processes } = sandbox;",
  "",
  "const run = await harness.run(",
  '  "Fix the failing checkout tests and verify the change.",',
  ");",
  "",
  "const { result, changes, artifacts, record } = run;",
];

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
      <Container className="relative grid items-center gap-12 py-20 lg:grid-cols-[0.92fr_1.08fr] lg:gap-16 lg:py-28">
        <motion.div className="min-w-0" {...parentMotion}>
          <motion.div {...childMotion}>
            <Eyebrow>Runtime for AI developer agents</Eyebrow>
          </motion.div>
          <motion.h1
            {...childMotion}
            className="mt-6 font-display text-[2.6rem] leading-[1.04] font-semibold tracking-[-0.03em] text-foreground text-balance sm:text-5xl lg:text-[3.5rem]"
          >
            Give AI agents a real development environment.
          </motion.h1>
          <motion.p
            {...childMotion}
            className="mt-6 max-w-[52ch] text-lg leading-relaxed text-muted-foreground"
          >
            Create an isolated sandbox for any repository. Run its harness, connect over SSH when you
            need to, and get back the result with a{" "}
            <span className="text-primary">complete record</span> of how it was produced.
          </motion.p>
          <motion.div {...childMotion} className="mt-9 flex flex-wrap items-center gap-3">
            <PrimaryCTA href={REPO_URL}>
              Start building
              <ArrowUpRight
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
            </PrimaryCTA>
            <SecondaryCTA href={REPO_URL} external>
              Read the documentation
              <ArrowRight className="size-4" aria-hidden="true" />
            </SecondaryCTA>
          </motion.div>
        </motion.div>

        <div className="min-w-0">
          <CodePanel
            title="fix-ci.ts"
            lift
            footer={
              <div className="flex items-center gap-2.5 border-t border-white/10 px-5 py-3.5">
                <span className="size-1.5 shrink-0 rounded-full bg-success-dot" aria-hidden="true" />
                <span className="font-mono text-xs text-white/70">
                  Completed · 3 files changed · Checks passed · 184 events recorded
                </span>
              </div>
            }
          >
            <Code lines={HERO_CODE} />
          </CodePanel>
        </div>
      </Container>
    </section>
  );
}

// ── Capability strip ───────────────────────────────────────────────────────────

const SCOPE = [
  "Sandboxes",
  "Harnesses",
  "SSH",
  "Processes",
  "Files",
  "Network",
  "Artifacts",
  "Execution records",
];

function CapabilityStrip() {
  return (
    <section className="border-y border-border bg-panel">
      <Container className="py-5">
        <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-xs text-muted-foreground sm:gap-x-5">
          {SCOPE.map((s, i) => (
            <li key={s} className="flex items-center gap-x-3 sm:gap-x-5">
              {i > 0 ? <span className="text-faint" aria-hidden="true">·</span> : null}
              {s}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

// ── 1. The missing runtime ───────────────────────────────────────────────────

const SANDBOX_PARTS: ReadonlyArray<{ icon: ComponentType<{ className?: string }>; label: string }> = [
  { icon: GitBranch, label: "Repository" },
  { icon: Cpu, label: "Harness" },
  { icon: Terminal, label: "Terminal" },
  { icon: Activity, label: "Processes" },
  { icon: Folder, label: "Files" },
  { icon: Server, label: "Services" },
];

function MissingRuntime() {
  return (
    <section id="runtime" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-16">
        <Reveal className="min-w-0">
          <Eyebrow>The missing runtime</Eyebrow>
          <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
            The runtime between an AI agent and a real codebase.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Agent frameworks decide what to do. Sealant gives the work somewhere real to happen.
          </p>
          <p className="mt-4 leading-relaxed text-muted-foreground">
            Each sandbox contains the repository, harness, tools, processes, and services required by
            the task. Your product controls it through the SDK, developers can enter it directly, and
            every run becomes structured data.
          </p>
          <div className="mt-7 rounded-2xl border-l-2 border-l-primary bg-panel py-4 pr-6 pl-5 shadow-[var(--shadow-sm)]">
            <p className="leading-relaxed text-foreground">
              The agent supplies the decisions. Sealant supplies the environment and the evidence.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.1} className="min-w-0">
          <div className="flex flex-col items-center text-center">
            <span className="rounded-lg border border-border bg-panel px-4 py-2 font-mono text-xs text-ink-2 shadow-[var(--shadow-xs)]">
              Your product
            </span>
            <DownArrow />
            <div className="w-full rounded-3xl border border-primary/30 bg-panel p-6 shadow-[var(--shadow-cobalt)] sm:p-7">
              <p className="ev-eyebrow text-center text-primary">Sealant sandbox</p>
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {SANDBOX_PARTS.map((p) => {
                  const Icon = p.icon;
                  return (
                    <div
                      key={p.label}
                      className="flex items-center gap-2 rounded-xl border border-rule-faint bg-background px-3 py-2.5"
                    >
                      <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                      <span className="font-mono text-xs text-ink-2">{p.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <DownArrow />
            <div className="flex flex-wrap justify-center gap-2">
              {["Result", "Changes", "Artifacts", "Record"].map((o) => (
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
      </Container>
    </section>
  );
}

// ── 2. The platform model ──────────────────────────────────────────────────────

const SANDBOX_MOCK = ["const {", "  harness,", "  ssh,", "  files,", "  processes,", "} = sandbox;"];
const RUN_MOCK = ["const {", "  result,", "  changes,", "  artifacts,", "  record,", "} = run;"];

function ModelCard({
  label,
  title,
  copy,
  mock,
  footer,
}: {
  label: string;
  title: string;
  copy: string;
  mock: ReadonlyArray<string>;
  footer: string;
}) {
  return (
    <div className="flex h-full flex-col rounded-3xl border border-border bg-panel p-7 shadow-[var(--shadow-sm)] sm:p-8">
      <p className="ev-eyebrow">{label}</p>
      <h3 className="mt-3 font-display text-2xl font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </h3>
      <p className="mt-3 leading-relaxed text-muted-foreground">{copy}</p>
      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-[#1c1c1f]">
        <pre className="overflow-x-auto px-5 py-4 font-mono text-[0.8rem] leading-[1.7]">
          <code>
            <Code lines={mock} />
          </code>
        </pre>
      </div>
      <p className="mt-5 text-sm leading-relaxed text-muted-foreground">{footer}</p>
    </div>
  );
}

function PlatformModel() {
  return (
    <section id="platform" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="One simple model"
          title="A sandbox you can enter. A run you can keep."
          intro={<p>Sealant separates the live environment from the durable result of the work.</p>}
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          <Reveal>
            <ModelCard
              label="Live environment"
              title="The sandbox"
              copy="A real development workspace containing the repository, harness, dependencies, processes, files, and services."
              mock={SANDBOX_MOCK}
              footer="Start work through the harness, or connect directly when you need to inspect the environment yourself."
            />
          </Reveal>
          <Reveal delay={0.06}>
            <ModelCard
              label="Durable output"
              title="The run"
              copy="One unit of developer work, including what it produced and the structured history of how it happened."
              mock={RUN_MOCK}
              footer="Use the output in your product, attach it to a pull request, or inspect it long after the sandbox has stopped."
            />
          </Reveal>
        </div>
        <Reveal delay={0.1} className="mt-10">
          <p className="text-center text-lg leading-relaxed text-foreground text-balance">
            The sandbox is where the work happens. The run is what your product gets back.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 3. Human access ──────────────────────────────────────────────────────────

const TERMINAL_LINES: ReadonlyArray<{ prompt?: boolean; text: string; ok?: boolean }> = [
  { prompt: true, text: "ssh sandbox.sbx_8m2k" },
  { text: "" },
  { prompt: true, text: "git diff --stat" },
  { text: " src/checkout.ts     | 18 +++++++++----" },
  { text: " tests/checkout.test | 24 +++++++++++++++++" },
  { text: "" },
  { prompt: true, text: "ps -ef | grep dev" },
  { text: "238  pnpm dev" },
  { text: "264  vite --host 0.0.0.0" },
  { text: "" },
  { prompt: true, text: "pnpm test checkout" },
  { text: "✓ 14 tests passed", ok: true },
];

function HumanAccess() {
  return (
    <section id="access" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-16">
        <Reveal delay={0.05} className="min-w-0 lg:order-2">
          <Eyebrow>Not a black box</Eyebrow>
          <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
            Let the harness work. Step in when reality gets messy.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Developer environments fail in ordinary ways. A dependency is missing. A port is
            occupied. A process hangs. A test needs closer inspection.
          </p>
          <p className="mt-4 leading-relaxed text-muted-foreground">
            Connect over SSH to the same live sandbox, inspect the files and processes, make a
            change, and let the work continue without recreating the environment.
          </p>
          <p className="mt-6 font-mono text-xs text-faint">
            Same repository · Same processes · Same task · Same execution record
          </p>
          <div className="mt-6 rounded-2xl border-l-2 border-l-primary bg-panel py-4 pr-6 pl-5 shadow-[var(--shadow-sm)]">
            <p className="leading-relaxed text-foreground">
              Automation when it works. Direct access when it does not.
            </p>
          </div>
        </Reveal>

        <Reveal className="min-w-0 lg:order-1">
          <CodePanel title="sandbox.sbx_8m2k — ssh">
            {TERMINAL_LINES.map((l, i) => (
              <span key={i} className="block">
                {l.prompt ? <span className="text-primary">$ </span> : null}
                <span className={l.ok ? "text-success" : l.prompt ? "text-[#e6e6ea]" : "text-white/55"}>
                  {l.text === "" ? " " : l.text}
                </span>
              </span>
            ))}
          </CodePanel>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 4. Execution records ─────────────────────────────────────────────────────

const TIMELINE: ReadonlyArray<{ t: string; event: string; detail?: string; kind: "info" | "ok" | "file" }> = [
  { t: "00:00.000", event: "sandbox.ready", kind: "info" },
  { t: "00:01.184", event: "process.started", detail: "pnpm install", kind: "info" },
  { t: "00:14.628", event: "process.exited", detail: "exit code 0", kind: "ok" },
  { t: "00:15.021", event: "process.started", detail: "pnpm dev", kind: "info" },
  { t: "00:17.406", event: "file.modified", detail: "src/checkout.ts", kind: "file" },
  { t: "00:19.218", event: "process.started", detail: "pnpm test checkout", kind: "info" },
  { t: "00:24.802", event: "process.exited", detail: "14 tests passed", kind: "ok" },
  { t: "00:25.110", event: "run.completed", kind: "ok" },
];

const RECORD_USES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Show live progress",
    body: "Build status interfaces from typed events instead of parsing terminal text.",
  },
  {
    title: "Explain the outcome",
    body: "Connect the final result to the commands, changes, and artifacts that produced it.",
  },
  {
    title: "Debug failed work",
    body: "See where the environment diverged, which process failed, and what changed immediately beforehand.",
  },
];

function ExecutionRecords() {
  return (
    <section id="records" className="bg-panel py-24 lg:py-32">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-16">
          <Reveal className="min-w-0">
            <Eyebrow>Structured execution</Eyebrow>
            <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
              Every run becomes product data.
            </Display>
            <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
              A wall of terminal output is difficult to build on.
            </p>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Sealant captures commands, input and output, process lifecycle, file changes, network
              activity, and generated artifacts as one ordered execution record. Stream it while the
              work is happening, or replay the history after it has finished.
            </p>
          </Reveal>

          <Reveal delay={0.08} className="min-w-0">
            <CodePanel title="execution record">
              {TIMELINE.map((e) => (
                <span key={e.t + e.event} className="block">
                  <span className="text-white/40">{e.t}</span>
                  {"  "}
                  <span
                    className={
                      e.kind === "ok"
                        ? "text-success"
                        : e.kind === "file"
                          ? "text-[#d9a93a]"
                          : "text-[#9db4f0]"
                    }
                  >
                    {e.event}
                  </span>
                  {e.detail ? <span className="text-white/55">{"  " + e.detail}</span> : null}
                </span>
              ))}
            </CodePanel>
            <p className="mt-4 text-center font-mono text-xs text-faint">
              184 events · 3 file changes · 4 artifacts
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-3">
          {RECORD_USES.map((u, i) => (
            <Reveal key={u.title} delay={(i % 3) * 0.05}>
              <div className="h-full rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)]">
                <h3 className="text-base font-semibold tracking-[-0.01em] text-foreground">
                  {u.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{u.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.1} className="mt-10">
          <p className="text-center text-lg leading-relaxed text-foreground text-balance">
            Not merely logs. A stable execution model your product can understand.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 5. Platform primitives ───────────────────────────────────────────────────

const PRIMITIVES: ReadonlyArray<{
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
  dev?: boolean;
}> = [
  {
    icon: Boxes,
    title: "Isolated sandboxes",
    body: "Create disposable development environments around real repositories and their dependencies.",
  },
  {
    icon: Cpu,
    title: "Harness execution",
    body: "Run OpenCode or another configured harness inside the environment instead of building your own agent worker lifecycle.",
  },
  {
    icon: Terminal,
    title: "SSH and interactive terminals",
    body: "Connect developers and software to PTY-backed sessions that behave like real terminals.",
  },
  {
    icon: Server,
    title: "Processes and services",
    body: "Start foreground commands and long-running services, supervise process trees, send signals, and clean up children.",
  },
  {
    icon: FileText,
    title: "Files and diffs",
    body: "Read and modify the workspace, watch changes, and produce a clear before-and-after diff.",
  },
  {
    icon: Network,
    title: "Network observation",
    body: "Observe proxied network activity and associate external requests with the run that produced them.",
  },
  {
    icon: Database,
    title: "Artifacts and history",
    body: "Retain logs, reports, generated files, screenshots, and the durable event history of the execution.",
  },
  {
    icon: Globe,
    title: "Browser sessions",
    body: "Let harnesses use web applications, authentication flows, and browser-based developer tools inside the same recorded run.",
    dev: true,
  },
];

function PlatformPrimitives() {
  return (
    <section id="primitives" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Platform primitives"
          title="The building blocks behind real developer work."
          intro={<p>Use the complete runtime, or adopt the pieces your product needs.</p>}
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PRIMITIVES.map((p, i) => {
            const Icon = p.icon;
            return (
              <Reveal key={p.title} delay={(i % 4) * 0.04}>
                <div className="h-full rounded-2xl border border-border bg-panel p-6 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex size-9 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
                      <Icon className="size-4.5" />
                    </span>
                    {p.dev ? <InDevBadge /> : null}
                  </div>
                  <h3 className="mt-4 text-base font-semibold tracking-[-0.01em] text-foreground">
                    {p.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

// ── 6. Products built on Sealant ──────────────────────────────────────────────

const PRODUCTS: ReadonlyArray<{ name: string; tagline: string; copy: string }> = [
  {
    name: "Sealant Verify",
    tagline: "Behavior → proof → test",
    copy: "Describe what should work. Sealant runs the application, exercises the behavior with real developer tools, shows reviewable evidence, and saves a test the team can keep.",
  },
  {
    name: "Sealant Repro",
    tagline: "Report → runnable case",
    copy: "Turn a bug report or failed CI run into a clean environment containing the exact commands, files, logs, and failure another developer needs to rerun.",
  },
  {
    name: "Sealant Handoff",
    tagline: "Task → verified change",
    copy: "Give a coding harness an engineering task and receive the result, code changes, checks, artifacts, and execution record in one reviewable handoff.",
  },
];

function Products() {
  return (
    <section id="products" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Built on Sealant"
          title="One platform underneath focused developer products."
          intro={
            <p>
              We are building opinionated workflows on top of the same sandboxes, harnesses, and
              execution records exposed through the platform SDK.
            </p>
          }
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {PRODUCTS.map((p, i) => (
            <Reveal key={p.name} delay={(i % 3) * 0.05}>
              <div className="flex h-full flex-col rounded-2xl border border-border bg-background p-7 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]">
                <h3 className="font-display text-xl font-semibold tracking-[-0.01em] text-foreground">
                  {p.name}
                </h3>
                <p className="mt-1.5 font-mono text-xs text-primary">{p.tagline}</p>
                <p className="mt-3 grow leading-relaxed text-muted-foreground">{p.copy}</p>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 inline-flex items-center gap-1.5 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
                >
                  Explore {p.name.replace("Sealant ", "")}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.12} className="mt-10">
          <div className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-background px-6 py-7 text-center shadow-[var(--shadow-sm)]">
            <p className="max-w-[60ch] text-lg leading-relaxed text-foreground text-balance">
              Use the products directly, or build a different developer workflow on the platform
              beneath them.
            </p>
            <SecondaryCTA href={REPO_URL} external>
              Explore all products
              <ArrowRight className="size-4" aria-hidden="true" />
            </SecondaryCTA>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 7. Harness-neutral execution ──────────────────────────────────────────────

function HarnessNeutral() {
  return (
    <section id="harness" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-16">
        <Reveal className="min-w-0">
          <Eyebrow>Bring your harness</Eyebrow>
          <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
            Keep the execution layer when the agent changes.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Sealant is not another model or reasoning framework.
          </p>
          <p className="mt-4 leading-relaxed text-muted-foreground">
            Run OpenCode, your own agent harness, or a custom worker inside the sandbox. Change
            models and planners without rebuilding repository setup, environment access, process
            control, observability, and artifact handling.
          </p>
          <div className="mt-7 rounded-2xl border-l-2 border-l-primary bg-panel py-4 pr-6 pl-5 shadow-[var(--shadow-sm)]">
            <p className="leading-relaxed text-foreground">
              Models decide what to do. Sealant standardizes where and how the work happens.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.1} className="min-w-0">
          <div className="flex flex-col items-center">
            <div className="flex w-full max-w-xs flex-col gap-2.5">
              {["OpenCode", "Custom agent", "CI worker"].map((h) => (
                <span
                  key={h}
                  className="rounded-xl border border-border bg-panel px-4 py-3 text-center font-mono text-sm text-ink-2 shadow-[var(--shadow-xs)]"
                >
                  {h}
                </span>
              ))}
            </div>
            <DownArrow />
            <div className="w-full max-w-sm rounded-3xl border border-primary/30 bg-panel p-6 text-center shadow-[var(--shadow-cobalt)]">
              <p className="ev-eyebrow text-center text-primary">Sealant Platform</p>
              <p className="mt-2.5 font-mono text-sm text-foreground">Sandbox · Control · Record</p>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 8. Where it runs ───────────────────────────────────────────────────────────

function WhereItRuns() {
  return (
    <section id="deploy" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="One execution model"
          title="Run where your code lives."
          intro={
            <p>
              Develop against the same SDK and event model whether execution happens on a laptop,
              inside your infrastructure, or in a managed environment.
            </p>
          }
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          <Reveal>
            <DeployCard
              icon={Laptop}
              title="Local runtime"
              body={
                <>
                  Run <span className="font-mono text-ink-2">sealantd</span> in a local development
                  environment or container. Keep the repository and services on your own machine
                  while building your integration.
                </>
              }
              cta="Install locally"
            />
          </Reveal>
          <Reveal delay={0.05}>
            <DeployCard
              icon={Server}
              title="Self-hosted"
              body="Place Sealant inside your own container or VM infrastructure, close to private repositories, internal services, and existing developer tooling."
              cta="Read the architecture"
            />
          </Reveal>
          <Reveal delay={0.1}>
            <DeployCard
              icon={Cloud}
              title="Sealant Cloud"
              dev
              body="Create managed sandboxes on demand, run work concurrently, retain artifacts, and share execution records across a team."
              cta="Join early access"
            />
          </Reveal>
        </div>
        <Reveal delay={0.12} className="mt-10">
          <p className="text-center text-lg leading-relaxed text-foreground text-balance">
            Start locally without designing a second product architecture for hosted execution.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

function DeployCard({
  icon: Icon,
  title,
  body,
  cta,
  dev = false,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: ReactNode;
  cta: string;
  dev?: boolean;
}) {
  return (
    <div
      className={`flex h-full flex-col rounded-2xl border bg-background p-7 shadow-[var(--shadow-sm)] ${
        dev ? "border-dashed border-border bg-panel/60" : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-[var(--sw-wash)] text-primary">
          <Icon className="size-5" />
        </span>
        {dev ? <InDevBadge /> : null}
      </div>
      <h3 className="mt-5 text-lg font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
      <p className="mt-2.5 grow leading-relaxed text-muted-foreground">{body}</p>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-5 inline-flex items-center gap-1.5 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
      >
        {cta}
        <ArrowRight className="size-4" aria-hidden="true" />
      </a>
    </div>
  );
}

// ── 9. Controlled execution (dark) ────────────────────────────────────────────

const CONTROL_POINTS: ReadonlyArray<{ icon: ComponentType<{ className?: string }>; title: string; body: string }> = [
  {
    icon: Activity,
    title: "Process supervision",
    body: "Track process groups, enforce timeouts, send signals, and clean up child processes reliably.",
  },
  {
    icon: KeyRound,
    title: "Secret redaction",
    body: "Remove configured secret values from captured terminal output before they become durable records.",
  },
  {
    icon: FileText,
    title: "Filesystem visibility",
    body: "See what the work created, changed, or removed instead of relying on the harness's summary.",
  },
  {
    icon: Network,
    title: "Network visibility",
    body: "Observe which external services were contacted during the run.",
  },
];

function ControlledExecution() {
  return (
    <section id="control" className="bg-[#191919] py-24 text-white lg:py-32">
      <Container>
        <Reveal className="max-w-[56ch]">
          <Eyebrow dark>Control and visibility</Eyebrow>
          <Display className="mt-5 text-[2rem] leading-[1.08] text-white sm:text-4xl lg:text-[2.85rem]">
            Give agents useful access without making their work opaque.
          </Display>
          <p className="mt-5 text-lg leading-relaxed text-white/65">
            Real developer work requires processes, network access, credentials, and mutable files.
            Sealant keeps that work isolated, supervised, and inspectable.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {CONTROL_POINTS.map((p, i) => {
            const Icon = p.icon;
            return (
              <Reveal key={p.title} delay={(i % 4) * 0.04}>
                <div className="h-full rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-white/[0.06] text-[#9db4f0]">
                    <Icon className="size-4.5" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold tracking-[-0.01em] text-white">
                    {p.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">{p.body}</p>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={0.12} className="mt-10">
          <p className="max-w-[68ch] leading-relaxed text-white/55">
            Additional secret, network, filesystem, and approval policies belong to the environment —
            not to instructions hidden inside a prompt.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 10. Developer use cases ────────────────────────────────────────────────────

const USE_CASES = [
  "Coding agents",
  "Autonomous QA",
  "Bug reproduction",
  "Failed CI investigation",
  "Dependency updates",
  "Repository maintenance",
  "Release automation",
  "Internal developer tooling",
  "Support engineering",
  "Migration workflows",
];

function UseCases() {
  return (
    <section id="use-cases" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow="Build with Sealant"
          title="Use the runtime wherever software must do real developer work."
        />
        <Reveal delay={0.08} className="mt-12">
          <ul className="flex flex-wrap gap-2.5">
            {USE_CASES.map((u) => (
              <li
                key={u}
                className="rounded-xl border border-border bg-panel px-4 py-2.5 text-sm font-medium text-ink-2 shadow-[var(--shadow-xs)]"
              >
                {u}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.12} className="mt-8 max-w-[64ch]">
          <p className="leading-relaxed text-muted-foreground">
            Sealant handles where the work runs, how it is controlled, and what gets recorded. Your
            product decides what the work means.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

// ── 11. FAQ ────────────────────────────────────────────────────────────────────

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Is Sealant an AI agent?",
    a: "No. Sealant is the environment and execution layer around an agent harness. The harness decides what actions to take; Sealant runs, controls, and records those actions.",
  },
  {
    q: "Why not run the agent directly inside Docker?",
    a: "Containers provide isolation. Sealant adds the developer-work model around that isolation: harness execution, interactive access, process supervision, filesystem changes, network observation, artifacts, and a structured run record.",
  },
  {
    q: "Can I use my own agent or harness?",
    a: "Yes. Sealant is designed to keep the sandbox and execution model independent from a particular model, agent framework, or planning loop.",
  },
  {
    q: "Can a developer access the environment directly?",
    a: "Yes. The sandbox can expose SSH and interactive terminal access so a developer can inspect or take over the same environment used by the harness.",
  },
  {
    q: "Can Sealant run inside our own infrastructure?",
    a: "Yes. The runtime can operate locally or inside environments you control. Managed execution can use the same SDK and event model.",
  },
  {
    q: "What does replay mean?",
    a: "Sealant can replay the durable history of a run — its commands, output, process events, file activity, network activity, and artifacts. It does not imply that arbitrary external systems can always be deterministically recreated.",
  },
];

function Faq() {
  return (
    <section id="faq" className="bg-panel py-24 lg:py-32">
      <Container className="max-w-[820px]">
        <SectionHead eyebrow="FAQ" title="Questions, answered." className="max-w-[40ch]" />
        <div className="mt-10 border-t border-border">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group border-b border-border [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-base font-medium text-foreground">
                {item.q}
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="pb-5 leading-relaxed text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}

// ── 12. Final CTA ─────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section id="start" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="relative overflow-hidden rounded-[2.25rem] border border-border bg-panel px-8 py-16 text-center shadow-[var(--shadow-md)] sm:px-12 lg:py-24">
            <div
              className="pointer-events-none absolute inset-x-0 top-[-30%] mx-auto h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(32,82,204,0.14),transparent_60%)] blur-2xl"
              aria-hidden="true"
            />
            <div className="relative">
              <Eyebrow>Build on Sealant</Eyebrow>
              <Display className="mx-auto mt-5 max-w-[20ch] text-[2.1rem] leading-[1.06] sm:text-5xl lg:text-[3.25rem]">
                Build the workflow. Sealant runs the work.
              </Display>
              <p className="mx-auto mt-5 max-w-[52ch] text-lg leading-relaxed text-muted-foreground">
                Create a sandbox, run a harness, and get back a result your users can inspect.
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
                TypeScript SDK · Local Protobuf protocol · Open-source runtime
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
      <CapabilityStrip />
      <MissingRuntime />
      <PlatformModel />
      <HumanAccess />
      <ExecutionRecords />
      <PlatformPrimitives />
      <Products />
      <HarnessNeutral />
      <WhereItRuns />
      <ControlledExecution />
      <UseCases />
      <Faq />
      <FinalCta />
    </main>
  );
}
