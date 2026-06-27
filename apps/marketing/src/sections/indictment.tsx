// THE INDICTMENT — the pain, made felt. The contrast IS the argument.
//
// LEFT: what you're doing today, told as a rhythm of cobalt left-edge lines.
// RIGHT: the foil — a dimmed dark CodePanel (the wall of logs you scrape today)
// directly above the SAME run rendered cleanly as a RunRecord strip. Same run,
// read instead of scraped.

import { type ReactNode } from "react";

import { CodePanel, Container, Display, Eyebrow, Reveal } from "#/components/primitives";
import { RunRecord } from "#/components/run-record";

// Each line: muted body, with the key noun lifted to text-foreground.
const TODAY: ReadonlyArray<ReactNode> = [
  <>
    You <span className="text-foreground">docker run</span> and hope it&rsquo;s isolated enough.
  </>,
  <>
    You scrape a <span className="text-foreground">wall of terminal text</span> to learn what the
    agent did.
  </>,
  <>
    You have no clean <span className="text-foreground">before and after</span>.
  </>,
  <>
    When it hangs, you <span className="text-foreground">can&rsquo;t step in</span>.
  </>,
  <>
    You rebuild this for{" "}
    <span className="text-foreground">every agent, every model, every project</span>.
  </>,
];

const NOISE: ReadonlyArray<string> = [
  "14:02:11.882 [container] OCI runtime exec start id=8m2k pid=1 tty=false cgroup=/sys/fs…",
  "14:02:11.903 agent stdout> resolving deps… ⠋⠙⠹ npm WARN deprecated har-validator@5.1.5",
  '14:02:12.140 [proc 2271] write fd=2 "\\x1b[32m✓\\x1b[0m" ... "added 1043 packages in 9s"',
  "14:02:12.141 agent stdout> \\r\\u001b[2K\\u001b[1Grunning suite (jest --silent)…",
  "14:02:13.778 [proc 2289] sched_yield futex(0x7ffd…, FUTEX_WAIT_PRIVATE, 0, NULL) = 0",
  "14:02:14.002 agent stdout> PASS src/checkout.test.ts (1.4 s) … 14 passing, 0 fail",
  "14:02:14.628 [proc 2289] exit_group(0) ptrace=detached rss=84112kB user=1.21 sys=0.34",
  "14:02:25.110 [container] task reaped status=0 … flushing 184 buffered fd events",
];

export function Indictment() {
  return (
    <section id="indictment" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <Reveal>
          <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
            {/* LEFT — what you're doing today */}
            <div className="min-w-0">
              <Eyebrow>What you&rsquo;re doing today</Eyebrow>
              <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
                Containers isolate the work. They don&rsquo;t tell you what it did.
              </Display>

              <div className="mt-8 space-y-4">
                {TODAY.map((line, i) => (
                  <div
                    key={i}
                    className="border-l-2 border-l-primary pl-4 leading-relaxed text-muted-foreground"
                  >
                    {line}
                  </div>
                ))}
              </div>

              <p className="mt-8 text-lg leading-relaxed font-medium text-foreground text-balance">
                Containers give you isolation. They don&rsquo;t give you the developer-work model
                around it.
              </p>
            </div>

            {/* RIGHT — the foil: the wall of logs, then the same run read cleanly */}
            <div className="min-w-0 space-y-4">
              <CodePanel dim title="agent.log">
                {NOISE.map((line, i) => (
                  <span key={i} className="block text-[#9a9aa2]">
                    {line === "" ? " " : line}
                  </span>
                ))}
                <span className="block text-[#6f6f77]">… 8,932 more lines</span>
              </CodePanel>

              <p className="pl-1 font-mono text-xs text-faint">same run — read, not scraped ↓</p>

              <RunRecord
                variant="strip"
                runId="sbx_8m2k"
                status={{ word: "Completed · observed", tone: "observed" }}
                events={[
                  { seq: 1, offset: "00:00.000", name: "sandbox.ready", provenance: "observed" },
                  {
                    seq: 18,
                    offset: "00:24.802",
                    name: "process.exited",
                    detail: "14 tests passed",
                    provenance: "observed",
                  },
                  { seq: 21, offset: "00:25.110", name: "run.completed", provenance: "observed" },
                ]}
              />
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
