import { useState } from "react";

import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";
import { forgotPasswordFormDefaults, forgotPasswordFormSchema } from "@/features/auth/forms/forgot-password-form";
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
        `Reset email delivery is not configured yet for this deployment. Capture the request for ${email || "this account"} and wire outbound email before enabling the flow.`,
      );
    },
    validators: {
      onDynamic: forgotPasswordFormSchema,
    },
  });

  return (
    <AuthShell
      badge="Public"
      title="Request a password reset."
      description="The route is in place. Email delivery is not enabled yet."
      asideTitle="Status"
      asideCopy="Requests stop here until outbound email is configured."
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">Forgot Password</p>
          <h2 className="font-display text-4xl uppercase tracking-[0.02em] text-foreground">Reset Request</h2>
          <p className="text-sm leading-7 text-muted-foreground">Enter the account email.</p>
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
                labelClassName="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-muted-foreground"
                placeholder="operator@company.com..."
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
              Email delivery is disabled.
            </div>
          )}

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button
                className="h-12 w-full"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Requesting..." : "Request Reset"}
              </Button>
            )}
          </form.Subscribe>
        </form>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Remembered the password?</p>
          <a href="/login" className="font-semibold uppercase tracking-[0.1em] text-foreground no-underline hover:text-primary">
            Sign In
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
