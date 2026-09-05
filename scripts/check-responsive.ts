import { chromium } from "@playwright/test";

const appUrl = process.env.VISUAL_APP_URL ?? "http://127.0.0.1:3002/";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
});
for (const width of [375, 768, 1280]) {
  const context = await browser.newContext({ viewport: { width, height: width === 375 ? 812 : 900 } });
  const page = await context.newPage();
  await page.goto(appUrl);
  const newRun = page.getByRole("button", { name: "New run" });
  if (await newRun.isVisible()) await newRun.click();
  await page.getByRole("button", { name: "Try the demo" }).click();
  await page.getByRole("button", { name: "Extract constraints" }).click();
  await page.getByRole("button", { name: "Confirm constraints" }).click();
  await page.getByRole("heading", { name: "Lemon rice" }).waitFor();
  await page.getByRole("img", { name: /Live 3D kitchen/ }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error(`Horizontal overflow at ${width}px.`);
  await page.screenshot({ path: `/tmp/rasoi-gate5-${width}.png`, fullPage: true });
  console.log(`${width}px: complete flow visible, no horizontal overflow`);
  await context.close();
}
await browser.close();
