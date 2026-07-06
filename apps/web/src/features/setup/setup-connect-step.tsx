import { Button } from "@sealant/ui";
import type { SetupStateResponse } from "@sealant/validators";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

const buildSshConfigSnippet = (gateway: NonNullable<SetupStateResponse["sshGateway"]>): string => {
  return [
    `Host ${gateway.usernamePrefix}-*`,
    `  HostName ${gateway.host}`,
    `  Port ${gateway.port}`,
    "  User %n",
    "  StrictHostKeyChecking accept-new",
  ].join("\n");
};

/**
 * Wizard step 3: one copy-paste block for ~/.ssh/config. No IdentityFile line — the user's own
 * keys are offered normally; a non-default key just needs their usual IdentityFile entry.
 */
export function SetupConnectStep(props: { readonly sshGateway: SetupStateResponse["sshGateway"] }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const snippet = props.sshGateway === null ? null : buildSshConfigSnippet(props.sshGateway);

  const copySnippet = async () => {
    if (snippet === null) {
      return;
    }

    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setCopyState("error");
      return;
    }

    try {
      await navigator.clipboard.writeText(snippet);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2.5">
        <p className="ev-eyebrow">Setup · 3 of 3</p>
        <h2 className="flex items-baseline gap-3 font-display text-2xl font-semibold tracking-tight text-foreground">
          <span className="font-mono text-sm text-primary">03</span>
          Connect
        </h2>
        <p className="text-sm leading-7 text-muted-foreground">
          Append this once to <span className="font-mono">~/.ssh/config</span>. After launching a
          workspace,{" "}
          <span className="font-mono">
            ssh {props.sshGateway?.usernamePrefix ?? "ws"}
            -&lt;workspaceId&gt;
          </span>{" "}
          drops you into it.
        </p>
      </div>

      {snippet === null ? (
        <div className="border-l-2 border-[var(--sw-amber)] py-1 pl-3 text-sm leading-6 text-warning">
          The SSH gateway is not configured on this deployment (the API has no{" "}
          <span className="font-mono">WORKSPACE_SSH_GATEWAY_HOST</span>). You can finish setup and
          wire this up later.
        </div>
      ) : (
        <div className="space-y-3">
          <pre className="overflow-x-auto rounded-xl border border-rule-faint bg-background px-4 py-4 font-mono text-xs leading-relaxed text-foreground">
            {snippet}
          </pre>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" className="h-10 px-4" onClick={copySnippet}>
              {copyState === "copied" ? "Copied" : "Copy"}
            </Button>
            {copyState === "error" ? (
              <span className="text-sm text-danger">
                Copy failed — select the block and copy it manually.
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            Using a key that is not your default? Add your usual{" "}
            <span className="font-mono">IdentityFile</span> line to the block.
          </p>
        </div>
      )}

      <div className="border-t border-border pt-6">
        <Button
          className="h-12 w-full rounded-xl shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
          render={<Link to="/" />}
        >
          Go to dashboard
        </Button>
      </div>
    </div>
  );
}
