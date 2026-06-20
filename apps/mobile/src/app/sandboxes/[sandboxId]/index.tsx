import { useLocalSearchParams, useRouter } from "expo-router";
import { ExternalLink, GitBranch, RotateCcw, Share2 } from "lucide-react-native";
import { Share } from "react-native";

import { useSandbox } from "@/api/queries";
import {
  ActionButton,
  LoadingState,
  MetricStrip,
  Notice,
  PageHeader,
  Screen,
  Section,
  StatusPill,
} from "@/components/ui";
import { firstRouteParam } from "@/lib/route-params";
import { colors } from "@/styles/theme";

export default function SandboxDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const sandboxId = firstRouteParam(params.sandboxId);
  const sandbox = useSandbox(sandboxId);

  if (sandbox.isLoading || sandbox.data === undefined) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (sandbox.data === null) {
    return (
      <Screen>
        <PageHeader eyebrow="Sandbox" title="Not found" summary="This sandbox is not available." />
      </Screen>
    );
  }

  const currentSandbox = sandbox.data;
  const runtimeEndpoint = currentSandbox.runtime?.endpoint;

  return (
    <Screen>
      <PageHeader
        eyebrow="Sandbox Detail"
        title={currentSandbox.name}
        summary={currentSandbox.repository ?? "Repository metadata pending"}
        trailing={<StatusPill status={currentSandbox.status} />}
      />

      <MetricStrip
        metrics={[
          { label: "Sandbox", value: currentSandbox.sandboxId },
          { label: "Registry", value: currentSandbox.registryId ?? "unknown" },
          { label: "Tag", value: currentSandbox.tag ?? "n/a" },
        ]}
      />

      <Section title="Connection">
        <Notice
          title={runtimeEndpoint ?? "Runtime connection pending"}
          detail="Mobile should copy or open runtime connection details when appropriate; command execution remains inside the isolated sandbox."
        />
        <ActionButton
          disabled={runtimeEndpoint === undefined}
          icon={<Share2 color={colors.text} size={16} />}
          label="Share connection"
          onPress={() => {
            void Share.share({
              message: runtimeEndpoint ?? currentSandbox.sandboxId,
            });
          }}
        />
      </Section>

      <Section title="Sandbox Evidence">
        <ActionButton
          icon={<GitBranch color={colors.text} size={16} />}
          label="Attempts"
          onPress={() => router.push(`/sandboxes/${currentSandbox.sandboxId}/attempts`)}
        />
        <ActionButton
          icon={<ExternalLink color={colors.text} size={16} />}
          label="Events timeline"
          onPress={() => router.push(`/sandboxes/${currentSandbox.sandboxId}/events`)}
        />
        <ActionButton
          disabled
          icon={<RotateCcw color={colors.text} size={16} />}
          label="Retry pending API"
          onPress={() => undefined}
        />
      </Section>

      {currentSandbox.error === undefined ? null : (
        <Notice title="Failure reason" detail={currentSandbox.error.message} />
      )}
    </Screen>
  );
}
