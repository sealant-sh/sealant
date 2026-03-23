import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./sandboxes.handlers.js";
import * as routes from "./sandboxes.routes.js";

const router = createRouter();

router.post("/", routes.createSandboxRoute, routes.createSandboxValidator, handlers.createSandbox);
router.patch(
  "/:sandboxId/name",
  routes.renameSandboxRoute,
  routes.sandboxIdValidator,
  routes.renameSandboxValidator,
  handlers.renameSandbox,
);
router.get(
  "/",
  routes.listSandboxesRoute,
  routes.listSandboxesQueryValidator,
  handlers.listSandboxes,
);
router.get(
  "/:sandboxId/attempts",
  routes.listSandboxAttemptsRoute,
  routes.sandboxIdValidator,
  routes.listSandboxAttemptsQueryValidator,
  handlers.listSandboxAttempts,
);
router.get(
  "/:sandboxId/events",
  routes.listSandboxEventsRoute,
  routes.sandboxIdValidator,
  routes.listSandboxEventsQueryValidator,
  handlers.listSandboxEvents,
);
router.get("/:sandboxId", routes.getSandboxRoute, routes.sandboxIdValidator, handlers.getSandbox);

export default router;
