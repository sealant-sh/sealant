import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/app/app-shell";
import { sessionQueryOptions } from "@/lib/auth/session.query";
import { resolveNeedsSetup } from "@/lib/setup/setup.query";
import { useTRPC } from "@/lib/trpc/react";
import { sidebarWorkspacesQueryOptions } from "@/lib/workspace/workspace.query";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(context.trpc));

    if (session === null) {
      // A fresh deployment lands on the first-run wizard no matter which URL is hit first.
      if (await resolveNeedsSetup(context)) {
        throw redirect({ to: "/setup", search: { step: undefined } });
      }

      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }

    return { session };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const trpc = useTRPC();
  const { data: session } = useSuspenseQuery(sessionQueryOptions(trpc));
  const { data: sidebarWorkspacesResponse } = useQuery(sidebarWorkspacesQueryOptions(trpc));

  if (session === null) {
    return null;
  }

  return (
    <AppShell session={session} sidebarWorkspaces={sidebarWorkspacesResponse?.items ?? []}>
      <Outlet />
    </AppShell>
  );
}
