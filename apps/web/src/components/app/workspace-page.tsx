import type { ReactNode } from "react";

interface MetricItem {
  readonly label: string;
  readonly value: string;
}

interface WorkspacePageProps {
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly metrics?: readonly MetricItem[];
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}

export function WorkspacePage({
  kicker,
  title,
  description,
  metrics,
  action,
  children,
}: WorkspacePageProps) {
  return (
    <section className="space-y-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="ev-eyebrow">{kicker}</p>
          <h1 className="mt-2.5 font-display text-2xl font-semibold tracking-tight text-balance text-foreground sm:text-3xl">
            {title}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>

      {metrics && metrics.length > 0 ? (
        <dl className="overflow-hidden rounded-2xl border border-border bg-card p-2 shadow-[var(--shadow-sm)] sm:grid sm:grid-cols-3">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="border-b border-rule-faint px-5 py-4 last:border-b-0 sm:border-b-0"
            >
              <dt className="ev-eyebrow">{metric.label}</dt>
              <dd className="mt-2 font-mono text-sm text-ink-2">{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {children ? <div>{children}</div> : null}
    </section>
  );
}
