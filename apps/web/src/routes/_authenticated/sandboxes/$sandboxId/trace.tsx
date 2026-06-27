import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/trace")({
  beforeLoad: ({ params }: { params: { sandboxId: string } }) => {
    throw redirect({
      to: "/sandboxes/$sandboxId/spec",
      params: { sandboxId: params.sandboxId },
    });
  },
  component: RedirectToSpec,
});

function RedirectToSpec() {
  return null;
}
