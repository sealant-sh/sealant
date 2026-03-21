import { useState, type ReactNode } from "react";

import type { AuthSession } from "@sealant/auth/session";
import { Button } from "@sealant/ui";
import { cn } from "@sealant/ui";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Search, ShieldCheck } from "lucide-react";

import { authClient } from "@/lib/auth/auth-client";
import { PROFILES, REPOSITORIES } from "@/lib/navigation/workspace-data";
import { ThemeSwitcher } from "@/components/theme/theme-switcher";

interface AppShellProps {
  readonly session: AuthSession;
  readonly children: ReactNode;
}

type GlobalArea = "runs" | "issues" | "repositories" | "profiles";

interface GlobalNavItem {
  readonly href: string;
  readonly label: string;
}

interface SidebarLink {
  readonly href: string;
  readonly label: string;
  readonly exact?: boolean;
}

interface SidebarGroup {
  readonly label: string;
  readonly links: readonly SidebarLink[];
}

const GLOBAL_NAV_ITEMS: readonly GlobalNavItem[] = [
  { href: "/runs", label: "Runs" },
  { href: "/issues", label: "Issues" },
  { href: "/repositories", label: "Repositories" },
  { href: "/profiles", label: "Profiles" },
] as const;

const RUN_OVERVIEW_SIDEBAR: readonly SidebarGroup[] = [
  {
    label: "Run Views",
    links: [
      { href: "/runs", label: "All Runs", exact: true },
      { href: "/runs/active", label: "Active Runs", exact: true },
      { href: "/runs/failed", label: "Failed Runs", exact: true },
    ],
  },
];

const ISSUE_SIDEBAR: readonly SidebarGroup[] = [
  {
    label: "Issue Views",
    links: [
      { href: "/issues", label: "All Issues", exact: true },
      { href: "/issues/assigned", label: "Assigned to me", exact: true },
      { href: "/issues/ready", label: "Ready for run", exact: true },
    ],
  },
];

export function AppShell({ session, children }: AppShellProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => normalizePath(state.location.pathname) });

  const activeArea = getGlobalArea(pathname);
  const runDetail = getRunDetail(pathname);
  const selectedRepository = getSelectedEntity(pathname, "repositories");
  const selectedProfile = getSelectedEntity(pathname, "profiles");

  const sidebarGroups = getSidebarGroups({
    activeArea,
    runDetail,
    selectedRepository,
    selectedProfile,
  });

  const handleSignOut = async () => {
    setIsSigningOut(true);

    try {
      await authClient.signOut();
      await queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
      await router.invalidate();
      window.location.assign("/login");
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_1px_1px,color-mix(in_oklab,var(--sw-rule)_16%,transparent)_1px,transparent_0)] [background-size:20px_20px] opacity-15" />

      <div className="relative flex min-h-svh w-full flex-col border-x border-border">
        <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur-sm">
          <div className="flex min-h-16 flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-5 text-muted-foreground" />
              <Link to={"/runs" as never} className="font-display text-4xl uppercase tracking-[0.02em] text-foreground no-underline">
                Sealant
              </Link>
            </div>

            <nav className="flex flex-wrap items-center gap-4 sm:gap-5" aria-label="Global navigation">
              {GLOBAL_NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  to={item.href as never}
                  className="border-b-2 border-transparent pb-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground no-underline transition duration-200 hover:text-foreground"
                  activeProps={{ className: "border-primary pb-1 font-mono text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-primary no-underline" }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-3">
              <label className="relative hidden min-w-56 items-center lg:flex">
                <Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search"
                  className="h-9 w-full border border-border bg-background pl-9 pr-3 font-mono text-[0.62rem] tracking-[0.11em] uppercase text-foreground placeholder:text-muted-foreground/80 focus:border-foreground focus:outline-none"
                />
              </label>

              <ThemeSwitcher className="h-9" />

              <div className="hidden items-center gap-2 border border-border px-2.5 py-1.5 sm:flex">
                <div className="flex h-7 w-7 items-center justify-center border border-border bg-background text-xs font-semibold uppercase text-foreground">
                  {(session.user.name || session.user.email).slice(0, 1)}
                </div>
                <div>
                  <p className="font-mono text-[0.58rem] uppercase tracking-[0.11em] text-muted-foreground">
                    {session.user.email}
                  </p>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-9 border-border bg-transparent px-3 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-foreground hover:border-primary hover:bg-primary hover:text-primary-foreground",
                  isSigningOut && "opacity-70",
                )}
                disabled={isSigningOut}
                onClick={() => {
                  void handleSignOut();
                }}
              >
                <LogOut className="size-4" />
                {isSigningOut ? "Signing out" : "Sign out"}
              </Button>
            </div>
          </div>
        </header>

        <div className="grid min-h-[calc(100svh-4.25rem)] min-w-0 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="flex min-h-full flex-col border-r border-border bg-card/80">
            <div className="border-b border-border px-4 py-4">
              <p className="font-mono text-[0.64rem] uppercase tracking-[0.16em] text-muted-foreground">
                {runDetail === null ? `${activeArea} context` : `run ${runDetail.runId}`}
              </p>
              <p className="mt-1 font-mono text-[0.62rem] uppercase tracking-[0.11em] text-muted-foreground">v2.0 stable</p>
            </div>

            <div className="flex-1 overflow-auto px-4 py-5">
              <div className="space-y-5">
                {sidebarGroups.map((group) => (
                  <section key={group.label}>
                    <p className="border-b border-border pb-2 font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{group.label}</p>
                    <nav className="mt-2" aria-label={group.label}>
                      {group.links.map((item) => {
                        const isActive = isPathActive(pathname, item.href, item.exact ?? false);
                        return (
                          <Link
                            key={item.href}
                            to={item.href as never}
                            className={cn(
                              "mb-1.5 block border border-transparent px-3 py-2 font-mono text-[0.66rem] uppercase tracking-[0.11em] no-underline transition-colors duration-200",
                              isActive
                                ? "border-l-primary border-l-2 bg-muted text-foreground"
                                : "text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
                            )}
                          >
                            {item.label}
                          </Link>
                        );
                      })}
                    </nav>
                  </section>
                ))}
              </div>
            </div>

            <div className="border-t border-border p-4">
              <Link
                to={"/runs" as never}
                className="block border border-primary bg-primary px-3 py-3 text-center font-mono text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-primary-foreground no-underline transition-colors hover:bg-transparent hover:text-foreground"
              >
                New Run
              </Link>
            </div>
          </aside>

          <main className="min-h-0 min-w-0 overflow-auto p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function isPathActive(pathname: string, target: string, exact: boolean): boolean {
  const normalizedTarget = normalizePath(target);

  if (exact) {
    return pathname === normalizedTarget;
  }

  return pathname === normalizedTarget || pathname.startsWith(`${normalizedTarget}/`);
}

function getGlobalArea(pathname: string): GlobalArea {
  if (pathname.startsWith("/issues")) {
    return "issues";
  }

  if (pathname.startsWith("/repositories")) {
    return "repositories";
  }

  if (pathname.startsWith("/profiles")) {
    return "profiles";
  }

  return "runs";
}

function getRunDetail(pathname: string): { runId: string } | null {
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== "runs" || segments.length < 2) {
    return null;
  }

  if (segments[1] === "active" || segments[1] === "failed") {
    return null;
  }

  return { runId: decodeURIComponent(segments[1]) };
}

function getSelectedEntity(pathname: string, area: "repositories" | "profiles"): string | null {
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== area || segments.length < 2) {
    return null;
  }

  if (area === "profiles" && segments[1] === "create") {
    return null;
  }

  return decodeURIComponent(segments[1]);
}

function getSidebarGroups({
  activeArea,
  runDetail,
  selectedRepository,
  selectedProfile,
}: {
  readonly activeArea: GlobalArea;
  readonly runDetail: { runId: string } | null;
  readonly selectedRepository: string | null;
  readonly selectedProfile: string | null;
}): readonly SidebarGroup[] {
  if (runDetail !== null) {
    const encodedRunId = encodeURIComponent(runDetail.runId);
    const runBase = `/runs/${encodedRunId}`;

    return [
      {
        label: "Run Navigation",
        links: [
          { href: runBase, label: "Summary", exact: true },
          { href: `${runBase}/diff`, label: "Diff", exact: true },
          { href: `${runBase}/validation`, label: "Validation", exact: true },
          { href: `${runBase}/trace`, label: "Trace", exact: true },
          { href: `${runBase}/spec`, label: "Spec", exact: true },
        ],
      },
    ];
  }

  if (activeArea === "issues") {
    return ISSUE_SIDEBAR;
  }

  if (activeArea === "repositories") {
    const repositoryLinks = REPOSITORIES.map((repository) => ({
      href: `/repositories/${encodeURIComponent(repository.id)}`,
      label: repository.id,
      exact: false,
    }));

    if (selectedRepository === null) {
      return [
        {
          label: "Repository Views",
          links: [{ href: "/repositories", label: "Repo list", exact: true }],
        },
        { label: "Repository List", links: repositoryLinks },
      ];
    }

    const repositoryBase = `/repositories/${encodeURIComponent(selectedRepository)}`;

    return [
      {
        label: "Repository Views",
        links: [{ href: "/repositories", label: "Repo list", exact: true }],
      },
      {
        label: "Repository List",
        links: repositoryLinks,
      },
      {
        label: selectedRepository,
        links: [
          { href: repositoryBase, label: "Overview", exact: true },
          { href: `${repositoryBase}/setup`, label: "Setup", exact: true },
          { href: `${repositoryBase}/runs`, label: "Runs", exact: true },
          { href: `${repositoryBase}/settings`, label: "Settings", exact: true },
        ],
      },
    ];
  }

  if (activeArea === "profiles") {
    const profileLinks = PROFILES.map((profile) => ({
      href: `/profiles/${encodeURIComponent(profile.id)}`,
      label: profile.name,
      exact: false,
    }));

    const baseGroups: SidebarGroup[] = [
      {
        label: "Profile Views",
        links: [
          { href: "/profiles", label: "All Profiles", exact: true },
          { href: "/profiles/create", label: "Create Profile", exact: true },
        ],
      },
      {
        label: "Profile List",
        links: profileLinks,
      },
    ];

    if (selectedProfile === null) {
      return baseGroups;
    }

    const profileBase = `/profiles/${encodeURIComponent(selectedProfile)}`;

    return [
      ...baseGroups,
      {
        label: selectedProfile,
        links: [
          { href: profileBase, label: "Overview", exact: true },
          { href: `${profileBase}/env-variables`, label: "Env Variables", exact: true },
          { href: `${profileBase}/secrets`, label: "Secrets", exact: true },
          { href: `${profileBase}/access`, label: "SSH / Access", exact: true },
          { href: `${profileBase}/packages`, label: "Packages", exact: true },
          { href: `${profileBase}/setup`, label: "Setup", exact: true },
        ],
      },
    ];
  }

  return RUN_OVERVIEW_SIDEBAR;
}
