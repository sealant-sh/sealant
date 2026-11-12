// Screenshots pages of the local sealant web app, signed in.
//
// As a command, from the repo root:
//   node .agents/skills/verify/scripts/shot.mjs <path>[=<name>] ...
//   node .agents/skills/verify/scripts/shot.mjs /settings=settings-after /=home
//
// As a library, from a scratch script anywhere (import it by absolute path; it resolves
// Playwright from this repo, so the scratch script needs no node_modules of its own):
//   import { withSignedInPage, open, shoot } from "/abs/path/to/shot.mjs";
//   await withSignedInPage(async (page) => {
//     await open(page, "/workspaces");
//     await page.getByRole("button", { name: "New workspace" }).click();
//     await shoot(page, "new-workspace-dialog");
//   });
//
// Needs the stack from "Run it" in DEVELOPMENT.md. On an empty database it creates the first
// account through the /setup wizard; otherwise it signs in as that account. The account exists
// only in the local database.
//
// SEALANT_WEB_URL overrides the web app's address (default http://localhost:3000; Vite listens on
// localhost, not 127.0.0.1). SHOT_DIR overrides where screenshots go (default /tmp/sealant-verify).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const base = process.env.SEALANT_WEB_URL ?? "http://localhost:3000";
const outDir = process.env.SHOT_DIR ?? "/tmp/sealant-verify";
const account = {
  name: "Verify Agent",
  email: "verify@example.test",
  password: "verify-password-123",
};

// Vite's dev server keeps a socket open, so "networkidle" never arrives. Wait for the load event,
// then give the app a moment to render.
export async function open(page, path) {
  await page.goto(new URL(path, base).href, { waitUntil: "load" });
  await page.waitForTimeout(1500);
}

// Saves a full-page screenshot as <SHOT_DIR>/<name>.png and returns its path.
export async function shoot(page, name) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${file}  ${page.url()}`);
  return file;
}

async function signIn(page) {
  await open(page, "/");
  // Inputs by type: the password labels hold more than the word (the login one holds its
  // "Reset password" link), so label matching is brittle.
  const passwords = page.locator('input[type="password"]');
  if (page.url().includes("/setup")) {
    await page.getByLabel("Name").fill(account.name);
    await page.locator('input[type="email"]').fill(account.email);
    await passwords.nth(0).fill(account.password);
    await passwords.nth(1).fill(account.password);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForTimeout(2000);
    // Step 2 (SSH key) is optional: skip it. Step 3 (connect your machine) ends on
    // "Go to dashboard".
    for (let step = 0; step < 3 && page.url().includes("/setup"); step++) {
      await page
        .getByText(/Skip for now|Go to dashboard/)
        .first()
        .click();
      await page.waitForTimeout(1500);
    }
  } else if (page.url().includes("/login")) {
    await page.locator('input[type="email"]').fill(account.email);
    await passwords.fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(2000);
  }
  if (page.url().includes("/login") || page.url().includes("/setup")) {
    throw new Error(`still signed out at ${page.url()}`);
  }
}

// Runs fn with a page signed in to the local app, then closes the browser.
export async function withSignedInPage(fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await signIn(page);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2).map((arg) => {
    const [path, name] = arg.split("=");
    return {
      path,
      name: name ?? (path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"),
    };
  });
  if (targets.length === 0) {
    console.error("usage: shot.mjs <path>[=<name>] ...");
    process.exit(2);
  }
  await withSignedInPage(async (page) => {
    for (const { path, name } of targets) {
      await open(page, path);
      await shoot(page, name);
    }
  });
}
