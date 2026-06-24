import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { type ReactNode } from "react";

import { LogoBlob } from "#/components/logo";

import appCss from "../styles.css?url";

const REPO = "https://github.com/get-sealant/sealant";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Sealant — the runtime for AI developer agents",
      },
      {
        name: "description",
        content:
          "Create an isolated sandbox for any repository, run its harness, connect over SSH, and get back the result with a complete, replayable record of how it was produced.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="marketing-body" id="top">
        <header className="sticky top-0 z-40 border-b border-border/60 bg-[color-mix(in_oklab,var(--sw-canvas)_82%,transparent)] backdrop-blur-md">
          <div className="mx-auto flex min-h-16 max-w-[1200px] items-center justify-between gap-3 px-6 sm:px-8">
            <div className="flex items-center gap-9">
              <Brand />
              <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
                <TopLevelNavLink href="#platform">Platform</TopLevelNavLink>
                <TopLevelNavLink href="#products">Products</TopLevelNavLink>
                <TopLevelNavLink href={REPO}>Documentation</TopLevelNavLink>
                <TopLevelNavLink href={REPO}>GitHub</TopLevelNavLink>
              </nav>
            </div>
            <div className="hidden items-center gap-2.5 md:inline-flex">
              <ThemeSwitcher />
              <a
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 font-sans text-sm font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
                href={REPO}
                target="_blank"
                rel="noreferrer"
              >
                Start building
              </a>
            </div>
            <div className="inline-flex items-center gap-2 md:hidden">
              <ThemeSwitcher compact />
            </div>
          </div>
        </header>
        <Outlet />
        <footer className="border-t border-border bg-[var(--sw-canvas)]">
          <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-8">
            <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr_1fr] lg:gap-8">
              <div className="min-w-0">
                <a
                  href="/"
                  className="inline-flex items-center gap-2.5 font-display text-lg font-semibold tracking-[-0.01em] text-foreground no-underline"
                >
                  <LogoBlob className="size-6" aria-hidden="true" />
                  Sealant
                </a>
                <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-muted-foreground">
                  Sealant gives developer software a real environment in which to work — and makes
                  the resulting work inspectable and reusable.
                </p>
              </div>
              <FooterCol
                title="Platform"
                links={[
                  ["Documentation", REPO],
                  ["SDK reference", REPO],
                  ["Architecture", REPO],
                  ["GitHub", REPO],
                ]}
              />
              <FooterCol
                title="Products"
                links={[
                  ["Sealant Verify", "#products"],
                  ["Sealant Repro", "#products"],
                  ["Sealant Handoff", "#products"],
                ]}
              />
              <FooterCol
                title="Resources"
                links={[
                  ["Examples", REPO],
                  ["Changelog", REPO],
                  ["Roadmap", REPO],
                ]}
              />
              <FooterCol
                title="Company"
                links={[
                  ["About", "#"],
                  ["Contact", "#"],
                ]}
              />
            </div>
          </div>
        </footer>
        <Scripts />
      </body>
    </html>
  );
}

function Brand() {
  return (
    <a
      className="inline-flex items-center gap-2.5 font-display text-xl font-semibold tracking-[-0.01em] text-foreground no-underline"
      href="/"
      aria-label="Sealant home"
    >
      <LogoBlob className="size-7" aria-hidden="true" />
      Sealant
    </a>
  );
}

function TopLevelNavLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  const external = href.startsWith("http");

  return (
    <a
      className="font-sans text-sm font-medium text-muted-foreground no-underline transition-colors duration-200 hover:text-foreground"
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

function FooterCol({
  title,
  links,
}: {
  readonly title: string;
  readonly links: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <div className="min-w-0">
      <p className="ev-eyebrow">{title}</p>
      <ul className="mt-4 space-y-2.5">
        {links.map(([label, href]) => {
          const external = href.startsWith("http");
          return (
            <li key={label}>
              <a
                href={href}
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                className="text-sm text-muted-foreground no-underline transition-colors duration-200 hover:text-foreground"
              >
                {label}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ThemeSwitcher({ compact = false }: { readonly compact?: boolean }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-9 items-center justify-center rounded-xl border border-border bg-panel px-3 font-sans text-sm text-muted-foreground shadow-[var(--shadow-xs)] transition-colors duration-200 hover:border-input hover:text-foreground"
      aria-label="Toggle color theme"
      onClick={() => {
        document.documentElement.classList.toggle("dark");
      }}
    >
      {compact ? "Mode" : "Theme"}
    </button>
  );
}
