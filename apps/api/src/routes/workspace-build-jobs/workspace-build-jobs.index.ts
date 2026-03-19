import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./workspace-build-jobs.handlers.js";
import * as routes from "./workspace-build-jobs.routes.js";

const router = createRouter();

router.post(
  "/",
  routes.createWorkspaceBuildJobRoute,
  routes.createWorkspaceBuildJobValidator,
  handlers.createWorkspaceBuildJob,
);
router.get(
  "/:jobId",
  routes.getWorkspaceBuildJobRoute,
  routes.workspaceBuildJobIdValidator,
  handlers.getWorkspaceBuildJob,
);

export default router;
