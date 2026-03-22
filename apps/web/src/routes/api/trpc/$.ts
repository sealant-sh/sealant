import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createTrpcContext } from "@/lib/trpc/context";
import { appRouter } from "@/lib/trpc/router";

const endpoint = "/api/trpc";

const handleRequest = (request: Request) => {
  return fetchRequestHandler({
    endpoint,
    req: request,
    router: appRouter,
    createContext: createTrpcContext,
  });
};

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleRequest(request),
      POST: ({ request }) => handleRequest(request),
    },
  },
});
