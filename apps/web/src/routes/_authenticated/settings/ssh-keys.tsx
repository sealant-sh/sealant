import { Button } from "@sealant/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { AddSshKeyForm } from "@/features/ssh-keys/add-ssh-key-form";
import { useTRPC } from "@/lib/trpc/react";

export const Route = createFileRoute("/_authenticated/settings/ssh-keys")({
  component: SshKeysSettingsPage,
});

function SshKeysSettingsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const keysQuery = useQuery(trpc.sshKey.list.queryOptions());

  const removeKeyMutation = useMutation(
    trpc.sshKey.remove.mutationOptions({
      onSuccess: async (response) => {
        setStatusMessage(`Removed '${response.name}'. New SSH connections with it are rejected.`);
        await queryClient.invalidateQueries({ queryKey: trpc.sshKey.list.pathKey() });
      },
    }),
  );

  const removeErrorMessage = useMemo(() => {
    return removeKeyMutation.error instanceof Error ? removeKeyMutation.error.message : null;
  }, [removeKeyMutation.error]);

  const keys = keysQuery.data?.items ?? [];

  return (
    <div className="space-y-8 p-8 lg:p-10">
      <header>
        <p className="ev-eyebrow">settings.ssh</p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          SSH keys
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Public keys registered here authenticate you at the workspace SSH gateway. A new key works
          immediately — connect with <span className="font-mono">ssh ws-&lt;workspaceId&gt;</span>{" "}
          after launching a workspace.
        </p>
      </header>

      <div className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:p-8">
            <h2 className="flex items-baseline gap-3 text-base font-semibold tracking-[-0.01em] text-foreground">
              <span className="font-mono text-sm text-primary">01</span>
              Register a public key
            </h2>
            <div className="mt-5">
              <AddSshKeyForm
                onSuccess={(key) => {
                  setStatusMessage(`Registered '${key.name}' (${key.fingerprint}).`);
                }}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:p-8">
            <h2 className="flex items-baseline gap-3 text-base font-semibold tracking-[-0.01em] text-foreground">
              <span className="font-mono text-sm text-primary">02</span>
              Registered keys
            </h2>

            {removeErrorMessage === null ? null : (
              <div className="mt-5 border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
                {removeErrorMessage}
              </div>
            )}

            {keysQuery.isLoading ? (
              <div className="mt-5 rounded-xl border border-rule-faint bg-background px-4 py-4 text-sm text-muted-foreground">
                Loading registered keys...
              </div>
            ) : keys.length === 0 ? (
              <div className="mt-5 rounded-xl border border-rule-faint bg-background px-4 py-4 text-sm leading-relaxed text-muted-foreground">
                No keys registered yet. Paste your public key above — usually found at{" "}
                <span className="font-mono">~/.ssh/id_ed25519.pub</span>.
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {keys.map((key) => {
                  const isRemoving =
                    removeKeyMutation.isPending &&
                    removeKeyMutation.variables?.sshKeyId === key.sshKeyId;

                  return (
                    <div
                      key={key.sshKeyId}
                      className="rounded-xl border border-rule-faint bg-background px-4 py-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground break-all">
                            {key.name}
                          </p>
                          <p className="mt-1.5 font-mono text-xs text-faint break-all">
                            {key.fingerprint}
                          </p>
                          <p className="mt-2 font-mono text-[0.68rem] text-muted-foreground">
                            {key.algorithm} · added {new Date(key.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10 px-3"
                          disabled={isRemoving}
                          onClick={() => {
                            setStatusMessage(null);
                            removeKeyMutation.mutate({ sshKeyId: key.sshKeyId });
                          }}
                        >
                          {isRemoving ? "Removing..." : "Remove"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside className="xl:sticky xl:top-6 xl:self-start">
          <div className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">
              How gateway access works
            </h2>

            {statusMessage === null ? null : (
              <div className="mt-5 border-l-2 border-primary py-1 pl-3 text-sm leading-6 text-foreground">
                {statusMessage}
              </div>
            )}

            <div className="mt-6 space-y-4 border-t border-rule-faint pt-6 text-sm leading-relaxed text-muted-foreground">
              <p>
                The gateway matches the key your SSH client offers against your registered keys and
                only routes you to workspaces <em>you own</em>.
              </p>
              <p>
                Keys take effect immediately on registration and stop working immediately on removal
                — no restarts involved.
              </p>
              <div className="rounded-xl border border-rule-faint bg-background px-4 py-4">
                <p className="ev-eyebrow">Connect</p>
                <p className="mt-2 font-mono text-xs text-foreground break-all">
                  ssh ws-&lt;workspaceId&gt;
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
