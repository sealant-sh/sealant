import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/about")({ component: AboutPage });

function AboutPage() {
  return (
    <section className="border border-steel bg-card px-6 py-8 sm:px-8 sm:py-10 lg:px-10">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.36em] text-white/45">Platform Brief</p>
      <h1 className="mt-5 text-5xl font-black uppercase tracking-[-0.06em] leading-[0.9] text-white sm:text-6xl">Sealant</h1>
      <p className="mt-6 max-w-3xl text-base leading-8 text-white/66">
        Sealant provisions isolated development environments from a private control plane. Repositories, build inputs,
        and runtime settings stay behind authentication while the execution layer remains disposable.
      </p>
    </section>
  );
}
