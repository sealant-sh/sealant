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
  readonly children?: ReactNode;
}

export function WorkspacePage({ kicker, title, description, metrics, children }: WorkspacePageProps) {
  return (
    <section className="overflow-hidden border border-border bg-card">
      <div className="h-1 w-full bg-primary" />
      <div className="px-6 py-7 sm:px-8 sm:py-8">
        <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-muted-foreground">{kicker}</p>
        <h1 className="mt-4 font-display text-5xl leading-[0.88] tracking-[0.02em] uppercase text-foreground text-balance sm:text-6xl">
          {title}
        </h1>
        <p className="mt-5 max-w-3xl text-sm leading-7 text-muted-foreground">{description}</p>

        {metrics && metrics.length > 0 ? (
          <div className="mt-8 grid gap-px border border-border bg-border sm:grid-cols-3">
            {metrics.map((metric) => (
              <div key={metric.label} className="bg-card px-4 py-4">
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{metric.label}</p>
                <p className="mt-2 text-lg font-semibold text-foreground">{metric.value}</p>
              </div>
            ))}
          </div>
        ) : null}

        {children ? <div className="mt-8">{children}</div> : null}
      </div>
    </section>
  );
}
