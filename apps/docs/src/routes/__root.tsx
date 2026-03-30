import { TanStackDevtools } from "@tanstack/react-devtools";
import { useRouterState } from "@tanstack/react-router";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { RootProvider } from "fumadocs-ui/provider/tanstack";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "TanStack Start Starter",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

const DOC_EXTENSION_RE = /\.md(?=([?#].*)?$)/;
const INDEX_SEGMENT_RE = /\/index(?=([?#].*)?$)/;
const EXTERNAL_HREF_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

type FrameworkLinkProps = React.ComponentProps<"a"> & {
  prefetch?: boolean;
};

function normalizeDocsHref(href: string): string {
  return href.replace(DOC_EXTENSION_RE, "").replace(INDEX_SEGMENT_RE, "");
}

function resolveDocsHref(pathname: string, href: string): string {
  if (EXTERNAL_HREF_RE.test(href) || href.startsWith("#")) {
    return href;
  }

  if (href.startsWith("/")) {
    return href;
  }

  if (!href.startsWith("./") && !href.startsWith("../")) {
    return href;
  }

  const basePath = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const resolved = new URL(href, `https://docs.local${basePath}`).pathname;

  if (resolved.length > 1 && resolved.endsWith("/")) {
    return resolved.slice(0, -1);
  }

  return resolved;
}

function DocsFrameworkLink({ href, prefetch: _prefetch = true, ...props }: FrameworkLinkProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const hrefValue = href ?? "";
  const normalizedHref = normalizeDocsHref(hrefValue);
  const resolvedHref = resolveDocsHref(pathname, normalizedHref);

  return <a href={resolvedHref} {...props} />;
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <RootProvider components={{ Link: DocsFrameworkLink }}>
          {children}
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
