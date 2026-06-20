import { useLocalSearchParams, useRouter } from "expo-router";
import { Bell, Boxes, FileText } from "lucide-react-native";

import { useWorkflow } from "@/api/queries";
import {
  ActionButton,
  LoadingState,
  MetricStrip,
  Notice,
  PageHeader,
  ProgressBar,
  RiskPill,
  Screen,
  Section,
  StatusPill,
} from "@/components/ui";
import { firstRouteParam } from "@/lib/route-params";
import { colors } from "@/styles/theme";

export default function WorkflowDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const workflowId = firstRouteParam(params.workflowId);
  const workflow = useWorkflow(workflowId);

  if (workflow.isLoading || workflow.data === undefined) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (workflow.data === null) {
    return (
      <Screen>
        <PageHeader
          eyebrow="Issue Workflow"
          title="Not found"
          summary="This workflow is not available."
        />
      </Screen>
    );
  }

  const currentWorkflow = workflow.data;

  return (
    <Screen>
      <PageHeader
        eyebrow="Issue Workflow"
        title={currentWorkflow.currentStep}
        summary={`${currentWorkflow.harness} · ${currentWorkflow.policy}`}
        trailing={
          <StatusPill status={currentWorkflow.status === "waiting" ? "waiting" : "running"} />
        }
      />

      <MetricStrip
        metrics={[
          { label: "Progress", value: `${currentWorkflow.progressPercent}%` },
          { label: "Issue", value: currentWorkflow.issueId },
          { label: "Sandbox", value: currentWorkflow.sandboxId ?? "pending" },
        ]}
      />

      <ProgressBar value={currentWorkflow.progressPercent} />

      <Section title="Current Gate">
        <Notice
          title="Waiting on approval"
          detail="Mobile review should show why a gate exists, what it unlocks, and what risk is introduced."
        />
        <RiskPill risk={currentWorkflow.risk} />
      </Section>

      <Section title="Actions">
        {currentWorkflow.sandboxId === undefined ? null : (
          <ActionButton
            icon={<Boxes color={colors.text} size={16} />}
            label="Open sandbox"
            onPress={() => router.push(`/sandboxes/${currentWorkflow.sandboxId}`)}
          />
        )}
        <ActionButton
          icon={<Bell color={colors.black} size={16} />}
          label="Review approval"
          onPress={() => router.push("/approvals/approval-network-314")}
          variant="primary"
        />
        <ActionButton
          icon={<FileText color={colors.text} size={16} />}
          label="Open Run Record"
          onPress={() => router.push("/run-records/record-314")}
        />
      </Section>
    </Screen>
  );
}
