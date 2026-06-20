import { useRouter } from "expo-router";
import { BellRing, Play, RadioTower } from "lucide-react-native";

import { useHomeSnapshot } from "@/api/queries";
import {
  ApprovalRow,
  IssueRow,
  RunRecordRow,
  SandboxRow,
  WorkflowProgress,
  WorkflowRow,
} from "@/components/domain-rows";
import {
  ActionButton,
  DataModePill,
  LoadingState,
  MetricStrip,
  Notice,
  PageHeader,
  Screen,
  Section,
} from "@/components/ui";
import { scheduleRunStatusPreview } from "@/lib/notifications";
import { colors } from "@/styles/theme";

export default function HomeScreen() {
  const router = useRouter();
  const snapshot = useHomeSnapshot();

  if (snapshot.isLoading || snapshot.data === undefined) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const readyIssue = snapshot.data.readyIssues[0];
  const waitingApproval = snapshot.data.waitingApprovals[0];
  const activeWorkflow = snapshot.data.activeWorkflows[0];
  const activeSandbox = snapshot.data.activeSandboxes[0];
  const recentRunRecord = snapshot.data.recentRunRecords[0];

  return (
    <Screen>
      <PageHeader
        eyebrow="Run Command Center"
        title="Start, approve, watch, review."
        summary="A mobile control room for secure AI coding work, focused on decisions that matter away from your desk."
        trailing={<DataModePill mode={snapshot.data.dataMode} />}
      />

      <MetricStrip
        metrics={[
          { label: "Active sandboxes", value: String(snapshot.data.activeSandboxes.length) },
          { label: "Waiting approvals", value: String(snapshot.data.waitingApprovals.length) },
          { label: "Recent records", value: String(snapshot.data.recentRunRecords.length) },
        ]}
      />

      {readyIssue === undefined ? null : (
        <Section
          title="Ready To Run"
          action={
            <ActionButton
              icon={<Play color={colors.black} size={16} />}
              label="Start"
              onPress={() => router.push(`/issues/${readyIssue.issueId}`)}
              variant="primary"
            />
          }
        >
          <IssueRow
            issue={readyIssue}
            onPress={() => router.push(`/issues/${readyIssue.issueId}`)}
          />
        </Section>
      )}

      {waitingApproval === undefined ? null : (
        <Section title="Approval Inbox">
          <ApprovalRow
            approval={waitingApproval}
            onPress={() => router.push(`/approvals/${waitingApproval.approvalId}`)}
          />
        </Section>
      )}

      {activeWorkflow === undefined ? null : (
        <Section title="Live Issue Workflow">
          <WorkflowRow
            workflow={activeWorkflow}
            onPress={() => router.push(`/workflows/${activeWorkflow.workflowId}`)}
          />
          <WorkflowProgress workflow={activeWorkflow} />
        </Section>
      )}

      {activeSandbox === undefined ? null : (
        <Section title="Active Sandbox">
          <SandboxRow
            sandbox={activeSandbox}
            onPress={() => router.push(`/sandboxes/${activeSandbox.sandboxId}`)}
          />
        </Section>
      )}

      {recentRunRecord === undefined ? null : (
        <Section title="Run Record">
          <RunRecordRow
            record={recentRunRecord}
            onPress={() => router.push(`/run-records/${recentRunRecord.recordId}`)}
          />
        </Section>
      )}

      <Notice
        title="Push status preview"
        detail="Notifications are scaffolded for run state changes. The MVP keeps the server registration endpoint explicit before enabling live delivery."
      />

      <ActionButton
        icon={<BellRing color={colors.text} size={16} />}
        label="Preview notification"
        onPress={() => {
          void scheduleRunStatusPreview();
        }}
      />

      <ActionButton
        icon={<RadioTower color={colors.text} size={16} />}
        label="Open live setup"
        onPress={() => router.push("/settings")}
      />
    </Screen>
  );
}
