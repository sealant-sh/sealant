/**
 * @deprecated Legacy Hono implementation disabled during Effect migration.
 * Original code is intentionally commented out below.
 */

// import type { Context } from "hono";
//
// import packageJson from "../../../package.json" with { type: "json" };
// import type { AppBindings } from "../../lib/types.js";
//
// export const index = async (c: Context<AppBindings>) => {
//   return c.json({
//     name: "Sealant Control Plane API",
//     version: packageJson.version,
//     docsPath: "/docs",
//     openApiPath: "/openapi.json",
//   });
// };
//
// export const health = async (c: Context<AppBindings>) => {
//   return c.json({
//     status: "ok",
//   });
// };
//
// export const ready = async (c: Context<AppBindings>) => {
//   return c.json({
//     status: "ok",
//   });
// };

export {};
