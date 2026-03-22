import type { AuthSession } from "@sealant/auth/session";
import { cn } from "@sealant/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent as UiSidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@sealant/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ChevronsUpDown,
  CircleAlert,
  FolderGit2,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sun,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import packageJson from "@/../package.json";
import { LogoBlob, LogoText } from "@/components/app/Logo";
import { authClient } from "@/lib/auth/auth-client";
import { PROFILES, REPOSITORIES } from "@/lib/navigation/workspace-data";
import { type UserTheme, useTheme } from "@/lib/theme/theme-provider";

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

      <SidebarProvider
        open={isSidebarOpen}
        onOpenChange={setIsSidebarOpen}
        className="relative min-h-svh border-x border-border"
        style={{ "--sidebar-offset": "0px" } as CSSProperties}
      >
        <Sidebar collapsible="icon" className="z-30 border-r border-sidebar-border bg-card">
          <AppSidebarNav
            activeArea={activeArea}
            pathname={pathname}
            sidebarGroups={sidebarGroups}
            session={session}
            isSigningOut={isSigningOut}
            onSignOut={handleSignOut}
          />
        </Sidebar>

        <SidebarInset className="min-h-svh border-0 bg-transparent">
          <main className="min-h-svh min-w-0 overflow-auto p-4 sm:p-6">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

function AppSidebarNav({
  activeArea,
  pathname,
  sidebarGroups,
  session,
  isSigningOut,
  onSignOut,
}: {
  readonly activeArea: GlobalArea;
  readonly pathname: string;
  readonly sidebarGroups: readonly SidebarGroup[];
  readonly session: AuthSession;
  readonly isSigningOut: boolean;
  readonly onSignOut: () => Promise<void>;
}) {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { isMobile, openMobile, setOpen, setOpenMobile, state } = useSidebar();
  const { userTheme, setTheme } = useTheme();
  const userLabel = session.user.name || session.user.email;
  const currentTheme = getThemeMenuState(userTheme);
  const ThemeIcon = currentTheme.icon;
  const isExpanded = isMobile || state === "expanded";
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <>
      <SidebarHeader className="group-data-[collapsible=icon]:py-4">
        <div className={cn("flex items-center", isExpanded ? "justify-between gap-3" : "justify-center")}>
          <div
            className={cn(
              "flex items-center overflow-hidden transition-[max-width,opacity,transform] duration-200 ease-out",
              isExpanded ? "max-w-[14rem] translate-x-0 opacity-100" : "pointer-events-none max-w-0 -translate-x-2 opacity-0",
            )}
            aria-hidden={!isExpanded}
          >
            <Link
              to={"/runs" as never}
              className="inline-flex items-center gap-3 text-foreground no-underline"
              aria-label="Sealant home"
            >
              <LogoBlob className="size-8 shrink-0" />
              <LogoText className="h-8 shrink-0" />
            </Link>
          </div>

          <button
            type="button"
            aria-label={(isMobile ? openMobile : isExpanded) ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={isMobile ? openMobile : isExpanded}
            onClick={() => {
              if (isMobile) {
                setOpenMobile(!openMobile);
                return;
              }

              setOpen(!isExpanded);
            }}
            className={cn(
              "inline-flex h-10 shrink-0 items-center justify-center border border-transparent bg-background text-sidebar-foreground transition-[background-color,border-color] duration-200 hover:border-l-2 hover:border-l-sidebar-border hover:bg-sidebar-accent",
              isExpanded ? "w-10" : "w-full",
            )}
          >
            {isMobile ? (
              openMobile ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />
            ) : isExpanded ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </button>
        </div>

        <div className={cn("mt-4 flex w-full items-center", isExpanded ? "gap-2" : "justify-center") }>
          <button
            type="button"
            aria-label="Open search"
            onClick={() => {
              const focusSearch = () => {
                requestAnimationFrame(() => {
                  searchInputRef.current?.focus();
                });
              };

              if (isMobile) {
                if (!openMobile) {
                  setOpenMobile(true);
                  focusSearch();
                } else {
                  searchInputRef.current?.focus();
                }
                return;
              }

              if (!isExpanded) {
                setOpen(true);
                focusSearch();
              } else {
                searchInputRef.current?.focus();
              }
            }}
            className={cn(
              "inline-flex h-10 shrink-0 items-center justify-center border border-transparent bg-background text-sidebar-foreground transition-[background-color,border-color] duration-200 hover:border-l-2 hover:border-l-sidebar-border hover:bg-sidebar-accent",
              isExpanded ? "w-10" : "w-full",
            )}
          >
            <Search className="size-3.5" />
          </button>

          <label
            className={cn(
              "min-w-0 flex-1 overflow-hidden transition-[max-width,opacity,transform] duration-200 ease-out",
              isExpanded ? "max-w-full translate-x-0 opacity-100" : "pointer-events-none max-w-0 -translate-x-2 opacity-0",
            )}
            aria-hidden={!isExpanded}
          >
            <input
              ref={searchInputRef}
              type="search"
              aria-label="Search runs, repos, profiles"
              placeholder="Search runs, repos, profiles"
              className="h-10 w-full border border-sidebar-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/80 focus:border-sidebar-foreground focus:outline-none"
            />
          </label>
        </div>
      </SidebarHeader>

      <UiSidebarContent>
        <SidebarGroup
          className={cn("border-b border-sidebar-border", isExpanded ? "px-3 py-3" : "px-2 py-3")}
        >
          <SidebarMenu aria-label="Global navigation" className="space-y-1.5">
            {GLOBAL_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeArea === getGlobalArea(item.href);

              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link to={item.href as never} />}
                    isActive={isActive}
                    tooltip={item.label}
                    aria-label={item.label}
                    className={cn(
                      isExpanded ? "gap-3 px-3" : "justify-center gap-0 px-2",
                      "[&>span:last-child]:transition-[max-width,opacity,transform] [&>span:last-child]:duration-200 [&>span:last-child]:ease-out [&>span:last-child]:whitespace-nowrap",
                      isExpanded
                        ? "[&>span:last-child]:max-w-[10rem] [&>span:last-child]:translate-x-0 [&>span:last-child]:opacity-100"
                        : "[&>span:last-child]:pointer-events-none [&>span:last-child]:max-w-0 [&>span:last-child]:-translate-x-2 [&>span:last-child]:opacity-0",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className={cn(isExpanded ? "px-3 py-4" : "px-2 py-0")}>
          <div
            className={cn(
              "overflow-hidden transition-[max-height,opacity,transform] duration-200 ease-out",
              isExpanded
                ? "max-h-[160rem] translate-y-0 opacity-100"
                : "pointer-events-none max-h-0 -translate-y-2 opacity-0",
            )}
            aria-hidden={!isExpanded}
          >
            <div className="space-y-5">
              {sidebarGroups.map((group) => (
                <div key={group.label}>
                  <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                  <SidebarGroupContent className="mt-2">
                    <SidebarMenu className="space-y-1">
                      {group.links.map((item) => {
                        const isActive = isPathActive(pathname, item.href, item.exact ?? false);

                        return (
                          <SidebarMenuItem key={item.href}>
                            <SidebarMenuButton
                              render={<Link to={item.href as never} />}
                              isActive={isActive}
                              className="px-3 text-sm normal-case tracking-normal"
                            >
                              <span>{item.label}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </div>
              ))}
            </div>
          </div>
        </SidebarGroup>
      </UiSidebarContent>

      <SidebarFooter>
        <p
          className={cn(
            "mb-3 h-4 overflow-hidden font-mono text-[0.58rem] leading-none tracking-[0.12em] text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
            isExpanded ? "translate-y-0 opacity-100" : "text-center -translate-y-0.5 opacity-100",
          )}
        >
          {`v${packageJson.version}`}
        </p>
        <Link
          to={"/runs" as never}
          className={cn(
            "flex items-center justify-center border border-primary bg-primary text-center text-[0.64rem] font-semibold tracking-[0.14em] text-primary-foreground no-underline transition-all duration-200 ease-out hover:bg-transparent hover:text-foreground",
            isExpanded ? "h-11 gap-2 px-3 py-3" : "h-11 gap-0 px-2 py-3",
          )}
          title={!isExpanded ? "New Run" : undefined}
          aria-label="New Run"
        >
          <Plus className="size-4 shrink-0" />
          <span
            className={cn(
              "overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-200 ease-out",
              isExpanded
                ? "max-w-[8rem] translate-x-0 opacity-100"
                : "pointer-events-none max-w-0 -translate-x-2 opacity-0",
            )}
            aria-hidden={!isExpanded}
          >
            New Run
          </span>
        </Link>

        <DropdownMenu open={isProfileMenuOpen} onOpenChange={setIsProfileMenuOpen}>
          <DropdownMenuTrigger
            className={cn(
              "mt-3 flex w-full items-center border border-border bg-background text-left text-foreground transition-all duration-200 ease-out hover:border-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              isExpanded ? "gap-3 px-3 py-3" : "justify-center gap-0 px-2 py-3",
            )}
            aria-label="Open profile menu"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-xs font-semibold text-foreground">
              {userLabel.slice(0, 1)}
            </div>
            <div
              className={cn(
                "min-w-0 overflow-hidden transition-[max-width,opacity,transform] duration-200 ease-out",
                isExpanded
                  ? "max-w-[10rem] translate-x-0 opacity-100"
                  : "pointer-events-none max-w-0 -translate-x-2 opacity-0",
              )}
              aria-hidden={!isExpanded}
            >
              <p className="truncate font-mono text-[0.58rem] tracking-[0.12em] text-muted-foreground">
                Operator
              </p>
              <p className="truncate text-sm text-foreground">{userLabel}</p>
            </div>
            <ChevronsUpDown
              className={cn(
                "ml-auto size-4 shrink-0 text-muted-foreground transition-[opacity,transform,max-width] duration-200 ease-out",
                isExpanded
                  ? "max-w-4 translate-x-0 opacity-100"
                  : "pointer-events-none max-w-0 translate-x-2 opacity-0",
              )}
              aria-hidden={!isExpanded}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align={isExpanded ? "start" : "end"}
            sideOffset={8}
            className="w-56 min-w-56 border-border bg-card p-0"
          >
            <DropdownMenuItem
              onClick={() => {
                setTheme(getNextTheme(userTheme));
                requestAnimationFrame(() => {
                  setIsProfileMenuOpen(true);
                });
              }}
              className="flex items-center gap-3 border-b border-border px-4 py-3 text-[0.72rem] normal-case tracking-normal"
            >
              <ThemeIcon className="size-4" />
              <span>{`Theme: ${currentTheme.menuLabel}`}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-0 -mx-0 bg-border" />
            <DropdownMenuItem
              disabled={isSigningOut}
              onClick={() => {
                void onSignOut();
              }}
              className="flex items-center gap-3 px-4 py-3 text-[0.72rem] normal-case tracking-normal"
            >
              <LogOut className="size-4" />
              <span>{isSigningOut ? "Signing out" : "Sign out"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </>
  );
}

function getNextTheme(theme: UserTheme): UserTheme {
  if (theme === "light") {
    return "dark";
  }

  if (theme === "dark") {
    return "system";
  }

  return "light";
}

function getThemeMenuState(theme: UserTheme): {
  readonly icon: LucideIcon;
  readonly menuLabel: string;
} {
  if (theme === "light") {
    return { icon: Sun, menuLabel: "Light" };
  }

  if (theme === "dark") {
    return { icon: Moon, menuLabel: "Dark" };
  }

  return { icon: Monitor, menuLabel: "System" };
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
  const runId = segments[1];

  if (segments[0] !== "runs" || runId === undefined) {
    return null;
  }

  if (runId === "active" || runId === "failed") {
    return null;
  }

  return { runId: decodeURIComponent(runId) };
}

function getSelectedEntity(pathname: string, area: "repositories" | "profiles"): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const entityId = segments[1];

  if (segments[0] !== area || entityId === undefined) {
    return null;
  }

  if (area === "profiles" && entityId === "create") {
    return null;
  }

  return decodeURIComponent(entityId);
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
