import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";

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
              <button
                type="button"
                className="inline-flex size-11 items-center justify-center border border-border bg-transparent text-foreground/80 transition-colors duration-200 hover:border-ring hover:bg-accent/40 hover:text-foreground"
                aria-expanded={mobileMenuOpen}
                aria-controls="marketing-mobile-nav"
                aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
                onClick={() => {
                  setMobileMenuOpen((open) => !open);
                }}
              >
                <span className="relative size-[1.3125rem]" aria-hidden="true">
                  <motion.span
                    className="absolute inset-0"
                    initial={false}
                    animate={{
                      opacity: mobileMenuOpen ? 0 : 1,
                      rotate: mobileMenuOpen ? -45 : 0,
                      scale: mobileMenuOpen ? 0.86 : 1,
                    }}
                    transition={mobileMenuIconTransition}
                  >
                    <Menu className="size-[1.3125rem]" aria-hidden="true" />
                  </motion.span>
                  <motion.span
                    className="absolute inset-0"
                    initial={false}
                    animate={{
                      opacity: mobileMenuOpen ? 1 : 0,
                      rotate: mobileMenuOpen ? 0 : 45,
                      scale: mobileMenuOpen ? 1 : 0.86,
                    }}
                    transition={mobileMenuIconTransition}
                  >
                    <X className="size-[1.3125rem]" aria-hidden="true" />
                  </motion.span>
                </span>
              </button>
            </div>
          </div>
          <motion.div
            className={`overflow-hidden md:hidden ${mobileMenuOpen ? "pointer-events-auto" : "pointer-events-none"}`}
            initial={false}
            animate={{
              height: mobileMenuOpen ? "auto" : 0,
              opacity: mobileMenuOpen ? 1 : 0,
            }}
            transition={mobileMenuTransition}
            aria-hidden={!mobileMenuOpen}
          >
            <div id="marketing-mobile-nav" className="border-t border-border">
              <div className="mx-auto grid max-w-[1320px] gap-2 px-4 py-3 sm:px-6">
                <a
                  href="#product"
                  className="inline-flex min-h-11 items-center border border-transparent px-1 font-sans text-base font-semibold text-foreground/90 no-underline transition-colors duration-200 hover:text-foreground"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  Product
                </a>
                <a
                  href="#security"
                  className="inline-flex min-h-11 items-center border border-transparent px-1 font-sans text-base font-semibold text-foreground/90 no-underline transition-colors duration-200 hover:text-foreground"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  Security
                </a>
                <a
                  href="#review"
                  className="inline-flex min-h-11 items-center border border-transparent px-1 font-sans text-base font-semibold text-foreground/90 no-underline transition-colors duration-200 hover:text-foreground"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  Review
                </a>
                <a
                  href="#sdk"
                  className="inline-flex min-h-11 items-center border border-transparent px-1 font-sans text-base font-semibold text-foreground/90 no-underline transition-colors duration-200 hover:text-foreground"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  SDK
                </a>
                <a
                  href="https://github.com/get-sealant/sealant"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center border border-transparent px-1 font-sans text-base font-semibold text-foreground/90 no-underline transition-colors duration-200 hover:text-foreground"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  Docs
                </a>
                <a
                  href="https://github.com/get-sealant/sealant"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 border border-primary bg-primary px-4 font-sans text-[1rem] font-semibold tracking-wider text-primary-foreground no-underline transition duration-200 hover:-translate-y-px hover:brightness-95"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  <Github className="size-[1.3125rem]" aria-hidden="true" />
                  GitHub
                </a>
              </div>
            </div>
          </motion.div>
        </header>
        <Outlet />
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-full border border-border bg-background/90 px-2 py-1.5 backdrop-blur-sm shadow-lg">
            <span className="px-2 font-mono text-[0.52rem] uppercase tracking-[0.14em] text-muted-foreground">
              Design
            </span>
            {[
              { href: "/", label: "V1" },
              { href: "/v2", label: "V2" },
              { href: "/v3", label: "V3" },
              { href: "/v4", label: "V4" },
              { href: "/v5", label: "V5" },
            ].map((v) => (
              <a
                key={v.href}
                href={v.href}
                className="rounded-full px-3 py-1 font-mono text-[0.58rem] font-bold uppercase tracking-wider text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground"
              >
                {v.label}
              </a>
            ))}
          </div>
        </div>
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
        <TanStackDevtools
          config={{ position: "bottom-right" }}
          plugins={[{ name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> }]}
        />
        <Scripts />
      </body>
    </html>
  );
}
