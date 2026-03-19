import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";

const tags = ["System"];

export const indexResponseSchema = z.object({
  name: z.string(),
  version: z.string(),
  docsPath: z.string(),
  openApiPath: z.string(),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const indexRoute = describeRoute({
  tags,
  description: "Show the API entrypoint and documentation paths.",
  responses: {
    200: {
      description: "API entrypoint",
      content: {
        "application/json": {
          schema: resolver(indexResponseSchema),
        },
      },
    },
  },
});

export const healthRoute = describeRoute({
  tags,
  description: "Liveness probe for the control-plane API.",
  responses: {
    200: {
      description: "API is alive",
      content: {
        "application/json": {
          schema: resolver(healthResponseSchema),
        },
      },
    },
  },
});

export const readyRoute = describeRoute({
  tags,
  description: "Readiness probe for the control-plane API scaffold.",
  responses: {
    200: {
      description: "API is ready",
      content: {
        "application/json": {
          schema: resolver(healthResponseSchema),
        },
      },
    },
  },
});
