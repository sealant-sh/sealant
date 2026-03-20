import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { sessionQueryOptions } from "@/lib/auth/session.query";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());

    if (session !== null) {
      throw redirect({ to: "/" });
    }
  },
  component: Outlet,
});
