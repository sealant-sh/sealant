import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { SunMoon } from "lucide-react";
import { type ReactNode } from "react";

import { GitHubLogo } from "#/components/github";
import { LogoBlob } from "#/components/logo";
import { RunHeaderClock } from "#/components/run-header";

import appCss from "../styles.css?url";

const REPO = "https://github.com/get-sealant/sealant";

const TITLE = "Sealant — the open-source runtime for AI dev agents";
const DESCRIPTION =
  "Sealant is the open-source, self-hosted runtime under your AI agent. One call spins up a real sandbox around your repo, runs your harness, and hands back a structured run you can replay. Bring your own agent. Keep your code. Read the evidence yourself.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
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
                <TopLevelNavLink href="#records">The run</TopLevelNavLink>
                <TopLevelNavLink href="#sdk">SDK</TopLevelNavLink>
                <TopLevelNavLink href="#sandboxes">Sandboxes</TopLevelNavLink>
                <TopLevelNavLink href={REPO}>Docs</TopLevelNavLink>
              </nav>
            </div>
            <div className="flex items-center gap-2.5">
              <RunHeaderClock />
              <div className="hidden items-center gap-2.5 md:inline-flex">
                <ThemeSwitcher />
                <a
                  className="group inline-flex min-h-9 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 font-sans text-sm font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
                  href={REPO}
                  target="_blank"
                  rel="noreferrer"
                >
                  <GitHubLogo className="size-4" />
                  GitHub
                </a>
              </div>
              <div className="inline-flex items-center md:hidden">
                <ThemeSwitcher />
              </div>
            </div>
          </div>
        </header>
        <Outlet />
        <footer className="border-t border-border bg-[var(--sw-canvas)]">
          <div className="mx-auto max-w-[1200px] px-6 py-14 sm:px-8">
            <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr] lg:gap-8">
              <div className="min-w-0">
                <a
                  href="/"
                  className="inline-flex items-center gap-2.5 font-display text-lg font-semibold tracking-[-0.01em] text-foreground no-underline"
                >
                  <LogoBlob className="size-6" aria-hidden="true" />
                  Sealant
                </a>
                <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-muted-foreground">
                  The runtime the agent era skipped — a real environment to work in, and a
                  trustworthy, replayable record of what happened. Open-source, self-hosted, yours.
                </p>
              </div>
              <FooterCol
                title="Platform"
                links={[
                  ["The run", "#records"],
                  ["SDK", "#sdk"],
                  ["What it captures", "#capture"],
                  ["Sandboxes", "#sandboxes"],
                  ["GitHub", REPO],
                ]}
              />
              <FooterCol
                title="Build on it"
                links={[
                  ["Open-source & self-hosted", "#open-source"],
                  ["Handoff (by Sealant)", REPO],
                ]}
              />
              <FooterCol
                title="Project"
                links={[
                  ["License", REPO],
                  ["Roadmap", REPO],
                  ["Changelog", REPO],
                  ["Discussions", REPO],
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

function ThemeSwitcher() {
  return (
    <button
      type="button"
      className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-panel text-muted-foreground shadow-[var(--shadow-xs)] transition-colors duration-200 hover:border-input hover:text-foreground"
      aria-label="Toggle color theme"
      title="Toggle theme"
      onClick={() => {
        document.documentElement.classList.toggle("dark");
      }}
    >
      <SunMoon className="size-4" aria-hidden="true" />
    </button>
  );
}
