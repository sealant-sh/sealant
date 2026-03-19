import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./registries.handlers.js";
import * as routes from "./registries.routes.js";

const router = createRouter();

router.get(
  "/:registryId",
  routes.getRegistryRoute,
  routes.registryIdValidator,
  handlers.getRegistry,
);
router.get(
  "/:registryId/ping",
  routes.pingRegistryRoute,
  routes.registryIdValidator,
  handlers.pingRegistry,
);
router.get(
  "/:registryId/extensions",
  routes.listExtensionsRoute,
  routes.registryIdValidator,
  handlers.listExtensions,
);
router.get(
  "/:registryId/tags",
  routes.listTagsRoute,
  routes.registryIdValidator,
  routes.tagsQueryValidator,
  handlers.listTags,
);
router.get(
  "/:registryId/manifest",
  routes.getManifestRoute,
  routes.registryIdValidator,
  routes.manifestQueryValidator,
  handlers.getManifest,
);

export default router;
