import type { ReactNode } from "react";

interface MetricItem {
  readonly label: string;
  readonly value: string;
}

interface SandboxPageProps {
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly metrics?: readonly MetricItem[];
  readonly children?: ReactNode;
}

export function SandboxPage({
  kicker,
  title,
  description,
  metrics,
  children,
}: SandboxPageProps) {
  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <div className="px-6 py-7 sm:px-8 sm:py-8">
        <p className="ev-eyebrow">{kicker}</p>
        <h1 className="mt-2 text-xl text-balance sm:text-2xl">{title}</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground">{description}</p>

        {metrics && metrics.length > 0 ? (
          <dl className="mt-8 grid gap-x-8 gap-y-5 border-t border-border pt-6 sm:grid-cols-3">
            {metrics.map((metric) => (
              <div key={metric.label}>
                <dt className="ev-eyebrow">{metric.label}</dt>
                <dd className="mt-1.5 font-mono text-sm text-foreground">{metric.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {children ? <div className="mt-8">{children}</div> : null}
      </div>
    </section>
  );
}
