import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import {
  BROWSER_TELEMETRY_CONFIG_ELEMENT_ID,
  readBrowserTelemetryConfig,
  serializeBrowserTelemetryConfig,
} from "@/lib/telemetry/runtime-config";
import { themeStorageKey } from "@/lib/theme/appearance";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import type { AppTrpc } from "@/lib/trpc/client";

import appCss from "../styles.css?url";

interface RouterContext {
  readonly queryClient: QueryClient;
  readonly trpc: AppTrpc;
}

const APPEARANCE_INIT_SCRIPT = `(function(){try{var themeKey=${JSON.stringify(themeStorageKey)};var storedTheme=window.localStorage.getItem(themeKey);var mode=storedTheme==="light"||storedTheme==="dark"||storedTheme==="system"?storedTheme:"system";var prefersDark=window.matchMedia("(prefers-color-scheme: dark)").matches;var resolvedTheme=mode==="system"?(prefersDark?"dark":"light"):mode;var root=document.documentElement;root.classList.remove("light","dark","system");root.classList.add(resolvedTheme);if(mode==="system"){root.classList.add("system")}root.style.colorScheme=resolvedTheme;}catch(e){}})();`;

/**
 * The browser's Sentry settings as the JSON the page carries, or `undefined` when telemetry is off.
 * The server reads its environment once; the browser reads back the tag the server rendered, so
 * hydration sees the same markup.
 */
let serverTelemetryConfig: { readonly json: string | undefined } | undefined;
const browserTelemetryConfigJson = createIsomorphicFn()
  .server((): string | undefined => {
    if (serverTelemetryConfig === undefined) {
      const result = readBrowserTelemetryConfig(process.env);
      if (result.status === "invalid")
        console.warn(`[web] browser telemetry is off: ${result.reason}`);
      serverTelemetryConfig = {
        json: result.status === "on" ? serializeBrowserTelemetryConfig(result.config) : undefined,
      };
    }
    return serverTelemetryConfig.json;
  })
  .client(
    (): string | undefined =>
      document.getElementById(BROWSER_TELEMETRY_CONFIG_ELEMENT_ID)?.textContent ?? undefined,
  );

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
  const telemetryConfigJson = browserTelemetryConfigJson();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        {telemetryConfigJson === undefined ? null : (
          <script
            id={BROWSER_TELEMETRY_CONFIG_ELEMENT_ID}
            type="application/json"
            dangerouslySetInnerHTML={{ __html: telemetryConfigJson }}
          />
        )}
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
