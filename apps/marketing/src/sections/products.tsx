// Products by Sealant — the platform, productized. Each is its own open-source
// product on the public SDK, the same create → run → audit loop focused on one job.
// This replaces the "one runtime, many shapes" gallery: the shapes are now named
// products. Status is honest — one is being built, the rest are on the roadmap.

import { ArrowRight } from "lucide-react";

import { Container, Eyebrow, REPO_URL, Reveal, SectionHead } from "#/components/primitives";

type ProductStatus = "building" | "roadmap";

interface Product {
  readonly name: string;
  readonly pattern: string;
  readonly desc: string;
  readonly status: ProductStatus;
}

const PRODUCTS: ReadonlyArray<Product> = [
  {
    name: "Mend",
    pattern: "issue → reviewed change → PR",
    desc: "Give a coding harness an engineering task and get back the change, the checks, the artifacts, and the full record — ending in a pull request.",
    status: "building",
  },
  {
    name: "Witness",
    pattern: "flow → evidence → test",
    desc: "Drive a real browser flow and keep the screenshots, DOM snapshots, and network evidence as a test you can actually trust.",
    status: "roadmap",
  },
  {
    name: "Rerun",
    pattern: "failing job → replayable repro",
    desc: "Recreate a failed CI job in a clean sandbox and keep the commands, logs, and failure state as a case you can replay.",
    status: "roadmap",
  },
  {
    name: "Bump",
    pattern: "update → checks → reviewed patch",
    desc: "Let a harness update dependencies, run the checks, and present the exact diff for review.",
    status: "roadmap",
  },
];

function StatusTag({ status }: { status: ProductStatus }) {
  if (status === "building") {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-warning-dot" aria-hidden="true" />
        <span className="font-mono text-xs text-warning">Building now</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span
        className="size-1.5 rounded-full bg-transparent ring-[1.5px] ring-[#b3b0a8]"
        aria-hidden="true"
      />
      <span className="font-mono text-xs text-muted-foreground">On the roadmap</span>
    </span>
  );
}

function ProductCard({ product }: { product: Product }) {
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-xs)] sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-xl font-semibold tracking-[-0.02em] text-foreground">
            {product.name}
          </h3>
          <span className="font-mono text-xs text-faint">by Sealant</span>
        </div>
        <StatusTag status={product.status} />
      </div>
      <p className="mt-4 font-mono text-sm text-primary">{product.pattern}</p>
      <p className="mt-3 leading-relaxed text-muted-foreground">{product.desc}</p>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-5 inline-flex items-center gap-1 font-sans text-sm font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
      >
        Follow on GitHub
        <ArrowRight className="size-4" aria-hidden="true" />
      </a>
    </div>
  );
}

export function Products() {
  return (
    <section id="products" className="bg-[var(--sw-canvas)] py-24 lg:py-32">
      <Container>
        <SectionHead
          eyebrow={<Eyebrow>Products by Sealant</Eyebrow>}
          title="One runtime. A family of products on top."
          intro={
            <p>
              Each is its own open-source product on the public SDK — the same create → run → audit
              loop, focused on one job.
            </p>
          }
        />
        <Reveal className="mt-12 grid gap-5 sm:grid-cols-2">
          {PRODUCTS.map((product) => (
            <ProductCard key={product.name} product={product} />
          ))}
        </Reveal>
      </Container>
    </section>
  );
}
