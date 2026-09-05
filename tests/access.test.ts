import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3001,
  appOrigin: "http://localhost:5173",
  databasePath: ":memory:",
  demoAccessCode: "a-strong-demo-code",
  publicDemoEnabled: false,
  allowRazorpayTest: false,
  razorpayWebhookSecret: "test-webhook-secret"
};

describe("run access bootstrap", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("rejects the wrong origin and wrong access code", async () => {
    app = await buildApp(config);
    const badOrigin = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: "https://attacker.example", "content-type": "application/json" }, payload: { accessCode: config.demoAccessCode, mode: "MOCK" } });
    expect(badOrigin.statusCode).toBe(403);

    const badCode = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin, "content-type": "application/json" }, payload: { accessCode: "not-the-right-code", mode: "MOCK" } });
    expect(badCode.statusCode).toBe(401);
    expect(badCode.json()).not.toHaveProperty("accessCode");
  });

  it("accepts localhost and 127.0.0.1 as equivalent origins only in development", async () => {
    app = await buildApp({ ...config, nodeEnv: "development" });
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { origin: "http://127.0.0.1:5173", "content-type": "application/json" },
      payload: { accessCode: config.demoAccessCode, mode: "MOCK" }
    });
    expect(response.statusCode).toBe(201);
  });

  it("opens a public simulated run without exposing the private test flow", async () => {
    app = await buildApp({ ...config, publicDemoEnabled: true });
    const created = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: "https://demo.example", "content-type": "application/json" }, payload: { mode: "MOCK" } });
    expect(created.statusCode).toBe(201);
    const runId = created.json().runId as string;
    const rawCookie = created.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/state`, headers: { cookie } })).statusCode).toBe(200);

    const station = await app.inject({ method: "POST", url: `/api/runs/${runId}/station`, headers: { origin: "https://demo.example", cookie, "content-type": "application/json" }, payload: { stationId: "tawa", status: "DOWN" } });
    expect(station.statusCode).toBe(200);
    expect(station.json().stations.tawa.status).toBe("DOWN");

    const privateMode = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin }, payload: { mode: "RAZORPAY_TEST" } });
    expect(privateMode.statusCode).toBe(409);
  });

  it("creates a mock run, stores only a cookie token, and authorizes state reads", async () => {
    app = await buildApp(config);
    const created = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin, "content-type": "application/json" }, payload: { accessCode: config.demoAccessCode, mode: "MOCK" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ runId: expect.any(String) });
    expect(created.json()).not.toHaveProperty("token");
    expect(created.headers["set-cookie"]).toContain("HttpOnly");
    expect(created.headers["set-cookie"]).toContain("SameSite=Strict");

    const unauthorized = await app.inject({ method: "GET", url: `/api/runs/${created.json().runId}/state` });
    expect(unauthorized.statusCode).toBe(401);

    const rawCookie = created.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0];
    const authorized = await app.inject({ method: "GET", url: `/api/runs/${created.json().runId}/state`, headers: { cookie: cookie ?? "" } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ mode: "MOCK", salesStopped: false, razorpayEnabled: false });
  });

  it("refuses Razorpay test mode while integration is disabled", async () => {
    app = await buildApp(config);
    const response = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin, "content-type": "application/json" }, payload: { accessCode: config.demoAccessCode, mode: "RAZORPAY_TEST" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MODE_MISMATCH");
  });

  it("rotates expired access, stops sales, and exports a sanitized audit", async () => {
    app = await buildApp(config);
    const created = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin }, payload: { accessCode: config.demoAccessCode, mode: "MOCK" } });
    const runId = created.json().runId as string;
    const rawCookie = created.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";

    const stopped = await app.inject({ method: "POST", url: `/api/runs/${runId}/stop-sales`, headers: { origin: config.appOrigin, cookie } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().salesStopped).toBe(true);
    const audit = await app.inject({ method: "GET", url: `/api/runs/${runId}/audit`, headers: { cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({ runId, auditType: "append-only-application-audit" });
    expect(audit.json().events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "SALES_STOPPED" })]));
    expect(JSON.stringify(audit.json())).not.toContain("tokenHash");

    app.db.prepare("UPDATE runs SET tokenExpiresAtMs = 1 WHERE id = ?").run(runId);
    const expired = await app.inject({ method: "GET", url: `/api/runs/${runId}/state`, headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    const resumed = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume`, headers: { origin: config.appOrigin }, payload: { accessCode: config.demoAccessCode } });
    expect(resumed.statusCode).toBe(200);
    const resumedRawCookie = resumed.headers["set-cookie"];
    const resumedCookie = (Array.isArray(resumedRawCookie) ? resumedRawCookie[0] : resumedRawCookie)?.split(";")[0] ?? "";
    expect(resumedCookie).not.toBe(cookie);
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/state`, headers: { cookie: resumedCookie } })).statusCode).toBe(200);
  });

  it("settles an explicit simulated payment outcome through the authenticated control route", async () => {
    app = await buildApp(config);
    const created = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin }, payload: { accessCode: config.demoAccessCode, mode: "MOCK" } });
    const runId = created.json().runId as string;
    const rawCookie = created.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";
    const headers = { origin: config.appOrigin, cookie };
    const interpreted = await app.inject({ method: "POST", url: `/api/runs/${runId}/request`, headers, payload: { requestId: randomUUID(), text: "Maximum ₹120, within five minutes, plain dosa only." } });
    const draft = interpreted.json().intent.draft as { id: string; version: number; requestReceivedAtMs: number };
    const confirmed = await app.inject({
      method: "POST", url: `/api/runs/${runId}/confirm-intent`, headers,
      payload: { intentId: draft.id, intentVersion: draft.version, budgetPaise: 12000, latestReadyAtMs: draft.requestReceivedAtMs + 300_000, excludedIngredients: [], preferredDishIds: ["plain_dosa"], allowSubstitutes: false }
    });
    const intent = confirmed.json().intent as { confirmed: { id: string; version: number }; quote: { id: string; contentHash: string } };
    const accepted = await app.inject({
      method: "POST", url: `/api/runs/${runId}/accept`, headers,
      payload: { quoteId: intent.quote.id, quoteHash: intent.quote.contentHash, intentId: intent.confirmed.id, intentVersion: intent.confirmed.version, clientCommandId: randomUUID() }
    });
    const orderId = accepted.json().currentOrder.id as string;

    const failed = await app.inject({ method: "POST", url: `/api/orders/${orderId}/mock-payment`, headers, payload: { outcome: "failed" } });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().currentOrder).toMatchObject({ localState: "CANCELLED", paymentStatus: "failed" });
    expect(failed.json().events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "SIMULATED_PAYMENT_FAILED" })]));
  });
});
