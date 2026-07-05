import { Button, useAppForm } from "@sealant/ui";
import { revalidateLogic } from "@tanstack/react-form";
import { useState } from "react";

import { registerFormDefaults, registerFormSchema } from "@/features/auth/forms/register-form";
import { authClient } from "@/lib/auth/auth-client";
import { normalizeRequiredString } from "@/lib/forms/zod";

/**
 * First-run account creation. Mirrors the register page form; on success it hard-navigates to the
 * next wizard step so the fresh session cookie is picked up server-side (same pattern as
 * register.tsx).
 */
export function SetupAccountStep() {
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

      window.location.assign("/setup?step=key");
    },
    validators: {
      onDynamic: registerFormSchema,
    },
  });

  return (
    <div className="space-y-8">
      <div className="space-y-2.5">
        <p className="ev-eyebrow">Setup · 1 of 3</p>
        <h2 className="flex items-baseline gap-3 font-display text-2xl font-semibold tracking-tight text-foreground">
          <span className="font-mono text-sm text-primary">01</span>
          Create your account
        </h2>
        <p className="text-sm leading-7 text-muted-foreground">
          The first account on this deployment. Sign-up stays open for teammates afterwards.
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
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              autoComplete="name"
              errorClassName="text-[0.72rem] leading-6 text-danger"
              fieldClassName="space-y-2"
              inputClassName="h-12 rounded-lg px-4"
              label="Name"
              placeholder="Full name..."
              required
            />
          )}
        </form.AppField>

        <form.AppField name="email">
          {(field) => (
            <field.TextField
              autoComplete="email"
              errorClassName="text-[0.72rem] leading-6 text-danger"
              fieldClassName="space-y-2"
              inputClassName="h-12 rounded-lg px-4"
              label="Email"
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
                errorClassName="text-[0.72rem] leading-6 text-danger"
                fieldClassName="space-y-2"
                inputClassName="h-12 rounded-lg px-4"
                label="Password"
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
                label="Confirm"
                placeholder="Repeat the password..."
                required
              />
            )}
          </form.AppField>
        </div>

        {errorMessage !== null ? (
          <div className="border-l-2 border-[var(--sw-red)] pl-3 text-sm leading-6 text-danger">
            {errorMessage}
          </div>
        ) : null}

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button
              className="h-12 w-full rounded-xl shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)]"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Creating account..." : "Continue"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}
