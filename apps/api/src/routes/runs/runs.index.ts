import { createRouter } from "../../lib/create-app.js";
import * as handlers from "./runs.handlers.js";
import * as routes from "./runs.routes.js";

const router = createRouter();

router.get("/:runId", routes.getRunRoute, routes.runIdValidator, handlers.getRun);

export default router;
