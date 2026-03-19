import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({ component: AboutPage })

function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12">
      <p className="font-mono text-xs tracking-widest uppercase text-secondary mb-4">
        ABOUT
      </p>
      <h1 className="font-black text-5xl tracking-tight uppercase leading-none text-foreground mb-6">
        SEALANT
      </h1>
      <p className="max-w-3xl font-mono text-sm text-muted-foreground leading-relaxed">
        Sealant provisions isolated, personal, reproducible development environments
        from a polished control UI. Pick a Git repository, an AI coding harness,
        and optional personalization inputs — Sealant turns those into a composed,
        disposable microVM runtime.
      </p>
    </div>
  )
}
