import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { DataMode, RiskLevel, SandboxStatus } from "@/api/types/models";
import { colors, radii, shadow, spacing, typography } from "@/styles/theme";

interface ScreenProps {
  readonly children: ReactNode;
  readonly scroll?: boolean;
}

export function Screen({ children, scroll = true }: ScreenProps) {
  if (!scroll) {
    return <SafeAreaView style={styles.screen}>{children}</SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

interface PageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary?: string;
  readonly trailing?: ReactNode;
}

export function PageHeader({ eyebrow, title, summary, trailing }: PageHeaderProps) {
  return (
    <View style={styles.pageHeader}>
      <View style={styles.pageHeaderText}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.title}>{title}</Text>
        {summary === undefined ? null : <Text style={styles.summary}>{summary}</Text>}
      </View>
      {trailing}
    </View>
  );
}

interface SectionProps {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

export function Section({ title, action, children }: SectionProps) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

interface DataModePillProps {
  readonly mode: DataMode;
}

export function DataModePill({ mode }: DataModePillProps) {
  return (
    <View
      accessible
      accessibilityLabel={mode === "live" ? "Live sandbox data" : "Preview data"}
      style={[styles.pill, mode === "live" ? styles.livePill : styles.previewPill]}
    >
      <Text style={[styles.pillText, mode === "live" ? styles.liveText : styles.previewText]}>
        {mode === "live" ? "Live" : "Preview"}
      </Text>
    </View>
  );
}

interface StatusPillProps {
  readonly status: SandboxStatus | "ready" | "waiting" | "completed" | "attention" | "blocked";
}

export function StatusPill({ status }: StatusPillProps) {
  const palette = statusPalette(status);

  return (
    <View
      accessible
      accessibilityLabel={`Status ${status}`}
      style={[styles.pill, { borderColor: palette.border, backgroundColor: palette.background }]}
    >
      <Text style={[styles.pillText, { color: palette.text }]}>{status}</Text>
    </View>
  );
}

interface RiskPillProps {
  readonly risk: RiskLevel;
}

export function RiskPill({ risk }: RiskPillProps) {
  const palette = riskPalette(risk);

  return (
    <View
      accessible
      accessibilityLabel={`Risk ${riskLabel(risk)}`}
      style={[styles.pill, { borderColor: palette.border, backgroundColor: palette.background }]}
    >
      <Text style={[styles.pillText, { color: palette.text }]}>{riskLabel(risk)}</Text>
    </View>
  );
}

interface MetricStripProps {
  readonly metrics: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export function MetricStrip({ metrics }: MetricStripProps) {
  return (
    <View style={styles.metricStrip}>
      {metrics.map((metric) => (
        <View key={metric.label} style={styles.metricItem}>
          <Text style={styles.metricLabel}>{metric.label}</Text>
          <Text style={styles.metricValue}>{metric.value}</Text>
        </View>
      ))}
    </View>
  );
}

interface ActionButtonProps {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onPress: () => void;
  readonly variant?: "primary" | "secondary" | "danger";
  readonly disabled?: boolean;
  readonly accessibilityRole?: AccessibilityRole;
}

export function ActionButton({
  label,
  icon,
  onPress,
  variant = "secondary",
  disabled = false,
  accessibilityRole = "button",
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        actionVariantStyle(variant),
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {icon}
      <Text style={[styles.actionLabel, actionLabelStyle(variant)]}>{label}</Text>
    </Pressable>
  );
}

interface EntityRowProps {
  readonly label: string;
  readonly title: string;
  readonly detail: string;
  readonly meta?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
}

export function EntityRow({
  label,
  title,
  detail,
  meta,
  leading,
  trailing,
  onPress,
}: EntityRowProps) {
  const content = (
    <>
      {leading}
      <View style={styles.entityBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
        {meta === undefined ? null : <Text style={styles.rowMeta}>{meta}</Text>}
      </View>
      {trailing}
    </>
  );

  if (onPress === undefined) {
    return <View style={styles.entityRow}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.entityRow, pressed ? styles.pressedRow : null]}
    >
      {content}
    </Pressable>
  );
}

interface ProgressBarProps {
  readonly value: number;
}

export function ProgressBar({ value }: ProgressBarProps) {
  const bounded = Math.max(0, Math.min(value, 100));

  return (
    <View
      accessible
      accessibilityLabel={`Progress ${bounded} percent`}
      accessibilityRole="progressbar"
      style={styles.progressTrack}
    >
      <View style={[styles.progressFill, { width: `${bounded}%` }]} />
    </View>
  );
}

interface TimelineRowProps {
  readonly phase: string;
  readonly message: string;
  readonly time: string;
  readonly level?: "debug" | "info" | "warn" | "error";
}

export function TimelineRow({ phase, message, time, level = "info" }: TimelineRowProps) {
  const palette = timelinePalette(level);

  return (
    <View style={styles.timelineRow}>
      <View style={[styles.timelineDot, { backgroundColor: palette }]} />
      <View style={styles.timelineBody}>
        <View style={styles.timelineMeta}>
          <Text style={styles.rowLabel}>{phase}</Text>
          <Text style={styles.rowMeta}>{time}</Text>
        </View>
        <Text style={styles.rowDetail}>{message}</Text>
      </View>
    </View>
  );
}

interface NoticeProps {
  readonly title: string;
  readonly detail: string;
}

export function Notice({ title, detail }: NoticeProps) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeTitle}>{title}</Text>
      <Text style={styles.noticeDetail}>{detail}</Text>
    </View>
  );
}

export function LoadingState() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.rowDetail}>Loading Sealant state</Text>
    </View>
  );
}

interface EmptyStateProps {
  readonly title: string;
  readonly detail: string;
}

export function EmptyState({ title, detail }: EmptyStateProps) {
  return (
    <View style={styles.empty}>
      <Text style={styles.noticeTitle}>{title}</Text>
      <Text style={styles.noticeDetail}>{detail}</Text>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

const statusPalette = (status: StatusPillProps["status"]) => {
  switch (status) {
    case "running":
    case "queued":
    case "waiting":
      return {
        background: "rgba(121, 199, 255, 0.12)",
        border: "rgba(121, 199, 255, 0.44)",
        text: colors.cyan,
      };
    case "ready":
    case "completed":
      return {
        background: "rgba(125, 220, 154, 0.12)",
        border: "rgba(125, 220, 154, 0.44)",
        text: colors.green,
      };
    case "failed":
    case "blocked":
      return {
        background: "rgba(255, 129, 122, 0.12)",
        border: "rgba(255, 129, 122, 0.5)",
        text: colors.red,
      };
    case "attention":
    case "cancelled":
      return {
        background: "rgba(242, 193, 102, 0.12)",
        border: "rgba(242, 193, 102, 0.5)",
        text: colors.amber,
      };
  }
};

const riskLabel = (risk: RiskLevel): string => {
  switch (risk) {
    case "healthy":
      return "Healthy";
    case "watching":
      return "Watching";
    case "needs-review":
      return "Needs review";
    case "blocked":
      return "Blocked";
    case "critical":
      return "Critical";
  }
};

const riskPalette = (risk: RiskLevel) => {
  switch (risk) {
    case "healthy":
      return {
        background: "rgba(125, 220, 154, 0.12)",
        border: "rgba(125, 220, 154, 0.44)",
        text: colors.green,
      };
    case "watching":
      return {
        background: "rgba(121, 199, 255, 0.12)",
        border: "rgba(121, 199, 255, 0.44)",
        text: colors.cyan,
      };
    case "needs-review":
      return {
        background: "rgba(242, 193, 102, 0.12)",
        border: "rgba(242, 193, 102, 0.5)",
        text: colors.amber,
      };
    case "blocked":
    case "critical":
      return {
        background: "rgba(255, 129, 122, 0.12)",
        border: "rgba(255, 129, 122, 0.5)",
        text: colors.red,
      };
  }
};

const timelinePalette = (level: TimelineRowProps["level"]): string => {
  switch (level) {
    case "error":
      return colors.red;
    case "warn":
      return colors.amber;
    case "debug":
      return colors.violet;
    case "info":
    default:
      return colors.accent;
  }
};

const actionVariantStyle = (
  variant: NonNullable<ActionButtonProps["variant"]>,
): StyleProp<ViewStyle> => {
  switch (variant) {
    case "primary":
      return styles.primaryButton;
    case "danger":
      return styles.dangerButton;
    case "secondary":
      return styles.secondaryButton;
  }
};

const actionLabelStyle = (variant: NonNullable<ActionButtonProps["variant"]>) => {
  switch (variant) {
    case "primary":
      return styles.primaryActionLabel;
    case "danger":
      return styles.dangerActionLabel;
    case "secondary":
      return styles.secondaryActionLabel;
  }
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: 40,
    gap: spacing.xl,
  },
  pageHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  pageHeaderText: {
    flex: 1,
    gap: spacing.sm,
  },
  eyebrow: {
    ...typography.label,
    color: colors.accent,
  },
  title: {
    color: colors.text,
    fontSize: 29,
    lineHeight: 34,
    fontWeight: "700",
  },
  summary: {
    ...typography.body,
    color: colors.muted,
  },
  section: {
    gap: spacing.md,
  },
  sectionHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  pill: {
    alignSelf: "flex-start",
    minHeight: 28,
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
  },
  pillText: {
    ...typography.label,
    fontSize: 10,
    fontWeight: "700",
  },
  livePill: {
    backgroundColor: "rgba(126, 231, 197, 0.12)",
    borderColor: "rgba(126, 231, 197, 0.44)",
  },
  liveText: {
    color: colors.accent,
  },
  previewPill: {
    backgroundColor: "rgba(199, 166, 255, 0.12)",
    borderColor: "rgba(199, 166, 255, 0.44)",
  },
  previewText: {
    color: colors.violet,
  },
  metricStrip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  metricItem: {
    minHeight: 70,
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  metricLabel: {
    ...typography.label,
  },
  metricValue: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "700",
    marginTop: spacing.xs,
  },
  actionButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  dangerButton: {
    backgroundColor: "rgba(255, 129, 122, 0.12)",
    borderColor: "rgba(255, 129, 122, 0.5)",
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  primaryActionLabel: {
    color: colors.black,
  },
  secondaryActionLabel: {
    color: colors.text,
  },
  dangerActionLabel: {
    color: colors.red,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.45,
  },
  entityRow: {
    ...shadow.border,
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  pressedRow: {
    backgroundColor: colors.surfaceAlt,
  },
  entityBody: {
    flex: 1,
    gap: spacing.xs,
  },
  rowLabel: {
    ...typography.label,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
  },
  rowDetail: {
    ...typography.body,
    color: colors.muted,
  },
  rowMeta: {
    ...typography.label,
    color: colors.dim,
  },
  progressTrack: {
    height: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.accent,
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 5,
  },
  timelineBody: {
    flex: 1,
    gap: spacing.xs,
  },
  timelineMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  notice: {
    ...shadow.border,
    gap: spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  noticeTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  noticeDetail: {
    ...typography.body,
    color: colors.muted,
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    minHeight: 180,
  },
  empty: {
    ...shadow.border,
    gap: spacing.sm,
    alignItems: "center",
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.xl,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
  },
});
