import { Button } from "@sealant/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";

import { useTRPC } from "@/lib/trpc/react";

/** Best-effort comment extraction for the name prefill; the server does authoritative parsing. */
const readKeyComment = (publicKey: string): string | undefined => {
  const parts = publicKey.trim().split(/\s+/);
  const comment = parts.slice(2).join(" ").trim();

  return comment.length > 0 ? comment : undefined;
};

export interface RegisteredSshKey {
  readonly sshKeyId: string;
  readonly name: string;
  readonly fingerprint: string;
}

/**
 * Paste-and-register form for a single SSH public key. Owns the tRPC mutation and the
 * `sshKey.list` invalidation; callers handle page-specific follow-up (status message, navigation)
 * in `onSuccess`.
 */
export function AddSshKeyForm(props: {
  readonly submitLabel?: string;
  readonly onSuccess?: (key: RegisteredSshKey) => void | Promise<void>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [emptyKeyMessage, setEmptyKeyMessage] = useState<string | null>(null);

  const addKeyMutation = useMutation(
    trpc.sshKey.add.mutationOptions({
      onSuccess: async (response) => {
        setName("");
        setPublicKey("");
        await queryClient.invalidateQueries({ queryKey: trpc.sshKey.list.pathKey() });
        await props.onSuccess?.(response);
      },
    }),
  );

  const errorMessage = useMemo(() => {
    if (emptyKeyMessage !== null) {
      return emptyKeyMessage;
    }

    return addKeyMutation.error instanceof Error ? addKeyMutation.error.message : null;
  }, [addKeyMutation.error, emptyKeyMessage]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const normalizedKey = publicKey.trim();
    if (normalizedKey.length === 0) {
      setEmptyKeyMessage("Paste an SSH public key to register it.");
      return;
    }

    setEmptyKeyMessage(null);
    const normalizedName = name.trim().length > 0 ? name.trim() : readKeyComment(normalizedKey);
    await addKeyMutation.mutateAsync({
      publicKey: normalizedKey,
      ...(normalizedName === undefined ? {} : { name: normalizedName }),
    });
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <label className="flex flex-col gap-2">
        <span className="ev-eyebrow">Name (optional — defaults to the key comment)</span>
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setEmptyKeyMessage(null);
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
            setEmptyKeyMessage(null);
          }}
          rows={4}
          className="w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          placeholder="ssh-ed25519 AAAA... user@host"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {errorMessage === null ? null : (
        <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
          {errorMessage}
        </div>
      )}

      <Button type="submit" className="h-11 px-5" disabled={addKeyMutation.isPending}>
        {addKeyMutation.isPending ? "Registering..." : (props.submitLabel ?? "Register key")}
      </Button>
    </form>
  );
}
