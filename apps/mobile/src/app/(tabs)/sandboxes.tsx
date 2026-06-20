import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Plus, RefreshCcw } from "lucide-react-native";

import { sealantApi } from "@/api/client";
import { queryKeys, useRepositories, useSandboxes } from "@/api/queries";
import { SandboxRow } from "@/components/domain-rows";
import {
  ActionButton,
  EmptyState,
  LoadingState,
  Notice,
  PageHeader,
  Screen,
  Section,
} from "@/components/ui";
import { colors } from "@/styles/theme";

export default function SandboxesScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sandboxes = useSandboxes();
  const repositories = useRepositories();
  const firstRepository = repositories.data?.[0];

  const createSandbox = useMutation({
    mutationFn: () => {
      if (firstRepository === undefined) {
        throw new Error("No repository available for sandbox creation.");
      }

      return sealantApi.createSandbox({
        repository: firstRepository,
        ref: firstRepository.defaultBranch,
        templateTag: "mobile-preview",
        name: `${firstRepository.name} mobile preview`,
      });
    },
    onSuccess: (sandbox) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes });
      router.push(`/sandboxes/${sandbox.sandboxId}`);
    },
  });

  return (
    <Screen>
      <PageHeader
        eyebrow="Sandboxes"
        title="Mobile control room"
        summary="Create, monitor, inspect attempts, and open runtime connection details for sandboxes."
      />

      <Section
        title="Package / Repo Shortcut"
        action={
          <ActionButton
            disabled={firstRepository === undefined || createSandbox.isPending}
            icon={<Plus color={colors.black} size={16} />}
            label={createSandbox.isPending ? "Creating" : "Create"}
            onPress={() => createSandbox.mutate()}
            variant="primary"
          />
        }
      >
        <Notice
          title={firstRepository?.fullName ?? "Repository picker pending"}
          detail="GitHub repository selection is wired as a clean adapter. Live install and catalog setup remain backend follow-ups."
        />
      </Section>

      <Section
        title="Active Sandboxes"
        action={
          <ActionButton
            icon={<RefreshCcw color={colors.text} size={16} />}
            label="Refresh"
            onPress={() => {
              void sandboxes.refetch();
            }}
          />
        }
      >
        {sandboxes.isLoading || sandboxes.data === undefined ? <LoadingState /> : null}
        {sandboxes.data?.length === 0 ? (
          <EmptyState title="No sandboxes" detail="Create one from a repository shortcut." />
        ) : null}
        {sandboxes.data?.map((sandbox) => (
          <SandboxRow
            key={sandbox.sandboxId}
            sandbox={sandbox}
            onPress={() => router.push(`/sandboxes/${sandbox.sandboxId}`)}
          />
        ))}
      </Section>
    </Screen>
  );
}
