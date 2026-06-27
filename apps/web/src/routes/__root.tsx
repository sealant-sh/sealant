import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";

import { themeStorageKey } from "@/lib/theme/appearance";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import type { AppTrpc } from "@/lib/trpc/client";

import appCss from "../styles.css?url";

interface RouterContext {
  readonly queryClient: QueryClient;
  readonly trpc: AppTrpc;
}

const APPEARANCE_INIT_SCRIPT = `(function(){try{var themeKey=${JSON.stringify(themeStorageKey)};var storedTheme=window.localStorage.getItem(themeKey);var mode=storedTheme==="light"||storedTheme==="dark"||storedTheme==="system"?storedTheme:"system";var prefersDark=window.matchMedia("(prefers-color-scheme: dark)").matches;var resolvedTheme=mode==="system"?(prefersDark?"dark":"light"):mode;var root=document.documentElement;root.classList.remove("light","dark","system");root.classList.add(resolvedTheme);if(mode==="system"){root.classList.add("system")}root.style.colorScheme=resolvedTheme;}catch(e){}})();`;

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Sealant" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="min-h-svh bg-[var(--sw-canvas)] text-foreground font-sans antialiased [overflow-wrap:anywhere]">
        <ThemeProvider>
          {children}
          <TanStackDevtools
            config={{ position: "bottom-right" }}
            plugins={[{ name: "Tanstack Router", render: <TanStackRouterDevtoolsPanel /> }]}
          />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
