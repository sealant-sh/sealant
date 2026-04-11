/**
 * @deprecated Legacy Hono implementation disabled during Effect migration.
 * Original code is intentionally commented out below.
 */

// import {
//   messageResponseSchema,
//   resolvePackageQuerySchema,
//   resolvePackageResponseSchema,
// } from "@sealant/validators";
// import { describeRoute, resolver, validator } from "hono-openapi";
//
// const tags = ["Packages"];
//
// export const resolvePackageQueryValidator = validator("query", resolvePackageQuerySchema);
//
// export const resolvePackageRoute = describeRoute({
//   tags,
//   description:
//     "Resolve and standardize a user package request into distro-aware package names for sandbox composition.",
//   responses: {
//     200: {
//       description: "Resolved package response",
//       content: {
//         "application/json": {
//           schema: resolver(resolvePackageResponseSchema),
//         },
//       },
//     },
//     502: {
//       description: "Failed to reach package resolution backend",
//       content: {
//         "application/json": {
//           schema: resolver(messageResponseSchema),
//         },
//       },
//     },
//   },
// });

export {};
