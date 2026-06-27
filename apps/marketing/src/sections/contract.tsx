// The platform backbone. One contract defines the primitives; the SDK is the public
// surface on top of the low-level client. The right column is a vertical stack diagram
// (your code → SDK → wire contract → runtime), with the runtime layer carrying the
// hero's cobalt-lift motif and a small fan of language tags under the contract layer.

import { ChevronDown } from "lucide-react";

import { Callout, Container, Display, Eyebrow, Reveal } from "#/components/primitives";

interface Layer {
  readonly label: string;
  readonly sub: string;
  readonly highlight?: boolean;
}

const STACK: ReadonlyArray<Layer> = [
  { label: "Your code", sub: "the agent you bring" },
  { label: "Fluent SDK", sub: "@sealant/sdk" },
  { label: "Wire contract", sub: ".proto · Protobuf over a local socket" },
  { label: "sealantd runtime", sub: "sandboxes · runs · harness", highlight: true },
];

const LANGS: ReadonlyArray<{ name: string; ready?: boolean }> = [
  { name: "TypeScript", ready: true },
  { name: "Go" },
  { name: "Python" },
  { name: "Java" },
];

function StackLayer({ layer }: { layer: Layer }) {
  return (
    <div
      className={`rounded-xl border bg-panel px-4 py-3 font-mono text-sm ${
        layer.highlight
          ? "border-primary/30 shadow-[var(--shadow-cobalt)]"
          : "border-border shadow-[var(--shadow-xs)]"
      }`}
    >
      <span className="text-foreground">{layer.label}</span>
      <span className="text-faint"> · {layer.sub}</span>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center py-1.5" aria-hidden="true">
      <ChevronDown className="size-4 text-faint" />
    </div>
  );
}

function LangTag({ name, ready }: { name: string; ready?: boolean }) {
  if (ready) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1 font-mono text-xs text-foreground shadow-[var(--shadow-xs)]">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        {name}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-transparent px-2.5 py-1 font-mono text-xs text-muted-foreground">
      {name}
      <span className="text-[0.62rem] tracking-[0.04em] text-faint uppercase">planned</span>
    </span>
  );
}

export function Contract() {
  return (
    <section id="contract" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal className="max-w-[52ch]">
            <Eyebrow>One contract, one SDK</Eyebrow>
            <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
              Composable. Multi-language. No lock-in.
            </Display>
            <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
              The primitives are defined once in a wire contract — the Protobuf control protocol
              over a local socket. The fluent SDK is the public surface on top of the low-level
              client.
            </p>
            <Callout className="mt-6">
              You import the SDK; the SDK speaks the contract; the contract is the single source of
              truth.
            </Callout>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              That same schema generates typed clients in other languages.
            </p>
          </Reveal>

          <div className="min-w-0">
            <StackLayer layer={STACK[0]!} />
            <Connector />
            <StackLayer layer={STACK[1]!} />
            <Connector />
            <StackLayer layer={STACK[2]!} />
            <div className="flex flex-wrap gap-2 px-1 pt-3 pb-1">
              {LANGS.map((lang) => (
                <LangTag key={lang.name} name={lang.name} ready={lang.ready ?? false} />
              ))}
            </div>
            <Connector />
            <StackLayer layer={STACK[3]!} />
          </div>
        </div>
      </Container>
    </section>
  );
}
