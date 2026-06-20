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
        title: "Sealant — Secure AI coding runs, reviewable from first command to final PR",
      },
      {
        name: "description",
        content:
          "The secure run layer for AI software work. Sealant runs agents inside isolated sandboxes and turns every run into a reviewable record — from issue intake to pull request.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=DM+Sans:wght@400;500;700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,900;1,9..144,400&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
      },
    ],
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
        <header className="sticky top-0 z-40 border-b border-border bg-background text-foreground">
          <div className="mx-auto flex min-h-16 max-w-[1320px] items-center justify-between gap-3 px-4 sm:px-6 md:gap-4 md:px-8">
            <div className="flex items-center gap-8 lg:gap-10">
              <Brand />
              <nav className="mt-0.5 hidden items-center gap-6 md:flex" aria-label="Primary">
                <TopLevelNavLink href="#product">Product</TopLevelNavLink>
                <TopLevelNavLink href="#security">Security</TopLevelNavLink>
                <TopLevelNavLink href="#review">Review</TopLevelNavLink>
                <TopLevelNavLink href="#sdk">SDK</TopLevelNavLink>
                <TopLevelNavLink href="https://github.com/get-sealant/sealant">
                  Docs
                </TopLevelNavLink>
              </nav>
            </div>
            <div className="hidden items-center gap-2.5 md:inline-flex">
              <ThemeSwitcher />
              <a
                className="inline-flex min-h-11 items-center justify-center gap-1.5 border border-primary bg-primary px-4 font-sans text-[1rem] font-semibold tracking-wider text-primary-foreground no-underline transition duration-200 hover:-translate-y-px hover:brightness-95 md:min-h-9"
                href="https://github.com/get-sealant/sealant"
                target="_blank"
                rel="noreferrer"
              >
                <Github className="size-[1.3125rem]" aria-hidden="true" />
                GitHub
              </a>
            </div>
            <div className="inline-flex items-center gap-2 md:hidden">
              <ThemeSwitcher compact />
            </div>
          </div>
        </header>
        <Outlet />
        <footer className="border-t-2 border-[var(--sw-rule)] py-4 pb-5">
          <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-4 px-6 max-md:flex-col max-md:items-start sm:px-8">
            <p className="m-0 text-sm text-muted-foreground">
              The secure run layer for AI software work.
            </p>
            <a
              className="m-0 font-mono text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground no-underline transition-colors duration-200 hover:text-foreground"
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
      className="inline-flex items-center gap-2 font-display text-xl font-bold uppercase tracking-tight text-foreground no-underline"
      href="/"
      aria-label="Sealant home"
    >
      <LogoBlob className="size-8" aria-hidden="true" />
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
      className="font-sans text-sm font-semibold text-foreground/70 no-underline transition-colors duration-200 hover:text-foreground"
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
      className="inline-flex min-h-9 items-center justify-center border border-border bg-transparent px-3 font-mono text-[0.62rem] font-bold uppercase tracking-[0.12em] text-foreground/70 transition-colors duration-200 hover:border-ring hover:bg-accent/40 hover:text-foreground"
      aria-label="Toggle color theme"
      onClick={() => {
        document.documentElement.classList.toggle("dark");
      }}
    >
      {compact ? "Mode" : "Theme"}
    </button>
  );
}
