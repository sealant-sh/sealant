import { Button } from "@sealant/ui";

import { AddSshKeyForm } from "@/features/ssh-keys/add-ssh-key-form";

/**
 * Wizard step 2: register the SSH public key this machine will offer at the workspace gateway.
 * Skippable — keys can always be added later under Settings → SSH keys.
 */
export function SetupSshKeyStep(props: { readonly onContinue: () => void }) {
  return (
    <div className="space-y-8">
      <div className="space-y-2.5">
        <p className="ev-eyebrow">Setup · 2 of 3</p>
        <h2 className="flex items-baseline gap-3 font-display text-2xl font-semibold tracking-tight text-foreground">
          <span className="font-mono text-sm text-primary">02</span>
          Add your SSH key
        </h2>
        <p className="text-sm leading-7 text-muted-foreground">
          The gateway authenticates you with the key your SSH client offers. Paste your public key —
          usually found at <span className="font-mono">~/.ssh/id_ed25519.pub</span>.
        </p>
      </div>

      <AddSshKeyForm submitLabel="Register key and continue" onSuccess={props.onContinue} />

      <div className="border-t border-border pt-5">
        <Button
          type="button"
          variant="ghost"
          className="h-10 px-3 text-muted-foreground"
          onClick={props.onContinue}
        >
          Skip for now — add a key later in Settings
        </Button>
      </div>
    </div>
  );
}
