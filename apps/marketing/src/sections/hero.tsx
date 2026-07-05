// THE HERO — agent work, returned as reviewable engineering work. A centered claim,
// then the full Run-Review Exhibit as the hero screenshot: the reviewed run the
// harness handed back. Static-legible; the page opens on a run that is ready to review.

import { motion, useReducedMotion } from "framer-motion";

import { GitHubLogo } from "#/components/github";
import {
  Container,
  InstallCommand,
  PrimaryCTA,
  REPO_URL,
  riseChild,
  riseParent,
  SecondaryCTA,
} from "#/components/primitives";
import { RunTimeline } from "#/components/run-timeline";

export function Hero() {
  const reduce = useReducedMotion();
  const parent = reduce
    ? {}
    : { variants: riseParent, initial: "hidden" as const, animate: "show" as const };
  const child = reduce ? {} : { variants: riseChild };

  return (
    <section className="relative overflow-hidden bg-[var(--sw-canvas)]">
      <div
        className="sealant-dot-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_50%_0%,black,transparent_70%)]"
        aria-hidden="true"
      />
      <Container className="py-20 lg:py-28">
        <motion.div className="mx-auto max-w-[58ch] text-center" {...parent}>
          <motion.div {...child}>
            <span className="ev-eyebrow inline-flex items-center gap-2 text-primary">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
              Open-source runtime for agentic development
            </span>
          </motion.div>
          <motion.h1
            {...child}
            className="mt-6 font-display text-[2.5rem] leading-[1.05] font-semibold tracking-[-0.03em] text-foreground text-balance sm:text-5xl lg:text-[3.4rem]"
          >
            Turn agent work into reviewable engineering work.
          </motion.h1>
          <motion.p
            {...child}
            className="mx-auto mt-6 max-w-[58ch] text-lg leading-relaxed text-muted-foreground"
          >
            Sealant gives coding harnesses a self-hosted sandbox to work in, then turns every run
            into a structured record you can replay and review: code changes, checks, terminal
            output, artifacts, browser evidence, and the source trail behind the result.
          </motion.p>
          <motion.div {...child} className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <PrimaryCTA href={REPO_URL}>
              <GitHubLogo className="size-4" />
              GitHub
            </PrimaryCTA>
            <SecondaryCTA href={REPO_URL}>Run the demo</SecondaryCTA>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center px-1 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
            >
              Read the SDK docs
            </a>
          </motion.div>
          <motion.div {...child} className="mt-7 flex justify-center">
            <InstallCommand />
          </motion.div>
          <motion.p {...child} className="mt-5 font-mono text-xs text-faint">
            Open source · Self-hosted · Bring your own harness · Replayable runs
          </motion.p>
        </motion.div>

        <motion.div
          className="mt-14 lg:mt-16"
          {...(reduce
            ? {}
            : {
                initial: { opacity: 0, y: 24 },
                animate: { opacity: 1, y: 0 },
                transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.2 },
              })}
        >
          <RunTimeline lift illustrative />
        </motion.div>
      </Container>
    </section>
  );
}
