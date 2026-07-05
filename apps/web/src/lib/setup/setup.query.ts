import type { QueryClient } from "@tanstack/react-query";

import type { AppTrpc } from "@/lib/trpc/client";

export const setupStateQueryOptions = (trpc: AppTrpc) => {
  return trpc.setup.state.queryOptions(undefined, {
    // Staleness is safe: every transition that flips needsSetup in this browser goes through a
    // full page reload (fresh QueryClient), so a stale `true` can only linger for other visitors.
    staleTime: 30_000,
  });
};

/**
 * Fail-open needsSetup check for route gating: if the core API is unreachable, pretend setup is
 * done so /login still renders instead of redirect-looping into a broken wizard.
 */
export const resolveNeedsSetup = async (context: {
  readonly queryClient: QueryClient;
  readonly trpc: AppTrpc;
}): Promise<boolean> => {
  try {
    const state = await context.queryClient.ensureQueryData(setupStateQueryOptions(context.trpc));
    return state.needsSetup;
  } catch {
    return false;
  }
};
