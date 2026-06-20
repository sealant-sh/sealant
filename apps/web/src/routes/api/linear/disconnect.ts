import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/linear/disconnect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleLinearDisconnectRequest } = await import("@/lib/linear/linear-oauth.server");

        return handleLinearDisconnectRequest(request);
      },
    },
  },
});
