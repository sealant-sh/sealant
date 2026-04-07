import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardClock,
  Container as ContainerIcon,
  Hammer,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

export const Route = createFileRoute("/" as never)({
  component: MarketingPage,
});

const HERO_CTA_CYCLE = 5.4;
const HERO_ICON_PULSE = 0.58;
const HERO_WAVE_DRAW = 0.72;
const HERO_WAVE_PATH =
  "M1 10C6.4 10 6.4 2 11.8 2C17.2 2 17.2 18 22.6 18C28 18 28 2 33.4 2C38.8 2 38.8 18 44.2 18C49.6 18 49.6 10 55 10";
const HERO_WINDOW_X_OFFSETS = [0, 26, 52, 78] as const;
const HERO_WINDOW_Y_OFFSETS = [0, 18, 36, 54] as const;
const HERO_WINDOW_SCALES = [1, 0.974, 0.948, 0.922] as const;
const HERO_WINDOW_OPACITIES = [1, 0.9, 0.76, 0.58] as const;

interface HeroWindowDefinition {
  readonly id: string;
  readonly step: string;
  readonly title: string;
  readonly description: string;
  readonly content: ReactNode;
}

function createLoopTimes(start: number, active: number, tail = 0.18) {
  return [
    0,
    start / HERO_CTA_CYCLE,
    (start + active * 0.45) / HERO_CTA_CYCLE,
    (start + active) / HERO_CTA_CYCLE,
    Math.min((start + active + tail) / HERO_CTA_CYCLE, 0.98),
    1,
  ];
}

function AnimatedHeroIcon({ Icon, start }: { Icon: LucideIcon; start: number }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="relative size-12 shrink-0 sm:size-14 lg:size-16" aria-hidden="true">
      {shouldReduceMotion ? (
        <Icon className="absolute inset-0 size-full text-foreground [stroke-width:1.5px]" />
      ) : (
        <motion.div
          className="absolute inset-0 text-foreground"
          animate={{
            opacity: [1, 1, 0, 0.18, 1, 1],
          }}
          transition={{
            duration: HERO_CTA_CYCLE,
            ease: "linear",
            repeat: Number.POSITIVE_INFINITY,
            times: createLoopTimes(start, HERO_ICON_PULSE),
          }}
        >
          <Icon className="size-full [stroke-width:1.5px]" />
        </motion.div>
      )}
      {shouldReduceMotion ? null : (
        <motion.div
          className="absolute inset-0 text-primary"
          animate={{
            opacity: [0, 0, 1, 0.34, 0, 0],
            scale: [1, 1, 1.08, 1.02, 1, 1],
            filter: [
              "drop-shadow(0 0 0 rgba(217, 36, 216, 0))",
              "drop-shadow(0 0 0 rgba(217, 36, 216, 0))",
              "drop-shadow(0 0 18px rgba(217, 36, 216, 0.95))",
              "drop-shadow(0 0 10px rgba(217, 36, 216, 0.35))",
              "drop-shadow(0 0 0 rgba(217, 36, 216, 0))",
              "drop-shadow(0 0 0 rgba(217, 36, 216, 0))",
            ],
          }}
          transition={{
            duration: HERO_CTA_CYCLE,
            ease: "linear",
            repeat: Number.POSITIVE_INFINITY,
            times: createLoopTimes(start, HERO_ICON_PULSE),
          }}
        >
          <Icon className="size-full [stroke-width:1.5px]" />
        </motion.div>
      )}
    </div>
  );
}

function HeroWave({ start }: { start: number }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      className="relative h-6 w-12 shrink-0 text-foreground/55 sm:h-8 sm:w-16 lg:h-10 lg:w-20"
      aria-hidden="true"
    >
      <svg viewBox="0 0 56 20" className="absolute inset-0 size-full">
        <path
          d={HERO_WAVE_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {shouldReduceMotion ? null : (
        <motion.svg
          viewBox="0 0 56 20"
          className="absolute inset-0 size-full overflow-visible text-primary"
        >
          <motion.path
            d={HERO_WAVE_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="blur-[4px]"
            animate={{
              pathLength: [0, 0, 1, 1, 1, 1],
              opacity: [0, 0, 0.6, 0.2, 0, 0],
            }}
            transition={{
              duration: HERO_CTA_CYCLE,
              ease: "linear",
              repeat: Number.POSITIVE_INFINITY,
              times: createLoopTimes(start, HERO_WAVE_DRAW),
            }}
          />
          <motion.path
            d={HERO_WAVE_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            animate={{
              pathLength: [0, 0, 1, 1, 1, 1],
              opacity: [0, 0, 1, 0.35, 0, 0],
            }}
            transition={{
              duration: HERO_CTA_CYCLE,
              ease: "linear",
              repeat: Number.POSITIVE_INFINITY,
              times: createLoopTimes(start, HERO_WAVE_DRAW),
            }}
          />
        </motion.svg>
      )}
    </div>
  );
}

function AnimatedHeroCta() {
  return (
    <div className="mx-auto mt-8 flex w-full items-center justify-center gap-2 text-foreground sm:mt-10 sm:gap-4 lg:mx-0 lg:mt-6 lg:justify-start lg:gap-5">
      <AnimatedHeroIcon Icon={Hammer} start={0.2} />
      <HeroWave start={0.88} />
      <AnimatedHeroIcon Icon={ContainerIcon} start={1.72} />
      <HeroWave start={2.42} />
      <AnimatedHeroIcon Icon={ClipboardClock} start={3.28} />
    </div>
  );
}

// Replace the placeholder copy and blocks below with your product-specific diagrams and messaging.
const heroWindows: ReadonlyArray<HeroWindowDefinition> = [
  {
    id: "issue-brief",
    step: "Issue Workflow",
    title: "Capture issues",
    description: "Pull issues from GitHub or Linear, and define the execution outline",
    content: (
      <div className="grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="h-2.5 w-24 rounded-full bg-foreground/14" />
            <div className="h-2.5 w-full rounded-full bg-foreground/10" />
            <div className="h-2.5 w-4/5 rounded-full bg-foreground/10" />
          </div>
          <div className="rounded-[1.25rem] border border-dashed border-border/90 bg-background/70 px-4 py-5"></div>
        </div>
        <div className="grid gap-3 self-start"></div>
      </div>
    ),
  },
  {
    id: "image-creation",
    step: "Image Creation",
    title: "Define your image",
    description:
      "Drop in environment details, build inputs, and policies for your sandbox lifecycle.",
    content: (
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[1.2rem] border border-border bg-background/80 px-4 py-4">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-muted-foreground">
              Clone repo, install dependencies
            </p>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="h-2.5 w-20 rounded-full bg-foreground/12" />
                <div className="h-6 w-14 rounded-full border border-border bg-background/70" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="h-2.5 w-16 rounded-full bg-foreground/12" />
                <div className="h-6 w-[4.5rem] rounded-full border border-border bg-background/70" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="h-2.5 w-24 rounded-full bg-foreground/12" />
                <div className="h-6 w-12 rounded-full border border-border bg-background/70" />
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "review-diff",
    step: "Agent work",
    title: "Execute your changes",
    description: "Use your preferred harness, and make desired changes",
    content: (
      <div className="grid gap-4 lg:grid-cols-[1fr_0.92fr]">
        <div className="space-y-3">
          <div className="rounded-[1rem] border border-border bg-background/80 px-4 py-4">
            <div className="h-2.5 w-20 rounded-full bg-foreground/12" />
            <div className="mt-3 space-y-2">
              <div className="h-2.5 w-full rounded-full bg-foreground/10" />
              <div className="h-2.5 w-11/12 rounded-full bg-foreground/10" />
              <div className="h-2.5 w-3/4 rounded-full bg-foreground/10" />
            </div>
          </div>
          <div className="rounded-[1rem] border border-border bg-background/80 px-4 py-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="h-10 rounded-[0.85rem] border border-border bg-background/70" />
              <div className="h-10 rounded-[0.85rem] border border-border bg-background/70" />
              <div className="h-10 rounded-[0.85rem] border border-border bg-background/70" />
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "execution-output",
    step: "Output",
    title: "View Execution Summary, Open PR",
    description: "View execution metrics, outcome summaries, or a polished trace snapshot.",
    content: (
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-[0.86fr_1.14fr]">
          <div className="grid gap-3">
            <div className="rounded-[1rem] border border-border bg-background/80 px-4 py-4">
              <div className="h-2.5 w-[4.5rem] rounded-full bg-foreground/12" />
              <div className="mt-4 grid gap-2">
                <div className="h-10 rounded-[0.85rem] border border-border bg-background/70" />
                <div className="h-10 rounded-[0.85rem] border border-border bg-background/70" />
              </div>
            </div>
            <div className="rounded-[1rem] border border-border bg-background/80 px-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="h-2.5 w-12 rounded-full bg-foreground/12" />
                  <div className="mt-3 h-8 rounded-[0.85rem] border border-border bg-background/70" />
                </div>
                <div>
                  <div className="h-2.5 w-16 rounded-full bg-foreground/12" />
                  <div className="mt-3 h-8 rounded-[0.85rem] border border-border bg-background/70" />
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-[1.2rem] border border-dashed border-border/90 bg-background/70 px-4 py-4">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-muted-foreground">
              Metrics
            </p>
            <div className="mt-4 grid gap-3">
              <div className="h-28 rounded-[1rem] border border-border bg-background/75" />
              <div className="grid grid-cols-3 gap-3">
                <div className="h-10 rounded-[0.85rem] border border-border bg-background/75" />
                <div className="h-10 rounded-[0.85rem] border border-border bg-background/75" />
                <div className="h-10 rounded-[0.85rem] border border-border bg-background/75" />
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
];

function wrapIndex(value: number, length: number) {
  return (value + length) % length;
}

function StackedHeroWindows() {
  const shouldReduceMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const total = heroWindows.length;

  const cycleWindows = (delta: 1 | -1) => {
    setActiveIndex((current) => wrapIndex(current + delta, total));
  };

  const windowTransition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div className="mx-auto w-full max-w-[42rem] lg:mx-0 lg:max-w-[46rem]">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div></div>
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background/75 p-1.5">
          <span className="px-2 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-muted-foreground">
            {String(activeIndex + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
          </span>
          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors duration-200 hover:bg-accent/45"
            aria-label="Show previous window"
            onClick={() => {
              cycleWindows(-1);
            }}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors duration-200 hover:bg-accent/45"
            aria-label="Show next window"
            onClick={() => {
              cycleWindows(1);
            }}
          >
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="relative min-h-[27rem] pb-16 pr-10 sm:min-h-[29rem] sm:pb-20 sm:pr-16 lg:min-h-[31rem] lg:pb-24 lg:pr-20">
        {heroWindows.map((window, index) => {
          const depth = wrapIndex(index - activeIndex, total);
          const isActive = depth === 0;
          const x = HERO_WINDOW_X_OFFSETS[depth] ?? 0;
          const y = HERO_WINDOW_Y_OFFSETS[depth] ?? 0;
          const scale = HERO_WINDOW_SCALES[depth] ?? 1;
          const opacity = HERO_WINDOW_OPACITIES[depth] ?? 1;

          return (
            <motion.section
              key={window.id}
              className={`absolute inset-0 origin-top-left overflow-hidden rounded-[1.75rem] border border-border bg-background ${isActive ? "pointer-events-auto" : "pointer-events-none"}`}
              initial={false}
              animate={{
                x,
                y,
                scale,
                opacity,
                filter: isActive
                  ? "drop-shadow(0 26px 42px rgba(0, 0, 0, 0.16))"
                  : "drop-shadow(0 18px 28px rgba(0, 0, 0, 0.08))",
              }}
              transition={windowTransition}
              style={{
                zIndex: total - depth,
              }}
            >
              <div className="flex items-center justify-between border-b border-border bg-muted/25 px-5 py-3">
                <div className="flex items-center gap-2.5" aria-hidden="true">
                  <span className="size-3 rounded-full bg-[#ff5f57]" />
                  <span className="size-3 rounded-full bg-[#ffbd2e]" />
                  <span className="size-3 rounded-full bg-[#28c840]" />
                </div>
                <p className="font-mono text-[0.64rem] uppercase tracking-[0.18em] text-muted-foreground">
                  {window.step}
                </p>
              </div>
              <div className="flex h-[calc(100%-3.25rem)] flex-col px-5 py-5 sm:px-6 sm:py-6">
                <div className="border-b border-border pb-4">
                  <h3 className="mt-3 font-display text-[2rem] uppercase leading-none tracking-[0.03em] text-foreground sm:text-[2.35rem]">
                    {window.title}
                  </h3>
                  <p className="mt-3 max-w-[42rem] text-sm leading-7 text-foreground/76 sm:text-[0.98rem]">
                    {window.description}
                  </p>
                </div>
                <div className="mt-5 flex-1">{window.content}</div>
              </div>
            </motion.section>
          );
        })}
      </div>
    </div>
  );
}

function MarketingPage() {
  return (
    <main>
      <section className="relative overflow-hidden border-b-2 border-ring bg-background text-foreground">
        <div className="pointer-events-none absolute -left-40 -top-32 size-[24rem] rounded-full bg-primary/16 blur-[130px] lg:-left-52 lg:-top-44 lg:size-[36rem] lg:blur-[170px]" />
        <div className="pointer-events-none absolute -right-44 top-1/3 size-[28rem] rounded-full bg-primary/14 blur-[180px] lg:-right-60 lg:top-1/4 lg:size-[44rem] lg:blur-[220px]" />
        <div className="relative mx-auto w-full max-w-[1720px] px-6 py-16 sm:px-8 sm:py-20 lg:grid lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[40px_640px_minmax(0,1fr)] lg:px-0 lg:py-0 xl:grid-cols-[40px_690px_minmax(0,1fr)]">
          <div className="hidden lg:block" aria-hidden="true" />
          <div className="flex items-center lg:border-r lg:border-border lg:py-0">
            <div className="w-full text-center lg:pl-[42px] lg:pr-10 lg:py-0 lg:text-left xl:pr-14">
              <h1 className="m-0 mx-auto max-w-[11ch] font-display text-[2.5rem] leading-[0.95] uppercase sm:text-[3rem] lg:mx-0 lg:max-w-[487px] lg:text-[48px] lg:leading-[48px] lg:tracking-[0.48px] xl:max-w-[11.5ch] xl:text-[56px] xl:leading-[54px] xl:tracking-[0.56px]">
                The open platform for tracked agent execution
              </h1>
              <p className="mx-auto mt-5 max-w-[34rem] text-sm leading-7 text-foreground/85 sm:mt-6 sm:text-base lg:mx-0 lg:max-w-[34rem] lg:text-[1.1rem]">
                A self-hosted platform for running isolated sandboxes, capturing execution history,
                and building modular developer workflows on top.
              </p>
              <AnimatedHeroCta />
            </div>
          </div>
          <div className="mt-12 flex items-center lg:mt-0 lg:pl-10 xl:pl-14">
            <StackedHeroWindows />
          </div>
        </div>
      </section>

      <section id="details" className="border-b-2 border-ring pt-1.5">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-10 sm:px-8 sm:py-12">
          <div>
            <p className="m-0 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Platform overview
            </p>
            <h2 className="m-0 max-w-[16ch] font-display text-[2.25rem] uppercase tracking-wide leading-none sm:text-5xl lg:text-6xl">
              Tracked software work, built on two core primitives.
            </h2>
            <p>
              Sealant centers two core primitives: sandboxes and executions. Workflow modules build
              on top of that foundation.
            </p>
          </div>
          <ol
            className="m-0 list-none border-t border-border p-0"
            aria-label="Sealant capabilities"
          >
            <li className="grid items-start gap-2 border-b border-border py-4 sm:gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                The Core
              </span>
              <p>
                Two core primitives: fast, highly customizable sandboxes and tracked software runs
                (executions). Sandboxes provide the isolated environment. Executions provide the
                durable record of what ran, what changed, and how the run completed.
              </p>
            </li>
            <li className="grid items-start gap-2 border-b border-border py-4 sm:gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                Observability
              </span>
              <p>
                Execution visibility is a core product surface. Sealant focuses first on state
                transitions, artifacts, diffs, and run summaries, with deeper tracing added over
                time.
              </p>
            </li>
            <li className="grid items-start gap-2 border-b border-border py-4 sm:gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                First-party modules
              </span>
              <p>
                Sealant is designed to support first-party workflow modules, starting with Issue
                Workflows. These modules are intended to exercise the same execution, artifact, and
                policy surfaces that future extension points will build on.
              </p>
            </li>
            <li className="grid items-start gap-2 border-b border-border py-4 sm:gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
              <span className="font-mono text-xs uppercase tracking-wider leading-6 text-muted-foreground">
                SDK &amp; extensions
              </span>
              <p>
                Sealant is being built with future extension seams in mind. Early extension points
                are expected around workflow hooks, reporters, runtime adapters, and first-party-
                style modules, with the public SDK formalized after those seams are proven in
                product use.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section id="opensource" className="py-12 pb-16">
        <div className="mx-auto max-w-7xl px-6 sm:px-8">
          <p className="m-0 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Open Source
          </p>
          <h2 className="m-0 max-w-[16ch] font-display text-[2.25rem] uppercase tracking-wide leading-none sm:text-5xl lg:text-6xl">
            Self-hosted by default.
          </h2>
          <p>
            Run Sealant inside your own boundary and build on an open platform for isolated, tracked
            software work.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              className="inline-flex min-h-11 items-center justify-center border border-primary bg-primary px-4 text-sm font-bold uppercase tracking-wider text-primary-foreground no-underline transition duration-200 hover:-translate-y-px hover:brightness-95 md:min-h-9 md:text-xs"
              href="https://github.com/sealant-ops/sealant"
              target="_blank"
              rel="noreferrer"
            >
              Explore repository
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
