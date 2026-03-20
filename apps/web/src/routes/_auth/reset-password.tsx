import { useState } from "react";

import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";
import { resetPasswordFormDefaults, resetPasswordFormSchema } from "@/features/auth/forms/reset-password-form";

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
      setNotice(
        "Password reset completion is not active yet. Keep this route in place so future email links have a stable destination.",
      );
    },
    validators: {
      onDynamic: resetPasswordFormSchema,
    },
  });

  return (
    <AuthShell
      badge="Public"
      title="Set a new password."
      description="This route is ready for the future email handoff."
      asideTitle="Status"
      asideCopy="Token verification and email delivery are not active yet."
      accent="cyan"
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.38em] text-white/50">Reset Password</p>
          <h2 className="text-3xl font-black uppercase tracking-[-0.05em] text-white">New Password</h2>
          <p className="text-sm leading-7 text-white/62">
            {search.token !== undefined
              ? `Recovery token detected: ${search.token.slice(0, 8)}…`
              : "This route will accept a recovery token once the email flow is live."}
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
          <div className="grid gap-5 sm:grid-cols-2">
            <form.AppField name="password">
              {(field) => (
                <field.PasswordField
                  autoComplete="new-password"
                  errorClassName="text-[0.72rem] leading-6 text-neon-magenta"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
                  label="New password"
                  labelClassName="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55"
                  placeholder="Create a password..."
                  required
                />
              )}
            </form.AppField>

            <form.AppField name="confirmPassword">
              {(field) => (
                <field.PasswordField
                  autoComplete="new-password"
                  errorClassName="text-[0.72rem] leading-6 text-neon-magenta"
                  fieldClassName="space-y-2"
                  inputClassName="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
                  label="Confirm password"
                  labelClassName="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55"
                  placeholder="Repeat the password..."
                  required
                />
              )}
            </form.AppField>
          </div>

          <div className="border border-steel bg-[#161616] px-4 py-3 text-sm text-white/62">
            Token verification is not enabled yet.
          </div>

          {notice !== null ? (
            <div className="border border-neon-cyan/20 bg-neon-cyan/8 px-4 py-3 text-sm text-white/86">
              {notice}
            </div>
          ) : null}

          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button
                className="h-12 w-full rounded-none bg-neon-magenta px-4 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Setting Password..." : "Set Password"}
              </Button>
            )}
          </form.Subscribe>
        </form>

        <div className="flex flex-col gap-3 border-t border-steel pt-6 text-sm text-white/62 sm:flex-row sm:items-center sm:justify-between">
          <p>Need a new link?</p>
          <a href="/forgot-password" className="font-semibold uppercase tracking-[0.22em] text-white no-underline hover:text-neon-magenta">
            Request Reset
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
