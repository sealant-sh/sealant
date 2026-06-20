import { useLocalSearchParams } from "expo-router";

import { useSandboxEvents } from "@/api/queries";
import { LoadingState, PageHeader, Screen, Section, TimelineRow } from "@/components/ui";
import { firstRouteParam } from "@/lib/route-params";
import { compactTime } from "@/lib/time";

export default function SandboxEventsScreen() {
  const params = useLocalSearchParams();
  const sandboxId = firstRouteParam(params.sandboxId);
  const events = useSandboxEvents(sandboxId);

  return (
    <Screen>
      <PageHeader
        eyebrow="Sandbox Timeline"
        title={sandboxId}
        summary="A compact runtime event stream for build and runtime state."
      />

      <Section title="Events">
        {events.isLoading || events.data === undefined ? <LoadingState /> : null}
        {events.data?.map((event) => (
          <TimelineRow
            key={event.eventId}
            phase={event.type}
            message={event.message ?? "Sandbox state changed."}
            time={compactTime(event.occurredAt)}
          />
        ))}
      </Section>
    </Screen>
  );
}
