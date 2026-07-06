// The Run-Artifact Timeline — the hero exhibit. The core loop as a vertical timeline:
// create a workspace, make a run, audit the outcome. Each stage pairs the SDK call (the
// way you'd write it) with a small UI exhibit (the way Sealant shows it back) — so the
// hero reads as "this is the API, and this is what it returns," top to bottom.
//
// Built from the evidence-review token vocabulary (dot+word status, mono machine facts,
// hairline rows, warm panels). Static-first and illustrative.

import { ChevronDown } from "lucide-react";
import { type ReactNode } from "react";

// ── Light code rendering ─────────────────────────────────────────────────────
type Tone = "kw" | "str" | "fn" | "member" | "comment" | "plain";

const TONE: Record<Tone, string> = {
  kw: "text-primary",
  str: "text-success",
  fn: "text-primary",
  member: "text-primary",
  comment: "text-faint",
  plain: "text-ink-2",
};

type Line = ReadonlyArray<readonly [string, Tone]>;

function Code({ lines }: { lines: ReadonlyArray<Line> }) {
  return (
    <div className="h-full overflow-x-auto rounded-xl border border-rule bg-[var(--sw-sunken)] px-4 py-3.5 font-mono text-[0.72rem] leading-[1.75]">
      <pre>
        <code>
          {lines.map((parts, i) => (
            <span key={i} className="block">
              {parts.length === 0 ? (
                <span> </span>
              ) : (
                parts.map((p, j) => (
                  <span key={j} className={TONE[p[1]]}>
                    {p[0]}
                  </span>
                ))
              )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

// ── Small UI exhibit primitives ──────────────────────────────────────────────
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`h-full overflow-hidden rounded-xl border border-rule bg-panel ${className}`}>
      {children}
    </div>
  );
}

function PanelHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule px-3.5 py-2.5">
      {children}
    </div>
  );
}

function Status({
  word,
  dot = "bg-success-dot",
  text = "text-success",
}: {
  word: string;
  dot?: string;
  text?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      <span className={`font-mono text-[0.7rem] ${text}`}>{word}</span>
    </span>
  );
}

function Kv({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl>
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="grid grid-cols-[5.5rem_1fr] gap-x-3 border-b border-rule-faint px-3.5 py-2 last:border-b-0"
        >
          <dt className="ev-eyebrow text-faint">{k}</dt>
          <dd className="min-w-0 truncate font-mono text-[0.72rem] text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── The three stage UIs ──────────────────────────────────────────────────────
function UiWorkspace() {
  return (
    <Panel>
      <PanelHead>
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="sealant-status-running size-2 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
          <span className="font-mono text-[0.72rem] text-ink-2">ws_8m2k</span>
        </span>
        <Status word="Ready · running" />
      </PanelHead>
      <Kv
        rows={[
          ["Repository", "acme/billing-service"],
          ["Branch", "main @ a9f3c20"],
          ["Harness", "opencode"],
          ["Runtime", "node 20 · ubuntu 24.04"],
        ]}
      />
    </Panel>
  );
}

const RUN_EVENTS: ReadonlyArray<{ offset: string; name: string; detail: string }> = [
  { offset: "00:00.000", name: "workspace.ready", detail: "" },
  { offset: "00:14.628", name: "process.exited", detail: "pnpm install · exit 0" },
  { offset: "00:17.406", name: "file.modified", detail: "src/checkout.ts" },
  { offset: "00:24.802", name: "process.exited", detail: "14 tests passed" },
];

function UiRun() {
  return (
    <Panel>
      <PanelHead>
        <span className="font-mono text-[0.72rem] text-ink-2">run_ws_8m2k</span>
        <Status word="Completed" />
      </PanelHead>
      <div>
        {RUN_EVENTS.map((e) => (
          <div
            key={e.offset}
            className="flex flex-wrap items-baseline gap-x-2.5 border-b border-rule-faint px-3.5 py-1.5 last:border-b-0 font-mono text-[0.7rem]"
          >
            <span className="text-faint tabular-nums">{e.offset}</span>
            <span className="text-ink-2">{e.name}</span>
            {e.detail ? <span className="text-muted-foreground">{e.detail}</span> : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// A peek into the record — a few real events, then the count. Drives the point that
// the record is structured evidence you can open, not a transcript.
const RECORD_PEEK: ReadonlyArray<{ offset: string; name: string; detail?: string }> = [
  { offset: "00:00.000", name: "workspace.ready" },
  { offset: "00:14.628", name: "process.exited", detail: "pnpm install · exit 0" },
  { offset: "00:17.406", name: "file.modified", detail: "src/checkout.ts" },
  { offset: "00:22.041", name: "net.request", detail: "api.stripe.com" },
];

function UiOutcome() {
  return (
    <Panel>
      <PanelHead>
        <Status word="Completed" />
        <span className="font-mono text-[0.7rem] text-primary" aria-hidden="true">
          Replay ▸
        </span>
      </PanelHead>
      <Kv
        rows={[
          ["Changes", "3 files · +41 / −22"],
          ["Checks", "14 passed"],
          ["Artifacts", "4 retained"],
        ]}
      />
      <div className="border-t border-rule-faint">
        <div className="flex items-center justify-between gap-3 px-3.5 py-2">
          <span className="inline-flex items-center gap-1.5">
            <ChevronDown className="size-3 text-faint" aria-hidden="true" />
            <span className="ev-eyebrow text-faint">Record</span>
          </span>
          <span className="font-mono text-[0.72rem] text-ink-2">184 events</span>
        </div>
        <div className="px-3.5 pb-2.5">
          <div className="space-y-[3px] border-l border-rule pl-3">
            {RECORD_PEEK.map((e) => (
              <div
                key={e.offset}
                className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.68rem] leading-[1.6]"
              >
                <span className="text-faint tabular-nums">{e.offset}</span>
                <span className="text-ink-2">{e.name}</span>
                {e.detail ? <span className="text-muted-foreground">{e.detail}</span> : null}
              </div>
            ))}
            <div className="pt-0.5 font-mono text-[0.66rem] text-faint">+ 180 more events</div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ── Stage scaffold (the rail + dot) ──────────────────────────────────────────
function Stage({
  title,
  tag,
  code,
  ui,
  last = false,
}: {
  title: string;
  tag: string;
  code: ReadonlyArray<Line>;
  ui: ReactNode;
  last?: boolean;
}) {
  return (
    <div className="flex gap-4 sm:gap-5">
      <div className="flex flex-col items-center pt-1.5">
        <span
          className="size-3 shrink-0 rounded-full bg-primary ring-4 ring-[var(--sw-wash)]"
          aria-hidden="true"
        />
        {last ? null : <span className="mt-1.5 w-px flex-1 bg-rule" aria-hidden="true" />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-8"}`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
            {title}
          </h3>
          <span className="ev-eyebrow text-faint normal-case">{tag}</span>
        </div>
        <div className="mt-3 grid gap-3.5 lg:grid-cols-2 lg:items-stretch">
          <Code lines={code} />
          {ui}
        </div>
      </div>
    </div>
  );
}

// ── Stage SDK snippets ───────────────────────────────────────────────────────
const CREATE: ReadonlyArray<Line> = [
  [
    ["const", "kw"],
    [" workspace = ", "plain"],
    ["await", "kw"],
    [" sealant.workspaces.", "plain"],
    ["create", "fn"],
    ["({", "plain"],
  ],
  [
    ["  repository: ", "plain"],
    ['"acme/billing-service"', "str"],
    [",", "plain"],
  ],
  [
    ["  harness: ", "plain"],
    ["opencode", "fn"],
    ["(),", "plain"],
  ],
  [["})", "plain"]],
];

const RUN: ReadonlyArray<Line> = [
  [
    ["const", "kw"],
    [" run = ", "plain"],
    ["await", "kw"],
    [" workspace.harness.", "plain"],
    ["run", "fn"],
    ["(", "plain"],
  ],
  [
    ['  "Round invoice totals once, after applying the discount."', "str"],
    [",", "plain"],
  ],
  [[")", "plain"]],
];

const AUDIT: ReadonlyArray<Line> = [
  [
    ["const", "kw"],
    [" { ", "plain"],
  ],
  [
    ["  changes", "member"],
    [",", "plain"],
  ],
  [
    ["  checks", "member"],
    [",", "plain"],
  ],
  [
    ["  artifacts", "member"],
    [",", "plain"],
  ],
  [
    ["  record", "member"],
    [",", "plain"],
  ],
  [
    ["} = ", "plain"],
    ["run", "plain"],
  ],
  [],
  [
    ["const", "kw"],
    [" { ", "plain"],
  ],
  [
    ["  files", "member"],
    [",", "plain"],
  ],
  [
    ["  processes", "member"],
    [",", "plain"],
  ],
  [
    ["  logs", "member"],
    [",", "plain"],
  ],
  [
    ["} = ", "plain"],
    ["workspace", "plain"],
  ],
  [],
  [
    ["await", "kw"],
    [" record.", "plain"],
    ["replay", "fn"],
    ["()", "plain"],
  ],
];

export function RunTimeline({
  illustrative = false,
  lift = false,
  className = "",
}: {
  readonly illustrative?: boolean;
  readonly lift?: boolean;
  readonly className?: string;
}) {
  const shadow = lift ? "shadow-[var(--shadow-cobalt)]" : "shadow-[var(--shadow-md)]";
  return (
    <figure className={`min-w-0 ${className}`}>
      <div className={`overflow-hidden rounded-2xl border border-border bg-panel ${shadow}`}>
        <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3.5">
          <span className="ev-eyebrow text-faint">Run artifact</span>
          <span className="font-mono text-xs text-faint">acme/billing-service · run_ws_8m2k</span>
        </div>
        <div className="px-5 py-7 sm:px-7">
          <Stage
            title="Create a workspace"
            tag="workspaces.create"
            code={CREATE}
            ui={<UiWorkspace />}
          />
          <Stage title="Make a run" tag="harness.run" code={RUN} ui={<UiRun />} />
          <Stage
            title="Audit the outcome"
            tag="record.replay"
            code={AUDIT}
            ui={<UiOutcome />}
            last
          />
        </div>
      </div>
      {illustrative ? (
        <figcaption className="mt-3 text-center font-mono text-[0.62rem] tracking-[0.04em] text-faint uppercase">
          Illustrative run artifact
        </figcaption>
      ) : null}
    </figure>
  );
}
