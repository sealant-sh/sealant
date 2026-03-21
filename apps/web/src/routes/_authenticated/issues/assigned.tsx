import { createFileRoute } from "@tanstack/react-router";

import { IssueRows } from "@/components/app/issue-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { ISSUES } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/issues/assigned" as never)({
  component: AssignedIssuesPage,
});

function AssignedIssuesPage() {
  const assignedIssues = ISSUES.filter((issue) => issue.assignedToMe);

  return (
    <WorkspacePage
      kicker="Issues"
      title="Assigned to me"
      description="Focus only on issues you currently own and drive each one into a validated run workspace."
      metrics={[
        { label: "Owned now", value: String(assignedIssues.length) },
        {
          label: "Ready",
          value: String(assignedIssues.filter((issue) => issue.readyForRun).length),
        },
        {
          label: "Blocked",
          value: String(assignedIssues.filter((issue) => !issue.readyForRun).length),
        },
      ]}
    >
      <IssueRows issues={assignedIssues} />
    </WorkspacePage>
  );
}
