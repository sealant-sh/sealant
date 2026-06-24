import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { Github } from "lucide-react";
import { type ReactNode } from "react";

import { LogoBlob } from "#/components/logo";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Sealant Platform — Execution infrastructure for developer software",
      },
      {
        name: "description",
        content:
          "Give developer agents and automation products isolated workspaces, terminal and process control, filesystem and network observation, and durable execution history.",
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
                <TopLevelNavLink href="#products">Products</TopLevelNavLink>
                <TopLevelNavLink href="#use-cases">Use cases</TopLevelNavLink>
                <TopLevelNavLink href="https://github.com/get-sealant/sealant">
                  Documentation
                </TopLevelNavLink>
                <TopLevelNavLink href="#integration">SDKs</TopLevelNavLink>
                <TopLevelNavLink href="#core-concept">Architecture</TopLevelNavLink>
              </nav>
            </div>
            <div className="hidden items-center gap-2.5 md:inline-flex">
              <ThemeSwitcher />
              <a
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl border border-border bg-panel px-3 font-sans text-sm font-medium text-foreground no-underline shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[var(--shadow-sm)]"
                href="https://github.com/get-sealant/sealant"
                target="_blank"
                rel="noreferrer"
              >
                <Github className="size-4" aria-hidden="true" />
                GitHub
              </a>
              <a
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 font-sans text-sm font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
                href="https://github.com/get-sealant/sealant"
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
        <footer className="border-t border-border bg-[var(--sw-canvas)] py-9">
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-6 max-md:flex-col max-md:items-start sm:px-8">
            <div className="flex items-center gap-2.5">
              <LogoBlob className="size-6" aria-hidden="true" />
              <p className="m-0 text-sm text-muted-foreground">
                Execution infrastructure for developer software.
              </p>
            </div>
            <a
              className="m-0 text-sm text-muted-foreground no-underline transition-colors duration-200 hover:text-foreground"
              href="#top"
            >
              Back to top
            </a>
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
      aria-label="Sealant Platform home"
    >
      <LogoBlob className="size-7" aria-hidden="true" />
      Sealant Platform
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
