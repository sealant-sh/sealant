import { Button } from "@sealant/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";

import { useTRPC } from "@/lib/trpc/react";

export const Route = createFileRoute("/_authenticated/settings/ssh-keys")({
  component: SshKeysSettingsPage,
});

/** Best-effort comment extraction for the name prefill; the server does authoritative parsing. */
const readKeyComment = (publicKey: string): string | undefined => {
  const parts = publicKey.trim().split(/\s+/);
  const comment = parts.slice(2).join(" ").trim();

  return comment.length > 0 ? comment : undefined;
};

function SshKeysSettingsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const keysQuery = useQuery(trpc.sshKey.list.queryOptions());

  const addKeyMutation = useMutation(
    trpc.sshKey.add.mutationOptions({
      onSuccess: async (response) => {
        setStatusMessage(`Registered '${response.name}' (${response.fingerprint}).`);
        setName("");
        setPublicKey("");
        await queryClient.invalidateQueries({ queryKey: trpc.sshKey.list.pathKey() });
      },
    }),
  );

  const removeKeyMutation = useMutation(
    trpc.sshKey.remove.mutationOptions({
      onSuccess: async (response) => {
        setStatusMessage(`Removed '${response.name}'. New SSH connections with it are rejected.`);
        await queryClient.invalidateQueries({ queryKey: trpc.sshKey.list.pathKey() });
      },
    }),
  );

  const addErrorMessage = useMemo(() => {
    return addKeyMutation.error instanceof Error ? addKeyMutation.error.message : null;
  }, [addKeyMutation.error]);

  const removeErrorMessage = useMemo(() => {
    return removeKeyMutation.error instanceof Error ? removeKeyMutation.error.message : null;
  }, [removeKeyMutation.error]);

  const keys = keysQuery.data?.items ?? [];

  const handleAddKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const normalizedKey = publicKey.trim();
    if (normalizedKey.length === 0) {
      setStatusMessage("Paste an SSH public key to register it.");
      return;
    }

    setStatusMessage(null);
    const normalizedName = name.trim().length > 0 ? name.trim() : readKeyComment(normalizedKey);
    await addKeyMutation.mutateAsync({
      publicKey: normalizedKey,
      ...(normalizedName === undefined ? {} : { name: normalizedName }),
    });
  };

  return (
    <div className="space-y-8 p-8 lg:p-10">
      <header>
        <p className="ev-eyebrow">settings.ssh</p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          SSH keys
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Public keys registered here authenticate you at the sandbox SSH gateway. A new key works
          immediately — connect with <span className="font-mono">ssh sbx-&lt;sandboxId&gt;</span>{" "}
          after launching a sandbox.
        </p>
      </header>

      <div className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:p-8">
            <h2 className="flex items-baseline gap-3 text-base font-semibold tracking-[-0.01em] text-foreground">
              <span className="font-mono text-sm text-primary">01</span>
              Register a public key
            </h2>
            <form className="mt-5 space-y-4" onSubmit={handleAddKey}>
              <label className="flex flex-col gap-2">
                <span className="ev-eyebrow">Name (optional — defaults to the key comment)</span>
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setStatusMessage(null);
                  }}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  placeholder="my laptop"
                  autoComplete="off"
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="ev-eyebrow">Public key</span>
                <textarea
                  value={publicKey}
                  onChange={(event) => {
                    setPublicKey(event.target.value);
                    setStatusMessage(null);
                  }}
                  rows={4}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  placeholder="ssh-ed25519 AAAA... user@host"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              {addErrorMessage === null ? null : (
                <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
                  {addErrorMessage}
                </div>
              )}

              <Button type="submit" className="h-11 px-5" disabled={addKeyMutation.isPending}>
                {addKeyMutation.isPending ? "Registering..." : "Register key"}
              </Button>
            </form>
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
                only routes you to sandboxes <em>you own</em>.
              </p>
              <p>
                Keys take effect immediately on registration and stop working immediately on
                removal — no restarts involved.
              </p>
              <div className="rounded-xl border border-rule-faint bg-background px-4 py-4">
                <p className="ev-eyebrow">Connect</p>
                <p className="mt-2 font-mono text-xs text-foreground break-all">
                  ssh sbx-&lt;sandboxId&gt;@127.0.0.1 -p 2222
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
