import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/runs/$runId/trace" as never)({
  loader: async ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { runId: string };
  }) => {
    const sandbox = await context.queryClient.ensureQueryData(
      context.trpc.sandbox.byId.queryOptions({ sandboxId: params.runId }),
    );
    const eventsResponse = await context.queryClient.ensureQueryData(
      context.trpc.sandbox.events.queryOptions({ sandboxId: params.runId, limit: 20 }),
    );

    return {
      sandbox,
      events: eventsResponse.items,
    };
  },
  component: RunTracePage,
});

function RunTracePage() {
  const { sandbox, events } = Route.useLoaderData() as {
    sandbox: {
      sandboxId: string;
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
    <RunDetailSection
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
    </RunDetailSection>
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
