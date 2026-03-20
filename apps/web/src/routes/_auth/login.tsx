import { useState } from "react";

import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";
import { loginFormDefaults, loginFormSchema } from "@/features/auth/forms/login-form";
import { authClient } from "@/lib/auth/auth-client";
import { resolveRedirectTarget } from "@/lib/auth/redirect";
import { normalizeRequiredString } from "@/lib/forms/zod";

export const Route = createFileRoute("/_auth/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: loginFormDefaults,
    validationLogic: revalidateLogic(),
    onSubmit: async ({ value }) => {
      setErrorMessage(null);

      const result = await authClient.signIn.email({
        email: normalizeRequiredString(value.email),
        password: value.password,
      });

      if (result.error !== null) {
        setErrorMessage(result.error.message ?? "Unable to sign in right now.");
        return;
      }

      window.location.assign(resolveRedirectTarget(search.redirect));
    },
    validators: {
      onDynamic: loginFormSchema,
    },
  });

  return (
    <AuthShell
      badge="Private"
      title="Sign in to Sealant."
      description="Access the private control plane for registries, builds, and environment management."
      asideTitle="Session"
      asideCopy="Email & password. Verified on the server before protected routes render."
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.38em] text-white/50">Sign In</p>
          <h2 className="text-3xl font-black uppercase tracking-[-0.05em] text-white text-balance">Operator Login</h2>
          <p className="text-sm leading-7 text-white/62">Use the account for this deployment.</p>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-[0.68rem] uppercase tracking-[0.26em] text-white/38">Password Access</span>
            <a href="/forgot-password" className="font-mono text-[0.68rem] uppercase tracking-[0.26em] text-white/55 no-underline hover:text-white">
              Reset Password
            </a>
          </div>

          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  autoComplete="email"
                  errorClassName="text-[0.72rem] leading-6 text-neon-magenta"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
                  label="Email"
                  labelClassName="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55"
                  placeholder="operator@company.com..."
                  required
                  spellCheck={false}
                  type="email"
                />
              )}
            </form.AppField>

            <form.AppField name="password">
              {(field) => (
                <field.PasswordField
                  autoComplete="current-password"
                  errorClassName="text-[0.72rem] leading-6 text-neon-magenta"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
                  label="Password"
                  labelClassName="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55"
                  placeholder="Enter your password..."
                  required
                />
              )}
            </form.AppField>

            {errorMessage !== null ? (
              <div className="border border-neon-magenta/30 bg-neon-magenta/10 px-4 py-3 text-sm text-white">
                {errorMessage}
              </div>
            ) : null}

            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  className="h-12 w-full rounded-none bg-neon-magenta px-4 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]"
                  disabled={isSubmitting}
                  type="submit"
                >
                  {isSubmitting ? "Signing In..." : "Sign In"}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </div>

        <div className="flex flex-col gap-3 border-t border-steel pt-6 text-sm text-white/62 sm:flex-row sm:items-center sm:justify-between">
          <p>Need access?</p>
          <a href="/register" className="font-semibold uppercase tracking-[0.22em] text-white no-underline hover:text-neon-magenta">
            Register
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
