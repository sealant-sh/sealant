import { createFileRoute } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-16">
      {/* Hero */}
      <div className="mb-16">
        <p className="font-mono text-xs tracking-widest uppercase text-secondary mb-4">
          VOID ISOLATION ENGINES
        </p>
        <h1 className="font-black text-6xl tracking-tight uppercase leading-none text-foreground sm:text-8xl">
          SEALANT
        </h1>
        <p className="mt-6 max-w-xl font-mono text-sm text-muted-foreground leading-relaxed">
          Spin up isolated, ready-to-code microVM development environments.
          Pick a repository, an AI harness, and go.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/registry"
            className="inline-flex items-center gap-2 border border-transparent bg-primary px-5 py-2.5 font-black text-sm tracking-widest uppercase text-primary-foreground no-underline transition-opacity hover:opacity-90"
          >
            VIEW REGISTRY
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>

      {/* Feature grid */}
      <div className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(({ title, desc }) => (
          <div key={title} className="bg-card p-6">
            <h2 className="font-black text-xs tracking-widest uppercase text-foreground mb-2">
              {title}
            </h2>
            <p className="font-mono text-xs text-muted-foreground leading-relaxed">
              {desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

const FEATURES = [
  {
    title: 'ISOLATED',
    desc: 'Each workspace is a disposable microVM — your host is never touched.',
  },
  {
    title: 'AI NATIVE',
    desc: 'Pre-configured harnesses for OpenCode, Codex, and Claude Code.',
  },
  {
    title: 'REPRODUCIBLE',
    desc: 'Nix-built OCI images from a single spec. Same env every time.',
  },
  {
    title: 'YOURS',
    desc: 'Self-hosted. No accounts, no SaaS. Your registry, your rules.',
  },
]
