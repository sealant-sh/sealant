import { Button } from "@sealant/ui";
import type { ConnectedAccountProvider, ConnectedAccountSummary } from "@sealant/validators";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useTRPC } from "@/lib/trpc/react";

export const Route = createFileRoute("/_authenticated/settings/connected-accounts")({
  component: ConnectedAccountsSettingsPage,
});

type Provider = ConnectedAccountProvider;

interface ProviderCopy {
  readonly provider: Provider;
  readonly name: string;
  readonly valueProp: string;
  readonly command: string;
  readonly commandNote: string;
  readonly footnote: string;
}

const PROVIDERS: readonly ProviderCopy[] = [
  {
    provider: "claude",
    name: "Claude",
    valueProp: "Run Claude Code and the Agent SDK inside your sandboxes on your own subscription.",
    command: "claude setup-token",
    commandNote: "Run on your machine — requires Claude Pro or Max.",
    footnote:
      "Stored encrypted in your control plane. Only used by the official Claude Code CLI / Agent SDK inside your sandboxes.",
  },
  {
    provider: "codex",
    name: "Codex",
    valueProp: "Run the Codex CLI inside your sandboxes with your ChatGPT subscription.",
    command: "codex login",
    commandNote: "Run on your machine, then paste the contents of ~/.codex/auth.json below.",
    footnote:
      "This is OpenAI's documented pattern for running Codex on another machine. Sandboxes refresh it; Sealant syncs it back.",
  },
  {
    provider: "github",
    name: "GitHub",
    valueProp: "Give sandboxes your GitHub identity for git push/pull and the GitHub API.",
    command: "gh auth token",
    commandNote: "Run on your machine, or use --token with a PAT you created.",
    footnote:
      "Used for git clone/push/pull and GitHub API calls from your sandboxes. Needs the repo scope; workflow is required to edit .github/workflows.",
  },
];

const isCredentialsKeyError = (message: string): boolean =>
  message.toUpperCase().includes("SEALANT_CREDENTIALS_KEY");

const readString = (
  metadata: ConnectedAccountSummary["metadata"],
  key: string,
): string | undefined => {
  const value = metadata[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readStringArray = (
  metadata: ConnectedAccountSummary["metadata"],
  key: string,
): readonly string[] => {
  const value = metadata[key];

  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const formatDate = (value: string | null): string => {
  if (value === null) {
    return "—";
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
};

function ConnectedAccountsSettingsPage() {
  const trpc = useTRPC();
  const accountsQuery = useQuery(trpc.connectedAccounts.list.queryOptions());

  const accountsByProvider = useMemo(() => {
    const map = new Map<Provider, ConnectedAccountSummary>();

    for (const account of accountsQuery.data?.items ?? []) {
      if (account.status === "archived") {
        continue;
      }

      if (!map.has(account.provider)) {
        map.set(account.provider, account);
      }
    }

    return map;
  }, [accountsQuery.data]);

  return (
    <div className="space-y-8 p-8 lg:p-10">
      <header>
        <p className="ev-eyebrow">settings.accounts</p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Connected accounts
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Bring your own Claude and Codex subscriptions and a GitHub token. You run the official
          tool once on your machine and paste the result here; Sealant stores it encrypted and
          injects it into your sandboxes. Sealant never signs in on your behalf.
        </p>
      </header>

      {accountsQuery.isLoading ? (
        <div className="rounded-xl border border-rule-faint bg-background px-4 py-4 text-sm text-muted-foreground">
          Loading connected accounts...
        </div>
      ) : (
        <div className="space-y-6">
          {PROVIDERS.map((copy) => (
            <ProviderCard
              key={copy.provider}
              copy={copy}
              account={accountsByProvider.get(copy.provider) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  copy,
  account,
}: {
  readonly copy: ProviderCopy;
  readonly account: ConnectedAccountSummary | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.connectedAccounts.list.pathKey() });
  };

  const connectMutation = useMutation(
    trpc.connectedAccounts.connect.mutationOptions({
      onSuccess: async (response) => {
        setStatusMessage(`Connected ${copy.name} account '${response.name}'.`);
        setSecret("");
        setValidationError(null);
        setIsFormOpen(false);
        await invalidate();
      },
    }),
  );

  const disconnectMutation = useMutation(
    trpc.connectedAccounts.disconnect.mutationOptions({
      onSuccess: async () => {
        setStatusMessage(`Disconnected ${copy.name}. Sandboxes will no longer receive it.`);
        await invalidate();
      },
    }),
  );

  const connectErrorMessage =
    connectMutation.error instanceof Error ? connectMutation.error.message : null;
  const disconnectErrorMessage =
    disconnectMutation.error instanceof Error ? disconnectMutation.error.message : null;
  const showSetupCallout =
    connectErrorMessage !== null && isCredentialsKeyError(connectErrorMessage);

  const validate = (value: string): string | null => {
    if (copy.provider === "claude") {
      return value.startsWith("sk-ant-oat01-")
        ? null
        : "That doesn't look like a setup token. It should start with sk-ant-oat01-.";
    }

    if (copy.provider === "codex") {
      try {
        JSON.parse(value);
        return null;
      } catch {
        return "Paste the full contents of ~/.codex/auth.json — this isn't valid JSON.";
      }
    }

    return null;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const normalized = secret.trim();
    if (normalized.length === 0) {
      setValidationError("Paste the value from the command above to connect.");
      return;
    }

    const error = validate(normalized);
    if (error !== null) {
      setValidationError(error);
      return;
    }

    setValidationError(null);
    setStatusMessage(null);
    await connectMutation.mutateAsync({ provider: copy.provider, secret: normalized });
  };

  const openForm = () => {
    setStatusMessage(null);
    setValidationError(null);
    setSecret("");
    connectMutation.reset();
    setIsFormOpen(true);
  };

  const isInvalid = account !== null && account.status === "invalid";

  return (
    <section className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">
              {copy.name}
            </h2>
            {account === null ? null : <AccountStatus status={account.status} />}
          </div>

          {account === null ? (
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              {copy.valueProp}
            </p>
          ) : (
            <div className="mt-2 space-y-1">
              <p className="text-sm font-medium text-foreground break-all">{account.name}</p>
              <AccountMetadata account={account} />
            </div>
          )}
        </div>

        {account === null ? (
          <Button type="button" className="h-10 px-4" onClick={openForm} disabled={isFormOpen}>
            Connect
          </Button>
        ) : (
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant={isInvalid ? "default" : "outline"}
              className="h-10 px-3"
              onClick={openForm}
              disabled={isFormOpen}
            >
              Reconnect
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-10 px-3"
              disabled={disconnectMutation.isPending}
              onClick={() => {
                setStatusMessage(null);
                disconnectMutation.mutate({ connectedAccountId: account.connectedAccountId });
              }}
            >
              {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          </div>
        )}
      </div>

      {isInvalid && !isFormOpen ? (
        <div className="mt-4 border-l-2 border-warning-dot py-1 pl-3 text-sm leading-6 text-warning">
          This credential stopped working. Reconnect to restore access from your sandboxes.
        </div>
      ) : null}

      {statusMessage === null ? null : (
        <div className="mt-4 border-l-2 border-primary py-1 pl-3 text-sm leading-6 text-foreground">
          {statusMessage}
        </div>
      )}

      {disconnectErrorMessage === null ? null : (
        <div className="mt-4 border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
          {disconnectErrorMessage}
        </div>
      )}

      {isFormOpen ? (
        <form className="mt-6 space-y-5 border-t border-rule-faint pt-6" onSubmit={handleSubmit}>
          <NumberedStep index={1} title={`Run ${copy.command}`} note={copy.commandNote}>
            <CopyableCommand command={copy.command} />
          </NumberedStep>

          <NumberedStep index={2} title="Paste the result" note={copy.footnote}>
            {copy.provider === "codex" ? (
              <textarea
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setValidationError(null);
                }}
                rows={6}
                className="w-full rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                placeholder='{ "OPENAI_API_KEY": null, "tokens": { ... } }'
                autoComplete="off"
                spellCheck={false}
              />
            ) : (
              <input
                type="password"
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setValidationError(null);
                }}
                className="h-11 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                placeholder={copy.provider === "claude" ? "sk-ant-oat01-..." : "gho_..."}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {copy.provider === "codex" ? (
              <p className="mt-2 text-xs leading-relaxed text-faint">
                This value is sensitive — it authenticates as you. It is masked in transit and
                stored encrypted.
              </p>
            ) : null}
          </NumberedStep>

          {validationError === null ? null : (
            <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
              {validationError}
            </div>
          )}

          {showSetupCallout ? (
            <div className="border-l-2 border-warning-dot py-1 pl-3 text-sm leading-6 text-warning">
              The control plane has no SEALANT_CREDENTIALS_KEY configured — add one to enable
              connected accounts.
            </div>
          ) : connectErrorMessage === null ? null : (
            <div className="border-l-2 border-danger-dot py-1 pl-3 text-sm leading-6 text-danger">
              {connectErrorMessage}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button type="submit" className="h-11 px-5" disabled={connectMutation.isPending}>
              {connectMutation.isPending ? "Connecting..." : `Connect ${copy.name}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-4"
              onClick={() => {
                setIsFormOpen(false);
                setValidationError(null);
                connectMutation.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <p className="mt-5 border-t border-rule-faint pt-4 text-xs leading-relaxed text-muted-foreground">
        Prefer the terminal? Run{" "}
        <span className="font-mono text-foreground">sealant auth {copy.provider}</span> — it does
        the same thing.
      </p>
    </section>
  );
}

function AccountMetadata({ account }: { readonly account: ConnectedAccountSummary }) {
  const connected = `connected ${formatDate(account.connectedAt)}`;

  if (account.provider === "claude") {
    const suffix = readString(account.metadata, "tokenSuffix");

    return (
      <p className="font-mono text-xs text-muted-foreground break-all">
        {suffix === undefined ? "token" : `token …${suffix}`} · {connected}
      </p>
    );
  }

  if (account.provider === "codex") {
    const identity =
      readString(account.metadata, "email") ?? readString(account.metadata, "accountId");
    const synced =
      account.lastSyncedAt === null ? null : `last synced ${formatDate(account.lastSyncedAt)}`;

    return (
      <p className="font-mono text-xs text-muted-foreground break-all">
        {identity ?? "codex session"} · {synced ?? connected}
      </p>
    );
  }

  const login = readString(account.metadata, "login");
  const scopes = readStringArray(account.metadata, "scopes");

  return (
    <div className="space-y-2">
      <p className="font-mono text-xs text-muted-foreground break-all">
        {login === undefined ? "github" : login} · {connected}
      </p>
      {scopes.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {scopes.map((scope) => (
            <span
              key={scope}
              className="rounded-[3px] bg-[var(--sw-sunken)] px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-ink-2"
            >
              {scope}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const ACCOUNT_STATUS_PRESENTATION = {
  active: { dot: "bg-success-dot", text: "text-success", label: "Active" },
  invalid: { dot: "bg-warning-dot", text: "text-warning", label: "Invalid" },
  archived: { dot: "bg-danger-dot", text: "text-danger", label: "Archived" },
} as const;

function AccountStatus({ status }: { readonly status: ConnectedAccountSummary["status"] }) {
  const presentation = ACCOUNT_STATUS_PRESENTATION[status];

  return (
    <span className={`flex items-center gap-1.5 text-xs ${presentation.text}`}>
      <span className={`size-1.5 rounded-full ${presentation.dot}`} />
      {presentation.label}
    </span>
  );
}

function NumberedStep({
  index,
  title,
  note,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-sm text-primary">{String(index).padStart(2, "0")}</span>
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <p className="mt-1.5 ml-8 text-xs leading-relaxed text-muted-foreground">{note}</p>
      <div className="mt-3 ml-8">{children}</div>
    </div>
  );
}

function CopyableCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-rule-faint bg-background px-3 py-2.5">
      <code className="font-mono text-xs text-foreground break-all">{command}</code>
      <Button
        type="button"
        variant="ghost"
        className="h-8 shrink-0 px-2.5"
        onClick={() => void handleCopy()}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
