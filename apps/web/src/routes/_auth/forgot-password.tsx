import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import {
  forgotPasswordFormDefaults,
  forgotPasswordFormSchema,
} from "@/features/auth/forms/forgot-password-form";
import { normalizeRequiredString } from "@/lib/forms/zod";

export const Route = createFileRoute("/_auth/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [notice, setNotice] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: forgotPasswordFormDefaults,
    validationLogic: revalidateLogic(),
    onSubmit: ({ value }) => {
      const email = normalizeRequiredString(value.email);

      setNotice(
        `Password reset email is not available yet for this deployment. Please contact support and include ${email || "your account email"}.`,
      );
    },
    validators: {
      onDynamic: forgotPasswordFormSchema,
    },
  });

  return (
    <AuthShell
      title="Forgot your password?"
      description="Enter your account email to request a reset."
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-[0.68rem] tracking-[0.16em] text-muted-foreground">
            Forgot Password
          </p>
          <h2 className="font-display text-4xl tracking-[0.02em] text-foreground">
            Reset Your Password
          </h2>
          <p className="text-sm leading-7 text-muted-foreground">
            Enter the email for your account.
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

          {notice !== null ? (
            <div className="border border-border bg-muted/40 px-4 py-3 text-sm text-foreground">
              {notice}
            </div>
          ) : (
            <div className="border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              Password reset email is not available yet.
            </div>
          )}

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button className="h-12 w-full" disabled={isSubmitting} type="submit">
                {isSubmitting ? "Requesting..." : "Request Reset"}
              </Button>
            )}
          </form.Subscribe>
        </form>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Remembered the password?</p>
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
