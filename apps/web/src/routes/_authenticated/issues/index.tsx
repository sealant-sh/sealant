import { createFileRoute } from "@tanstack/react-router";

import { IssueRows } from "@/components/app/issue-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { ISSUES } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/issues/" as never)({
  component: IssuesPage,
});

function IssuesPage() {
  return (
    <WorkspacePage
      kicker="Issues"
      title="Delegation queue"
      description="Start here when triaging incoming issues and routing each one into the right run and profile context."
      metrics={[
        { label: "All issues", value: String(ISSUES.length) },
        {
          label: "Assigned to me",
          value: String(ISSUES.filter((issue) => issue.assignedToMe).length),
        },
        {
          label: "Ready for run",
          value: String(ISSUES.filter((issue) => issue.readyForRun).length),
        },
      ]}
    >
      <IssueRows issues={ISSUES} />
    </WorkspacePage>
  );
}
