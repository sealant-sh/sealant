import { useState, type FormEvent } from "react";

import { Button, Input, Label } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";

export const Route = createFileRoute("/_auth/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(
      `Reset email delivery is not configured yet for this deployment. Capture the request for ${email || "this account"} and wire outbound email before enabling the flow.`,
    );
  };

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
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.38em] text-white/50">Forgot Password</p>
          <h2 className="text-3xl font-black uppercase tracking-[-0.05em] text-white">Reset Request</h2>
          <p className="text-sm leading-7 text-white/62">Enter the account email.</p>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="forgot-email" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
              Email
            </Label>
            <Input
              id="forgot-email"
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

          {notice !== null ? (
            <div aria-live="polite" className="border border-neon-cyan/20 bg-neon-cyan/8 px-4 py-3 text-sm text-white/86">{notice}</div>
          ) : (
            <div className="border border-steel bg-[#161616] px-4 py-3 text-sm text-white/62">
              Email delivery is disabled.
            </div>
          )}

          <Button type="submit" className="h-12 w-full rounded-none bg-neon-magenta px-4 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]">
            Request Reset
          </Button>
        </form>

        <div className="flex flex-col gap-3 border-t border-steel pt-6 text-sm text-white/62 sm:flex-row sm:items-center sm:justify-between">
          <p>Remembered the password?</p>
          <a href="/login" className="font-semibold uppercase tracking-[0.22em] text-white no-underline hover:text-neon-magenta">
            Sign In
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
