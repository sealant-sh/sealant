import type { ReactNode } from "react";

import { LogoBlob, LogoText } from "@/components/app/Logo";
import { ThemeSwitcher } from "@/components/theme/theme-switcher";

interface AuthShellProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly accent?: "magenta" | "cyan";
}

const EVIDENCE_ROWS: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }> = [
  { label: "Repository", value: "acme/billing · #482" },
  { label: "Ref", value: "main @ 8f3c20a" },
  {
    label: "Tests",
    value: (
      <span>
        <span className="text-success">11 passed</span>
        <span className="text-faint"> · </span>
        <span className="text-danger">1 failed</span>
      </span>
    ),
  },
];

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <div className="min-h-svh bg-[var(--sw-canvas)] text-foreground">
      <div className="mx-auto flex min-h-svh w-full max-w-[1280px] flex-col px-6 py-6 sm:px-10 lg:px-12 lg:py-10">
        <header className="flex h-12 shrink-0 items-center justify-between">
          <a
            href="/login"
            className="inline-flex items-center gap-3 text-foreground no-underline"
            aria-label="Sealant home"
          >
            <LogoBlob className="size-7 shrink-0" />
            <LogoText className="h-6 shrink-0" />
          </a>
          <ThemeSwitcher />
        </header>

        <div className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-0">
          {/* Left — warm panel: headline + a restrained run-record flourish */}
          <section className="hidden lg:block">
            <p className="ev-eyebrow">Evidence review</p>
            <h1 className="mt-6 max-w-[18ch] font-display text-4xl leading-[1.05] font-semibold tracking-[-0.02em] text-foreground text-balance xl:text-5xl">
              {title}
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
              {description}
            </p>

            <div className="mt-12 max-w-md">
              <div className="overflow-hidden rounded-2xl border border-border bg-popover shadow-[var(--shadow-md)]">
                <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-5 py-3.5">
                  <span className="inline-flex items-center gap-2.5">
                    <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                    <span className="font-mono text-xs text-ink-2">run · wf_482</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                    <span className="size-1.5 rounded-full bg-success-dot" aria-hidden="true" />
                    Reviewable
                  </span>
                </div>
                <dl className="divide-y divide-rule-faint px-5">
                  {EVIDENCE_ROWS.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-baseline justify-between gap-4 py-2.5"
                    >
                      <dt className="font-mono text-[0.7rem] tracking-[0.02em] text-label">
                        {row.label}
                      </dt>
                      <dd className="text-right font-mono text-xs text-ink-2">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </section>

          {/* Right — elevated white form card */}
          <section className="w-full">
            <div className="mb-8 lg:hidden">
              <p className="ev-eyebrow">Evidence review</p>
              <h1 className="mt-4 max-w-[18ch] font-display text-3xl leading-[1.06] font-semibold tracking-[-0.02em] text-foreground text-balance">
                {title}
              </h1>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>

            <div className="mx-auto w-full max-w-md rounded-2xl border border-border bg-popover shadow-[var(--shadow-md)]">
              <div className="px-6 py-7 sm:px-8 sm:py-8">{children}</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
