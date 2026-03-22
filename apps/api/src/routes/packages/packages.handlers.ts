import type { Context } from "hono";
import type { z } from "zod";

import type { AppBindings } from "../../lib/types.js";
import type { resolvePackageQuerySchema } from "./packages.routes.js";

export const resolvePackage = async (c: Context<AppBindings>) => {
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof resolvePackageQuerySchema>;
    }
  ).valid("query");

  try {
    const resolution = await c.get("packageStandardizer").resolvePackage({
      query: query.query,
    });

    return c.json(resolution);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Package resolution failed.";

    console.error("[packages.resolve] package resolution failed", {
      query: query.query,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json(
      {
        message,
      },
      502,
    );
  }
};
