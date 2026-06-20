import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/linear/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleLinearImportRequest } = await import("@/lib/linear/linear-oauth.server");

        return handleLinearImportRequest(request);
      },
    },
  },
});
