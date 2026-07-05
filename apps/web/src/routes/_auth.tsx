import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { sessionQueryOptions } from "@/lib/auth/session.query";
import { resolveNeedsSetup } from "@/lib/setup/setup.query";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(context.trpc));

    if (session !== null) {
      throw redirect({ to: "/" });
    }

    // A fresh deployment lands on the first-run wizard no matter which URL is hit first.
    if (await resolveNeedsSetup(context)) {
      throw redirect({ to: "/setup", search: { step: undefined } });
    }
  },
  component: Outlet,
});
