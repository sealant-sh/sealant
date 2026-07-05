// §5 — BUILD ON THE SDK. Sealant core is programmable infrastructure, not container
// glue. The fluent SDK is the public surface: create a live sandbox, run the harness
// you already use, keep the record. Light mono panel (not a dark terminal) so the
// code reads in the same warm evidence-review system as the rest of the page.

import { Display, Eyebrow, Reveal } from "#/components/primitives";

// A line is a list of [text, tone] spans. Tones map to the token vocabulary.
type Tone = "kw" | "str" | "fn" | "comment" | "plain";

const CODE: ReadonlyArray<ReadonlyArray<readonly [string, Tone]>> = [
  [
    ["const", "kw"],
    [" sandbox = ", "plain"],
    ["await", "kw"],
    [" sealant.sandboxes.", "plain"],
    ["create", "fn"],
    ["({", "plain"],
  ],
  [
    ["  repository: ", "plain"],
    ['"github.com/acme/billing-service"', "str"],
    [",", "plain"],
  ],
  [
    ["  harness: ", "plain"],
    ["opencode", "fn"],
    ["(),", "plain"],
  ],
  [["})", "plain"]],
  [["", "plain"]],
  [
    ["const", "kw"],
    [" run = ", "plain"],
    ["await", "kw"],
    [" sandbox.harness.", "plain"],
    ["run", "fn"],
    ["(", "plain"],
  ],
  [
    ['  "Round invoice totals once, after applying the discount."', "str"],
    [",", "plain"],
  ],
  [[")", "plain"]],
  [["", "plain"]],
  [
    ["await", "kw"],
    [" run.record.", "plain"],
    ["replay", "fn"],
    ["()", "plain"],
  ],
];

const TONE_CLASS: Record<Tone, string> = {
  kw: "text-primary",
  str: "text-success",
  fn: "text-primary",
  comment: "text-faint",
  plain: "text-ink-2",
};

function LightCode() {
  return (
    <div className="overflow-x-auto rounded-2xl border border-rule bg-[var(--sw-sunken)] px-5 py-5 font-mono text-[0.8rem] leading-[1.85] shadow-[var(--shadow-sm)]">
      <pre>
        <code>
          {CODE.map((line, i) => (
            <span key={i} className="block">
              {line.length === 1 && line[0]![0] === "" ? (
                <span> </span>
              ) : (
                line.map((part, j) => (
                  <span key={j} className={TONE_CLASS[part[1]]}>
                    {part[0]}
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

export function BuildOnSdk() {
  return (
    <section id="sdk" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <div className="mx-auto w-full max-w-[1200px] px-6 sm:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal className="min-w-0">
            <Eyebrow>Build on the SDK</Eyebrow>
            <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
              Build your agent on a runtime, not container glue.
            </Display>
            <p className="mt-5 max-w-[52ch] text-lg leading-relaxed text-muted-foreground">
              Create a live sandbox around a real repository, run the harness you already use,
              stream progress while it works, and{" "}
              <span className="text-foreground">keep the record after the sandbox is gone</span>.
            </p>
            <p className="mt-6 font-mono text-xs text-faint">
              Bring OpenCode, a custom harness, a CI worker, or your own agent loop.
            </p>
          </Reveal>

          <Reveal className="min-w-0">
            <LightCode />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
