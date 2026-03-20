import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getSealantAuth } = await import("@sealant/auth/server");
        const auth = await getSealantAuth();
        return auth.handler(request);
      },
      POST: async ({ request }) => {
        const { getSealantAuth } = await import("@sealant/auth/server");
        const auth = await getSealantAuth();
        return auth.handler(request);
      },
    },
  },
});
