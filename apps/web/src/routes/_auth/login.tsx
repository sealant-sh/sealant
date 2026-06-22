import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

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
      title="Sign in to your account."
      description="Use your email and password to continue."
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="ev-eyebrow">Sign in</p>
          <h2 className="text-2xl text-foreground text-balance">Welcome back</h2>
          <p className="text-sm leading-7 text-muted-foreground">
            Sign in with your account details.
          </p>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-foreground">Password</span>
            <a
              href="/forgot-password"
              className="text-sm text-muted-foreground no-underline hover:text-primary"
            >
              Reset password
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
                  errorClassName="text-[0.72rem] leading-6 text-danger"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 px-4"
                  label="Email"
                  placeholder="you@company.com"
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
                  errorClassName="text-[0.72rem] leading-6 text-danger"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 px-4"
                  label="Password"
                  placeholder="Enter your password..."
                  required
                />
              )}
            </form.AppField>

            {errorMessage !== null ? (
              <div className="flex gap-3 border-l-2 border-[var(--sw-red)] pl-3 text-sm leading-6 text-danger">
                {errorMessage}
              </div>
            ) : null}

            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button className="h-12 w-full" disabled={isSubmitting} type="submit">
                  {isSubmitting ? "Signing in..." : "Sign in"}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Need access?</p>
          <a
            href="/register"
            className="font-medium text-primary no-underline hover:text-primary"
          >
            Register
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
