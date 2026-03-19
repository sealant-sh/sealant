import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./system.handlers.js";
import * as routes from "./system.routes.js";

const router = createRouter();

router.get("/", routes.indexRoute, handlers.index);
router.get("/healthz", routes.healthRoute, handlers.health);
router.get("/readyz", routes.readyRoute, handlers.ready);

export default router;
