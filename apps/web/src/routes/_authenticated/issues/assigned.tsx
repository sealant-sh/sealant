import { createFileRoute } from "@tanstack/react-router";

import { IssueWorkflowBoard } from "@/components/app/issue-workflow-board";
import { SandboxPage } from "@/components/app/sandbox-page";
import {
  ISSUE_WORKFLOW_IMPORT_SUMMARIES,
  ISSUE_WORKFLOW_RECORDS,
  parseLinearImportSearchStatus,
} from "@/lib/navigation/issue-workflow-data";

export const Route = createFileRoute("/_authenticated/issues/assigned")({
  validateSearch: (search: Record<string, unknown>) => ({
    linear: parseLinearImportSearchStatus(search.linear),
  }),
  component: AssignedIssuesPage,
});

function AssignedIssuesPage() {
  const search = Route.useSearch();
  const assignedIssues = ISSUE_WORKFLOW_RECORDS.filter((issue) => issue.assigneeName !== null);

  return (
    <SandboxPage
      kicker="Issues"
      title="Assigned issue workflows"
      description="Focus on imported issues that already have an owner and can move through the workflow board with less context gathering."
      metrics={[
        { label: "Owned now", value: String(assignedIssues.length) },
        {
          label: "Ready",
          value: String(assignedIssues.filter((issue) => issue.stage === "ready").length),
        },
        {
          label: "In motion",
          value: String(
            assignedIssues.filter((issue) => issue.stage === "active" || issue.stage === "review")
              .length,
          ),
        },
      ]}
    >
      <IssueWorkflowBoard
        autoImportLinear={search.linear === "connected"}
        connectReturnTo="/issues/assigned"
        issues={assignedIssues}
        imports={ISSUE_WORKFLOW_IMPORT_SUMMARIES}
      />
    </SandboxPage>
  );
}
