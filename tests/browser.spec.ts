import { expect, test, type Page } from "@playwright/test";

async function startMockRun(page: Page): Promise<void> {
  await page.goto("/");
  const runId = await page.evaluate(async () => {
    const response = await fetch("/api/runs", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "MOCK" })
    });
    if (!response.ok) throw new Error("Could not create internal browser-test run.");
    return ((await response.json()) as { runId: string }).runId;
  });
  await page.evaluate((id) => window.sessionStorage.setItem("rasoi_run_id", id), runId);
  await page.reload();
  await expect(page.getByRole("img", { name: /Live 3D kitchen/ })).toBeVisible();
}

async function reachOffer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Extract constraints" }).click();
  await page.getByRole("button", { name: "Confirm constraints" }).click();
  await expect(page.getByRole("heading", { name: "Lemon rice" })).toBeVisible();
}

test("public entry explains the product and starts Razorpay without a code", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "An AI cashier that only sells what the kitchen can make." })).toBeVisible();
  await expect(page.getByText(/actual Razorpay Test Mode Orders/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Razorpay demo" })).toBeVisible();
});

test("happy MOCK flow advances accepted server state into cooking", async ({ page }) => {
  await startMockRun(page);
  await reachOffer(page);
  await page.getByRole("button", { name: "Accept simulated offer" }).click();

  await expect(page.getByRole("img", { name: /cooking/i })).toBeVisible();
  await expect(page.getByText("The simulated payment succeeded; kitchen work may now start.")).toBeVisible();
  await expect(page.getByText("The confirmed simulated payment released this meal to its reserved station.")).toBeVisible();
});

test("station outage before acceptance invalidates the offer and finds one valid alternative", async ({ page }) => {
  await startMockRun(page);
  await reachOffer(page);
  await page.getByRole("button", { name: "Disable bowl station" }).click();

  await expect(page.getByRole("heading", { name: "Plain dosa" })).toBeVisible();
  await expect(page.getByText(/one feasible replacement/)).toBeVisible();
  await expect(page.getByRole("img", { name: /bowl station down/i })).toBeVisible();
});

test("station outage after capture cancels and completes one simulated refund", async ({ page }) => {
  await startMockRun(page);
  await reachOffer(page);
  await page.getByRole("button", { name: "Accept simulated offer" }).click();
  await expect(page.getByRole("img", { name: /cooking/i })).toBeVisible();
  await page.getByRole("button", { name: "Disable bowl station" }).click();

  await expect(page.getByRole("img", { name: /cancelled/i })).toBeVisible();
  await expect(page.getByText("The simulated full refund completed after the station failure.")).toHaveCount(1);
  await expect(page.getByText("The station failed after capture; the meal was cancelled and a full refund is required.")).toHaveCount(1);
});

test("confirmed state survives reload and controls work from the keyboard", async ({ page }) => {
  await startMockRun(page);
  await reachOffer(page);
  await page.getByRole("button", { name: "Accept simulated offer" }).click();
  await expect(page.getByRole("img", { name: /cooking/i })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: /cooking/i })).toBeVisible();

  const disable = page.getByRole("button", { name: "Disable bowl station" });
  await disable.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Repair bowl station" })).toBeVisible();
});

test("WebGL fallback keeps honest status and all HTML controls", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
      return original.call(this, type as "2d", ...(args as []));
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/");
  await startMockRun(page);

  await expect(page.getByText(/3D preview unavailable/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable tawa" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Extract constraints" })).toBeVisible();
});
