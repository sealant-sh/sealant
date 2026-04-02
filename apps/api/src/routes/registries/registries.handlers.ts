import type { Context } from "hono";

import type { AppBindings } from "../../lib/types.js";

const getRuntime = (c: Context<AppBindings>) => {
  return c.get("runtime");
};

const getRegistrySummary = (c: Context<AppBindings>) => {
  const env = getRuntime(c).env;

  return {
    name: env.REGISTRY_NAME,
    baseUrl: env.REGISTRY_BASE_URL,
    pushRegistry: env.REGISTRY_PUSH_REGISTRY,
    hasBasicAuth: env.REGISTRY_USERNAME !== undefined,
  };
};

const ensureRegistry = (c: Context<AppBindings>) => {
  const env = getRuntime(c).env;
  const { registryId } = c.req.param() as {
    registryId: string;
  };

  if (registryId !== env.REGISTRY_NAME) {
    return c.json(
      {
        message: `Unknown registry: ${registryId}`,
      },
      404,
    );
  }

  return null;
};

const registryFailureResponse = (c: Context<AppBindings>, error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return c.json(
      {
        message: `Registry request failed with status ${error.status}.`,
      },
      502,
    );
  }

  const message = error instanceof Error ? error.message : "Registry request failed.";

  return c.json(
    {
      message,
    },
    502,
  );
};

export const getRegistry = async (c: Context<AppBindings>) => {
  const missingRegistry = ensureRegistry(c);

  if (missingRegistry !== null) {
    return missingRegistry;
  }

  return c.json(getRegistrySummary(c));
};

export const pingRegistry = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const missingRegistry = ensureRegistry(c);

  if (missingRegistry !== null) {
    return missingRegistry;
  }

  try {
    await runtime.registryClient.ping();

    return c.json({
      name: runtime.env.REGISTRY_NAME,
      reachable: true,
    });
  } catch (error) {
    return registryFailureResponse(c, error);
  }
};

export const listExtensions = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const missingRegistry = ensureRegistry(c);

  if (missingRegistry !== null) {
    return missingRegistry;
  }

  try {
    const extensions = await runtime.registryClient.discoverExtensions();

    return c.json({
      extensions,
    });
  } catch (error) {
    return registryFailureResponse(c, error);
  }
};

export const listTags = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const missingRegistry = ensureRegistry(c);

  if (missingRegistry !== null) {
    return missingRegistry;
  }

  const { repository } = c.req.query() as {
    repository: string;
  };

  try {
    const tags = await runtime.registryClient.listTags(repository);

    return c.json({
      repository,
      tags,
    });
  } catch (error) {
    return registryFailureResponse(c, error);
  }
};

export const getManifest = async (c: Context<AppBindings>) => {
  const runtime = getRuntime(c);
  const missingRegistry = ensureRegistry(c);

  if (missingRegistry !== null) {
    return missingRegistry;
  }

  const { repository, reference } = c.req.query() as {
    repository: string;
    reference: string;
  };

  try {
    const manifest = await runtime.registryClient.getManifest(repository, reference);

    if (manifest === null) {
      return c.json(
        {
          message: `Manifest not found for ${repository}:${reference}`,
        },
        404,
      );
    }

    return c.json({
      repository,
      reference,
      digest: manifest.digest,
      contentType: manifest.contentType,
      manifest: manifest.body,
    });
  } catch (error) {
    return registryFailureResponse(c, error);
  }
};
