import type { AppTrpc } from "@/lib/trpc/client";

export const sessionQueryOptions = (trpc: AppTrpc) => {
  return trpc.auth.session.queryOptions(undefined, {
    staleTime: 30_000,
  });
};
