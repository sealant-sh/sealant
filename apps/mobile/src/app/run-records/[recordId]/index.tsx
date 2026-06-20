import { useLocalSearchParams } from "expo-router";

import { useRunRecord } from "@/api/queries";
import { LoadingState, MetricStrip, PageHeader, Screen, StatusPill } from "@/components/ui";
import { ReviewPacket } from "@/features/run-record/review-packet";
import { firstRouteParam } from "@/lib/route-params";

export default function RunRecordScreen() {
  const params = useLocalSearchParams();
  const recordId = firstRouteParam(params.recordId);
  const record = useRunRecord(recordId);

  if (record.isLoading || record.data === undefined) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (record.data === null) {
    return (
      <Screen>
        <PageHeader
          eyebrow="Run Record"
          title="Not found"
          summary="This Run Record is not available."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        eyebrow="Run Record"
        title={record.data.title}
        summary="A compressed review packet for fast, trustworthy mobile review."
        trailing={
          <StatusPill status={record.data.status === "attention" ? "attention" : "ready"} />
        }
      />

      <MetricStrip
        metrics={[
          { label: "Files", value: String(record.data.filesChanged) },
          { label: "Commands", value: String(record.data.commandsRun) },
          { label: "Checks", value: String(record.data.validations.length) },
        ]}
      />

      <ReviewPacket record={record.data} />
    </Screen>
  );
}
