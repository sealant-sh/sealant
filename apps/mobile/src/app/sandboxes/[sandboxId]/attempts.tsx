import { useLocalSearchParams } from "expo-router";

import { useSandboxAttempts } from "@/api/queries";
import { EntityRow, LoadingState, PageHeader, Screen, Section, StatusPill } from "@/components/ui";
import { firstRouteParam } from "@/lib/route-params";
import { relativeTime } from "@/lib/time";

export default function SandboxAttemptsScreen() {
  const params = useLocalSearchParams();
  const sandboxId = firstRouteParam(params.sandboxId);
  const attempts = useSandboxAttempts(sandboxId);

  return (
    <Screen>
      <PageHeader
        eyebrow="Sandbox Attempts"
        title={sandboxId}
        summary="Launch, retry, rebuild, and resume records for this sandbox."
      />

      <Section title="Attempts">
        {attempts.isLoading || attempts.data === undefined ? <LoadingState /> : null}
        {attempts.data?.map((attempt) => (
          <EntityRow
            key={attempt.attemptId}
            label={attempt.relation}
            title={attempt.attemptId}
            detail={`${attempt.triggerType} trigger${
              attempt.durationMs === undefined ? "" : ` · ${Math.round(attempt.durationMs / 1000)}s`
            }`}
            meta={`Updated ${relativeTime(attempt.updatedAt)}`}
            trailing={<StatusPill status={attempt.status} />}
          />
        ))}
      </Section>
    </Screen>
  );
}
