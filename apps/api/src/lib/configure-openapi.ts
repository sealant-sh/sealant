/**
 * @deprecated Legacy non-Effect implementation disabled during Effect migration.
 * Original code is intentionally commented out below.
 */

// import { Scalar } from "@scalar/hono-api-reference";
// import type { AppEnv } from "@sealant/validators/env";
// import type { Hono } from "hono";
// import { openAPIRouteHandler } from "hono-openapi";
//
// import packageJson from "../../package.json" with { type: "json" };
// import type { AppBindings } from "./types.js";
//
// export const configureOpenAPI = (
//   app: Hono<AppBindings>,
//   routes: Hono<AppBindings>,
//   env: AppEnv,
// ) => {
//   app.get(
//     "/openapi.json",
//     openAPIRouteHandler(routes, {
//       documentation: {
//         openapi: "3.1.0",
//         info: {
//           title: "Sealant Control Plane API",
//           version: packageJson.version,
//           description: "Sandbox-first control-plane API with internal diagnostics surfaces.",
//         },
//         servers: [
//           {
//             url: `http://localhost:${env.PORT}`,
//             description: `${env.NODE_ENV} server`,
//           },
//         ],
//       },
//     }),
//   );
//
//   app.get(
//     "/docs",
//     Scalar({
//       url: "/openapi.json",
//       theme: "saturn",
//       layout: "classic",
//       defaultHttpClient: {
//         targetKey: "js",
//         clientKey: "fetch",
//       },
//     }),
//   );
// };

export {};
