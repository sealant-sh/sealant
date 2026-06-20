import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, FileText, MessageSquare, X } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";

import { useApproval } from "@/api/queries";
import {
  ActionButton,
  LoadingState,
  MetricStrip,
  Notice,
  PageHeader,
  RiskPill,
  Screen,
  Section,
} from "@/components/ui";
import { firstRouteParam } from "@/lib/route-params";
import { colors, radii, spacing, typography } from "@/styles/theme";

export default function ApprovalDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const approvalId = firstRouteParam(params.approvalId);
  const approval = useApproval(approvalId);
  const [reason, setReason] = useState("");

  if (approval.isLoading || approval.data === undefined) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (approval.data === null) {
    return (
      <Screen>
        <PageHeader
          eyebrow="Approval"
          title="Not found"
          summary="This approval request is not available."
        />
      </Screen>
    );
  }

  const currentApproval = approval.data;

  return (
    <Screen>
      <PageHeader
        eyebrow="Approval Request"
        title={currentApproval.title}
        summary={currentApproval.reason}
        trailing={<RiskPill risk={currentApproval.risk} />}
      />

      <MetricStrip
        metrics={[
          { label: "Kind", value: currentApproval.kind },
          { label: "Requested by", value: currentApproval.requestedBy },
          { label: "Status", value: currentApproval.status },
        ]}
      />

      <Section title="Linked Context">
        <Notice
          title={currentApproval.linkedWorkflowId ?? "Workflow pending"}
          detail={currentApproval.linkedSandboxId ?? "Sandbox link pending"}
        />
        {currentApproval.linkedWorkflowId === undefined ? null : (
          <ActionButton
            icon={<FileText color={colors.text} size={16} />}
            label="Open workflow"
            onPress={() => router.push(`/workflows/${currentApproval.linkedWorkflowId}`)}
          />
        )}
      </Section>

      <Section title="Decision Note">
        <TextInput
          accessibilityLabel="Approval decision reason"
          multiline
          onChangeText={setReason}
          placeholder="Reason required for reject or request changes"
          placeholderTextColor={colors.dim}
          style={styles.input}
          value={reason}
        />
      </Section>

      <Section title="Decision">
        <ActionButton
          icon={<Check color={colors.black} size={16} />}
          label="Approve"
          onPress={() => router.back()}
          variant="primary"
        />
        <ActionButton
          disabled={reason.trim().length === 0}
          icon={<MessageSquare color={colors.text} size={16} />}
          label="Request changes"
          onPress={() => router.back()}
        />
        <ActionButton
          disabled={reason.trim().length === 0}
          icon={<X color={colors.red} size={16} />}
          label="Reject"
          onPress={() => router.back()}
          variant="danger"
        />
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    ...typography.body,
    minHeight: 112,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    textAlignVertical: "top",
  },
});
