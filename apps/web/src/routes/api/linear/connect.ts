import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/linear/connect")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleLinearConnectRequest } = await import("@/lib/linear/linear-oauth.server");

        return handleLinearConnectRequest(request);
      },
    },
  },
});
