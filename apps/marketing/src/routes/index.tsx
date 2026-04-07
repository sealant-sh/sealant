import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { ClipboardClock, Container as ContainerIcon, Hammer, type LucideIcon } from "lucide-react";

export const Route = createFileRoute("/" as never)({
  component: MarketingPage,
});

const HERO_CTA_CYCLE = 5.4;
const HERO_ICON_PULSE = 0.58;
const HERO_WAVE_DRAW = 0.72;
const HERO_WAVE_PATH =
  "M1 10C6.4 10 6.4 2 11.8 2C17.2 2 17.2 18 22.6 18C28 18 28 2 33.4 2C38.8 2 38.8 18 44.2 18C49.6 18 49.6 10 55 10";

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
    <div className="mx-auto mt-8 flex w-full items-center justify-center gap-2 text-foreground sm:mt-10 sm:gap-4 lg:mt-6 lg:gap-5">
      <AnimatedHeroIcon Icon={Hammer} start={0.2} />
      <HeroWave start={0.88} />
      <AnimatedHeroIcon Icon={ContainerIcon} start={1.72} />
      <HeroWave start={2.42} />
      <AnimatedHeroIcon Icon={ClipboardClock} start={3.28} />
    </div>
  );
}

function MarketingPage() {
  return (
    <main>
      <section className="relative overflow-hidden border-b-2 border-ring bg-background text-foreground">
        <div className="pointer-events-none absolute -left-40 -top-32 size-[24rem] rounded-full bg-primary/16 blur-[130px] lg:-left-52 lg:-top-44 lg:size-[36rem] lg:blur-[170px]" />
        <div className="pointer-events-none absolute -right-44 top-1/3 size-[28rem] rounded-full bg-primary/14 blur-[180px] lg:-right-60 lg:top-1/4 lg:size-[44rem] lg:blur-[220px]" />
        <div className="relative mx-auto w-full max-w-[1720px] px-6 py-16 sm:px-8 sm:py-20 lg:grid lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[40px_710px_minmax(0,1fr)] lg:px-0 lg:py-0">
          <div className="hidden lg:block" aria-hidden="true" />
          <div className="flex items-center lg:border-r lg:border-border lg:py-0">
            <div className="w-full text-center lg:pl-[42px] lg:pr-[15px] lg:py-0">
              <h1 className="m-0 mx-auto max-w-[11ch] font-display text-[2.5rem] leading-[0.95] uppercase sm:text-[3rem] lg:max-w-[487px] lg:text-[48px] lg:leading-[48px] lg:tracking-[0.48px]">
                The open platform for tracked agent execution
              </h1>
              <p className="mt-5 mx-auto max-w-[34rem] text-sm leading-7 text-foreground/85 sm:mt-6 sm:text-base lg:max-w-[582px] lg:text-[1.1rem]">
                A self-hosted platform for running isolated sandboxes, capturing execution history,
                and building modular developer workflows on top.
              </p>
              <AnimatedHeroCta />
            </div>
          </div>
          <div className="hidden lg:block" aria-hidden="true" />
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
