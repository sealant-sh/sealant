import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/validation" as never)({
  beforeLoad: ({ params }: { params: { sandboxId: string } }) => {
    throw redirect({
      to: `/sandboxes/${encodeURIComponent(params.sandboxId)}/spec` as never,
    });
  },
  component: RedirectToSpec,
});

function RedirectToSpec() {
  return null;
}
