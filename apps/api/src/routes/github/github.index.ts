import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./github.handlers.js";
import * as routes from "./github.routes.js";

const router = createRouter();

router.get(
  "/installations",
  routes.listGitHubInstallationsRoute,
  routes.githubInstallationsQueryValidator,
  handlers.listInstallations,
);
router.get(
  "/installations/:installationId/repositories",
  routes.listGitHubInstallationRepositoriesRoute,
  routes.githubInstallationIdValidator,
  routes.githubInstallationRepositoriesQueryValidator,
  handlers.listInstallationRepositories,
);
router.post(
  "/installations/import",
  routes.importGitHubInstallationRoute,
  routes.importGitHubInstallationBodyValidator,
  handlers.importInstallation,
);
router.post(
  "/installations/:installationId/sync",
  routes.syncGitHubInstallationRoute,
  routes.githubInstallationIdValidator,
  routes.syncGitHubInstallationQueryValidator,
  handlers.syncInstallation,
);
router.post("/webhooks", routes.githubWebhookRoute, handlers.handleWebhook);

export default router;
