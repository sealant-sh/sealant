import type { AuthSession } from "@sealant/auth/session";
import { cn } from "@sealant/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { Link, useRouter, useRouterState, type LinkProps } from "@tanstack/react-router";
import {
  Activity,
  ChevronsUpDown,
  CircleAlert,
  FolderGit2,
  KeyRound,
  LogOut,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import packageJson from "@/../package.json";
import { LogoBlob, LogoText } from "@/components/app/Logo";
import { authClient } from "@/lib/auth/auth-client";
import { PROFILES, REPOSITORIES } from "@/lib/navigation/sandbox-data";
import { isUserTheme } from "@/lib/theme/appearance";
import { type UserTheme, useTheme } from "@/lib/theme/theme-provider";

interface AppShellProps {
  readonly session: AuthSession;
  readonly sidebarSandboxes: readonly SidebarSandbox[];
  readonly children: ReactNode;
}

type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

interface SidebarSandbox {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: SandboxStatus;
}

type GlobalArea = "sandboxes" | "issues" | "repositories" | "profiles" | "settings";

type GlobalNavHref = "/sandboxes" | "/issues" | "/repositories" | "/profiles";

interface GlobalNavItem {
  readonly href: GlobalNavHref;
  readonly label: string;
  readonly icon: LucideIcon;
}

interface SidebarLink {
  /** Route pattern (or static path) passed straight to {@link Link}. */
  readonly to: NonNullable<LinkProps["to"]>;
  /** Path params when {@link SidebarLink.to} is a dynamic route pattern. */
  readonly params?: NonNullable<LinkProps["params"]>;
  /** Concrete, interpolated path used for active matching and as the React key. */
  readonly match: string;
  readonly label: string;
  readonly meta?: string;
  readonly exact?: boolean;
}

interface SidebarGroup {
  readonly label: string;
  readonly links: readonly SidebarLink[];
}

const GLOBAL_NAV_ITEMS: readonly GlobalNavItem[] = [
  { href: "/sandboxes", label: "Sandboxes", icon: Activity },
  { href: "/issues", label: "Issues", icon: CircleAlert },
  { href: "/repositories", label: "Repositories", icon: FolderGit2 },
  { href: "/profiles", label: "Profiles", icon: UserRound },
] as const;

const SANDBOX_OVERVIEW_SIDEBAR: readonly SidebarGroup[] = [
  {
    label: "Sandbox views",
    links: [
      { to: "/sandboxes/new", match: "/sandboxes/new", label: "Create sandbox", exact: true },
      { to: "/github/setup", match: "/github/setup", label: "GitHub access", exact: true },
      { to: "/sandboxes", match: "/sandboxes", label: "All sandboxes", exact: true },
      { to: "/sandboxes/active", match: "/sandboxes/active", label: "Running", exact: true },
      { to: "/sandboxes/failed", match: "/sandboxes/failed", label: "Failed", exact: true },
    ],
  },
];

const SETTINGS_SIDEBAR: readonly SidebarGroup[] = [
  {
    label: "Settings",
    links: [
      { to: "/settings/ssh-keys", match: "/settings/ssh-keys", label: "SSH keys", exact: true },
    ],
  },
];

const ISSUE_SIDEBAR: readonly SidebarGroup[] = [
  {
    label: "Issue views",
    links: [
      { to: "/issues", match: "/issues", label: "All issues", exact: true },
      { to: "/issues/assigned", match: "/issues/assigned", label: "Assigned to me", exact: true },
      { to: "/issues/ready", match: "/issues/ready", label: "Ready for workflow", exact: true },
    ],
  },
];

const APPEARANCE_THEME_OPTIONS: ReadonlyArray<{
  readonly value: UserTheme;
  readonly label: string;
}> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function AppShell({ session, sidebarSandboxes, children }: AppShellProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => normalizePath(state.location.pathname) });

  const activeArea = getGlobalArea(pathname);
  const sandboxDetail = getSandboxDetail(pathname);
  const selectedRepository = getSelectedEntity(pathname, "repositories");
  const selectedProfile = getSelectedEntity(pathname, "profiles");

  const sidebarGroups = getSidebarGroups({
    activeArea,
    sidebarSandboxes,
    sandboxDetail,
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
    <div className="min-h-svh bg-[var(--sw-canvas)] text-foreground">
      <SidebarProvider
        open={isSidebarOpen}
        onOpenChange={setIsSidebarOpen}
        className="relative min-h-svh"
        style={{ "--sidebar-offset": "0px" } as CSSProperties}
      >
        <Sidebar
          collapsible="icon"
          className="z-30 border-r border-sidebar-border bg-sidebar shadow-[var(--shadow-sm)]"
        >
          <AppSidebarNav
            activeArea={activeArea}
            pathname={pathname}
            sidebarGroups={sidebarGroups}
            session={session}
            isSigningOut={isSigningOut}
            onSignOut={handleSignOut}
          />
        </Sidebar>

        <SidebarInset className="min-h-svh border-0 bg-background">
          <main className="min-h-svh min-w-0 overflow-auto p-6 sm:p-8 lg:p-10">{children}</main>
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { isMobile, openMobile, setOpen, setOpenMobile, state } = useSidebar();
  const { setTheme, userTheme } = useTheme();
  const userLabel = session.user.name || session.user.email;
  const currentTheme = getThemeMenuState(userTheme);
  const isExpanded = isMobile || state === "expanded";

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  const handleThemeValueChange = (value: string | null) => {
    if (value !== null && isUserTheme(value)) {
      setTheme(value);
    }
  };

  return (
    <>
      <SidebarHeader className="group-data-[collapsible=icon]:py-4">
        <div
          className={cn(
            "flex items-center",
            isExpanded ? "justify-between gap-3" : "justify-center",
          )}
        >
          <div
            className={cn(
              "flex items-center overflow-hidden transition-[max-width,opacity,transform] duration-200 ease-out",
              isExpanded
                ? "max-w-[14rem] translate-x-0 opacity-100"
                : "pointer-events-none max-w-0 -translate-x-2 opacity-0",
            )}
            aria-hidden={!isExpanded}
          >
            <Link
              to="/sandboxes"
              className="inline-flex items-center gap-3 text-foreground no-underline"
              aria-label="Sealant home"
            >
              <LogoBlob className="size-8 shrink-0" />
              <LogoText className="h-8 shrink-0" />
            </Link>
          </div>

          <button
            type="button"
            aria-label={
              (isMobile ? openMobile : isExpanded) ? "Collapse sidebar" : "Expand sidebar"
            }
            aria-expanded={isMobile ? openMobile : isExpanded}
            onClick={() => {
              if (isMobile) {
                setOpenMobile(!openMobile);
                return;
              }

              setOpen(!isExpanded);
            }}
            className={cn(
              "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground",
              isExpanded ? "w-9" : "w-full",
            )}
          >
            {isMobile ? (
              openMobile ? (
                <PanelLeftClose className="size-4" />
              ) : (
                <PanelLeftOpen className="size-4" />
              )
            ) : isExpanded ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </button>
        </div>

        <div
          className={cn("mt-4 flex w-full items-center", isExpanded ? "gap-2" : "justify-center")}
        >
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
              "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground",
              isExpanded ? "w-9" : "w-full",
            )}
          >
            <Search className="size-3.5" />
          </button>

          <label
            className={cn(
              "min-w-0 flex-1 overflow-hidden transition-[max-width,opacity,transform] duration-200 ease-out",
              isExpanded
                ? "max-w-full translate-x-0 opacity-100"
                : "pointer-events-none max-w-0 -translate-x-2 opacity-0",
            )}
            aria-hidden={!isExpanded}
          >
            <input
              ref={searchInputRef}
              type="search"
              aria-label="Search sandboxes, repos, profiles"
              placeholder="Search sandboxes, repos, profiles"
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[0.8125rem] text-foreground placeholder:text-faint focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
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
                    render={<Link to={item.href} />}
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
                        const isActive = isPathActive(pathname, item.match, item.exact ?? false);

                        return (
                          <SidebarMenuItem key={item.match}>
                            <SidebarMenuButton
                              render={
                                item.params === undefined ? (
                                  <Link to={item.to} />
                                ) : (
                                  <Link to={item.to} params={item.params} />
                                )
                              }
                              isActive={isActive}
                              className="px-3 text-[0.8125rem]"
                            >
                              <span>{item.label}</span>
                              {item.meta === undefined ? null : (
                                <span className="ml-auto font-mono text-[0.6875rem] text-faint">
                                  {item.meta}
                                </span>
                              )}
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
            "mb-3 h-4 overflow-hidden font-mono text-[0.6875rem] leading-none text-faint transition-[opacity,transform] duration-200 ease-out",
            isExpanded ? "translate-y-0 opacity-100" : "text-center -translate-y-0.5 opacity-100",
          )}
        >
          {`v${packageJson.version}`}
        </p>
        <Link
          to="/sandboxes/new"
          className={cn(
            "flex items-center justify-center rounded-xl bg-primary text-center text-[0.8125rem] font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]",
            isExpanded ? "h-10 gap-2 px-3" : "h-10 gap-0 px-2",
          )}
          title={!isExpanded ? "New sandbox" : undefined}
          aria-label="New sandbox"
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
            New sandbox
          </span>
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "mt-3 flex w-full items-center rounded-xl border border-border bg-popover text-left text-foreground shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-input hover:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              isExpanded ? "gap-3 px-3 py-2.5" : "justify-center gap-0 px-2 py-2.5",
            )}
            aria-label="Open profile menu"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-xs font-medium text-accent-foreground">
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
              <p className="ev-eyebrow truncate">Operator</p>
              <p className="truncate text-[0.8125rem] text-foreground">{userLabel}</p>
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
            className="w-56 min-w-56 border-border bg-popover p-0"
          >
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-3 border-b border-border px-4 py-2.5 text-[0.8125rem]">
                <Palette className="size-4" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">Appearance</span>
                  <span className="ev-eyebrow block truncate normal-case">
                    {currentTheme.menuLabel}
                  </span>
                </div>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 min-w-64 border-border bg-popover p-0">
                <div className="border-b border-border px-4 py-3">
                  <p className="ev-eyebrow">Appearance</p>
                  <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
                    Switch between light and dark mode.
                  </p>
                </div>

                <div className="p-1">
                  <DropdownMenuRadioGroup value={userTheme} onValueChange={handleThemeValueChange}>
                    {APPEARANCE_THEME_OPTIONS.map((option) => (
                      <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        className="px-4 py-2.5 text-[0.8125rem]"
                      >
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator className="my-0 -mx-0 bg-border" />
            <DropdownMenuItem
              onClick={() => {
                window.location.assign("/settings/ssh-keys");
              }}
              className="flex items-center gap-3 px-4 py-2.5 text-[0.8125rem]"
            >
              <KeyRound className="size-4" />
              <span>SSH keys</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-0 -mx-0 bg-border" />
            <DropdownMenuItem
              disabled={isSigningOut}
              onClick={() => {
                void onSignOut();
              }}
              className="flex items-center gap-3 px-4 py-2.5 text-[0.8125rem]"
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

function getThemeMenuState(theme: UserTheme): { readonly menuLabel: string } {
  if (theme === "light") {
    return { menuLabel: "Light" };
  }

  if (theme === "dark") {
    return { menuLabel: "Dark" };
  }

  return { menuLabel: "System" };
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

  if (pathname.startsWith("/settings")) {
    return "settings";
  }

  return "sandboxes";
}

function getSandboxDetail(pathname: string): { sandboxId: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  const sandboxId = segments[1];

  if (segments[0] !== "sandboxes" || sandboxId === undefined) {
    return null;
  }

  if (sandboxId === "active" || sandboxId === "failed" || sandboxId === "new") {
    return null;
  }

  return { sandboxId: decodeURIComponent(sandboxId) };
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
  sidebarSandboxes,
  sandboxDetail,
  selectedRepository,
  selectedProfile,
}: {
  readonly activeArea: GlobalArea;
  readonly sidebarSandboxes: readonly SidebarSandbox[];
  readonly sandboxDetail: { sandboxId: string } | null;
  readonly selectedRepository: string | null;
  readonly selectedProfile: string | null;
}): readonly SidebarGroup[] {
  if (sandboxDetail !== null) {
    const { sandboxId } = sandboxDetail;
    const sandboxBase = `/sandboxes/${encodeURIComponent(sandboxId)}`;

    return [
      {
        label: "Sandbox navigation",
        links: [
          {
            to: "/sandboxes/$sandboxId",
            params: { sandboxId },
            match: sandboxBase,
            label: "Summary",
            exact: true,
          },
          {
            to: "/sandboxes/$sandboxId/spec",
            params: { sandboxId },
            match: `${sandboxBase}/spec`,
            label: "Spec",
            exact: true,
          },
        ],
      },
    ];
  }

  if (activeArea === "issues") {
    return ISSUE_SIDEBAR;
  }

  if (activeArea === "settings") {
    return SETTINGS_SIDEBAR;
  }

  if (activeArea === "repositories") {
    const repositoryLinks: readonly SidebarLink[] = REPOSITORIES.map((repository) => ({
      to: "/repositories/$repoId",
      params: { repoId: repository.id },
      match: `/repositories/${encodeURIComponent(repository.id)}`,
      label: repository.id,
      exact: false,
    }));

    const viewsGroup: SidebarGroup = {
      label: "Repository views",
      links: [{ to: "/repositories", match: "/repositories", label: "Repo list", exact: true }],
    };

    if (selectedRepository === null) {
      return [viewsGroup, { label: "Repository list", links: repositoryLinks }];
    }

    const repoId = selectedRepository;
    const repositoryBase = `/repositories/${encodeURIComponent(repoId)}`;

    return [
      viewsGroup,
      { label: "Repository list", links: repositoryLinks },
      {
        label: selectedRepository,
        links: [
          {
            to: "/repositories/$repoId",
            params: { repoId },
            match: repositoryBase,
            label: "Overview",
            exact: true,
          },
          {
            to: "/repositories/$repoId/setup",
            params: { repoId },
            match: `${repositoryBase}/setup`,
            label: "Setup",
            exact: true,
          },
          {
            to: "/repositories/$repoId/sandboxes",
            params: { repoId },
            match: `${repositoryBase}/sandboxes`,
            label: "Sandboxes",
            exact: true,
          },
          {
            to: "/repositories/$repoId/settings",
            params: { repoId },
            match: `${repositoryBase}/settings`,
            label: "Settings",
            exact: true,
          },
        ],
      },
    ];
  }

  if (activeArea === "profiles") {
    const profileLinks: readonly SidebarLink[] = PROFILES.map((profile) => ({
      to: "/profiles/$profileId",
      params: { profileId: profile.id },
      match: `/profiles/${encodeURIComponent(profile.id)}`,
      label: profile.name,
      exact: false,
    }));

    const baseGroups: SidebarGroup[] = [
      {
        label: "Profile views",
        links: [
          { to: "/profiles", match: "/profiles", label: "All profiles", exact: true },
          {
            to: "/profiles/create",
            match: "/profiles/create",
            label: "Create profile",
            exact: true,
          },
        ],
      },
      {
        label: "Profile list",
        links: profileLinks,
      },
    ];

    if (selectedProfile === null) {
      return baseGroups;
    }

    const profileId = selectedProfile;
    const profileBase = `/profiles/${encodeURIComponent(profileId)}`;

    return [
      ...baseGroups,
      {
        label: selectedProfile,
        links: [
          {
            to: "/profiles/$profileId",
            params: { profileId },
            match: profileBase,
            label: "Overview",
            exact: true,
          },
          {
            to: "/profiles/$profileId/env-variables",
            params: { profileId },
            match: `${profileBase}/env-variables`,
            label: "Env variables",
            exact: true,
          },
          {
            to: "/profiles/$profileId/secrets",
            params: { profileId },
            match: `${profileBase}/secrets`,
            label: "Secrets",
            exact: true,
          },
          {
            to: "/profiles/$profileId/access",
            params: { profileId },
            match: `${profileBase}/access`,
            label: "SSH / access",
            exact: true,
          },
          {
            to: "/profiles/$profileId/packages",
            params: { profileId },
            match: `${profileBase}/packages`,
            label: "Packages",
            exact: true,
          },
          {
            to: "/profiles/$profileId/setup",
            params: { profileId },
            match: `${profileBase}/setup`,
            label: "Setup",
            exact: true,
          },
        ],
      },
    ];
  }

  if (activeArea === "sandboxes") {
    if (sidebarSandboxes.length === 0) {
      return SANDBOX_OVERVIEW_SIDEBAR;
    }

    return [
      ...SANDBOX_OVERVIEW_SIDEBAR,
      {
        label: "Recent sandboxes",
        links: sidebarSandboxes.map((sandbox) => ({
          to: "/sandboxes/$sandboxId",
          params: { sandboxId: sandbox.sandboxId },
          match: `/sandboxes/${encodeURIComponent(sandbox.sandboxId)}`,
          label: sandbox.name,
          meta: formatSandboxStatus(sandbox.status),
          exact: false,
        })),
      },
    ];
  }

  return SANDBOX_OVERVIEW_SIDEBAR;
}

function formatSandboxStatus(status: SidebarSandbox["status"]): string {
  if (status === "running") {
    return "Running";
  }

  if (status === "ready") {
    return "Ready";
  }

  if (status === "failed") {
    return "Failed";
  }

  if (status === "cancelled") {
    return "Cancelled";
  }

  return "Queued";
}
