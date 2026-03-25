import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";

import { accentStorageKey, defaultAccent, themeStorageKey } from "@/lib/theme/appearance";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import type { AppTrpc } from "@/lib/trpc/client";

import appCss from "../styles.css?url";

interface RouterContext {
  readonly queryClient: QueryClient;
  readonly trpc: AppTrpc;
}

const APPEARANCE_INIT_SCRIPT = `(function(){try{var themeKey=${JSON.stringify(themeStorageKey)};var accentKey=${JSON.stringify(accentStorageKey)};var defaultAccent=${JSON.stringify(defaultAccent)};function normalizeAccent(value){if(typeof value!=="string"){return null}var accent=value.trim().toLowerCase();var shortMatch=accent.match(/^#([0-9a-f]{3})$/i);if(shortMatch){var rawHex=shortMatch[1];return "#"+rawHex[0]+rawHex[0]+rawHex[1]+rawHex[1]+rawHex[2]+rawHex[2]}return /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(accent)?accent:null}function toLinear(channel){return channel<=0.03928?channel/12.92:Math.pow((channel+0.055)/1.055,2.4)}function getRgbChannels(color){var opaqueColor=color.length===9?color.slice(0,7):color;return{red:parseInt(opaqueColor.slice(1,3),16),green:parseInt(opaqueColor.slice(3,5),16),blue:parseInt(opaqueColor.slice(5,7),16)}}function getRelativeLuminance(color){var channels=getRgbChannels(color);return toLinear(channels.red/255)*0.2126+toLinear(channels.green/255)*0.7152+toLinear(channels.blue/255)*0.0722}function getContrastRatio(firstColor,secondColor){var firstLuminance=getRelativeLuminance(firstColor);var secondLuminance=getRelativeLuminance(secondColor);var lighter=Math.max(firstLuminance,secondLuminance);var darker=Math.min(firstLuminance,secondLuminance);return(lighter+0.05)/(darker+0.05)}function getAccentForeground(accent){return getContrastRatio(accent,"#111111")>=getContrastRatio(accent,"#ffffff")?"#111111":"#ffffff"}var storedTheme=window.localStorage.getItem(themeKey);var mode=storedTheme==="light"||storedTheme==="dark"||storedTheme==="system"?storedTheme:"system";var prefersDark=window.matchMedia("(prefers-color-scheme: dark)").matches;var resolvedTheme=mode==="system"?(prefersDark?"dark":"light"):mode;var resolvedAccent=normalizeAccent(window.localStorage.getItem(accentKey))||defaultAccent;var root=document.documentElement;root.classList.remove("light","dark","system");root.classList.add(resolvedTheme);if(mode==="system"){root.classList.add("system")}root.style.colorScheme=resolvedTheme;root.style.setProperty("--sw-accent",resolvedAccent);root.style.setProperty("--sw-accent-foreground",getAccentForeground(resolvedAccent));}catch(e){}})();`;

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
      <body className="min-h-svh bg-background text-foreground font-sans antialiased [overflow-wrap:anywhere]">
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
