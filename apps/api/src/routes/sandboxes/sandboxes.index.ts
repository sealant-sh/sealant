import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./sandboxes.handlers.js";
import * as routes from "./sandboxes.routes.js";

const router = createRouter();

router.post("/", routes.createSandboxRoute, routes.createSandboxValidator, handlers.createSandbox);
router.get(
  "/",
  routes.listSandboxesRoute,
  routes.listSandboxesQueryValidator,
  handlers.listSandboxes,
);
router.get("/:sandboxId", routes.getSandboxRoute, routes.sandboxIdValidator, handlers.getSandbox);

export default router;
