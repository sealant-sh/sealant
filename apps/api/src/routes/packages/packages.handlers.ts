import { resolvePackageQuerySchema } from "@sealant/validators";
import type { Context } from "hono";
import type { z } from "zod";

import type { AppBindings } from "../../lib/types.js";

export const resolvePackage = async (c: Context<AppBindings>) => {
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof resolvePackageQuerySchema>;
    }
  ).valid("query");

  try {
    const resolution = await c.get("packageStandardizer").resolvePackage({
      query: query.query,
      targetOs: query.targetOs,
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
