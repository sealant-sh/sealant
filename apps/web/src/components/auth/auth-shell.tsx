import type { ReactNode } from "react";

import { cn } from "@sealant/ui";

interface AuthShellProps {
  readonly badge: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly asideTitle: string;
  readonly asideCopy: string;
  readonly accent?: "magenta" | "cyan";
}

const accentStyles = {
  magenta: {
    rail: "bg-neon-magenta",
    badge: "border-neon-magenta/40 bg-neon-magenta/12 text-neon-magenta",
    minor: "text-neon-magenta/80",
  },
  cyan: {
    rail: "bg-neon-cyan",
    badge: "border-neon-cyan/40 bg-neon-cyan/12 text-neon-cyan",
    minor: "text-neon-cyan/80",
  },
} as const;

export function AuthShell({
  badge,
  title,
  description,
  children,
  asideTitle,
  asideCopy,
  accent = "magenta",
}: AuthShellProps) {
  const styles = accentStyles[accent];

  return (
    <div className="relative min-h-svh overflow-hidden bg-abyss text-white">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:calc(100%/12)_100%] opacity-50" />
      <div className={cn("pointer-events-none absolute left-0 top-0 h-1 w-full", styles.rail)} />
      <div className="pointer-events-none absolute left-[8.333%] top-0 h-full w-px bg-white/8" />

      <div className="relative mx-auto flex min-h-svh w-full max-w-[1440px] flex-col px-8 py-8 sm:px-10 lg:px-12">
        <header className="flex h-20 items-center justify-between border-b border-steel">
          <div>
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.42em] text-white/45">Sealant</p>
            <p className="mt-2 text-sm font-semibold uppercase tracking-[0.2em] text-white">Operator Access</p>
          </div>
          <span className={cn("inline-flex items-center border px-3 py-1 font-mono text-[0.65rem] uppercase tracking-[0.34em]", styles.badge)}>
            {badge}
          </span>
        </header>

        <div className="flex flex-1 items-center py-12 lg:grid lg:grid-cols-12 lg:gap-8 lg:py-0">
          <section className="lg:col-span-7 xl:col-span-8">
            <div className="max-w-3xl">
              <p className={cn("font-mono text-[0.7rem] uppercase tracking-[0.42em]", styles.minor)}>{asideTitle}</p>
              <h1 className="mt-6 text-5xl font-black uppercase leading-[0.88] tracking-[-0.06em] text-white text-balance sm:text-6xl xl:text-[5.1rem]">
                {title}
              </h1>
              <p className="mt-6 max-w-xl text-base leading-8 text-white/68">{description}</p>

              <div className="mt-10 max-w-md border-l-2 border-white/10 pl-4">
                <p className="font-mono text-[0.68rem] uppercase tracking-[0.32em] text-white/45">{asideTitle}</p>
                <p className="mt-3 text-sm leading-7 text-white/62">{asideCopy}</p>
              </div>
            </div>
          </section>

          <section className="mt-10 border border-steel bg-card lg:col-span-5 lg:col-start-8 lg:mt-0 xl:col-span-4 xl:col-start-9">
            <div className={cn("h-1 w-full", styles.rail)} />
            <div className="border-t border-steel px-5 py-6 sm:px-6 sm:py-7">{children}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
