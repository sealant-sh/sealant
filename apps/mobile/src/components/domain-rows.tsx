import { AlertTriangle, Box, CheckCircle2, GitBranch, ShieldCheck } from "lucide-react-native";

import type {
  ApprovalRequest,
  IssueSummary,
  IssueWorkflowSummary,
  RunRecordSummary,
  SandboxSummary,
} from "@/api/types/models";
import { EntityRow, ProgressBar, RiskPill, StatusPill } from "@/components/ui";
import { relativeTime } from "@/lib/time";
import { colors } from "@/styles/theme";

interface SandboxRowProps {
  readonly sandbox: SandboxSummary;
  readonly onPress: () => void;
}

export function SandboxRow({ sandbox, onPress }: SandboxRowProps) {
  return (
    <EntityRow
      label="Sandbox"
      title={sandbox.name}
      detail={sandbox.repository ?? "Repository pending"}
      meta={`${sandbox.sandboxId} · ${relativeTime(sandbox.updatedAt)}`}
      leading={<Box color={colors.accent} size={22} />}
      trailing={<StatusPill status={sandbox.status} />}
      onPress={onPress}
    />
  );
}

interface IssueRowProps {
  readonly issue: IssueSummary;
  readonly onPress: () => void;
}

export function IssueRow({ issue, onPress }: IssueRowProps) {
  return (
    <EntityRow
      label={`${issue.repository} #${issue.number}`}
      title={issue.title}
      detail={issue.objective}
      meta={`${issue.labels.join(", ")} · ${relativeTime(issue.updatedAt)}`}
      leading={<GitBranch color={colors.cyan} size={22} />}
      trailing={<RiskPill risk={issue.risk} />}
      onPress={onPress}
    />
  );
}

interface WorkflowRowProps {
  readonly workflow: IssueWorkflowSummary;
  readonly onPress: () => void;
}

export function WorkflowRow({ workflow, onPress }: WorkflowRowProps) {
  return (
    <EntityRow
      label="Issue workflow"
      title={workflow.currentStep}
      detail={`${workflow.harness} · ${workflow.policy}`}
      meta={`Updated ${relativeTime(workflow.updatedAt)}`}
      leading={<CheckCircle2 color={colors.green} size={22} />}
      trailing={<StatusPill status={workflow.status === "waiting" ? "waiting" : "running"} />}
      onPress={onPress}
    />
  );
}

interface WorkflowProgressProps {
  readonly workflow: IssueWorkflowSummary;
}

export function WorkflowProgress({ workflow }: WorkflowProgressProps) {
  return <ProgressBar value={workflow.progressPercent} />;
}

interface ApprovalRowProps {
  readonly approval: ApprovalRequest;
  readonly onPress: () => void;
}

export function ApprovalRow({ approval, onPress }: ApprovalRowProps) {
  return (
    <EntityRow
      label="Approval"
      title={approval.title}
      detail={approval.reason}
      meta={`Due ${relativeTime(approval.dueAt)} · ${approval.requestedBy}`}
      leading={<ShieldCheck color={colors.amber} size={22} />}
      trailing={<RiskPill risk={approval.risk} />}
      onPress={onPress}
    />
  );
}

interface RunRecordRowProps {
  readonly record: RunRecordSummary;
  readonly onPress: () => void;
}

export function RunRecordRow({ record, onPress }: RunRecordRowProps) {
  return (
    <EntityRow
      label="Run Record"
      title={record.title}
      detail={record.objective}
      meta={`${record.filesChanged} files · ${record.commandsRun} commands · ${relativeTime(
        record.generatedAt,
      )}`}
      leading={<AlertTriangle color={colors.violet} size={22} />}
      trailing={<StatusPill status={record.status === "attention" ? "attention" : "ready"} />}
      onPress={onPress}
    />
  );
}
