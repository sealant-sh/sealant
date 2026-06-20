import { createFileRoute } from "@tanstack/react-router";

import { IssueWorkflowBoard } from "@/components/app/issue-workflow-board";
import { SandboxPage } from "@/components/app/sandbox-page";
import {
  ISSUE_WORKFLOW_IMPORT_SUMMARIES,
  ISSUE_WORKFLOW_RECORDS,
  parseLinearImportSearchStatus,
} from "@/lib/navigation/issue-workflow-data";

export const Route = createFileRoute("/_authenticated/issues/")({
  validateSearch: (search: Record<string, unknown>) => ({
    linear: parseLinearImportSearchStatus(search.linear),
  }),
  component: IssuesPage,
});

function IssuesPage() {
  const search = Route.useSearch();

  return (
    <SandboxPage
      kicker="Issues"
      title="Issue workflow board"
      description="Import GitHub and Linear issues, triage what is ready, and keep workflow state visible before sandbox launch."
      metrics={[
        { label: "Imported issues", value: String(ISSUE_WORKFLOW_RECORDS.length) },
        {
          label: "Ready",
          value: String(ISSUE_WORKFLOW_RECORDS.filter((issue) => issue.stage === "ready").length),
        },
        {
          label: "Providers",
          value: String(ISSUE_WORKFLOW_IMPORT_SUMMARIES.length),
        },
      ]}
    >
      <IssueWorkflowBoard
        autoImportLinear={search.linear === "connected"}
        connectReturnTo="/issues"
        issues={ISSUE_WORKFLOW_RECORDS}
        imports={ISSUE_WORKFLOW_IMPORT_SUMMARIES}
      />
    </SandboxPage>
  );
}
