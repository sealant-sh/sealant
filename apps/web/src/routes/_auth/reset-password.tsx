import { useState, type FormEvent } from "react";

import { Button, Input, Label } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth/auth-shell";

export const Route = createFileRoute("/_auth/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const search = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password !== confirmPassword) {
      setNotice("The new password and confirmation must match.");
      return;
    }

    setNotice(
      "Password reset completion is not active yet. Keep this route in place so future email links have a stable destination.",
    );
  };

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

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="new-password" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
              New password
            </Label>
            <Input
              id="new-password"
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
            <Label htmlFor="confirm-new-password" className="font-mono text-[0.68rem] uppercase tracking-[0.28em] text-white/55">
              Confirm password
            </Label>
            <Input
              id="confirm-new-password"
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

          <div className="border border-steel bg-[#161616] px-4 py-3 text-sm text-white/62">
            Token verification is not enabled yet.
          </div>

          {notice !== null ? (
            <div aria-live="polite" className="border border-neon-cyan/20 bg-neon-cyan/8 px-4 py-3 text-sm text-white/86">{notice}</div>
          ) : null}

          <Button type="submit" className="h-12 w-full rounded-none bg-neon-magenta px-4 text-[0.72rem] font-black uppercase tracking-[0.32em] text-abyss hover:bg-[#ff88ff]">
            Set Password
          </Button>
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
