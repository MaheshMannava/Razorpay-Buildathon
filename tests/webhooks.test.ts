import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { createRun } from "../src/server/run-store.js";

const secret = "test-webhook-secret";
const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3001,
  appOrigin: "http://localhost:5173",
  databasePath: ":memory:",
  demoAccessCode: "a-strong-demo-code",
  publicDemoEnabled: false,
  allowRazorpayTest: true,
  razorpayWebhookSecret: secret
};

function sign(body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("Razorpay webhook ingress", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(config); });
  afterEach(async () => app.close());

  it("rejects a webhook with an invalid signature", async () => {
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/razorpay",
      headers: { "content-type": "application/json", "x-razorpay-signature": "0".repeat(64), "x-razorpay-event-id": "evt_invalid" },
      payload: body
    });
    expect(response.statusCode).toBe(401);
  });

  it("ignores a valid event that does not belong to a RASOI order", async () => {
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_other", order_id: "order_other", amount: 12000, currency: "INR", status: "captured" } } } });
    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/razorpay",
      headers: { "content-type": "application/json", "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_other" },
      payload: body
    });
    expect(response.statusCode).toBe(204);
    expect((app.db.prepare("SELECT count(*) AS count FROM webhook_inbox").get() as { count: number }).count).toBe(0);
  });

  it("persists one raw-verified normalized event for an owned order", async () => {
    const { runId } = createRun(app.db, "RAZORPAY_TEST");
    app.db.prepare(`
      INSERT INTO orders (
        id, runId, actorId, intentId, intentVersion, clientCommandId, requestHash,
        immutableQuoteJson, quoteHash, resourceJson, localState, createState,
        stableReceipt, persistedCreateBody, providerOrderId, createdAtMs
      ) VALUES ('local-order', ?, 'human', 'intent-1', 1, 'command-1', 'hash',
        '{}', 'quote-hash', '{}', 'AWAITING_PAYMENT', 'CREATED',
        'rs_12345678901234567890123456789012', '{}', 'order_owned', ?)
    `).run(runId, Date.now());

    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_owned", order_id: "order_owned", amount: 12000, currency: "INR", status: "captured" } } } });
    const headers = { "content-type": "application/json", "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_owned" };
    const first = await app.inject({ method: "POST", url: "/api/webhooks/razorpay", headers, payload: body });
    const duplicate = await app.inject({ method: "POST", url: "/api/webhooks/razorpay", headers, payload: body });

    expect(first.statusCode).toBe(204);
    expect(duplicate.statusCode).toBe(204);
    const rows = app.db.prepare("SELECT normalizedJson FROM webhook_inbox").all() as Array<{ normalizedJson: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].normalizedJson)).toMatchObject({ event: "payment.captured", localOrderId: "local-order", paymentId: "pay_owned" });
  });

  it("flags reuse of an owned event ID with different content", async () => {
    const { runId } = createRun(app.db, "RAZORPAY_TEST");
    app.db.prepare(`
      INSERT INTO orders (
        id, runId, actorId, intentId, intentVersion, clientCommandId, requestHash,
        immutableQuoteJson, quoteHash, resourceJson, localState, createState,
        stableReceipt, persistedCreateBody, providerOrderId, createdAtMs
      ) VALUES ('local-order', ?, 'human', 'intent-1', 1, 'command-1', 'hash',
        '{}', 'quote-hash', '{}', 'AWAITING_PAYMENT', 'CREATED',
        'rs_12345678901234567890123456789012', '{}', 'order_owned', ?)
    `).run(runId, Date.now());
    const firstBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_owned", order_id: "order_owned", amount: 12000 } } } });
    const changedBody = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_owned", order_id: "order_owned", amount: 13000 } } } });

    await app.inject({ method: "POST", url: "/api/webhooks/razorpay", headers: { "content-type": "application/json", "x-razorpay-signature": sign(firstBody), "x-razorpay-event-id": "evt_same" }, payload: firstBody });
    const conflict = await app.inject({ method: "POST", url: "/api/webhooks/razorpay", headers: { "content-type": "application/json", "x-razorpay-signature": sign(changedBody), "x-razorpay-event-id": "evt_same" }, payload: changedBody });
    expect(conflict.statusCode).toBe(409);
  });
});
