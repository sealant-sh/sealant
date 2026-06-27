// §6 — WHAT THE RECORD CAPTURES. The structured signals folded into one run, named.
// A six-item grid in the page's card idiom (the same lifted panels the webapp uses for
// run lists). Browser evidence is the standout wedge — and honestly still in progress,
// so it carries the in-development badge rather than claiming more than ships today.

import { Camera, Cpu, FileDiff, Network, Package, Terminal } from "lucide-react";

import {
  Container,
  Eyebrow,
  InDevBadge,
  type IconType,
  Reveal,
  SectionHead,
} from "#/components/primitives";

interface Signal {
  readonly icon: IconType;
  readonly title: string;
  readonly body: string;
  readonly inDev?: boolean;
}

const SIGNALS: ReadonlyArray<Signal> = [
  {
    icon: Terminal,
    title: "Terminal I/O",
    body: "Byte-exact command output, attached to the run that produced it.",
  },
  {
    icon: FileDiff,
    title: "File changes",
    body: "Added, modified, deleted, and renamed files with reviewable patches.",
  },
  {
    icon: Cpu,
    title: "Processes",
    body: "Lifecycle, exit codes, signals, timeouts, and supervised child processes.",
  },
  {
    icon: Package,
    title: "Artifacts",
    body: "Reports, logs, screenshots, generated files, and other retained outputs.",
  },
  {
    icon: Network,
    title: "Network activity",
    body: "Outbound requests associated with the run that made them.",
  },
  {
    icon: Camera,
    title: "Browser evidence",
    body: "Screenshots, DOM snapshots, navigations, and browser-generated network traces.",
    inDev: true,
  },
];

function SignalCard({ signal }: { signal: Signal }) {
  const Icon = signal.icon;
  return (
    <div
      className={`rounded-2xl border bg-background p-6 shadow-[var(--shadow-xs)] ${
        signal.inDev ? "border-primary/25" : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-[var(--sw-wash)] text-primary">
          <Icon className="size-4" />
        </span>
        {signal.inDev ? <InDevBadge /> : null}
      </div>
      <h3 className="mt-4 font-display text-base font-semibold tracking-[-0.01em] text-foreground">
        {signal.title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{signal.body}</p>
    </div>
  );
}

export function RecordCaptures() {
  return (
    <section id="capture" className="bg-panel py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>What the record captures</Eyebrow>}
          title="A structured record, not a pile of logs."
          intro={
            <p>
              One ordered, correlated, replayable stream — queried, not parsed. Every fact carries
              how it was captured.
            </p>
          }
        />
        <Reveal className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {SIGNALS.map((signal) => (
            <SignalCard key={signal.title} signal={signal} />
          ))}
        </Reveal>
      </Container>
    </section>
  );
}
