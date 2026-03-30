import { describeRoute, resolver, validator } from "hono-openapi";

import { messageResponseSchema } from "../../lib/schemas.js";
import {
  createSandboxRequestSchema,
  createSandboxResponseSchema,
  listSandboxAttemptsQuerySchema,
  listSandboxAttemptsResponseSchema,
  renameSandboxRequestSchema,
  renameSandboxResponseSchema,
  listSandboxEventsQuerySchema,
  listSandboxEventsResponseSchema,
  listSandboxesQuerySchema,
  listSandboxesResponseSchema,
  sandboxDetailsSchema,
  sandboxIdParamsSchema,
  sandboxSshTargetSchema,
} from "./sandboxes.schemas.js";

const tags = ["Sandboxes"];

export * from "./sandboxes.schemas.js";

export const createSandboxValidator = validator("json", createSandboxRequestSchema);
export const renameSandboxValidator = validator("json", renameSandboxRequestSchema);
export const sandboxIdValidator = validator("param", sandboxIdParamsSchema);
export const listSandboxesQueryValidator = validator("query", listSandboxesQuerySchema);
export const listSandboxAttemptsQueryValidator = validator("query", listSandboxAttemptsQuerySchema);
export const listSandboxEventsQueryValidator = validator("query", listSandboxEventsQuerySchema);

export const createSandboxRoute = describeRoute({
  tags,
  description: "Create and queue a sandbox launch request for a user sandbox spec.",
  responses: {
    202: {
      description: "Sandbox creation accepted and queued",
      content: {
        "application/json": {
          schema: resolver(createSandboxResponseSchema),
        },
      },
    },
    404: {
      description: "Unknown registry id or owner user",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    403: {
      description: "User is not allowed to launch the selected GitHub repository",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    400: {
      description: "Invalid package resolution or unsupported package request",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    502: {
      description: "Failed to enqueue sandbox build request",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listSandboxesRoute = describeRoute({
  tags,
  description: "List sandboxes for a specific owner user id.",
  responses: {
    200: {
      description: "Sandbox list",
      content: {
        "application/json": {
          schema: resolver(listSandboxesResponseSchema),
        },
      },
    },
  },
});

export const getSandboxRoute = describeRoute({
  tags,
  description: "Get consolidated sandbox lifecycle details by sandbox id.",
  responses: {
    200: {
      description: "Sandbox lifecycle details",
      content: {
        "application/json": {
          schema: resolver(sandboxDetailsSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const getSandboxSshTargetRoute = describeRoute({
  tags,
  description:
    "Resolve the internal SSH runtime target for a sandbox. Intended for the SSH gateway service.",
  responses: {
    200: {
      description: "Sandbox SSH runtime target",
      content: {
        "application/json": {
          schema: resolver(sandboxSshTargetSchema),
        },
      },
    },
    401: {
      description: "Gateway token is missing or invalid",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    409: {
      description: "Sandbox runtime has no SSH endpoint",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    503: {
      description: "Gateway integration is not configured",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const renameSandboxRoute = describeRoute({
  tags,
  description: "Rename an existing sandbox.",
  responses: {
    200: {
      description: "Sandbox renamed",
      content: {
        "application/json": {
          schema: resolver(renameSandboxResponseSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listSandboxAttemptsRoute = describeRoute({
  tags,
  description: "List sandbox attempts linked to a sandbox id, ordered by most recent link first.",
  responses: {
    200: {
      description: "Sandbox attempts list",
      content: {
        "application/json": {
          schema: resolver(listSandboxAttemptsResponseSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listSandboxEventsRoute = describeRoute({
  tags,
  description:
    "List sandbox lifecycle events synthesized from sandbox attempts and runtime records.",
  responses: {
    200: {
      description: "Sandbox event timeline",
      content: {
        "application/json": {
          schema: resolver(listSandboxEventsResponseSchema),
        },
      },
    },
    404: {
      description: "Sandbox not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});
