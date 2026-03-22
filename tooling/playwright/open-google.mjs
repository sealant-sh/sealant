import { chromium } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";

const browser = await chromium.launch(
  {
    ...(executablePath
      ? {
          executablePath,
        }
      : {}),
    headless,
  },
);

try {
  const page = await browser.newPage();
  await page.goto("https://google.com", { waitUntil: "domcontentloaded" });
  console.log(await page.title());
  if (!headless) {
    await page.waitForTimeout(30_000);
  }
} finally {
  await browser.close();
}
