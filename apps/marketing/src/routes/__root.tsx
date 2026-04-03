import { TanStackDevtools } from "@tanstack/react-devtools";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Monitor, Moon, Sun } from "lucide-react";
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

function ThemeSwitcher() {
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
      className="inline-flex min-h-9 items-center gap-1.5 border border-border bg-transparent px-3 font-mono text-xs uppercase tracking-wider text-foreground/80 transition-colors duration-200 hover:border-ring hover:bg-accent/40 hover:text-foreground"
      aria-label={`Theme: ${activeTheme.label}`}
      title={`Theme: ${activeTheme.label}`}
      onClick={() => {
        setTheme(nextTheme(theme));
      }}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{activeTheme.label}</span>
    </button>
  );
}

function Brand() {
  return (
    <a
      href="#top"
      className="inline-flex items-center gap-3 text-inherit no-underline"
      aria-label="Sealant home"
    >
      <LogoBlob className="size-8 shrink-0" aria-hidden="true" />
      <LogoText className="h-8 w-auto shrink-0" aria-hidden="true" />
    </a>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Sealant | Open source sandbox and issue workflow platform",
      },
      {
        name: "description",
        content:
          "Launch deeply customizable isolated sandboxes and run issue-to-PR workflows with built-in traceability.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="marketing-body" id="top">
        <header className="sticky top-0 z-40 border-b border-border bg-background text-foreground">
          <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-6 sm:px-8">
            <Brand />
            <div className="inline-flex items-center gap-2.5">
              <ThemeSwitcher />
              <a
                className="inline-flex min-h-9 items-center justify-center border border-primary bg-primary px-4 text-xs font-bold uppercase tracking-wider text-primary-foreground no-underline transition duration-200 hover:-translate-y-px hover:brightness-95"
                href="https://github.com/sealant-ops/sealant"
                target="_blank"
                rel="noreferrer"
              >
                View GitHub
              </a>
            </div>
          </div>
        </header>
        <Outlet />
        <footer className="border-t-2 border-ring py-4 pb-5">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 max-md:flex-col max-md:items-start sm:px-8">
            <p>Open source control plane for isolated sandboxes and issue workflows.</p>
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
