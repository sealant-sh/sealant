import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/")({
  beforeLoad: () => {
    throw redirect({ to: "/sandboxes" });
  },
  component: RedirectPage,
});

function RedirectPage() {
  return null;
}
