import { useRouter } from "expo-router";

import { useIssues } from "@/api/queries";
import { IssueRow } from "@/components/domain-rows";
import {
  DataModePill,
  EmptyState,
  LoadingState,
  Notice,
  PageHeader,
  Screen,
  Section,
} from "@/components/ui";

export default function IssuesScreen() {
  const router = useRouter();
  const issues = useIssues();

  return (
    <Screen>
      <PageHeader
        eyebrow="Issue Workflows"
        title="Ready issue inbox"
        summary="Issue workflow HTTP surfaces are preview-backed until the control-plane API exposes them."
        trailing={<DataModePill mode="mock" />}
      />

      <Notice
        title="Preview surface"
        detail="The DB already models issues, workflows, executions, events, validations, diffs, artifacts, summaries, and PR links. Mobile keeps that behind an adapter until endpoints exist."
      />

      <Section title="Ready To Run">
        {issues.isLoading || issues.data === undefined ? <LoadingState /> : null}
        {issues.data?.length === 0 ? (
          <EmptyState
            title="No issues"
            detail="Synced issue workflow inbox data will appear here."
          />
        ) : null}
        {issues.data?.map((issue) => (
          <IssueRow
            key={issue.issueId}
            issue={issue}
            onPress={() => router.push(`/issues/${issue.issueId}`)}
          />
        ))}
      </Section>
    </Screen>
  );
}
