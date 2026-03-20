import { useState, type ReactNode } from "react";

import type { AuthSession } from "@sealant/auth/session";
import { Button } from "@sealant/ui";
import { cn } from "@sealant/ui";
import { Link, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldCheck } from "lucide-react";

import { authClient } from "@/lib/auth/auth-client";

interface AppShellProps {
  readonly session: AuthSession;
  readonly children: ReactNode;
}

const NAV_ITEMS = [
  { to: "/", label: "Overview" },
  { to: "/registry", label: "Registry" },
  { to: "/about", label: "Platform" },
] as const;

export function AppShell({ session, children }: AppShellProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

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
    <div className="min-h-svh bg-abyss text-white">
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:calc(100%/12)_100%,100%_4rem] opacity-40" />
      <div className="pointer-events-none fixed left-[8.333%] top-0 h-full w-px bg-white/8" />
      <div className="pointer-events-none fixed right-[16.666%] top-0 h-full w-px bg-white/5" />

      <div className="relative mx-auto flex min-h-svh w-full max-w-[1440px] flex-col px-4 pb-16 pt-4 sm:px-8 lg:px-12">
        <header className="sticky top-0 z-40 border border-steel bg-card md:h-20">
          <div className="h-1 w-full bg-neon-magenta" />
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            <div className="flex items-center gap-4 px-4 py-4 md:px-6 md:py-5">
              <div className="flex h-12 w-12 items-center justify-center border border-steel bg-[#191919] text-neon-cyan">
                <ShieldCheck className="size-5" />
              </div>
              <div>
                <p className="font-mono text-[0.65rem] uppercase tracking-[0.42em] text-white/45">Sealant</p>
                <Link to="/" className="text-lg font-black uppercase tracking-[0.26em] text-white no-underline md:text-xl">
                  Private Control
                </Link>
              </div>
            </div>

            <nav className="flex flex-wrap items-center gap-2 px-4 pb-4 md:px-6 md:pb-5 lg:ml-8 lg:px-0 lg:pb-0" aria-label="Primary navigation">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="border border-steel bg-transparent px-3 py-2 text-xs font-black uppercase tracking-[0.32em] text-white/60 no-underline transition hover:border-neon-magenta hover:text-white"
                  activeProps={{
                    className:
                      "border border-neon-magenta bg-neon-magenta px-3 py-2 text-xs font-black uppercase tracking-[0.32em] text-abyss no-underline",
                  }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="lg:ml-auto flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-center sm:gap-4 md:px-6 md:pb-5 lg:px-6 lg:pb-0">
              <div className="flex items-center gap-3 border border-steel bg-[#171717] px-3 py-2">
                <div className="flex h-10 w-10 items-center justify-center border border-steel bg-abyss text-sm font-black uppercase text-neon-cyan">
                  {(session.user.name || session.user.email).slice(0, 1)}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{session.user.name}</p>
                  <p className="font-mono text-[0.7rem] uppercase tracking-[0.28em] text-white/45">
                    {session.user.email}
                  </p>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                className={cn(
                  "h-11 rounded-none border-steel bg-transparent px-4 text-xs font-black uppercase tracking-[0.32em] text-white/72 hover:border-neon-magenta hover:bg-neon-magenta hover:text-abyss",
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

        <main className="mt-8 min-w-0">{children}</main>
      </div>
    </div>
  );
}
