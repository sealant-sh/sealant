import { useState, type FormEvent } from "react";

import { Button, Input, Label } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";
import { authClient } from "@/lib/auth/auth-client";
import { resolveRedirectTarget } from "@/lib/auth/redirect";

export const Route = createFileRoute("/_auth/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    const result = await authClient.signIn.email({
      email,
      password,
    });

    setIsSubmitting(false);

    if (result.error !== null) {
      setErrorMessage(result.error.message ?? "Unable to sign in right now.");
      return;
    }

    window.location.assign(resolveRedirectTarget(search.redirect));
  };

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

        <form className="space-y-5" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <Label htmlFor="email" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
              Email
            </Label>
            <Input
              id="email"
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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="password" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
                Password
              </Label>
              <a href="/forgot-password" className="font-mono text-[0.68rem] uppercase tracking-[0.26em] text-white/55 no-underline hover:text-white">
                Reset Password
              </a>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-12 rounded-none border-steel bg-[#161616] px-4 text-white placeholder:text-white/30"
              placeholder="Enter your password…"
            />
          </div>

          {errorMessage !== null ? (
            <div aria-live="polite" className="border border-neon-magenta/30 bg-neon-magenta/10 px-4 py-3 text-sm text-white">
              {errorMessage}
            </div>
          ) : null}

          <Button
            type="submit"
            className="h-12 w-full rounded-none bg-neon-magenta px-4 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Signing In…" : "Sign In"}
          </Button>
        </form>

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
