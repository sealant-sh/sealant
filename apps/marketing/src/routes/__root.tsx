import { TanStackDevtools } from "@tanstack/react-devtools";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { motion, useReducedMotion } from "framer-motion";
import { Github, Menu, Monitor, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";

import { LogoText } from "../../../web/src/components/app/Logo";
import { LogoBlob } from "../components/logo";

import appCss from "../styles.css?url";

type UserTheme = "light" | "dark" | "system";

const themeStorageKey = "sealant-marketing-theme";

const THEME_INIT_SCRIPT = `(function(){try{var key=${JSON.stringify(themeStorageKey)};var raw=window.localStorage.getItem(key);var mode=raw==='light'||raw==='dark'||raw==='system'?raw:'dark';var resolved=mode==='light'?'light':'dark';var root=document.documentElement;root.classList.remove('light','dark','system');root.classList.add(resolved);if(mode==='system'){root.classList.add('system')}root.dataset.theme=mode;root.style.colorScheme=resolved;}catch(e){}})();`;

function resolveTheme(mode: UserTheme): "light" | "dark" {
  return mode === "light" ? "light" : "dark";
}

function applyTheme(mode: UserTheme): void {
  const root = document.documentElement;
  const resolved = resolveTheme(mode);

  root.classList.remove("light", "dark", "system");
  root.classList.add(resolved);

  if (mode === "system") {
    root.classList.add("system");
  }

  root.dataset.theme = mode;
  root.style.colorScheme = resolved;
  window.localStorage.setItem(themeStorageKey, mode);
}

function readStoredTheme(): UserTheme {
  if (typeof window === "undefined") {
    return "dark";
  }

  const raw = window.localStorage.getItem(themeStorageKey);

  return raw === "light" || raw === "dark" || raw === "system" ? raw : "dark";
}

const themeOptions: ReadonlyArray<{
  readonly value: UserTheme;
  readonly label: string;
  readonly icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const fallbackThemeOption: {
  readonly value: UserTheme;
  readonly label: string;
  readonly icon: typeof Sun;
} = {
  value: "dark",
  label: "Dark",
  icon: Moon,
};

function nextTheme(value: UserTheme): UserTheme {
  const index = themeOptions.findIndex((option) => option.value === value);
  const nextIndex = (index + 1) % themeOptions.length;

  return themeOptions[nextIndex]?.value ?? "light";
}

function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<UserTheme>("dark");
  const activeTheme = themeOptions.find((option) => option.value === theme) ?? fallbackThemeOption;
  const Icon = activeTheme.icon;

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") {
      return;
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      applyTheme("system");
    };

    query.addEventListener("change", handleChange);

    return () => {
      query.removeEventListener("change", handleChange);
    };
  }, [theme]);

  return (
    <button
      type="button"
      className={
        compact
          ? "inline-flex size-11 items-center justify-center border border-border bg-transparent text-foreground/80 transition-colors duration-200 hover:border-ring hover:bg-accent/40 hover:text-foreground"
          : "inline-flex min-h-11 items-center gap-1.5 border border-border bg-transparent px-3 font-sans text-[1rem] font-semibold tracking-wider text-foreground/80 transition-colors duration-200 hover:border-ring hover:bg-accent/40 hover:text-foreground md:min-h-9"
      }
      aria-label={`Theme: ${activeTheme.label}`}
      title={`Theme: ${activeTheme.label}`}
      onClick={() => {
        setTheme(nextTheme(theme));
      }}
    >
      <Icon className="size-[1.3125rem]" aria-hidden="true" />
      {compact ? (
        <span className="sr-only">{activeTheme.label}</span>
      ) : (
        <span>{activeTheme.label}</span>
      )}
    </button>
  );
}

function Brand() {
  return (
    <a
      href="/"
      className="inline-flex items-center gap-2 text-inherit no-underline sm:gap-3"
      aria-label="Sealant home"
    >
      <LogoBlob className="size-8 shrink-0 sm:size-9 lg:size-[42px]" aria-hidden="true" />
      <LogoText
        className="hidden h-8 w-auto shrink-0 min-[420px]:block sm:h-9 lg:h-[44px]"
        aria-hidden="true"
      />
    </a>
  );
}

function TopLevelNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="font-sans text-[1.2rem] font-semibold tracking-[0.6px] text-foreground/80 no-underline transition-colors duration-200 hover:text-foreground"
    >
      {children}
    </a>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Sealant | The open platform for reproducible software work",
      },
      {
        name: "description",
        content:
          "A self-hosted platform for managing isolated sandboxes, tracking execution lineage, and building modular developer workflows.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  const mobileMenuTransition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.24, ease: [0.32, 0.72, 0, 1] as const };

  const mobileMenuIconTransition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script src="https://mcp.figma.com/mcp/html-to-design/capture.js" async />
        <HeadContent />
      </head>
      <body className="marketing-body" id="top">
        <header className="sticky top-0 z-40 border-b border-border bg-background text-foreground">
          <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 md:gap-4 md:px-8">
            <div className="flex items-center gap-8 lg:gap-10">
              <Brand />
              <nav className="mt-0.5 hidden items-center gap-6 md:flex" aria-label="Primary">
                <TopLevelNavLink href="/blog">Blog</TopLevelNavLink>
                <TopLevelNavLink href="/docs">Docs</TopLevelNavLink>
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
              <div className="mx-auto grid max-w-7xl gap-2 px-4 py-3 sm:px-6">
                <a
                  href="/blog"
                  className="inline-flex min-h-11 items-center border border-transparent px-1 font-sans text-base font-semibold text-foreground/90 no-underline transition-colors duration-200 hover:text-foreground"
                  tabIndex={mobileMenuOpen ? 0 : -1}
                  onClick={() => {
                    setMobileMenuOpen(false);
                  }}
                >
                  Blog
                </a>
                <a
                  href="/docs"
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
        <footer className="border-t-2 border-ring py-4 pb-5">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 max-md:flex-col max-md:items-start sm:px-8">
            <p>The open platform for reproducible software work.</p>
            <a
              className="m-0 text-[0.78rem] text-muted-foreground no-underline hover:text-foreground"
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
