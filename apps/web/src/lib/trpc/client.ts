import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { createTRPCClient, httpBatchStreamLink, type TRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";

import type { AppRouter } from "./router";

const TRPC_PATH = "/api/trpc";

const getServerBaseUrl = () => {
  if (typeof window !== "undefined") {
    return "";
  }

  // SSR fetches this process's own /api/trpc handler, so the base must be where THIS process
  // listens: loopback + PORT. BETTER_AUTH_URL is the PUBLIC origin — in packaged deploys the
  // published host port can differ from the in-container port, making it unreachable from inside.
  const port = process.env.PORT;
  if (port !== undefined) {
    return `http://127.0.0.1:${port}`;
  }

  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
};

const getTrpcUrl = () => {
  const baseUrl = getServerBaseUrl();
  if (baseUrl === "") {
    return TRPC_PATH;
  }

  return new URL(TRPC_PATH, baseUrl).toString();
};

const getRequestHeaders = createIsomorphicFn()
  .client((): Record<string, string> => {
    return {};
  })
  .server(async (): Promise<Record<string, string>> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    const cookie = request.headers.get("cookie");

    if (cookie === null) {
      return {};
    }

    return { cookie };
  });

export const createTrpcClient = (): TRPCClient<AppRouter> => {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        url: getTrpcUrl(),
        transformer: superjson,
        headers: () => getRequestHeaders(),
      }),
    ],
  });
};

export const createTrpcOptions = (queryClient: QueryClient, trpcClient: TRPCClient<AppRouter>) => {
  return createTRPCOptionsProxy<AppRouter>({
    client: trpcClient,
    queryClient,
  });
};

export type AppTrpc = ReturnType<typeof createTrpcOptions>;
