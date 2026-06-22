import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import {
  resetPasswordFormDefaults,
  resetPasswordFormSchema,
} from "@/features/auth/forms/reset-password-form";

export const Route = createFileRoute("/_auth/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const search = Route.useSearch();
  const [notice, setNotice] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: resetPasswordFormDefaults,
    validationLogic: revalidateLogic(),
    onSubmit: () => {
      setNotice("Password reset is not available yet for this deployment. Please try again later.");
    },
    validators: {
      onDynamic: resetPasswordFormSchema,
    },
  });

  return (
    <AuthShell
      title="Set a new password."
      description="Create a new password for your account."
      accent="cyan"
    >
      <div className="space-y-8">
        <div className="space-y-2.5">
          <p className="ev-eyebrow">Reset password</p>
          <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground text-balance">
            New password
          </h2>
          <p className="text-sm leading-7 text-muted-foreground">
            {search.token !== undefined ? (
              <>
                A reset token was detected:{" "}
                <span className="font-mono text-ink-2">{search.token.slice(0, 8)}…</span>
              </>
            ) : (
              "Use the reset link from your email to continue."
            )}
          </p>
        </div>

        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <form.AppField name="password">
              {(field) => (
                <field.PasswordField
                  autoComplete="new-password"
                  errorClassName="text-[0.72rem] leading-6 text-danger"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 rounded-lg px-4"
                  label="New password"
                  placeholder="Create a password..."
                  required
                />
              )}
            </form.AppField>

            <form.AppField name="confirmPassword">
              {(field) => (
                <field.PasswordField
                  autoComplete="new-password"
                  errorClassName="text-[0.72rem] leading-6 text-danger"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 rounded-lg px-4"
                  label="Confirm password"
                  placeholder="Repeat the password..."
                  required
                />
              )}
            </form.AppField>
          </div>

          <div className="border-l-2 border-border pl-3 text-sm leading-6 text-muted-foreground">
            Reset token verification is not available yet.
          </div>

          {notice !== null ? (
            <div className="border-l-2 border-border pl-3 text-sm leading-6 text-foreground">
              {notice}
            </div>
          ) : null}

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button
                className="h-12 w-full rounded-xl shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Setting password..." : "Set password"}
              </Button>
            )}
          </form.Subscribe>
        </form>

        <div className="flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Need a new link?</p>
          <a
            href="/forgot-password"
            className="font-medium text-primary no-underline transition-colors hover:text-[var(--primary-hover)]"
          >
            Request reset
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
