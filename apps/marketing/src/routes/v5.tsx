import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";

import { REPO_URL } from "#/content";

export const Route = createFileRoute("/v5" as never)({
  component: DashboardDemoPage,
});

function Hero() {
  return (
    <section className="v5-mesh relative overflow-hidden border-b border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
      <div className="relative mx-auto max-w-[1200px] px-6 py-14 sm:px-8 lg:py-20">
        <div className="flex flex-col items-center gap-6 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]/50 px-3 py-1 font-mono text-[0.56rem] uppercase tracking-[0.16em] text-[var(--sw-accent)] backdrop-blur-sm">
            <span
              className="sealant-status-running size-1.5 rounded-full bg-[var(--sw-accent)]"
              aria-hidden="true"
            />
            Live demo — this is a real Sealant dashboard
          </span>
          <h1 className="m-0 max-w-[24ch] font-display text-[2.5rem] leading-[1.1] tracking-tight text-[var(--sw-ink)] sm:text-[3.5rem] lg:text-[4rem]">
            Don't read about Sealant.{" "}
            <span className="bg-gradient-to-r from-[var(--sw-accent)] to-sky-400 bg-clip-text text-transparent">
              Look at it.
            </span>
          </h1>
          <p className="max-w-[50ch] text-[0.98rem] leading-[1.6] text-[var(--sw-ink)]/65">
            This page is a mock Sealant dashboard. Scroll to see a run in progress — the sandbox,
            the recorder, the policy, the run record. Annotations explain what you're seeing.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <a
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--sw-accent)] px-5 py-2.5 text-[0.82rem] font-medium text-white no-underline transition hover:brightness-110"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              Run your own issue
            </a>
            <a
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--sw-rule)] px-5 py-2.5 text-[0.82rem] font-medium text-[var(--sw-ink)] no-underline transition hover:border-[var(--sw-accent)]"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              Read the docs
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Dashboard() {
  return (
    <section className="border-b border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
      <div className="mx-auto max-w-[1200px] px-6 py-12 sm:px-8 lg:py-16">
        {/* App chrome */}
        <div className="v5-card-glow overflow-hidden rounded-xl border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
          {/* Top bar */}
          <div className="flex items-center justify-between border-b border-[var(--sw-soft-rule)] px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className="size-4 rounded bg-gradient-to-br from-[var(--sw-accent)] to-sky-400"
                aria-hidden="true"
              />
              <span className="font-mono text-[0.62rem] font-bold text-[var(--sw-ink)]">
                Sealant
              </span>
              <span className="ml-2 font-mono text-[0.52rem] text-[var(--sw-muted)]">
                / acme-billing
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[0.48rem] text-[var(--sw-muted)]">acme/billing</span>
              <span
                className="size-5 rounded-full bg-gradient-to-br from-[var(--sw-accent)] to-sky-400"
                aria-hidden="true"
              />
            </div>
          </div>

          {/* Dashboard body */}
          <div className="grid lg:grid-cols-[200px_1fr_240px] gap-px bg-[var(--sw-soft-rule)]">
            {/* Left: run list */}
            <div className="bg-[var(--sw-panel)] p-3">
              <p className="m-0 mb-3 font-mono text-[0.48rem] uppercase tracking-[0.14em] text-[var(--sw-muted)]">
                Recent runs
              </p>
              <div className="space-y-2">
                {[
                  { id: "#wf_482", title: "Fix billing retry", status: "running", active: true },
                  { id: "#wf_481", title: "Add webhook idempotency", status: "done" },
                  { id: "#wf_480", title: "Refactor invoice validator", status: "done" },
                  { id: "#wf_479", title: "Update Stripe SDK", status: "failed" },
                  { id: "#wf_478", title: "Fix currency rounding", status: "done" },
                ].map((run) => (
                  <div
                    key={run.id}
                    className={`rounded-lg border px-3 py-2 transition-colors ${
                      run.active
                        ? "border-[var(--sw-accent)]/40 bg-[var(--sw-accent)]/5"
                        : "border-[var(--sw-soft-rule)]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`size-1.5 rounded-full ${
                          run.status === "running"
                            ? "sealant-status-running bg-[var(--sw-accent)]"
                            : run.status === "done"
                              ? "bg-emerald-400"
                              : "bg-red-400"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-[0.52rem] text-[var(--sw-ink)]/80">
                        {run.id}
                      </span>
                    </div>
                    <p className="m-0 mt-1 text-[0.66rem] leading-4 text-[var(--sw-ink)]/60">
                      {run.title}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Center: active run */}
            <div className="bg-[var(--sw-panel)] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="m-0 font-mono text-[0.52rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                    Run #wf_482
                  </p>
                  <h3 className="m-0 mt-1 text-[0.92rem] font-semibold text-[var(--sw-ink)]">
                    Fix billing retry bug
                  </h3>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--sw-accent)]/10 px-2.5 py-1 font-mono text-[0.48rem] uppercase tracking-[0.1em] text-[var(--sw-accent)]">
                  <span
                    className="sealant-status-running size-1.5 rounded-full bg-[var(--sw-accent)]"
                    aria-hidden="true"
                  />
                  Running
                </span>
              </div>

              {/* Timeline */}
              <div className="mt-5">
                <p className="m-0 mb-2 font-mono text-[0.48rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                  Timeline
                </p>
                <div className="flex items-center gap-1">
                  {[
                    { label: "Intake", state: "done" },
                    { label: "Policy", state: "done" },
                    { label: "Build", state: "done" },
                    { label: "Execute", state: "active" },
                    { label: "Validate", state: "pending" },
                    { label: "PR", state: "pending" },
                  ].map((stage, i) => (
                    <div key={stage.label} className="flex flex-1 items-center">
                      <div className="flex-1">
                        <div
                          className={`h-1 rounded-full ${
                            stage.state === "done"
                              ? "bg-[var(--sw-accent)]"
                              : stage.state === "active"
                                ? "bg-[var(--sw-accent)]/40"
                                : "bg-[var(--sw-soft-rule)]"
                          }`}
                        />
                        <p
                          className={`m-0 mt-1.5 font-mono text-[0.46rem] uppercase tracking-[0.06em] ${
                            stage.state === "active"
                              ? "text-[var(--sw-accent)]"
                              : stage.state === "done"
                                ? "text-[var(--sw-ink)]/60"
                                : "text-[var(--sw-muted)]"
                          }`}
                        >
                          {stage.label}
                        </p>
                      </div>
                      {i < 5 ? <div className="w-1" /> : null}
                    </div>
                  ))}
                </div>
              </div>

              {/* Command output */}
              <div className="mt-5">
                <p className="m-0 mb-2 font-mono text-[0.48rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                  Recorder — live output
                </p>
                <div className="rounded-lg border border-[var(--sw-soft-rule)] bg-[var(--sw-bg)] p-3 font-mono text-[0.6rem] leading-[1.7] text-[var(--sw-ink)]/70">
                  <p className="m-0 text-[var(--sw-accent)]">$ pnpm test</p>
                  <p className="m-0 text-[var(--sw-muted)]">↳ running 12 test suites...</p>
                  <p className="m-0 text-[var(--sw-muted)]"> ✓ retry.test.ts — 11 passed</p>
                  <p className="m-0 text-[var(--sw-accent)]">
                    {" "}
                    ✗ retry.test.ts:42 — "should retry 3 times"
                  </p>
                  <p className="m-0 text-[var(--sw-muted)]"> ✓ invoice.test.ts — 8 passed</p>
                  <p className="m-0 text-[var(--sw-muted)]"> ✓ webhook.test.ts — 15 passed</p>
                  <p className="m-0 mt-1 text-[var(--sw-accent)]">
                    → 11 passed · 1 failed · 0 skipped
                  </p>
                  <p className="m-0 mt-1 text-[var(--sw-muted)]">
                    [recorder: 14 commands · 3 files · 42 events captured]
                  </p>
                </div>
              </div>

              {/* Diff preview */}
              <div className="mt-4">
                <p className="m-0 mb-2 font-mono text-[0.48rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                  Files changed — 3
                </p>
                <div className="space-y-1.5">
                  {[
                    { file: "src/billing/retry.ts", changes: "+24 -8", intent: "fix" },
                    { file: "src/billing/retry.test.ts", changes: "+31 -0", intent: "test" },
                    { file: "src/billing/types.ts", changes: "+3 -1", intent: "refactor" },
                  ].map((f) => (
                    <div
                      key={f.file}
                      className="flex items-center gap-3 rounded-lg border border-[var(--sw-soft-rule)] px-3 py-2"
                    >
                      <span
                        className="rounded px-1.5 py-0.5 font-mono text-[0.46rem] uppercase tracking-[0.04em] text-[var(--sw-accent)]"
                        style={{ background: "rgba(99,102,241,0.1)" }}
                      >
                        {f.intent}
                      </span>
                      <span className="font-mono text-[0.58rem] text-[var(--sw-ink)]/75">
                        {f.file}
                      </span>
                      <span className="ml-auto font-mono text-[0.52rem] text-[var(--sw-muted)]">
                        {f.changes}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: policy + recorder */}
            <div className="bg-[var(--sw-panel)] p-3 space-y-3">
              <div>
                <p className="m-0 mb-2 font-mono text-[0.48rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                  Policy
                </p>
                <div className="space-y-1.5">
                  {[
                    { k: "Secrets", v: "STRIPE_SECRET_KEY (scoped)" },
                    { k: "Network", v: "restricted" },
                    { k: "Isolation", v: "runc" },
                    { k: "Approvals", v: "required for PR" },
                  ].map((row) => (
                    <div
                      key={row.k}
                      className="flex flex-col border-b border-[var(--sw-soft-rule)] pb-1.5"
                    >
                      <span className="font-mono text-[0.46rem] uppercase tracking-[0.08em] text-[var(--sw-muted)]">
                        {row.k}
                      </span>
                      <span className="font-mono text-[0.56rem] text-[var(--sw-ink)]/75">
                        {row.v}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="m-0 mb-2 font-mono text-[0.48rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                  Recorder
                </p>
                <div className="rounded-lg border border-[var(--sw-accent)]/30 bg-[var(--sw-accent)]/5 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="sealant-status-running size-1.5 rounded-full bg-[var(--sw-accent)]"
                      aria-hidden="true"
                    />
                    <span className="font-mono text-[0.48rem] uppercase tracking-[0.08em] text-[var(--sw-accent)]">
                      Active
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {[
                      { k: "Commands", v: "14" },
                      { k: "Files", v: "3" },
                      { k: "Events", v: "42" },
                      { k: "Processes", v: "7" },
                    ].map((row) => (
                      <div key={row.k} className="flex items-center justify-between">
                        <span className="font-mono text-[0.46rem] text-[var(--sw-muted)]">
                          {row.k}
                        </span>
                        <span className="font-mono text-[0.5rem] text-[var(--sw-ink)]/75">
                          {row.v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <p className="m-0 mb-2 font-mono text-[0.48rem] uppercase tracking-[0.12em] text-[var(--sw-muted)]">
                  Risk flags
                </p>
                <div className="space-y-1">
                  {["auth touched", "migration added"].map((flag) => (
                    <div
                      key={flag}
                      className="rounded border border-[var(--sw-accent)]/30 bg-[var(--sw-accent)]/5 px-2 py-1 font-mono text-[0.46rem] text-[var(--sw-accent)]"
                    >
                      ⚠ {flag}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Annotations() {
  const reduce = useReducedMotion();
  return (
    <section className="v5-mesh border-b border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[1000px] px-6 py-16 sm:px-8 lg:py-20">
        <h2 className="m-0 text-center font-display text-[1.75rem] leading-tight tracking-tight text-[var(--sw-ink)] sm:text-[2.5rem]">
          What you just saw
        </h2>
        <div className="mt-10 space-y-8">
          {[
            {
              title: "The run list",
              body: "Every run — whether from an issue, an SDK call, or a phone notification — appears here. You can see the status at a glance: running, done, or failed. Click any run to see its full record.",
            },
            {
              title: "The timeline",
              body: "A run moves through six stages: Intake → Policy → Build → Execute → Validate → PR. Each stage is tracked. You always know where the run is and what happened at each step.",
            },
            {
              title: "The recorder output",
              body: "This is the key. The recorder runs inside the sandbox and captures every command, every test result, every file change. It's not a summary — it's the actual execution trail, available for review.",
            },
            {
              title: "The policy panel",
              body: "Secrets are scoped per run. Network can be restricted. Approvals can be required. The agent never sees more than it needs — and you can prove it.",
            },
            {
              title: "The risk flags",
              body: "Sealant surfaces risky changes automatically: auth touched, migration added, dependency changed. A reviewer sees the risk before they open the diff.",
            },
          ].map((item, i) => (
            <motion.div
              key={item.title}
              initial={reduce ? false : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.5, delay: i * 0.04 }}
              className="flex items-start gap-4 border-b border-[var(--sw-soft-rule)] pb-6 last:border-b-0"
            >
              <span
                className="mt-1 size-2 shrink-0 rounded-full bg-[var(--sw-accent)]"
                aria-hidden="true"
              />
              <div>
                <h3 className="m-0 font-mono text-[0.72rem] font-semibold uppercase tracking-wider text-[var(--sw-ink)]">
                  {item.title}
                </h3>
                <p className="mt-1.5 max-w-[56ch] text-[0.88rem] leading-[1.6] text-[var(--sw-ink)]/65">
                  {item.body}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Sdk() {
  return (
    <section className="border-b border-[var(--sw-soft-rule)] bg-[var(--sw-bg)]">
      <div className="mx-auto grid max-w-[1000px] gap-8 px-6 py-16 sm:px-8 lg:grid-cols-2 lg:py-20">
        <div>
          <span className="inline-flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-[var(--sw-accent)]" aria-hidden="true" />
            <span className="font-mono text-[0.56rem] uppercase tracking-[0.18em] text-[var(--sw-accent)]">
              SDK
            </span>
          </span>
          <h2 className="m-0 mt-4 font-display text-[1.5rem] leading-tight tracking-tight text-[var(--sw-ink)] sm:text-[2rem]">
            Build your own workflows on the run layer.
          </h2>
          <p className="mt-4 max-w-[44ch] text-[0.92rem] leading-[1.6] text-[var(--sw-ink)]/65">
            Everything you just saw is programmable. Sandboxes, issue workflows, runtime events,
            policies, harnesses — all accessible through the SDK.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {["sandboxes", "issueWorkflows", "runtime", "policies", "harnesses", "sources"].map(
              (m) => (
                <span
                  key={m}
                  className="rounded-full border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)] px-2.5 py-1 font-mono text-[0.54rem] text-[var(--sw-ink)]/70"
                >
                  .{m}()
                </span>
              ),
            )}
          </div>
        </div>
        <div className="v5-card-glow rounded-xl border border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
          <div className="flex items-center justify-between border-b border-[var(--sw-soft-rule)] px-4 py-2.5">
            <span className="font-mono text-[0.52rem] uppercase tracking-[0.14em] text-[var(--sw-muted)]">
              sealant.ts
            </span>
            <div className="flex gap-1.5" aria-hidden="true">
              <span className="size-2 rounded-full bg-red-400/40" />
              <span className="size-2 rounded-full bg-yellow-400/40" />
              <span className="size-2 rounded-full bg-green-400/40" />
            </div>
          </div>
          <pre className="m-0 overflow-x-auto px-4 py-4 font-mono text-[0.7rem] leading-[1.7] text-[var(--sw-ink)]/85">
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
    <section className="v5-mesh border-b border-[var(--sw-soft-rule)] bg-[var(--sw-panel)]">
      <div className="mx-auto max-w-[1000px] px-6 py-24 text-center sm:px-8">
        <h2 className="m-0 mx-auto max-w-[24ch] font-display text-[2rem] leading-[1.15] tracking-tight text-[var(--sw-ink)] sm:text-[3rem]">
          Give AI coding work a place to run and a record to trust.
        </h2>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--sw-accent)] px-5 py-2.5 text-[0.82rem] font-medium text-white no-underline transition hover:brightness-110"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            Run an issue
          </a>
          <a
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--sw-rule)] px-5 py-2.5 text-[0.82rem] font-medium text-[var(--sw-ink)] no-underline transition hover:border-[var(--sw-accent)]"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

function DashboardDemoPage() {
  return (
    <div className="design-v5">
      <main>
        <Hero />
        <Dashboard />
        <Annotations />
        <Sdk />
        <Cta />
      </main>
    </div>
  );
}
