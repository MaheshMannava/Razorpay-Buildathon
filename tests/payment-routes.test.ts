import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import type { CreateOrderBody, PaymentProvider, ProviderOrder, ProviderPayment, ProviderRefund, RefundBody } from "../src/server/payments.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3001,
  appOrigin: "http://localhost:5173",
  databasePath: ":memory:",
  demoAccessCode: "a-strong-demo-code",
  publicDemoEnabled: false,
  allowRazorpayTest: true,
  razorpayKeyId: "rzp_test_fake",
  razorpayKeySecret: "fake-key-secret-long-enough",
  razorpayWebhookSecret: "fake-webhook-secret-long-enough"
};

class RouteProvider implements PaymentProvider {
  payment: ProviderPayment | undefined;
  refunds = 0;
  createBodies: CreateOrderBody[] = [];
  async createOrder(body: CreateOrderBody): Promise<ProviderOrder> {
    this.createBodies.push(body);
    return { id: "order_route_test", entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, status: "created" };
  }
  async fetchPayment(): Promise<ProviderPayment> {
    if (!this.payment) throw new Error("Payment not configured");
    return this.payment;
  }
  async fetchOrderPayments(): Promise<ProviderPayment[]> { return this.payment ? [this.payment] : []; }
  async createRefund(paymentId: string, _key: string, body: RefundBody): Promise<ProviderRefund> {
    this.refunds += 1;
    return { id: "rfnd_route_test", entity: "refund", payment_id: paymentId, amount: body.amount, currency: "INR", status: "processed" };
  }
  async fetchRefund(): Promise<ProviderRefund> { return { id: "rfnd_route_test", entity: "refund", payment_id: "pay_route_test", amount: 12000, currency: "INR", status: "processed" }; }
  async fetchPaymentRefunds(): Promise<ProviderRefund[]> { return []; }
}

describe("Gate A HTTP flow", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("creates, verifies, and fully refunds the bounded test order", async () => {
    const provider = new RouteProvider();
    app = await buildApp(config, { paymentProvider: provider });
    const createdRun = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin }, payload: { accessCode: config.demoAccessCode, mode: "RAZORPAY_TEST" } });
    const runId = createdRun.json().runId as string;
    const rawCookie = createdRun.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";
    const headers = { origin: config.appOrigin, cookie };

    const createdOrder = await app.inject({ method: "POST", url: `/api/runs/${runId}/gate-a-order`, headers, payload: { clientCommandId: randomUUID() } });
    expect(createdOrder.statusCode).toBe(201);
    const orderId = createdOrder.json().currentOrder.id as string;

    const checkout = await app.inject({ method: "POST", url: `/api/orders/${orderId}/checkout`, headers });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toMatchObject({ keyId: config.razorpayKeyId, orderId: "order_route_test", amountPaise: 12000 });
    expect(checkout.json()).not.toHaveProperty("keySecret");

    provider.payment = { id: "pay_route_test", entity: "payment", order_id: "order_route_test", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    const signature = createHmac("sha256", config.razorpayKeySecret!).update("order_route_test|pay_route_test").digest("hex");
    const confirmed = await app.inject({ method: "POST", url: `/api/orders/${orderId}/confirm`, headers, payload: { razorpay_payment_id: "pay_route_test", razorpay_order_id: "order_route_test", razorpay_signature: signature } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().currentOrder).toMatchObject({ localState: "QUEUED", paymentStatus: "captured" });

    const stationDown = await app.inject({ method: "POST", url: `/api/runs/${runId}/station`, headers, payload: { stationId: "tawa", status: "DOWN" } });
    expect(stationDown.statusCode).toBe(200);
    expect(stationDown.json().currentOrder).toMatchObject({ localState: "CANCELLED", refundState: "PROCESSED" });
    expect(provider.refunds).toBe(1);
  });

  it("creates Checkout from an accepted catalog quote in Razorpay mode", async () => {
    const provider = new RouteProvider();
    app = await buildApp(config, { paymentProvider: provider });
    const createdRun = await app.inject({ method: "POST", url: "/api/runs", headers: { origin: config.appOrigin }, payload: { accessCode: config.demoAccessCode, mode: "RAZORPAY_TEST" } });
    const runId = createdRun.json().runId as string;
    const rawCookie = createdRun.headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie)?.split(";")[0] ?? "";
    const headers = { origin: config.appOrigin, cookie };

    const interpreted = await app.inject({ method: "POST", url: `/api/runs/${runId}/request`, headers, payload: { requestId: randomUUID(), text: "Maximum ₹120, within five minutes, plain dosa only." } });
    const draft = interpreted.json().intent.draft as { id: string; version: number };
    const confirmed = await app.inject({
      method: "POST", url: `/api/runs/${runId}/confirm-intent`, headers,
      payload: { intentId: draft.id, intentVersion: draft.version, budgetPaise: 12000, latestReadyAtMs: Date.now() + 300_000, excludedIngredients: [], preferredDishIds: ["plain_dosa"], allowSubstitutes: false }
    });
    const intent = confirmed.json().intent as { confirmed: { id: string; version: number }; quote: { id: string; contentHash: string } };
    const accepted = await app.inject({
      method: "POST", url: `/api/runs/${runId}/accept`, headers,
      payload: { quoteId: intent.quote.id, quoteHash: intent.quote.contentHash, intentId: intent.confirmed.id, intentVersion: intent.confirmed.version, clientCommandId: randomUUID() }
    });

    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().currentOrder).toMatchObject({ dishId: "plain_dosa", amountPaise: 12000, createState: "CREATED", providerOrderIdSuffix: "ute_test" });
    expect(provider.createBodies).toHaveLength(1);
    expect(provider.createBodies[0]).toMatchObject({ amount: 12000, currency: "INR", notes: { rasoi_run_id: runId } });

    const checkout = await app.inject({ method: "POST", url: `/api/orders/${accepted.json().currentOrder.id}/checkout`, headers });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toMatchObject({ orderId: "order_route_test", amountPaise: 12000, description: "Plain dosa · Razorpay test mode" });
  });
});
