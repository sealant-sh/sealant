import { Button } from "@sealant/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  component: HomePage,
});

function HomePage() {
  return (
    <section className="border border-border bg-card px-6 py-8 sm:px-8 sm:py-10 lg:px-10">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">Overview</p>
      <h1 className="mt-5 max-w-4xl font-display text-6xl uppercase leading-[0.86] tracking-[0.02em] text-foreground text-balance sm:text-7xl">
        Private registry control for isolated development environments.
      </h1>
      <p className="mt-6 max-w-2xl text-base leading-8 text-muted-foreground">
        Sign-in is active. The protected application surface is now available.
      </p>

      <div className="mt-10 grid gap-px border border-border bg-border md:grid-cols-3">
        {[
          ["Access", "Locked by default"],
          ["Session", "Server verified"],
          ["State", "Query backed"],
        ].map(([label, value]) => (
          <div key={label} className="bg-card px-5 py-5">
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
            <p className="mt-3 text-lg font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link to="/registry" className="no-underline">
          <Button className="h-12 px-5">
            Open Registry
            <ArrowRight className="size-4" />
          </Button>
        </Link>
        <Link to="/about" className="no-underline">
          <Button variant="outline" className="h-12 px-5">
            Platform Brief
          </Button>
        </Link>
      </div>
    </section>
  );
}
