import { useRouter } from "expo-router";

import { useRunRecords, useWorkflows } from "@/api/queries";
import { RunRecordRow, WorkflowProgress, WorkflowRow } from "@/components/domain-rows";
import { EmptyState, LoadingState, Notice, PageHeader, Screen, Section } from "@/components/ui";

export default function RunsScreen() {
  const router = useRouter();
  const workflows = useWorkflows();
  const records = useRunRecords();

  return (
    <Screen>
      <PageHeader
        eyebrow="Runs"
        title="Evidence, not chat."
        summary="Active issue workflows and Run Records are compressed into the decisions a reviewer can make from a phone."
      />

      <Section title="Active Issue Workflows">
        {workflows.isLoading || workflows.data === undefined ? <LoadingState /> : null}
        {workflows.data?.length === 0 ? (
          <EmptyState
            title="No active workflows"
            detail="Ready issues will appear here after launch."
          />
        ) : null}
        {workflows.data?.map((workflow) => (
          <WorkflowRow
            key={workflow.workflowId}
            workflow={workflow}
            onPress={() => router.push(`/workflows/${workflow.workflowId}`)}
          />
        ))}
        {workflows.data?.[0] === undefined ? null : (
          <WorkflowProgress workflow={workflows.data[0]} />
        )}
      </Section>

      <Section title="Recent Run Records">
        {records.isLoading || records.data === undefined ? <LoadingState /> : null}
        {records.data?.length === 0 ? (
          <EmptyState
            title="No run records"
            detail="Completed issue workflows will generate records."
          />
        ) : null}
        {records.data?.map((record) => (
          <RunRecordRow
            key={record.recordId}
            record={record}
            onPress={() => router.push(`/run-records/${record.recordId}`)}
          />
        ))}
      </Section>

      <Notice
        title="Review compression stance"
        detail="This tab is the product differentiator: what changed, what ran, what failed, what is risky, and what needs human attention."
      />
    </Screen>
  );
}
