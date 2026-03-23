import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxDetailSection } from "@/components/app/sandbox-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/trace" as never)({
  loader: async ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { sandboxId: string };
  }) => {
    const sandbox = await context.queryClient.ensureQueryData(
      context.trpc.sandbox.byId.queryOptions({ sandboxId: params.sandboxId }),
    );
    const eventsResponse = await context.queryClient.ensureQueryData(
      context.trpc.sandbox.events.queryOptions({ sandboxId: params.sandboxId, limit: 20 }),
    );

    return {
      sandbox,
      events: eventsResponse.items,
    };
  },
  component: SandboxTracePage,
});

function SandboxTracePage() {
  const { sandbox, events } = Route.useLoaderData() as {
    sandbox: {
      sandboxId: string;
      name: string;
      status: "queued" | "running" | "ready" | "failed" | "cancelled";
      repository?: string | undefined;
      tag?: string | undefined;
    };
    events: readonly {
      eventId: string;
      occurredAt: string;
      type: string;
      message?: string | undefined;
    }[];
  };

  return (
    <SandboxDetailSection
      sandbox={sandbox}
      section="Trace"
      description="Inspect timeline events across the sandbox lifecycle to locate exactly where execution degraded."
    >
      <div className="border border-border">
        {events.map((event) => (
          <div
            key={event.eventId}
            className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[auto_1fr] sm:items-center"
          >
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {toShortTime(event.occurredAt)}
            </p>
            <p className="text-sm text-foreground">{event.message ?? event.type}</p>
          </div>
        ))}
      </div>
    </SandboxDetailSection>
  );
}

function toShortTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
