import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/linear/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleLinearCallbackRequest } = await import("@/lib/linear/linear-oauth.server");

        return handleLinearCallbackRequest(request);
      },
    },
  },
});
