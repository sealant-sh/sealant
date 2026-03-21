import { createFileRoute } from "@tanstack/react-router";

import { IssueRows } from "@/components/app/issue-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { ISSUES } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/issues/ready" as never)({
  component: ReadyIssuesPage,
});

function ReadyIssuesPage() {
  const readyIssues = ISSUES.filter((issue) => issue.readyForRun);

  return (
    <WorkspacePage
      kicker="Issues"
      title="Ready for run"
      description="These issues have enough context to launch execution immediately without extra setup steps."
      metrics={[
        { label: "Ready", value: String(readyIssues.length) },
        {
          label: "Assigned",
          value: String(readyIssues.filter((issue) => issue.assignedToMe).length),
        },
        { label: "Avg prep", value: "5m" },
      ]}
    >
      <IssueRows issues={readyIssues} />
    </WorkspacePage>
  );
}
