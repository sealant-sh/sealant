import type { ReactNode } from "react";

import { LogoBlob, LogoText } from "@/components/app/Logo";
import { ThemeSwitcher } from "@/components/theme/theme-switcher";

interface AuthShellProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly accent?: "magenta" | "cyan";
}

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <div className="relative min-h-svh overflow-hidden bg-[var(--sw-canvas)] text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,color-mix(in_oklab,var(--sw-rule)_16%,transparent)_1px,transparent_0)] [background-size:22px_22px] opacity-15" />
      <div className="pointer-events-none absolute left-0 top-0 h-0.5 w-full bg-primary" />

      <div className="relative mx-auto flex min-h-svh w-full max-w-[1200px] flex-col px-6 py-6 sm:px-10 lg:px-12">
        <header className="flex h-16 items-center justify-between border-b border-border">
          <div className="flex items-center gap-3 text-foreground">
            <LogoBlob className="size-7 shrink-0" />
            <LogoText className="h-6 shrink-0" />
          </div>
          <ThemeSwitcher className="hidden sm:inline-flex" />
        </header>

        <div className="pt-4 sm:hidden">
          <ThemeSwitcher />
        </div>

        <div className="flex flex-1 items-center py-12 lg:grid lg:grid-cols-12 lg:gap-12 lg:py-0">
          <section className="lg:col-span-6">
            <div className="max-w-xl">
              <p className="ev-eyebrow">Evidence review</p>
              <h1 className="mt-5 text-4xl leading-tight font-semibold tracking-[-0.016em] text-foreground text-balance sm:text-5xl">
                {title}
              </h1>
              <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          </section>

          <section className="mt-10 rounded-md border border-border bg-popover shadow-[var(--shadow-overlay)] lg:col-span-5 lg:col-start-8 lg:mt-0">
            <div className="px-6 py-7 sm:px-7">{children}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
