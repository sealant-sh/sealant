import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { registerFormDefaults, registerFormSchema } from "@/features/auth/forms/register-form";
import { authClient } from "@/lib/auth/auth-client";
import { resolveRedirectTarget } from "@/lib/auth/redirect";
import { normalizeRequiredString } from "@/lib/forms/zod";

export const Route = createFileRoute("/_auth/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const search = Route.useSearch();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: registerFormDefaults,
    validationLogic: revalidateLogic(),
    onSubmit: async ({ value }) => {
      setErrorMessage(null);

      const result = await authClient.signUp.email({
        email: normalizeRequiredString(value.email),
        name: normalizeRequiredString(value.name),
        password: value.password,
      });

      if (result.error !== null) {
        setErrorMessage(result.error.message ?? "Unable to create your account right now.");
        return;
      }

      window.location.assign(resolveRedirectTarget(search.redirect));
    },
    validators: {
      onDynamic: registerFormSchema,
    },
  });

  return (
    <AuthShell title="Create your account." description="Set up your account to get started.">
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-[0.68rem] tracking-[0.16em] text-muted-foreground">
            Register
          </p>
          <h2 className="font-display text-4xl tracking-[0.02em] text-foreground text-balance">
            Create Account
          </h2>
          <p className="text-sm leading-7 text-muted-foreground">
            Use your details to create an account.
          </p>
        </div>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="name">
            {(field) => (
              <field.TextField
                autoComplete="name"
                errorClassName="text-[0.72rem] leading-6 text-destructive"
                fieldClassName="space-y-2"
                inputClassName="h-12 px-4"
                label="Name"
                labelClassName="font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground"
                placeholder="Full name..."
                required
              />
            )}
          </form.AppField>

          <form.AppField name="email">
            {(field) => (
              <field.TextField
                autoComplete="email"
                errorClassName="text-[0.72rem] leading-6 text-destructive"
                fieldClassName="space-y-2"
                inputClassName="h-12 px-4"
                label="Email"
                labelClassName="font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground"
                placeholder="you@company.com"
                required
                spellCheck={false}
                type="email"
              />
            )}
          </form.AppField>

          <div className="grid gap-5 sm:grid-cols-2">
            <form.AppField name="password">
              {(field) => (
                <field.PasswordField
                  autoComplete="new-password"
                  errorClassName="text-[0.72rem] leading-6 text-destructive"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 px-4"
                  label="Password"
                  labelClassName="font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground"
                  placeholder="Create a password..."
                  required
                />
              )}
            </form.AppField>

            <form.AppField name="confirmPassword">
              {(field) => (
                <field.PasswordField
                  autoComplete="new-password"
                  errorClassName="text-[0.72rem] leading-6 text-destructive"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 px-4"
                  label="Confirm"
                  labelClassName="font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground"
                  placeholder="Repeat the password..."
                  required
                />
              )}
            </form.AppField>
          </div>

          {errorMessage !== null ? (
            <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button className="h-12 w-full" disabled={isSubmitting} type="submit">
                {isSubmitting ? "Creating Account..." : "Create Account"}
              </Button>
            )}
          </form.Subscribe>
        </form>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Already registered?</p>
          <a
            href="/login"
            className="font-semibold tracking-[0.1em] text-foreground no-underline hover:text-primary"
          >
            Sign In
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
