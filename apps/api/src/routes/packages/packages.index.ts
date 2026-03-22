import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./packages.handlers.js";
import * as routes from "./packages.routes.js";

const router = createRouter();

router.get(
  "/resolve",
  routes.resolvePackageRoute,
  routes.resolvePackageQueryValidator,
  handlers.resolvePackage,
);

export default router;
