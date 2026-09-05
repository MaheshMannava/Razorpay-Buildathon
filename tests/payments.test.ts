import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RasoiDatabase } from "../src/server/db.js";
import { openDatabase } from "../src/server/db.js";
import {
  applyPaymentObservation,
  confirmCheckoutPayment,
  createGateAOrder,
  createStationFailureObligations,
  dispatchRequiredRefunds,
  ProviderRequestError,
  type CreateOrderBody,
  type PaymentProvider,
  type ProviderOrder,
  type ProviderPayment,
  type ProviderRefund,
  type RefundBody
} from "../src/server/payments.js";
import { reconcileDueFinancialWork, recoverInterruptedFinancialWork } from "../src/server/reconciliation.js";
import { createRun } from "../src/server/run-store.js";
import { getRunSnapshot } from "../src/server/run-store.js";
import { acceptQuote, confirmIntent, submitMealRequest } from "../src/server/domain.js";
import { advanceKitchenLifecycle } from "../src/server/mock-lifecycle.js";

class FakeProvider implements PaymentProvider {
  createCalls: CreateOrderBody[] = [];
  refundCalls: Array<{ paymentId: string; key: string; body: RefundBody }> = [];
  payment: ProviderPayment | undefined;
  beforeCreate?: () => void;
  createError?: Error;

  async createOrder(body: CreateOrderBody): Promise<ProviderOrder> {
    this.beforeCreate?.();
    this.createCalls.push(body);
    if (this.createError) throw this.createError;
    return { id: "order_test_owned", entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, status: "created" };
  }
  async fetchPayment(): Promise<ProviderPayment> {
    if (!this.payment) throw new Error("No fake payment configured");
    return this.payment;
  }
  async fetchOrderPayments(): Promise<ProviderPayment[]> { return this.payment ? [this.payment] : []; }
  async createRefund(paymentId: string, key: string, body: RefundBody): Promise<ProviderRefund> {
    this.refundCalls.push({ paymentId, key, body });
    return { id: "rfnd_test_owned", entity: "refund", payment_id: paymentId, amount: body.amount, currency: "INR", status: "processed" };
  }
  async fetchRefund(): Promise<ProviderRefund> { return { id: "rfnd_test_owned", entity: "refund", payment_id: "pay_test_owned", amount: 12000, currency: "INR", status: "processed" }; }
  async fetchPaymentRefunds(): Promise<ProviderRefund[]> { return []; }
}

describe("Gate A payment boundary", () => {
  let db: RasoiDatabase;
  let runId: string;
  beforeEach(() => {
    db = openDatabase(":memory:");
    runId = createRun(db, "RAZORPAY_TEST").runId;
  });
  afterEach(() => db.close());

  it("persists the exact create body and SENT state before calling Razorpay", async () => {
    const provider = new FakeProvider();
    provider.beforeCreate = () => {
      const row = db.prepare("SELECT createState, persistedCreateBody FROM orders WHERE runId = ?").get(runId) as { createState: string; persistedCreateBody: string };
      expect(row.createState).toBe("SENT");
      expect(JSON.parse(row.persistedCreateBody)).toMatchObject({ amount: 12000, currency: "INR" });
    };
    await createGateAOrder(db, provider, runId, randomUUID());
    expect(provider.createCalls).toHaveLength(1);
    expect((db.prepare("SELECT createState FROM orders").get() as { createState: string }).createState).toBe("CREATED");
  });

  it("binds an accepted catalog quote to exactly one matching provider Order", async () => {
    const provider = new FakeProvider();
    const now = Date.now();
    submitMealRequest(db, runId, randomUUID(), "Maximum ₹120, within five minutes, plain dosa only.", now);
    const draft = getRunSnapshot(db, runId, true)!.intent!.draft;
    confirmIntent(db, runId, {
      id: draft.id, version: draft.version, budgetPaise: 12000, latestReadyAtMs: now + 300_000,
      excludedIngredients: [], preferredDishIds: ["plain_dosa"], allowSubstitutes: false
    }, now + 10);
    const intent = getRunSnapshot(db, runId, true)!.intent!;
    const orderId = acceptQuote(db, runId, {
      quoteId: intent.quote!.id, quoteHash: intent.quote!.contentHash, intentId: intent.confirmed!.id,
      intentVersion: intent.confirmed!.version, clientCommandId: randomUUID()
    }, now + 20);
    const persisted = db.prepare("SELECT createState, persistedCreateBody, resourceJson FROM orders WHERE id = ?").get(orderId) as { createState: string; persistedCreateBody: string; resourceJson: string };
    expect(persisted.createState).toBe("SENT");
    expect(JSON.parse(persisted.persistedCreateBody)).toMatchObject({ amount: 12000, currency: "INR", notes: { rasoi_order_id: orderId, rasoi_run_id: runId } });
    expect(JSON.parse(persisted.resourceJson).slotStartMs).toBeGreaterThanOrEqual(now + 90_020);

    await reconcileDueFinancialWork(db, provider, now + 20);
    await reconcileDueFinancialWork(db, provider, now + 20);

    expect(provider.createCalls).toHaveLength(1);
    expect(db.prepare("SELECT createState, providerOrderId FROM orders WHERE id = ?").get(orderId))
      .toMatchObject({ createState: "CREATED", providerOrderId: "order_test_owned" });

    applyPaymentObservation(db, orderId, {
      id: "pay_catalog", entity: "payment", order_id: "order_test_owned", amount: 12000,
      currency: "INR", status: "captured", amount_refunded: 0
    });
    const slotStartMs = JSON.parse(persisted.resourceJson).slotStartMs as number;
    advanceKitchenLifecycle(db, slotStartMs);
    expect(db.prepare("SELECT localState FROM orders WHERE id = ?").get(orderId)).toMatchObject({ localState: "COOKING" });
  });

  it("never blindly recreates an order after an ambiguous create result", async () => {
    const provider = new FakeProvider();
    provider.createError = new ProviderRequestError("timeout", true);
    await expect(createGateAOrder(db, provider, runId, randomUUID())).rejects.toMatchObject({ code: "ORDER_CREATE_UNKNOWN" });
    await createGateAOrder(db, provider, runId, randomUUID());
    expect(provider.createCalls).toHaveLength(1);
    expect((db.prepare("SELECT createState FROM orders").get() as { createState: string }).createState).toBe("UNKNOWN");
  });

  it("recovers interrupted creates and refunds conservatively on restart", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    applyPaymentObservation(db, order!.id, {
      id: "pay_restart", entity: "payment", order_id: "order_test_owned", amount: 12000,
      currency: "INR", status: "captured", amount_refunded: 0
    });
    createStationFailureObligations(db, runId, "tawa");
    db.prepare("UPDATE orders SET createState = 'SENT', providerOrderId = NULL, providerCreateClaimedAtMs = 1 WHERE id = ?").run(order!.id);
    db.prepare("UPDATE refunds SET state = 'SENT', nextCheckAtMs = NULL").run();

    recoverInterruptedFinancialWork(db, 5_000);

    expect(db.prepare("SELECT createState FROM orders WHERE id = ?").get(order!.id)).toMatchObject({ createState: "UNKNOWN" });
    expect(db.prepare("SELECT state, nextCheckAtMs FROM refunds").get()).toMatchObject({ state: "UNKNOWN", nextCheckAtMs: 5_000 });
    expect((db.prepare("SELECT count(*) AS count FROM events WHERE type IN ('ORDER_CREATE_UNKNOWN', 'REFUND_UNKNOWN')").get() as { count: number }).count).toBe(2);
  });

  it("requires a valid signature and a captured matching provider payment", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    const secret = "test-key-secret-long-enough";
    provider.payment = { id: "pay_test_owned", entity: "payment", order_id: "order_test_owned", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    const signature = createHmac("sha256", secret).update("order_test_owned|pay_test_owned").digest("hex");
    await confirmCheckoutPayment(db, provider, order!.id, { razorpay_payment_id: "pay_test_owned", razorpay_order_id: "order_test_owned", razorpay_signature: signature }, secret);
    expect((db.prepare("SELECT localState FROM orders").get() as { localState: string }).localState).toBe("QUEUED");
    await expect(confirmCheckoutPayment(db, provider, order!.id, { razorpay_payment_id: "pay_test_owned", razorpay_order_id: "order_test_owned", razorpay_signature: "0".repeat(64) }, secret)).rejects.toMatchObject({ code: "PAYMENT_REVIEW" });
  });

  it("creates one full refund with a stable key and immutable body after station failure", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    const payment: ProviderPayment = { id: "pay_test_owned", entity: "payment", order_id: "order_test_owned", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    applyPaymentObservation(db, order!.id, payment);
    createStationFailureObligations(db, runId, "tawa");
    createStationFailureObligations(db, runId, "tawa");
    await dispatchRequiredRefunds(db, provider, runId);
    await dispatchRequiredRefunds(db, provider, runId);
    expect(provider.refundCalls).toHaveLength(1);
    expect(provider.refundCalls[0]).toMatchObject({ paymentId: "pay_test_owned", body: { amount: 12000, speed: "normal", notes: { reason: "station_failure" } } });
    expect((db.prepare("SELECT count(*) AS count FROM refunds").get() as { count: number }).count).toBe(1);
  });

  it("turns a capture observed after cancellation into one full refund", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    createStationFailureObligations(db, runId, "tawa");
    expect(db.prepare("SELECT localState FROM orders WHERE id = ?").get(order!.id)).toMatchObject({ localState: "CANCELLED" });
    expect(db.prepare("SELECT count(*) AS count FROM refunds").get()).toMatchObject({ count: 0 });

    applyPaymentObservation(db, order!.id, {
      id: "pay_late", entity: "payment", order_id: "order_test_owned", amount: 12000,
      currency: "INR", status: "captured", amount_refunded: 0
    });
    await dispatchRequiredRefunds(db, provider, runId);

    expect(db.prepare("SELECT paymentId, amountPaise, state FROM refunds").get())
      .toMatchObject({ paymentId: "pay_late", amountPaise: 12000, state: "PROCESSED" });
    expect(provider.refundCalls).toHaveLength(1);
    expect((db.prepare("SELECT count(*) AS count FROM events WHERE type = 'LATE_CAPTURE_REFUND_REQUIRED'").get() as { count: number }).count).toBe(1);
  });

  it("reconciles a provider-side full refund before attempting another mutation", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    const payment: ProviderPayment = { id: "pay_test_owned", entity: "payment", order_id: "order_test_owned", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    applyPaymentObservation(db, order!.id, payment);
    createStationFailureObligations(db, runId, "tawa");
    provider.fetchPaymentRefunds = async () => [{ id: "rfnd_external", entity: "refund", payment_id: payment.id, amount: 12000, currency: "INR", status: "processed", notes: { rasoi_order_id: order!.id } }];
    await dispatchRequiredRefunds(db, provider, runId);
    expect(provider.refundCalls).toHaveLength(0);
    expect(db.prepare("SELECT providerRefundId, state FROM refunds").get()).toMatchObject({ providerRefundId: "rfnd_external", state: "PROCESSED" });
  });

  it("discovers a captured payment from persisted startup reconciliation work", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    provider.payment = { id: "pay_background", entity: "payment", order_id: "order_test_owned", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    db.prepare("UPDATE orders SET nextPaymentCheckAtMs = 1 WHERE id = ?").run(order!.id);

    await reconcileDueFinancialWork(db, provider, 2_000);

    expect(db.prepare("SELECT localState, nextPaymentCheckAtMs FROM orders WHERE id = ?").get(order!.id))
      .toMatchObject({ localState: "QUEUED", nextPaymentCheckAtMs: null });
  });

  it("caps uncertain refund mutations at five while preserving the key and body", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    const payment: ProviderPayment = { id: "pay_retry", entity: "payment", order_id: "order_test_owned", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    applyPaymentObservation(db, order!.id, payment);
    createStationFailureObligations(db, runId, "tawa");
    provider.createRefund = async (paymentId, key, body) => {
      provider.refundCalls.push({ paymentId, key, body });
      throw new ProviderRequestError("timeout", true);
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      db.prepare("UPDATE refunds SET nextCheckAtMs = 1").run();
      await dispatchRequiredRefunds(db, provider, runId, 2_000 + attempt);
    }

    expect(provider.refundCalls).toHaveLength(5);
    expect(new Set(provider.refundCalls.map((call) => call.key)).size).toBe(1);
    expect(new Set(provider.refundCalls.map((call) => JSON.stringify(call.body))).size).toBe(1);
    expect(db.prepare("SELECT state, attempts, nextCheckAtMs FROM refunds").get())
      .toMatchObject({ state: "REVIEW", attempts: 5, nextCheckAtMs: null });
  });

  it("continues read-only reconciliation for a known pending refund", async () => {
    const provider = new FakeProvider();
    const order = await createGateAOrder(db, provider, runId, randomUUID());
    const payment: ProviderPayment = { id: "pay_pending", entity: "payment", order_id: "order_test_owned", amount: 12000, currency: "INR", status: "captured", amount_refunded: 0 };
    applyPaymentObservation(db, order!.id, payment);
    createStationFailureObligations(db, runId, "tawa");
    const now = Date.now();
    provider.createRefund = async (paymentId, key, body) => {
      provider.refundCalls.push({ paymentId, key, body });
      return { id: "rfnd_pending", entity: "refund", payment_id: paymentId, amount: body.amount, currency: "INR", status: "pending" };
    };
    await dispatchRequiredRefunds(db, provider, runId, now);
    db.prepare("UPDATE refunds SET nextCheckAtMs = 1").run();
    provider.fetchPaymentRefunds = async () => [{ id: "rfnd_pending", entity: "refund", payment_id: payment.id, amount: 12000, currency: "INR", status: "processed" }];

    await reconcileDueFinancialWork(db, provider, now + 1);

    expect(db.prepare("SELECT state FROM refunds").get()).toMatchObject({ state: "PROCESSED" });
    expect(provider.refundCalls).toHaveLength(1);
  });
});
