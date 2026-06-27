// §7 — REAL SANDBOXES & CONSOLE. The sandbox is the platform object: a live,
// disposable development environment around a real repo. The console exhibit (light,
// evidence-review style) sits above the honest dark SSH terminal — editor access is a
// path *into* the sandbox, never "dev containers." Create from the SDK or the console.

import { Check } from "lucide-react";

import { Callout, CodePanel, Container, Display, Eyebrow, Reveal } from "#/components/primitives";

const SPEC: ReadonlyArray<readonly [string, string]> = [
  ["Repository", "acme/billing-service"],
  ["Branch", "main @ a9f3c20"],
  ["Harness", "opencode"],
  ["Runtime", "node 20 · ubuntu 24.04"],
  ["Services", "postgres · redis"],
];

const FEATURES = [
  "Create from a repo, a branch, or a commit",
  "Choose harness, OS, runtime, packages, and launch commands",
  "Stream lifecycle events and runtime status",
  "Open the live sandbox over SSH, VS Code, or Cursor",
  "Stop, restart, expire, or garbage-collect when done",
] as const;

function SandboxConsole() {
  return (
    <figure className="min-w-0 overflow-hidden rounded-2xl border border-border bg-panel shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="sealant-status-running size-2 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
          <span className="font-mono text-xs text-ink-2">sbx_8m2k</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success-dot" aria-hidden="true" />
          <span className="font-mono text-xs text-success">Ready · running</span>
        </span>
      </div>
      <dl>
        {SPEC.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[7rem_1fr] gap-x-3 border-b border-rule-faint px-4 py-2.5 last:border-b-0"
          >
            <dt className="ev-eyebrow text-faint">{label}</dt>
            <dd className="min-w-0 truncate font-mono text-xs text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-rule px-4 py-2.5 font-mono text-xs text-faint">
        Open over SSH · VS Code · Cursor
      </div>
    </figure>
  );
}

export function Sandboxes() {
  return (
    <section id="sandboxes" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal className="order-2 min-w-0 space-y-4 lg:order-1">
            <SandboxConsole />
            <CodePanel title="sandbox.sbx_8m2k — ssh">
              <span className="block">
                <span className="text-[#9db4f0]">$ </span>
                <span className="text-[#e6e6ea]">ssh sandbox.sbx_8m2k</span>
              </span>
              <span className="block"> </span>
              <span className="block">
                <span className="text-[#9db4f0]">$ </span>
                <span className="text-[#e6e6ea]">git diff --stat</span>
              </span>
              <span className="block text-white/55"> src/checkout.ts | 18 +++++---</span>
              <span className="block"> </span>
              <span className="block">
                <span className="text-[#9db4f0]">$ </span>
                <span className="text-[#e6e6ea]">pnpm test checkout</span>
              </span>
              <span className="block text-success">✓ 14 tests passed</span>
            </CodePanel>
          </Reveal>

          <Reveal className="order-1 min-w-0 lg:order-2">
            <Eyebrow>Real sandboxes, under your control</Eyebrow>
            <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
              The sandbox is a real development environment.
            </Display>
            <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
              Sealant creates a live, disposable environment around a repository — code,
              dependencies, harness, processes, runtime commands, and services. Use the SDK for
              automation or the console to create, inspect, restart, and enter sandboxes.
            </p>

            <ul className="mt-8 space-y-3">
              {FEATURES.map((feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="leading-relaxed text-foreground">{feature}</span>
                </li>
              ))}
            </ul>

            <Callout className="mt-7">
              Open the live sandbox whenever you want to inspect, guide, or extend the run.
            </Callout>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
