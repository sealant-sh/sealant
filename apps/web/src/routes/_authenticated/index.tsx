import { Button } from "@sealant/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  component: HomePage,
});

function HomePage() {
  return (
    <section className="border border-steel bg-card px-6 py-8 sm:px-8 sm:py-10 lg:px-10">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.36em] text-white/45">Overview</p>
      <h1 className="mt-5 max-w-4xl text-5xl font-black uppercase leading-[0.9] tracking-[-0.06em] text-white text-balance sm:text-6xl">
        Private registry control for isolated development environments.
      </h1>
      <p className="mt-6 max-w-2xl text-base leading-8 text-white/66">
        Sign-in is active. The protected application surface is now available.
      </p>

      <div className="mt-10 grid gap-px border border-steel bg-steel md:grid-cols-3">
        {[
          ["Access", "Locked by default"],
          ["Session", "Server verified"],
          ["State", "Query backed"],
        ].map(([label, value]) => (
          <div key={label} className="bg-card px-5 py-5">
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.3em] text-white/45">{label}</p>
            <p className="mt-3 text-lg font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link to="/registry" className="no-underline">
          <Button className="h-12 rounded-none bg-neon-magenta px-5 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]">
            Open Registry
            <ArrowRight className="size-4" />
          </Button>
        </Link>
        <Link to="/about" className="no-underline">
          <Button variant="outline" className="h-12 rounded-none border-steel bg-transparent px-5 text-[0.72rem] font-black uppercase tracking-[0.32em] text-white hover:border-white hover:bg-white/5">
            Platform Brief
          </Button>
        </Link>
      </div>
    </section>
  );
}
