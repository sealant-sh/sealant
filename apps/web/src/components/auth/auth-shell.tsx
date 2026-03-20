import type { ReactNode } from "react";

import { cn } from "@sealant/ui";

import { ThemeSwitcher } from "@/components/theme/theme-switcher";

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
    rail: "bg-primary",
    badge: "border-primary/40 bg-primary/10 text-primary",
    minor: "text-primary",
  },
  cyan: {
    rail: "bg-primary",
    badge: "border-primary/40 bg-primary/10 text-primary",
    minor: "text-primary",
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
    <div className="relative min-h-svh overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,color-mix(in_oklab,var(--sw-rule)_6%,transparent)_1px,transparent_1px)] [background-size:calc(100%/12)_100%] opacity-55" />
      <div className={cn("pointer-events-none absolute left-0 top-0 h-1 w-full", styles.rail)} />
      <div className="pointer-events-none absolute left-[8.333%] top-0 h-full w-px bg-border" />

      <div className="relative mx-auto flex min-h-svh w-full max-w-[1440px] flex-col px-8 py-8 sm:px-10 lg:px-12">
        <header className="flex h-20 items-center justify-between border-b-2 border-foreground">
          <div>
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.24em] text-muted-foreground">Sealant</p>
            <p className="mt-2 text-sm font-semibold uppercase tracking-[0.12em] text-foreground">Operator Access</p>
          </div>
          <div className="flex items-center gap-3">
            <ThemeSwitcher className="hidden sm:inline-flex" />
            <span className={cn("inline-flex items-center border px-3 py-1 font-mono text-[0.65rem] uppercase tracking-[0.34em]", styles.badge)}>
              {badge}
            </span>
          </div>
        </header>

        <div className="pt-4 sm:hidden">
          <ThemeSwitcher />
        </div>

        <div className="flex flex-1 items-center py-12 lg:grid lg:grid-cols-12 lg:gap-8 lg:py-0">
          <section className="lg:col-span-7 xl:col-span-8">
            <div className="max-w-3xl">
              <p className={cn("font-mono text-[0.7rem] uppercase tracking-[0.22em]", styles.minor)}>{asideTitle}</p>
              <h1 className="mt-6 font-display text-6xl uppercase leading-[0.84] tracking-[0.02em] text-foreground text-balance sm:text-7xl xl:text-[5.5rem]">
                {title}
              </h1>
              <p className="mt-6 max-w-xl text-base leading-8 text-muted-foreground">{description}</p>

              <div className="mt-10 max-w-md border-l-2 border-foreground pl-4">
                <p className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">{asideTitle}</p>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">{asideCopy}</p>
              </div>
            </div>
          </section>

          <section className="mt-10 border border-border bg-card lg:col-span-5 lg:col-start-8 lg:mt-0 xl:col-span-4 xl:col-start-9">
            <div className={cn("h-1 w-full", styles.rail)} />
            <div className="border-t border-border px-5 py-6 sm:px-6 sm:py-7">{children}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
