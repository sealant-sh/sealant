import { useRouter } from "expo-router";

import { useApprovals } from "@/api/queries";
import { ApprovalRow } from "@/components/domain-rows";
import { EmptyState, LoadingState, Notice, PageHeader, Screen, Section } from "@/components/ui";

export default function ApprovalsScreen() {
  const router = useRouter();
  const approvals = useApprovals();

  return (
    <Screen>
      <PageHeader
        eyebrow="Approvals"
        title="Context before commitment"
        summary="Secret access, network escalation, retry, PR creation, and broader repository permissions are first-class mobile decisions."
      />

      <Section title="Waiting">
        {approvals.isLoading || approvals.data === undefined ? <LoadingState /> : null}
        {approvals.data?.length === 0 ? (
          <EmptyState
            title="No approvals"
            detail="Requests that need your attention will appear here."
          />
        ) : null}
        {approvals.data?.map((approval) => (
          <ApprovalRow
            key={approval.approvalId}
            approval={approval}
            onPress={() => router.push(`/approvals/${approval.approvalId}`)}
          />
        ))}
      </Section>

      <Notice
        title="Approval guardrail"
        detail="Low-risk approvals can be quick. Privileged approvals should require a full detail view, rejection reason, and later biometric confirmation."
      />
    </Screen>
  );
}
