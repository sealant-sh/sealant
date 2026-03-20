import { useState, type FormEvent } from "react";

import { Button, Input, Label } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";
import { authClient } from "@/lib/auth/auth-client";
import { resolveRedirectTarget } from "@/lib/auth/redirect";

export const Route = createFileRoute("/_auth/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const search = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);

    if (password !== confirmPassword) {
      setErrorMessage("Passwords must match before the account can be created.");
      return;
    }

    setIsSubmitting(true);

    const result = await authClient.signUp.email({
      name,
      email,
      password,
    });

    setIsSubmitting(false);

    if (result.error !== null) {
      setErrorMessage(result.error.message ?? "Unable to create your account right now.");
      return;
    }

    window.location.assign(resolveRedirectTarget(search.redirect));
  };

  return (
    <AuthShell
      badge="Public"
      title="Create the first account."
      description="Register an operator account for this deployment."
      asideTitle="Access"
      asideCopy="The account signs in immediately after registration."
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.38em] text-white/50">Register</p>
          <h2 className="text-3xl font-black uppercase tracking-[-0.05em] text-white text-balance">New Operator</h2>
          <p className="text-sm leading-7 text-white/62">Use the details for the primary account.</p>
        </div>

        <form className="space-y-5" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <Label htmlFor="name" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
              Name
            </Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
              placeholder="Full name…"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="register-email" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
              Email
            </Label>
            <Input
              id="register-email"
              name="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
              placeholder="operator@company.com…"
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="register-password" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
                Password
              </Label>
              <Input
                id="register-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
                placeholder="Create a password…"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
                Confirm
              </Label>
              <Input
                id="confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
                placeholder="Repeat the password…"
              />
            </div>
          </div>

          {errorMessage !== null ? (
            <div aria-live="polite" className="border border-neon-magenta/30 bg-neon-magenta/10 px-4 py-3 text-sm text-white">{errorMessage}</div>
          ) : null}

          <Button
            type="submit"
            className="h-12 w-full rounded-none bg-neon-magenta px-4 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating Account…" : "Create Account"}
          </Button>
        </form>

        <div className="flex flex-col gap-3 border-t border-steel pt-6 text-sm text-white/62 sm:flex-row sm:items-center sm:justify-between">
          <p>Already registered?</p>
          <a href="/login" className="font-semibold uppercase tracking-[0.22em] text-white no-underline hover:text-neon-magenta">
            Sign In
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
