import { NativeSelect, NativeSelectOption } from "@sealant/ui";
import type { ConnectedAccountProvider, ConnectedAccountSummary } from "@sealant/validators";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { WorkspacePage } from "@/components/app/workspace-page";
import { useTRPC } from "@/lib/trpc/react";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/agents")({
  component: ProfileAgentsPage,
});

const PROVIDER_LABELS: ReadonlyArray<{
  readonly provider: ConnectedAccountProvider;
  readonly label: string;
}> = [
  { provider: "claude", label: "Claude" },
  { provider: "codex", label: "Codex" },
  { provider: "github", label: "GitHub" },
];

const NOT_LINKED = "";

function ProfileAgentsPage() {
  const { profileId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const profilesQuery = useQuery(trpc.connectedAccounts.profilesList.queryOptions());
  const accountsQuery = useQuery(trpc.connectedAccounts.list.queryOptions());
  const bindingsQuery = useQuery(
    trpc.connectedAccounts.profileBindings.queryOptions({ profileId }),
  );

  const setBindingMutation = useMutation(
    trpc.connectedAccounts.setProfileBinding.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.connectedAccounts.profileBindings.pathKey(),
        });
      },
    }),
  );

  const profile = useMemo(
    () => (profilesQuery.data?.items ?? []).find((item) => item.profileId === profileId) ?? null,
    [profilesQuery.data, profileId],
  );

  const accountsByProvider = useMemo(() => {
    const map = new Map<ConnectedAccountProvider, ConnectedAccountSummary[]>();

    for (const account of accountsQuery.data?.items ?? []) {
      if (account.status === "archived") {
        continue;
      }

      const existing = map.get(account.provider);
      if (existing === undefined) {
        map.set(account.provider, [account]);
      } else {
        existing.push(account);
      }
    }

    return map;
  }, [accountsQuery.data]);

  const bindingByProvider = useMemo(() => {
    const map = new Map<ConnectedAccountProvider, string>();

    for (const binding of bindingsQuery.data?.items ?? []) {
      map.set(binding.provider, binding.connectedAccountId);
    }

    return map;
  }, [bindingsQuery.data]);

  const errorMessage =
    setBindingMutation.error instanceof Error ? setBindingMutation.error.message : null;

  const title = profile === null ? "Agents" : `${profile.name} agents`;

  return (
    <WorkspacePage
      kicker="Profile"
      title={title}
      description="Bind a connected account per provider. Workspaces launched from this profile inherit these identities — Claude, Codex, and GitHub — unless a launch overrides them."
    >
      <div className="space-y-8">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-6 py-4">
            <span className="font-mono text-xs text-ink-2">profile · {profileId}</span>
            <Link
              to="/settings/connected-accounts"
              className="text-xs font-medium text-primary no-underline hover:underline"
            >
              Manage connected accounts
            </Link>
          </div>

          {errorMessage === null ? null : (
            <div className="border-b border-rule-faint px-6 py-3">
              <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
                {errorMessage}
              </div>
            </div>
          )}

          {bindingsQuery.isLoading || accountsQuery.isLoading ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">
              Loading account bindings...
            </div>
          ) : (
            <div className="divide-y divide-rule-faint">
              {PROVIDER_LABELS.map(({ provider, label }) => {
                const accounts = accountsByProvider.get(provider) ?? [];
                const selected = bindingByProvider.get(provider) ?? NOT_LINKED;
                const isPending =
                  setBindingMutation.isPending &&
                  setBindingMutation.variables?.provider === provider;

                return (
                  <div
                    key={provider}
                    className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{label}</p>
                      {accounts.length === 0 ? (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          No {label} account connected yet.{" "}
                          <Link
                            to="/settings/connected-accounts"
                            className="text-primary no-underline hover:underline"
                          >
                            Connect one
                          </Link>{" "}
                          to bind it here.
                        </p>
                      ) : null}
                    </div>

                    <NativeSelect
                      className="w-full sm:w-72"
                      aria-label={`${label} account for this profile`}
                      value={selected}
                      disabled={accounts.length === 0 || isPending}
                      onChange={(event) => {
                        const value = event.target.value;
                        setBindingMutation.mutate({
                          profileId,
                          provider,
                          connectedAccountId: value === NOT_LINKED ? null : value,
                        });
                      }}
                    >
                      <NativeSelectOption value={NOT_LINKED}>Not linked</NativeSelectOption>
                      {accounts.map((account) => (
                        <NativeSelectOption
                          key={account.connectedAccountId}
                          value={account.connectedAccountId}
                        >
                          {account.name}
                          {account.status === "invalid" ? " (invalid)" : ""}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </WorkspacePage>
  );
}
