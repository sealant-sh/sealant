import { StyleSheet, Text, View } from "react-native";

import type { RunRecordSummary } from "@/api/types/models";
import { Divider, RiskPill, Section, TimelineRow } from "@/components/ui";
import { compactTime } from "@/lib/time";
import { colors, radii, shadow, spacing, typography } from "@/styles/theme";

interface ReviewPacketProps {
  readonly record: RunRecordSummary;
}

export function ReviewPacket({ record }: ReviewPacketProps) {
  return (
    <>
      <Section title="60 Second Answer">
        <View style={styles.packet}>
          <PacketRow label="Objective" value={record.objective} />
          <PacketRow label="Repository" value={`${record.repository} · ${record.branch}`} />
          <PacketRow
            label="Evidence"
            value={`${record.commandsRun} commands · ${record.filesChanged} files changed`}
          />
          <PacketRow label="PR" value={record.prUrl ?? "PR pending approval"} />
        </View>
      </Section>

      <Section title="Validation">
        <View style={styles.packet}>
          {record.validations.map((validation) => (
            <View key={validation.checkKey} style={styles.validationRow}>
              <View style={styles.validationBody}>
                <Text style={styles.packetLabel}>{validation.checkKey}</Text>
                <Text style={styles.packetValue}>{validation.message}</Text>
              </View>
              <Text style={validationStatusStyle(validation.status)}>{validation.status}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Changed Files By Intent">
        {record.fileGroups.map((group) => (
          <View key={group.label} style={styles.packet}>
            <Text style={styles.groupTitle}>{group.label}</Text>
            <Text style={styles.packetValue}>{group.intent}</Text>
            <Divider />
            {group.files.map((file) => (
              <View key={file.path} style={styles.fileRow}>
                <View style={styles.validationBody}>
                  <Text style={styles.packetLabel}>{file.changeType}</Text>
                  <Text style={styles.packetValue}>{file.path}</Text>
                  <Text style={styles.packetMeta}>
                    +{file.additions} / -{file.deletions}
                  </Text>
                </View>
                <RiskPill risk={file.risk} />
              </View>
            ))}
          </View>
        ))}
      </Section>

      <Section title="Risks">
        {record.risks.map((risk) => (
          <View key={risk.summary} style={styles.riskRow}>
            <RiskPill risk={risk.level} />
            <Text style={styles.riskText}>{risk.summary}</Text>
          </View>
        ))}
      </Section>

      <Section title="Runtime Evidence">
        {record.timeline.map((event) => (
          <TimelineRow
            key={event.eventId}
            level={event.level}
            phase={event.phase}
            message={event.message}
            time={compactTime(event.occurredAt)}
          />
        ))}
      </Section>
    </>
  );
}

interface PacketRowProps {
  readonly label: string;
  readonly value: string;
}

function PacketRow({ label, value }: PacketRowProps) {
  return (
    <View style={styles.packetRow}>
      <Text style={styles.packetLabel}>{label}</Text>
      <Text style={styles.packetValue}>{value}</Text>
    </View>
  );
}

const validationStatusStyle = (status: RunRecordSummary["validations"][number]["status"]) => {
  switch (status) {
    case "pass":
      return styles.passText;
    case "warn":
      return styles.warnText;
    case "fail":
      return styles.failText;
    case "skip":
      return styles.skipText;
  }
};

const styles = StyleSheet.create({
  packet: {
    ...shadow.border,
    gap: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  packetRow: {
    gap: spacing.xs,
  },
  packetLabel: {
    ...typography.label,
  },
  packetValue: {
    ...typography.body,
    color: colors.text,
  },
  packetMeta: {
    ...typography.label,
    color: colors.dim,
  },
  groupTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  validationRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  validationBody: {
    flex: 1,
    gap: spacing.xs,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  riskRow: {
    ...shadow.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  riskText: {
    ...typography.body,
    flex: 1,
    color: colors.text,
  },
  passText: {
    ...typography.label,
    color: colors.green,
    fontWeight: "700",
  },
  warnText: {
    ...typography.label,
    color: colors.amber,
    fontWeight: "700",
  },
  failText: {
    ...typography.label,
    color: colors.red,
    fontWeight: "700",
  },
  skipText: {
    ...typography.label,
    color: colors.dim,
    fontWeight: "700",
  },
});
