import { useLocalSearchParams, useRouter } from "expo-router";
import { Play, Shield } from "lucide-react-native";

import { useIssue } from "@/api/queries";
import {
  ActionButton,
  DataModePill,
  LoadingState,
  Notice,
  PageHeader,
  RiskPill,
  Screen,
  Section,
} from "@/components/ui";
import { firstRouteParam } from "@/lib/route-params";
import { colors } from "@/styles/theme";

export default function IssueDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const issueId = firstRouteParam(params.issueId);
  const issue = useIssue(issueId);

  if (issue.isLoading || issue.data === undefined) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (issue.data === null) {
    return (
      <Screen>
        <PageHeader eyebrow="Issue" title="Not found" summary="This issue is not available." />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        eyebrow={`${issue.data.repository} #${issue.data.number}`}
        title={issue.data.title}
        summary={issue.data.objective}
        trailing={<RiskPill risk={issue.data.risk} />}
      />

      <Section title="Start Issue Workflow">
        <Notice
          title="Harness: opencode · Policy: standard-review"
          detail="The start action is preview-backed until issue workflow HTTP endpoints exist. The data model already mirrors planned backend execution records."
        />
        <ActionButton
          icon={<Play color={colors.black} size={16} />}
          label="Start preview workflow"
          onPress={() => router.push("/workflows/workflow-314")}
          variant="primary"
        />
      </Section>

      <Section title="Policy Preview">
        <Notice
          title="Network and secret gates"
          detail="Privileged access requests are routed to Approvals with reason, risk, linked sandbox, and rejection comment support."
        />
        <ActionButton
          icon={<Shield color={colors.text} size={16} />}
          label="Open approval"
          onPress={() => router.push("/approvals/approval-network-314")}
        />
      </Section>

      <DataModePill mode="mock" />
    </Screen>
  );
}
