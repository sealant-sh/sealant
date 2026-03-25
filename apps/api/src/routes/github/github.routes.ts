import { describeRoute, resolver, validator } from "hono-openapi";

import { messageResponseSchema } from "../../lib/schemas.js";
import {
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  githubInstallationIdParamsSchema,
  githubInstallationRepositoriesQuerySchema,
  githubWebhookResponseSchema,
  githubInstallationsQuerySchema,
  listGitHubInstallationRepositoriesResponseSchema,
  listGitHubInstallationsResponseSchema,
  syncGitHubInstallationQuerySchema,
  syncGitHubInstallationResponseSchema,
} from "./github.schemas.js";

const tags = ["GitHub"];

export * from "./github.schemas.js";

export const githubInstallationIdValidator = validator("param", githubInstallationIdParamsSchema);
export const githubInstallationsQueryValidator = validator("query", githubInstallationsQuerySchema);
export const githubInstallationRepositoriesQueryValidator = validator(
  "query",
  githubInstallationRepositoriesQuerySchema,
);
export const syncGitHubInstallationQueryValidator = validator(
  "query",
  syncGitHubInstallationQuerySchema,
);
export const importGitHubInstallationBodyValidator = validator(
  "json",
  importGitHubInstallationRequestSchema,
);

export const listGitHubInstallationsRoute = describeRoute({
  tags,
  description: "List GitHub App installations a user is granted to use.",
  responses: {
    200: {
      description: "Granted GitHub installations",
      content: {
        "application/json": {
          schema: resolver(listGitHubInstallationsResponseSchema),
        },
      },
    },
    503: {
      description: "GitHub integration is not configured",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const listGitHubInstallationRepositoriesRoute = describeRoute({
  tags,
  description: "List repositories available under a granted GitHub App installation.",
  responses: {
    200: {
      description: "Repositories under the installation",
      content: {
        "application/json": {
          schema: resolver(listGitHubInstallationRepositoriesResponseSchema),
        },
      },
    },
    403: {
      description: "User does not have access to the installation",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    404: {
      description: "Installation not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    503: {
      description: "GitHub integration is not configured",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const syncGitHubInstallationRoute = describeRoute({
  tags,
  description: "Synchronize the cached repository list for a GitHub App installation.",
  responses: {
    200: {
      description: "Installation repository sync completed",
      content: {
        "application/json": {
          schema: resolver(syncGitHubInstallationResponseSchema),
        },
      },
    },
    403: {
      description: "User does not have access to the installation or the installation is inactive",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    404: {
      description: "Installation not found",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    503: {
      description: "GitHub integration is not configured",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const importGitHubInstallationRoute = describeRoute({
  tags,
  description:
    "Import a GitHub App installation directly from GitHub and seed local installation state without a webhook.",
  responses: {
    200: {
      description: "Installation imported and repository sync completed",
      content: {
        "application/json": {
          schema: resolver(importGitHubInstallationResponseSchema),
        },
      },
    },
    404: {
      description: "Installation not found in GitHub",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    500: {
      description: "Installation import failed",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    503: {
      description: "GitHub integration is not configured",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});

export const githubWebhookRoute = describeRoute({
  tags,
  description: "Receive GitHub App webhooks for installation lifecycle and repository sync.",
  responses: {
    202: {
      description: "Webhook accepted",
      content: {
        "application/json": {
          schema: resolver(githubWebhookResponseSchema),
        },
      },
    },
    401: {
      description: "Webhook signature verification failed",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
    503: {
      description: "GitHub integration is not configured",
      content: {
        "application/json": {
          schema: resolver(messageResponseSchema),
        },
      },
    },
  },
});
