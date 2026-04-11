/**
 * @deprecated Legacy non-Effect implementation disabled during Effect migration.
 * Original code is intentionally commented out below.
 */

// import { Hono } from "hono";
// import { cors } from "hono/cors";
//
// import { createApiRuntime } from "./create-api-runtime.js";
// import type { AppBindings, AppRuntimeConfig } from "./types.js";
//
// /**
//  * Creates a typed Hono router with Sealant API bindings.
//  */
// export const createRouter = () => {
//   return new Hono<AppBindings>();
// };
//
// /**
//  * Creates the API application, wires middleware, and injects runtime dependencies.
//  */
// export const createApp = (config: AppRuntimeConfig) => {
//   const app = createRouter();
//   const runtime = createApiRuntime(config);
//   const allowAllOrigins = config.env.CORS_ALLOWED_ORIGINS.trim() === "*";
//   const allowedOrigins = parseAllowedOrigins(config.env.CORS_ALLOWED_ORIGINS);
//
//   app.use(
//     "*",
//     cors({
//       origin: (origin) => {
//         if (allowAllOrigins) {
//           return "*";
//         }
//
//         if (origin.length === 0) {
//           return origin;
//         }
//
//         if (allowedOrigins.has(origin)) {
//           return origin;
//         }
//
//         return "";
//       },
//       allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//       allowHeaders: ["content-type", "authorization", "idempotency-key", "x-sealant-gateway-token"],
//       exposeHeaders: ["location"],
//       maxAge: 86_400,
//     }),
//   );
//
//   app.use("*", async (c, next) => {
//     c.set("runtime", runtime);
//     await next();
//   });
//
//   app.notFound((c) => {
//     return c.json(
//       {
//         message: "Not Found",
//       },
//       404,
//     );
//   });
//
//   app.onError((error, c) => {
//     c.get("runtime").logger.error("[api] request failed", {
//       method: c.req.method,
//       path: c.req.path,
//       error: error.message,
//       stack: error.stack,
//     });
//
//     return c.json(
//       {
//         message: error.message.length > 0 ? error.message : "Internal Server Error",
//       },
//       500,
//     );
//   });
//
//   return app;
// };
//
// /**
//  * Parses a comma-separated CORS allow-list into a normalized lookup set.
//  */
// const parseAllowedOrigins = (value: string): Set<string> => {
//   return new Set(
//     value
//       .split(",")
//       .map((item) => item.trim())
//       .filter((item) => item.length > 0),
//   );
// };

export {};
