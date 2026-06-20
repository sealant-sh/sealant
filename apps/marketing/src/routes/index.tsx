import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/" as never)({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-20">
        <p className="font-mono text-sm tracking-[0.18em] text-muted-foreground uppercase">
          Sealant
        </p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Isolated, reproducible coding environments.
        </h1>
        <p className="mt-6 text-base leading-7 text-muted-foreground sm:text-lg">
          The public site is intentionally minimal while the product work continues in the app.
        </p>
      </section>
    </main>
  );
}
