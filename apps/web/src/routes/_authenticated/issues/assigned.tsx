import { createFileRoute } from "@tanstack/react-router";

import { IssueRows } from "@/components/app/issue-rows";
import { SandboxPage } from "@/components/app/sandbox-page";
import { ISSUES } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/issues/assigned" as never)({
  component: AssignedIssuesPage,
});

function AssignedIssuesPage() {
  const assignedIssues = ISSUES.filter((issue) => issue.assignedToMe);

  return (
    <SandboxPage
      kicker="Issues"
      title="Assigned to me"
      description="Focus only on issues you currently own and drive each one into a validated run sandbox."
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
    </SandboxPage>
  );
}
