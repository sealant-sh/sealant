import type { AuthSession } from "@sealant/auth/session";
import { Button } from "@sealant/ui";
import { cn } from "@sealant/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  CircleAlert,
  FolderGit2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { capitalizeFirstLetter } from "#/lib/utils/text";
import packageJson from "@/../package.json";
import { LogoBlob, LogoText } from "@/components/app/Logo";
import { ThemeSwitcher } from "@/components/theme/theme-switcher";
import { authClient } from "@/lib/auth/auth-client";
import { PROFILES, REPOSITORIES } from "@/lib/navigation/workspace-data";

interface AppShellProps {
  readonly session: AuthSession;
  readonly children: ReactNode;
}

type GlobalArea = "runs" | "issues" | "repositories" | "profiles";

interface GlobalNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
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
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/issues", label: "Issues", icon: CircleAlert },
  { href: "/repositories", label: "Repositories", icon: FolderGit2 },
  { href: "/profiles", label: "Profiles", icon: UserRound },
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
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

  useEffect(() => {
    setIsMobileSidebarOpen(false);
  }, [pathname]);

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
          <div className="flex min-h-16 items-center gap-3 px-4 py-3 sm:px-6">
            <button
              type="button"
              aria-label={isMobileSidebarOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={isMobileSidebarOpen}
              onClick={() => {
                setIsMobileSidebarOpen((current) => !current);
              }}
              className="inline-flex h-10 w-10 items-center justify-center border border-border bg-background text-foreground transition-colors duration-200 hover:border-foreground hover:bg-muted lg:hidden"
            >
              {isMobileSidebarOpen ? (
                <X className="size-4" />
              ) : (
                <PanelLeftOpen className="size-4" />
              )}
            </button>

            <button
              type="button"
              aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              aria-expanded={isSidebarOpen}
              onClick={() => {
                setIsSidebarOpen((current) => !current);
              }}
              className="hidden h-10 w-10 items-center justify-center border border-border bg-background text-foreground transition-colors duration-200 hover:border-foreground hover:bg-muted lg:inline-flex"
            >
              {isSidebarOpen ? (
                <PanelLeftClose className="size-4" />
              ) : (
                <PanelLeftOpen className="size-4" />
              )}
            </button>
            <div className="ml-auto flex items-center gap-3">
              <label className="relative hidden min-w-52 items-center xl:flex">
                <Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search runs, repos, profiles"
                  className="h-9 w-full border border-border bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/80 focus:border-foreground focus:outline-none"
                />
              </label>

              <ThemeSwitcher className="h-9" />

              <div className="hidden items-center gap-2 border border-border px-2.5 py-1.5 sm:flex">
                <div className="flex h-7 w-7 items-center justify-center border border-border bg-background text-xs font-semibold text-foreground">
                  {(session.user.name || session.user.email).slice(0, 1)}
                </div>
                <p className="font-mono text-[0.58rem] tracking-[0.11em] text-muted-foreground">
                  {session.user.email}
                </p>
              </div>

              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-9 border-border bg-transparent px-3 text-[0.62rem] font-semibold tracking-[0.12em] text-foreground hover:border-primary hover:bg-primary hover:text-primary-foreground",
                  isSigningOut && "opacity-70",
                )}
                disabled={isSigningOut}
                onClick={() => {
                  void handleSignOut();
                }}
              >
                <LogOut className="size-4" />
                <span className="hidden sm:inline">
                  {isSigningOut ? "Signing out" : "Sign out"}
                </span>
              </Button>
            </div>
          </div>
        </header>

        <div className="relative flex min-h-[calc(100svh-4.25rem)] min-w-0">
          <div
            aria-hidden={!isMobileSidebarOpen}
            className={cn(
              "fixed inset-0 z-30 bg-background/70 transition-opacity duration-200 lg:hidden",
              isMobileSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            onClick={() => {
              setIsMobileSidebarOpen(false);
            }}
          />

          <aside
            className={cn(
              "fixed inset-y-[4.25rem] left-0 z-40 flex w-[18rem] flex-col border-r border-border bg-card transition-transform duration-200 ease-out lg:hidden",
              isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
            )}
          >
            <SidebarContent
              activeArea={activeArea}
              pathname={pathname}
              sidebarGroups={sidebarGroups}
              isExpanded={true}
              session={session}
            />
          </aside>

          <aside
            className={cn(
              "hidden shrink-0 border-r border-border bg-card transition-[width] duration-200 ease-out lg:flex",
              isSidebarOpen ? "w-[18rem]" : "w-[5.25rem]",
            )}
          >
            <SidebarContent
              activeArea={activeArea}
              pathname={pathname}
              sidebarGroups={sidebarGroups}
              isExpanded={isSidebarOpen}
              session={session}
            />
          </aside>

          <main className="min-h-0 min-w-0 flex-1 overflow-auto p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

function SidebarContent({
  activeArea,
  pathname,
  sidebarGroups,
  isExpanded,
  session,
}: {
  readonly activeArea: GlobalArea;
  readonly pathname: string;
  readonly sidebarGroups: readonly SidebarGroup[];
  readonly isExpanded: boolean;
  readonly session: AuthSession;
}) {
  const userLabel = session.user.name || session.user.email;

  if (!isExpanded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-2 py-3">
          <Link
            to={"/runs" as never}
            className="flex justify-center text-foreground no-underline"
            aria-label="Sealant home"
          >
            <LogoBlob className="size-8" />
          </Link>
        </div>

        <nav aria-label="Global navigation" className="flex-1 px-2 py-3">
          <div className="space-y-1.5">
            {GLOBAL_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeArea === getGlobalArea(item.href);

              return (
                <Link
                  key={item.href}
                  to={item.href as never}
                  className={cn(
                    "flex h-11 items-center justify-center border border-transparent text-sm no-underline transition-all duration-200",
                    isActive
                      ? "border-l-2 border-l-primary bg-muted text-foreground"
                      : "text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
                  )}
                  title={item.label}
                  aria-label={item.label}
                >
                  <Icon className="size-4 shrink-0" />
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="border-t border-border px-2 py-4">
          <p className="mb-3 text-center font-mono text-[0.58rem] tracking-[0.12em] text-muted-foreground">
            {`v${packageJson.version}`}
          </p>
          <Link
            to={"/runs" as never}
            className="flex h-[4.75rem] items-center justify-center border border-primary bg-primary text-primary-foreground no-underline transition-colors duration-200 hover:bg-transparent hover:text-foreground"
            title="New Run"
            aria-label="New Run"
          >
            <Plus className="size-4 shrink-0" />
          </Link>

          <div className="mt-3 flex justify-center border border-border bg-background px-2 py-3">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-xs font-semibold text-foreground"
              title={userLabel}
              aria-label={userLabel}
            >
              {userLabel.slice(0, 1)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div
            className={cn(
              "min-w-0 overflow-hidden transition-all duration-200",
              isExpanded
                ? "translate-x-0 opacity-100"
                : "pointer-events-none w-0 -translate-x-2 opacity-0",
            )}
          >
            <Link
              to={"/runs" as never}
              className="inline-flex items-center gap-3 text-foreground no-underline"
            >
              <LogoBlob className="size-8 shrink-0" />
              <LogoText className="h-8" />
            </Link>
            {/* <p className="mt-4 font-display text-3xl leading-none tracking-[0.02em] text-foreground">
              {capitalizeFirstLetter(activeArea)}
            </p> */}
          </div>
        </div>
      </div>

      <div className="border-b border-border px-3 py-3">
        {/* <p
          className={cn(
            "pb-2 font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground transition-all duration-200",
            isExpanded ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          Global navigation
        </p> */}
        <nav aria-label="Global navigation" className="space-y-1.5">
          {GLOBAL_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeArea === getGlobalArea(item.href);

            return (
              <Link
                key={item.href}
                to={item.href as never}
                className={cn(
                  "group flex items-center gap-3 border border-transparent px-3 py-2.5 text-sm no-underline transition-all duration-200",
                  isActive
                    ? "border-l-2 border-l-primary bg-muted text-foreground"
                    : "text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
                  !isExpanded && "justify-center px-2",
                )}
                title={!isExpanded ? item.label : undefined}
              >
                <Icon className="size-4 shrink-0" />
                <span
                  className={cn(
                    "truncate transition-all duration-200",
                    isExpanded
                      ? "translate-x-0 opacity-100"
                      : "pointer-events-none w-0 -translate-x-2 opacity-0",
                  )}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 overflow-auto px-3 py-4">
        <div
          className={cn(
            "space-y-5 transition-all duration-200",
            isExpanded ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {sidebarGroups.map((group) => (
            <section key={group.label}>
              <p
                className={cn(
                  "border-b border-border pb-2 font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground",
                )}
              >
                {group.label}
              </p>
              <nav className="mt-2 space-y-1" aria-label={group.label}>
                {group.links.map((item) => {
                  const isActive = isPathActive(pathname, item.href, item.exact ?? false);
                  return (
                    <Link
                      key={item.href}
                      to={item.href as never}
                      className={cn(
                        "block border border-transparent px-3 py-2 text-sm no-underline transition-all duration-200",
                        isActive
                          ? "border-l-2 border-l-primary bg-muted text-foreground"
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

      <div className="border-t border-border px-3 py-4">
        <p className="mb-3 font-mono text-[0.58rem] tracking-[0.12em] text-muted-foreground">
          {`v${packageJson.version}`}
        </p>
        <Link
          to={"/runs" as never}
          className={cn(
            "flex items-center justify-center gap-2 border border-primary bg-primary px-3 py-3 text-center text-[0.64rem] font-semibold tracking-[0.14em] text-primary-foreground no-underline transition-colors duration-200 hover:bg-transparent hover:text-foreground",
            !isExpanded && "gap-0 px-2",
          )}
          title={!isExpanded ? "New Run" : undefined}
        >
          <Plus className="size-4 shrink-0" />
          <span
            className={cn(
              "transition-all duration-200",
              isExpanded
                ? "translate-x-0 opacity-100"
                : "pointer-events-none w-0 -translate-x-2 opacity-0",
            )}
          >
            New Run
          </span>
        </Link>

        <div
          className={cn(
            "mt-4 flex items-center gap-3 border border-border bg-background px-3 py-3 transition-all duration-200",
            !isExpanded && "justify-center px-2",
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-xs font-semibold text-foreground">
            {userLabel.slice(0, 1)}
          </div>
          <div
            className={cn(
              "min-w-0 overflow-hidden transition-all duration-200",
              isExpanded
                ? "translate-x-0 opacity-100"
                : "pointer-events-none w-0 -translate-x-2 opacity-0",
            )}
          >
            <p className="truncate font-mono text-[0.58rem] tracking-[0.12em] text-muted-foreground">
              Operator
            </p>
            <p className="truncate text-sm text-foreground">{userLabel}</p>
          </div>
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
