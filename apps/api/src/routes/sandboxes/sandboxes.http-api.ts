import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  createSandbox,
  getSandbox,
  getSandboxSshTarget,
  listSandboxAttempts,
  listSandboxEvents,
  listSandboxes,
  renameSandbox,
} from "./sandboxes.module.js";

export const SandboxesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "sandboxes",
  (handlers) => {
    return handlers
      .handle("createSandbox", ({ headers, payload }) =>
        createSandbox({
          headers,
          payload,
        }),
      )
      .handle("renameSandbox", ({ params, payload }) =>
        renameSandbox({
          sandboxId: params.sandboxId,
          payload,
        }),
      )
      .handle("listSandboxes", ({ query }) => listSandboxes(query))
      .handle("getSandbox", ({ params }) => getSandbox(params.sandboxId))
      .handle("listSandboxAttempts", ({ params, query }) =>
        listSandboxAttempts({
          sandboxId: params.sandboxId,
          query,
        }),
      )
      .handle("listSandboxEvents", ({ params, query }) =>
        listSandboxEvents({
          sandboxId: params.sandboxId,
          query,
        }),
      )
      .handle("getSandboxSshTarget", ({ params, headers }) =>
        getSandboxSshTarget({
          sandboxId: params.sandboxId,
          headers,
        }),
      );
  },
);
