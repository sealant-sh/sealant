import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/about")({ component: AboutPage });

function AboutPage() {
  return (
    <section className="border border-border bg-card px-6 py-8 sm:px-8 sm:py-10 lg:px-10">
      <p className="font-mono text-[0.68rem] tracking-[0.16em] text-muted-foreground">
        Platform Brief
      </p>
      <h1 className="mt-5 font-display text-6xl tracking-[0.02em] leading-[0.86] text-foreground sm:text-7xl">
        Sealant
      </h1>
      <p className="mt-6 max-w-3xl text-base leading-8 text-muted-foreground">
        Sealant provisions isolated development environments from a private control plane.
        Repositories, build inputs, and runtime settings stay behind authentication while the
        execution layer remains disposable.
      </p>
    </section>
  );
}
