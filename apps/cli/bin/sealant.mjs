#!/usr/bin/env node
// Thin bin shim: the real CLI is bundled to dist/main.js by `pnpm --filter @sealant/cli build`.
try {
  await import("../dist/main.js");
} catch (error) {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes("dist/main.js")
  ) {
    console.error(
      "sealant: dist/main.js not found. Build it first with `pnpm --filter @sealant/cli build`.",
    );
    process.exit(1);
  }
  throw error;
}
