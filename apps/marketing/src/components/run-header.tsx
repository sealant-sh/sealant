// The ambient run-header playhead — the page's single aesthetic risk (§10).
// A persistent run-id + recording pulse + an offset that advances with scroll, so
// reading the page subliminally replays one run: it opens on workspace.ready (hero)
// and reaches run.completed at the final CTA.
//
// Discipline: hairline-quiet, single cobalt accent, fully static-degradable (under
// reduced motion the offset shows its final value), and never required to understand
// what Sealant is. Removable without breaking the page.

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";

export const RUN_ID = "run_ws_8m2k";
const RUN_END_MS = 25_110;

function formatMs(ms: number): string {
  const clamped = Math.max(0, Math.min(RUN_END_MS, ms));
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(clamped % 1000);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

export function RunHeaderClock() {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const clock = useTransform(scrollYProgress, (p) => formatMs(p * RUN_END_MS));

  return (
    <span
      className="hidden items-center gap-2 font-mono text-xs text-faint sm:inline-flex"
      aria-hidden="true"
    >
      <span className="sealant-status-running size-1.5 rounded-full bg-primary" />
      <span className="text-muted-foreground">{RUN_ID}</span>
      <span className="tabular-nums">
        {reduce ? formatMs(RUN_END_MS) : <motion.span>{clock}</motion.span>}
      </span>
    </span>
  );
}
