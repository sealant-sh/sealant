import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/linear/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleLinearStatusRequest } = await import("@/lib/linear/linear-oauth.server");

        return handleLinearStatusRequest(request);
      },
    },
  },
});
