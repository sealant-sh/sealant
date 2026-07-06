import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";
import { SetupAccountStep } from "@/features/setup/setup-account-step";
import { SetupConnectStep } from "@/features/setup/setup-connect-step";
import { SetupSshKeyStep } from "@/features/setup/setup-ssh-key-step";
import { sessionQueryOptions } from "@/lib/auth/session.query";
import { resolveNeedsSetup, setupStateQueryOptions } from "@/lib/setup/setup.query";
import { useTRPC } from "@/lib/trpc/react";

type SetupStep = "account" | "key" | "connect";

const parseStep = (value: unknown): SetupStep | undefined => {
  return value === "account" || value === "key" || value === "connect" ? value : undefined;
};

const STEP_SHELL_COPY: Record<SetupStep, { title: string; description: string }> = {
  account: {
    title: "Welcome to Sealant.",
    description: "A short setup: create the first account, add an SSH key, connect your machine.",
  },
  key: {
    title: "Reach workspaces from your terminal.",
    description:
      "Register the public key this machine offers over SSH. The gateway matches it to your account and routes you only to workspaces you own.",
  },
  connect: {
    title: "One block in your SSH config.",
    description:
      "Your SSH client resolves workspace aliases through the gateway. Paste the block once and every future workspace is an `ssh` away.",
  },
};

export const Route = createFileRoute("/setup")({
  validateSearch: (search: Record<string, unknown>) => ({
    step: parseStep(search.step),
  }),
  // The single authority on which steps are legal in which auth state. Steps 2-3 call protected
  // procedures, so they require a session; step 1 is only for the very first user of a deployment
  // (sign-up itself stays open at /register afterwards).
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(context.trpc));

    if (session === null) {
      if (!(await resolveNeedsSetup(context))) {
        throw redirect({ to: "/login", search: { redirect: "/setup" } });
      }

      if (search.step !== undefined && search.step !== "account") {
        throw redirect({ to: "/setup", search: { step: "account" } });
      }

      return;
    }

    if (search.step === undefined || search.step === "account") {
      throw redirect({ to: "/setup", search: { step: "key" } });
    }
  },
  component: SetupWizardPage,
});

function SetupWizardPage() {
  const trpc = useTRPC();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Rendering data only (the connect snippet); gating already happened in beforeLoad. Falls back
  // to the not-configured callout while loading or if the API is unreachable.
  const setupStateQuery = useQuery(setupStateQueryOptions(trpc));
  const step = search.step ?? "account";
  const shellCopy = STEP_SHELL_COPY[step];

  return (
    <AuthShell title={shellCopy.title} description={shellCopy.description}>
      {step === "account" ? (
        <SetupAccountStep />
      ) : step === "key" ? (
        <SetupSshKeyStep
          onContinue={() => {
            void navigate({ search: { step: "connect" } });
          }}
        />
      ) : (
        <SetupConnectStep sshGateway={setupStateQuery.data?.sshGateway ?? null} />
      )}
    </AuthShell>
  );
}
