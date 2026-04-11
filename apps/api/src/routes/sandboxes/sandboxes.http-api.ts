import { HttpApiBuilder } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";

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
      .handle("renameSandbox", ({ path, payload }) =>
        renameSandbox({
          sandboxId: path.sandboxId,
          payload,
        }),
      )
      .handle("listSandboxes", ({ urlParams }) => listSandboxes(urlParams))
      .handle("getSandbox", ({ path }) => getSandbox(path.sandboxId))
      .handle("listSandboxAttempts", ({ path, urlParams }) =>
        listSandboxAttempts({
          sandboxId: path.sandboxId,
          query: urlParams,
        }),
      )
      .handle("listSandboxEvents", ({ path, urlParams }) =>
        listSandboxEvents({
          sandboxId: path.sandboxId,
          query: urlParams,
        }),
      )
      .handle("getSandboxSshTarget", ({ path, headers }) =>
        getSandboxSshTarget({
          sandboxId: path.sandboxId,
          headers,
        }),
      );
  },
);
