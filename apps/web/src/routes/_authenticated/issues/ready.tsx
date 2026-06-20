import { createFileRoute } from "@tanstack/react-router";

import { IssueWorkflowBoard } from "@/components/app/issue-workflow-board";
import { SandboxPage } from "@/components/app/sandbox-page";
import {
  ISSUE_WORKFLOW_IMPORT_SUMMARIES,
  ISSUE_WORKFLOW_RECORDS,
  parseLinearImportSearchStatus,
} from "@/lib/navigation/issue-workflow-data";

export const Route = createFileRoute("/_authenticated/issues/ready")({
  validateSearch: (search: Record<string, unknown>) => ({
    linear: parseLinearImportSearchStatus(search.linear),
  }),
  component: ReadyIssuesPage,
});

function ReadyIssuesPage() {
  const search = Route.useSearch();
  const readyIssues = ISSUE_WORKFLOW_RECORDS.filter((issue) => issue.stage === "ready");

  return (
    <SandboxPage
      kicker="Issues"
      title="Ready for workflow"
      description="These imported issues have enough source context and ownership signal to begin an issue workflow without extra setup steps."
      metrics={[
        { label: "Ready", value: String(readyIssues.length) },
        {
          label: "Assigned",
          value: String(readyIssues.filter((issue) => issue.assigneeName !== null).length),
        },
        { label: "Providers", value: String(ISSUE_WORKFLOW_IMPORT_SUMMARIES.length) },
      ]}
    >
      <IssueWorkflowBoard
        autoImportLinear={search.linear === "connected"}
        connectReturnTo="/issues/ready"
        issues={readyIssues}
        imports={ISSUE_WORKFLOW_IMPORT_SUMMARIES}
      />
    </SandboxPage>
  );
}
