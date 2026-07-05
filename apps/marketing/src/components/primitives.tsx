// Shared marketing primitives. The dark CodePanel is retained but, per the design
// direction (§10), it is now a SUPPORTING prop — used only for SSH, the Quickstart,
// and the indictment "wall of logs" foil. The hero/feature visual is the RunRecord
// Exhibit (see run-record.tsx).

import { motion, useReducedMotion, type Variants } from "framer-motion";
import { ArrowRight, ArrowUpRight, Check, Copy } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";

export const REPO_URL = "https://github.com/sealant-sh/sealant";

export const riseParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

export const riseChild: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-[1200px] px-6 sm:px-8 ${className}`}>{children}</div>
  );
}

export function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <span
      className={`ev-eyebrow inline-flex items-center gap-2 ${dark ? "text-[#9db4f0]" : "text-primary"}`}
    >
      <span
        className={`size-1.5 rounded-full ${dark ? "bg-[#9db4f0]" : "bg-primary"}`}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

export function Display({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={`font-display font-semibold tracking-[-0.02em] text-foreground text-balance ${className}`}
    >
      {children}
    </h2>
  );
}

export function SectionHead({
  eyebrow,
  title,
  intro,
  className = "max-w-[56ch]",
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  className?: string;
}) {
  return (
    <Reveal className={className}>
      {eyebrow}
      <Display className="mt-5 text-[2rem] leading-[1.08] sm:text-4xl lg:text-[2.85rem]">
        {title}
      </Display>
      {intro ? (
        <div className="mt-5 space-y-4 text-lg leading-relaxed text-muted-foreground">{intro}</div>
      ) : null}
    </Reveal>
  );
}

// The one filled cobalt-lift button. Default label is the adoption ask.
export function PrimaryCTA({ href = REPO_URL, children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 font-sans text-sm font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
    >
      {children}
      <ArrowUpRight
        className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        aria-hidden="true"
      />
    </a>
  );
}

export function SecondaryCTA({
  href = REPO_URL,
  children,
  external = true,
}: {
  href?: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-panel px-5 font-sans text-sm font-medium text-foreground no-underline shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[var(--shadow-sm)]"
    >
      {children}
      <ArrowRight className="size-4" aria-hidden="true" />
    </a>
  );
}

export const INSTALL_COMMAND = "curl -fsSL https://get.sealant.dev | sh";

// The self-host installer as a copyable one-liner — the whole install, in the page's
// quiet light-mono idiom (not a dark terminal panel).
export function InstallCommand({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div
      className={`inline-flex min-h-11 max-w-full items-center gap-3 rounded-xl border border-rule bg-[var(--sw-sunken)] py-2 pr-2 pl-4 shadow-[var(--shadow-xs)] ${className}`}
    >
      <code className="overflow-x-auto font-mono text-[0.8rem] whitespace-nowrap text-ink-2">
        <span className="text-faint select-none">$ </span>
        {INSTALL_COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy install command"}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--sw-wash)] hover:text-primary"
      >
        {copied ? (
          <Check className="size-4 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// A quiet mono trust line.
export function TrustLine({ className = "" }: { className?: string }) {
  return (
    <p className={`font-mono text-xs text-faint ${className}`}>
      TypeScript SDK · self-hosted · open-source
    </p>
  );
}

// Cobalt left-edge callout — an open statement, never a tinted alarm panel.
export function Callout({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border-l-2 border-l-primary bg-panel py-4 pr-6 pl-5 shadow-[var(--shadow-sm)] ${className}`}
    >
      <p className="leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

export function InDevBadge({ children = "In development" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-[var(--sw-wash)] px-2 py-0.5 font-mono text-[0.62rem] font-medium tracking-[0.08em] text-primary uppercase">
      {children}
    </span>
  );
}

// Dark terminal — supporting prop only (SSH, Quickstart, the indictment foil).
export function CodePanel({
  title,
  children,
  footer,
  dim = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-2xl border border-border bg-[#1c1c1f] shadow-[var(--shadow-lg)] ${dim ? "opacity-70 saturate-50" : ""}`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
        <span className="font-mono text-xs text-white/55">{title}</span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-primary/70" />
        </span>
      </div>
      <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.8rem] leading-[1.7]">
        <code>{children}</code>
      </pre>
      {footer}
    </div>
  );
}

export function Code({ lines }: { lines: ReadonlyArray<string> }) {
  return (
    <>
      {lines.map((text, i) => {
        const member = /^\s{2,}[A-Za-z_]\w*,?$/.test(text);
        return (
          <span key={i} className={`block ${member ? "text-[#9db4f0]" : "text-[#e6e6ea]"}`}>
            {text === "" ? " " : text}
          </span>
        );
      })}
    </>
  );
}

export type IconType = ComponentType<{ className?: string }>;
