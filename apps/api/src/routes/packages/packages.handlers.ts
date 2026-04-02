import { resolvePackageQuerySchema } from "@sealant/validators";
import type { Context } from "hono";
import type { z } from "zod";

import type { AppBindings } from "../../lib/types.js";

/**
 * Reads the composed API runtime from request context.
 */
const getRuntime = (c: Context<AppBindings>) => {
  return c.get("runtime");
};

/**
 * Resolves package requests using the runtime package standardizer service.
 */
export const resolvePackage = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): z.infer<typeof resolvePackageQuerySchema>;
    }
  ).valid("query");

  try {
    const resolution = await runtime.packageStandardizer.resolvePackage({
      query: query.query,
      targetOs: query.targetOs,
    });

    return c.json(resolution);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Package resolution failed.";

    runtime.logger.error("[packages.resolve] package resolution failed", {
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
