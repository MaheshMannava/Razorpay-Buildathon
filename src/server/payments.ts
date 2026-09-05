import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { RasoiDatabase } from "./db.js";

export type CreateOrderBody = {
  amount: number;
  currency: "INR";
  receipt: string;
  notes: { rasoi_order_id: string; rasoi_run_id: string };
};

export type RefundBody = {
  amount: number;
  speed: "normal";
  notes: { rasoi_order_id: string; reason: "station_failure" };
};

const providerOrderSchema = z.object({
  id: z.string(),
  entity: z.literal("order"),
  amount: z.number().int().positive(),
  currency: z.literal("INR"),
  receipt: z.string(),
  status: z.string()
}).passthrough();

const providerPaymentSchema = z.object({
  id: z.string(),
  entity: z.literal("payment"),
  amount: z.number().int().positive(),
  currency: z.literal("INR"),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  order_id: z.string(),
  amount_refunded: z.number().int().nonnegative().default(0)
}).passthrough();

const providerPaymentsSchema = z.object({ items: z.array(providerPaymentSchema) }).passthrough();

const providerRefundSchema = z.object({
  id: z.string(),
  entity: z.literal("refund"),
  payment_id: z.string(),
  amount: z.number().int().positive(),
  currency: z.literal("INR"),
  status: z.enum(["pending", "processed", "failed"]),
  receipt: z.string().nullable().optional(),
  notes: z.record(z.string(), z.string()).optional()
}).passthrough();

const providerRefundsSchema = z.object({ items: z.array(providerRefundSchema) }).passthrough();

export type ProviderOrder = z.infer<typeof providerOrderSchema>;
export type ProviderPayment = z.infer<typeof providerPaymentSchema>;
export type ProviderRefund = z.infer<typeof providerRefundSchema>;

const RECHECK_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;

function recheckDelay(attempts: number): number {
  return RECHECK_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RECHECK_DELAYS_MS.length - 1)]!;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    readonly statusCode?: number,
    readonly providerCode?: string,
    readonly providerDescription?: string,
    readonly providerDetails?: Record<string, unknown>
  ) {
    super(message);
  }
}

export interface PaymentProvider {
  createOrder(body: CreateOrderBody): Promise<ProviderOrder>;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  fetchOrderPayments(orderId: string): Promise<ProviderPayment[]>;
  createRefund(paymentId: string, idempotencyKey: string, body: RefundBody): Promise<ProviderRefund>;
  fetchRefund(refundId: string): Promise<ProviderRefund>;
  fetchPaymentRefunds(paymentId: string): Promise<ProviderRefund[]>;
}

export class RazorpayProvider implements PaymentProvider {
  private readonly authorization: string;

  constructor(keyId: string, keySecret: string) {
    if (!keyId.startsWith("rzp_test_")) throw new Error("Only Razorpay test keys are accepted.");
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`https://api.razorpay.com${path}`, {
        ...init,
        signal: AbortSignal.timeout(8_000),
        headers: {
          authorization: this.authorization,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers
        }
      });
    } catch {
      throw new ProviderRequestError("Razorpay did not return a definite response.", true);
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const ambiguous = response.status >= 500 || response.status === 409;
      const details = z.object({ error: z.object({ code: z.string().optional(), description: z.string().optional() }).passthrough() }).safeParse(body);
      throw new ProviderRequestError(
        "Razorpay rejected or could not complete the request.",
        ambiguous,
        response.status,
        details.success ? details.data.error.code : undefined,
        details.success ? details.data.error.description : undefined,
        details.success ? details.data.error : undefined
      );
    }
    return body;
  }

  async createOrder(body: CreateOrderBody): Promise<ProviderOrder> {
    return providerOrderSchema.parse(await this.request("/v1/orders", { method: "POST", body: JSON.stringify(body) }));
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    return providerPaymentSchema.parse(await this.request(`/v1/payments/${encodeURIComponent(paymentId)}`));
  }

  async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const result = providerPaymentsSchema.parse(await this.request(`/v1/orders/${encodeURIComponent(orderId)}/payments`));
    return result.items;
  }

  async createRefund(paymentId: string, idempotencyKey: string, body: RefundBody): Promise<ProviderRefund> {
    return providerRefundSchema.parse(await this.request(`/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: { "X-Refund-Idempotency": idempotencyKey },
      body: JSON.stringify(body)
    }));
  }

  async fetchRefund(refundId: string): Promise<ProviderRefund> {
    return providerRefundSchema.parse(await this.request(`/v1/refunds/${encodeURIComponent(refundId)}`));
  }

  async fetchPaymentRefunds(paymentId: string): Promise<ProviderRefund[]> {
    const result = providerRefundsSchema.parse(await this.request(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`));
    return result.items;
  }
}

export function createPaymentProvider(config: AppConfig): PaymentProvider | null {
  if (!config.allowRazorpayTest || !config.razorpayKeyId || !config.razorpayKeySecret) return null;
  return new RazorpayProvider(config.razorpayKeyId, config.razorpayKeySecret);
}

type OrderRow = {
  id: string;
  runId: string;
  localState: string;
  createState: string;
  persistedCreateBody: string;
  providerOrderId: string | null;
  checkoutIssuedAtMs: number | null;
  providerCreateClaimedAtMs: number | null;
  resourceJson: string;
};

function appendEvent(db: RasoiDatabase, runId: string, orderId: string, type: string, reason: string, details: Record<string, unknown>, now = Date.now()) {
  db.prepare(`
    INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, orderId, type, now, JSON.stringify(details), reason);
}

function getOrder(db: RasoiDatabase, orderId: string): OrderRow | undefined {
  return db.prepare(`
    SELECT id, runId, localState, createState, persistedCreateBody,
           providerOrderId, checkoutIssuedAtMs, providerCreateClaimedAtMs, resourceJson
    FROM orders WHERE id = ?
  `).get(orderId) as OrderRow | undefined;
}

export async function createGateAOrder(db: RasoiDatabase, provider: PaymentProvider, runId: string, clientCommandId: string) {
  const run = db.prepare("SELECT mode FROM runs WHERE id = ?").get(runId) as { mode: string } | undefined;
  if (!run || run.mode !== "RAZORPAY_TEST") throw new PaymentFlowError("MODE_MISMATCH", "Gate A requires a Razorpay test run.", 409);

  const existing = db.prepare("SELECT id FROM orders WHERE runId = ? AND intentId = 'gate-a-smoke' AND intentVersion = 1").get(runId) as { id: string } | undefined;
  if (existing) return getOrder(db, existing.id);

  const orderId = randomUUID();
  const receipt = `rs_${randomUUID().replaceAll("-", "")}`;
  const createBody: CreateOrderBody = {
    amount: 12000,
    currency: "INR",
    receipt,
    notes: { rasoi_order_id: orderId, rasoi_run_id: runId }
  };
  const resource = { dishId: "plain_dosa", dishName: "Plain dosa", stationId: "tawa", amountPaise: 12000, currency: "INR" };
  const now = Date.now();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (
        id, runId, actorId, intentId, intentVersion, clientCommandId, requestHash,
        immutableQuoteJson, quoteHash, resourceJson, localState, createState,
        stableReceipt, persistedCreateBody, providerOrderId, checkoutIssuedAtMs,
        refundRequiredReason, createdAtMs
      ) VALUES (?, ?, 'human', 'gate-a-smoke', 1, ?, 'gate-a-fixed-v1',
        ?, 'gate-a-fixed-v1', ?, 'AWAITING_PAYMENT', 'SENT', ?, ?, NULL, NULL, NULL, ?)
    `).run(orderId, runId, clientCommandId, JSON.stringify(resource), JSON.stringify(resource), receipt, JSON.stringify(createBody), now);
    appendEvent(db, runId, orderId, "ORDER_CREATE_SENT", "A fixed ₹120 test order was persisted before contacting Razorpay.", { amountPaise: 12000, receipt }, now);
  })();

  try {
    const created = await provider.createOrder(createBody);
    if (created.amount !== createBody.amount || created.currency !== createBody.currency || created.receipt !== createBody.receipt) {
      throw new ProviderRequestError("Razorpay returned an order that does not match the persisted request.", true);
    }
    db.transaction(() => {
      db.prepare("UPDATE orders SET createState = 'CREATED', providerOrderId = ?, nextPaymentCheckAtMs = ? WHERE id = ?")
        .run(created.id, Date.now() + RECHECK_DELAYS_MS[0], orderId);
      appendEvent(db, runId, orderId, "ORDER_CREATED", "Razorpay returned the matching test Order.", { providerOrderId: created.id }, Date.now());
    })();
  } catch (error) {
    const ambiguous = error instanceof ProviderRequestError ? error.ambiguous : true;
    db.transaction(() => {
      db.prepare("UPDATE orders SET createState = ? WHERE id = ?").run(ambiguous ? "UNKNOWN" : "REJECTED", orderId);
      appendEvent(
        db,
        runId,
        orderId,
        ambiguous ? "ORDER_CREATE_UNKNOWN" : "ORDER_CREATE_REJECTED",
        ambiguous ? "The create result is unknown; checkout is blocked and the Order will not be recreated." : "Razorpay rejected the test Order.",
        {},
        Date.now()
      );
    })();
    throw new PaymentFlowError(ambiguous ? "ORDER_CREATE_UNKNOWN" : "ORDER_CREATE_REJECTED", ambiguous ? "The Razorpay Order result is unknown. Do not create another Order." : "Razorpay rejected the test Order.", 502);
  }

  return getOrder(db, orderId);
}

export async function createPersistedProviderOrder(db: RasoiDatabase, provider: PaymentProvider, orderId: string) {
  const order = getOrder(db, orderId);
  if (!order) throw new PaymentFlowError("ORDER_NOT_FOUND", "This order does not exist.", 404);
  if (order.createState === "CREATED") return order;
  if (order.createState === "UNKNOWN") throw new PaymentFlowError("ORDER_CREATE_UNKNOWN", "The Razorpay Order result is unknown. Do not create another Order.", 502);
  if (order.createState === "REJECTED") throw new PaymentFlowError("ORDER_CREATE_REJECTED", "Razorpay rejected the test Order.", 502);
  if (order.createState !== "SENT") throw new PaymentFlowError("MODE_MISMATCH", "This order does not require Razorpay creation.", 409);
  const claimedAt = Date.now();
  const claimed = db.prepare("UPDATE orders SET providerCreateClaimedAtMs = ? WHERE id = ? AND createState = 'SENT' AND providerCreateClaimedAtMs IS NULL")
    .run(claimedAt, order.id);
  if (claimed.changes !== 1) throw new PaymentFlowError("PAYMENT_PENDING", "This exact Razorpay Order request is already being created. Check status instead of retrying.", 409);
  const body = JSON.parse(order.persistedCreateBody) as CreateOrderBody;
  try {
    const created = await provider.createOrder(body);
    if (created.amount !== body.amount || created.currency !== body.currency || created.receipt !== body.receipt) {
      throw new ProviderRequestError("Razorpay returned an order that does not match the persisted request.", true);
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare("UPDATE orders SET createState = 'CREATED', providerOrderId = ?, nextPaymentCheckAtMs = ? WHERE id = ? AND createState = 'SENT'")
        .run(created.id, now + RECHECK_DELAYS_MS[0], order.id);
      appendEvent(db, order.runId, order.id, "ORDER_CREATED", "Razorpay returned the Order matching the accepted immutable quote.", { providerOrderId: created.id }, now);
    })();
  } catch (error) {
    const ambiguous = error instanceof ProviderRequestError ? error.ambiguous : true;
    db.transaction(() => {
      db.prepare("UPDATE orders SET createState = ? WHERE id = ? AND createState = 'SENT'").run(ambiguous ? "UNKNOWN" : "REJECTED", order.id);
      appendEvent(db, order.runId, order.id, ambiguous ? "ORDER_CREATE_UNKNOWN" : "ORDER_CREATE_REJECTED",
        ambiguous ? "The create result is unknown; checkout is blocked and the Order will not be recreated." : "Razorpay rejected the accepted test Order.", {}, Date.now());
    })();
    throw new PaymentFlowError(ambiguous ? "ORDER_CREATE_UNKNOWN" : "ORDER_CREATE_REJECTED", ambiguous ? "The Razorpay Order result is unknown. Do not create another Order." : "Razorpay rejected the test Order.", 502);
  }
  return getOrder(db, order.id);
}

export function issueCheckoutConfig(db: RasoiDatabase, orderId: string, keyId: string) {
  const order = getOrder(db, orderId);
  if (!order || order.createState !== "CREATED" || !order.providerOrderId) {
    throw new PaymentFlowError("PAYMENT_REVIEW", "Checkout is unavailable until the Razorpay Order is verified.", 409);
  }
  if (order.checkoutIssuedAtMs) {
    throw new PaymentFlowError("PAYMENT_PENDING", "Checkout was already opened. Do not pay again; check status.", 409);
  }
  const body = JSON.parse(order.persistedCreateBody) as CreateOrderBody;
  const resource = JSON.parse(order.resourceJson) as { dishName?: string };
  db.transaction(() => {
    db.prepare("UPDATE orders SET checkoutIssuedAtMs = ? WHERE id = ?").run(Date.now(), orderId);
    appendEvent(db, order.runId, orderId, "CHECKOUT_ISSUED", "Hosted Checkout was issued once for this test Order.", {}, Date.now());
  })();
  return { keyId, orderId: order.providerOrderId, localOrderId: order.id, amountPaise: body.amount, currency: body.currency, name: "RASOI" as const, description: `${resource.dishName ?? "Meal"} · Razorpay test mode` };
}

export function verifyCheckoutSignature(providerOrderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac("sha256", keySecret).update(`${providerOrderId}|${paymentId}`).digest("hex"), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function ensureRefundObligation(db: RasoiDatabase, order: OrderRow, payment: ProviderPayment, reason: "station_failure") {
  const body: RefundBody = { amount: payment.amount, speed: "normal", notes: { rasoi_order_id: order.id, reason } };
  const stableKey = randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO refunds (
      id, orderId, paymentId, amountPaise, reason, stableKey, immutableBody,
      providerRefundId, state, attempts, nextCheckAtMs, createdAtMs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'REQUIRED', 0, ?, ?)
  `).run(randomUUID(), order.id, payment.id, payment.amount, reason, stableKey, JSON.stringify(body), Date.now(), Date.now());
}

export function applyPaymentObservation(db: RasoiDatabase, orderId: string, payment: ProviderPayment) {
  const order = getOrder(db, orderId);
  if (!order || !order.providerOrderId) throw new PaymentFlowError("PAYMENT_REVIEW", "The local order cannot be matched to Razorpay.", 409);
  const body = JSON.parse(order.persistedCreateBody) as CreateOrderBody;
  if (payment.order_id !== order.providerOrderId || payment.amount !== body.amount || payment.currency !== body.currency) {
    throw new PaymentFlowError("PAYMENT_REVIEW", "Razorpay payment details do not match this order.", 409);
  }

  const previous = db.prepare("SELECT status FROM payments WHERE providerPaymentId = ?").get(payment.id) as { status: string } | undefined;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (providerPaymentId, orderId, providerOrderId, amountPaise, currency, status, amountRefundedPaise, lastObservedAtMs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(providerPaymentId) DO UPDATE SET
        status = CASE WHEN payments.status = 'captured' THEN payments.status ELSE excluded.status END,
        amountRefundedPaise = MAX(payments.amountRefundedPaise, excluded.amountRefundedPaise),
        lastObservedAtMs = excluded.lastObservedAtMs
    `).run(payment.id, order.id, payment.order_id, payment.amount, payment.currency, payment.status, payment.amount_refunded, Date.now());

    if (payment.status === "captured" && previous?.status !== "captured") {
      if (order.localState === "CANCELLED") {
        ensureRefundObligation(db, order, payment, "station_failure");
        appendEvent(db, order.runId, order.id, "LATE_CAPTURE_REFUND_REQUIRED", "A capture arrived after cancellation; a full refund is required.", { providerPaymentId: payment.id });
      } else {
        db.prepare("UPDATE orders SET localState = 'QUEUED' WHERE id = ? AND localState = 'AWAITING_PAYMENT'").run(order.id);
        appendEvent(db, order.runId, order.id, "PAYMENT_CAPTURED", "Razorpay verified the matching captured test payment.", { providerPaymentId: payment.id });
      }
    } else if (payment.status === "authorized" && !previous) {
      appendEvent(db, order.runId, order.id, "PAYMENT_AUTHORIZED", "Payment is authorized but not captured; cooking remains blocked.", { providerPaymentId: payment.id });
    } else if (payment.status === "failed" && !previous) {
      appendEvent(db, order.runId, order.id, "PAYMENT_FAILED", "This payment attempt failed; no fulfillment was started.", { providerPaymentId: payment.id });
    }
  })();
}

export async function confirmCheckoutPayment(db: RasoiDatabase, provider: PaymentProvider, orderId: string, response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }, keySecret: string) {
  const order = getOrder(db, orderId);
  if (!order?.providerOrderId || response.razorpay_order_id !== order.providerOrderId || !verifyCheckoutSignature(order.providerOrderId, response.razorpay_payment_id, response.razorpay_signature, keySecret)) {
    throw new PaymentFlowError("PAYMENT_REVIEW", "Checkout signature verification failed.", 400);
  }
  const payment = await provider.fetchPayment(response.razorpay_payment_id);
  applyPaymentObservation(db, orderId, payment);
  if (payment.status !== "captured") throw new PaymentFlowError("PAYMENT_PENDING", "Payment is not captured yet. Do not pay again; check status.", 409);
}

export async function checkOrderStatus(db: RasoiDatabase, provider: PaymentProvider, orderId: string, now = Date.now()) {
  const order = getOrder(db, orderId);
  if (!order?.providerOrderId) throw new PaymentFlowError("PAYMENT_REVIEW", "No verified Razorpay Order is attached.", 409);
  const payments = await provider.fetchOrderPayments(order.providerOrderId);
  for (const payment of payments) applyPaymentObservation(db, orderId, payment);

  const storedPayments = db.prepare("SELECT providerPaymentId FROM payments WHERE orderId = ?").all(orderId) as Array<{ providerPaymentId: string }>;
  for (const payment of storedPayments) {
    const observedRefunds = await provider.fetchPaymentRefunds(payment.providerPaymentId);
    applyRefundObservations(db, orderId, payment.providerPaymentId, observedRefunds);
  }

  const refunds = db.prepare("SELECT id, providerRefundId FROM refunds WHERE orderId = ? AND providerRefundId IS NOT NULL").all(orderId) as Array<{ id: string; providerRefundId: string }>;
  for (const row of refunds) {
    const refund = await provider.fetchRefund(row.providerRefundId);
    const state = refund.status === "processed" ? "PROCESSED" : refund.status === "pending" ? "PENDING" : "REVIEW";
    db.prepare("UPDATE refunds SET state = ?, nextCheckAtMs = ? WHERE id = ?").run(state, state === "PENDING" ? now + 60_000 : null, row.id);
  }

  const terminalPayment = payments.some((payment) => ["captured", "refunded"].includes(payment.status));
  const attempts = db.prepare("SELECT paymentCheckAttempts FROM orders WHERE id = ?").get(orderId) as { paymentCheckAttempts: number };
  const nextAttempts = attempts.paymentCheckAttempts + 1;
  db.prepare("UPDATE orders SET paymentCheckAttempts = ?, nextPaymentCheckAtMs = ? WHERE id = ?")
    .run(nextAttempts, terminalPayment ? null : now + recheckDelay(nextAttempts), orderId);
}

export function deferOrderStatusCheck(db: RasoiDatabase, orderId: string, now = Date.now()): void {
  const row = db.prepare("SELECT paymentCheckAttempts FROM orders WHERE id = ?").get(orderId) as { paymentCheckAttempts: number } | undefined;
  if (!row) return;
  const attempts = row.paymentCheckAttempts + 1;
  db.prepare("UPDATE orders SET paymentCheckAttempts = ?, nextPaymentCheckAtMs = ? WHERE id = ?")
    .run(attempts, now + recheckDelay(attempts), orderId);
}

function refundState(status: ProviderRefund["status"]): "PENDING" | "PROCESSED" | "REVIEW" {
  return status === "processed" ? "PROCESSED" : status === "pending" ? "PENDING" : "REVIEW";
}

export function applyRefundObservations(db: RasoiDatabase, orderId: string, paymentId: string, refunds: ProviderRefund[]) {
  const payment = db.prepare("SELECT amountPaise FROM payments WHERE providerPaymentId = ? AND orderId = ?").get(paymentId, orderId) as { amountPaise: number } | undefined;
  if (!payment) throw new PaymentFlowError("PAYMENT_REVIEW", "The refund cannot be matched to a stored payment.", 409);

  const owned = refunds.filter((refund) => refund.payment_id === paymentId && refund.currency === "INR");
  const total = owned.reduce((sum, refund) => sum + refund.amount, 0);
  if (total > payment.amountPaise) throw new PaymentFlowError("PAYMENT_REVIEW", "Razorpay reports refunds above the captured amount.", 409);

  const obligation = db.prepare(`
    SELECT id, providerRefundId, amountPaise, state
    FROM refunds WHERE orderId = ? AND paymentId = ?
  `).get(orderId, paymentId) as { id: string; providerRefundId: string | null; amountPaise: number; state: string } | undefined;
  if (!obligation) return;

  const observed = obligation.providerRefundId
    ? owned.find((refund) => refund.id === obligation.providerRefundId)
    : owned.find((refund) => refund.amount === obligation.amountPaise && refund.notes?.rasoi_order_id === orderId)
      ?? (owned.length === 1 && owned[0]?.amount === obligation.amountPaise ? owned[0] : undefined);
  if (!observed) return;

  const state = refundState(observed.status);
  db.transaction(() => {
    db.prepare("UPDATE refunds SET providerRefundId = ?, state = ?, nextCheckAtMs = ? WHERE id = ?")
      .run(observed.id, state, state === "PENDING" ? Date.now() + 60_000 : null, obligation.id);
    db.prepare("UPDATE payments SET amountRefundedPaise = MAX(amountRefundedPaise, ?), status = CASE WHEN ? >= amountPaise THEN 'refunded' ELSE status END, lastObservedAtMs = ? WHERE providerPaymentId = ?")
      .run(total, total, Date.now(), paymentId);
    if (obligation.providerRefundId !== observed.id || obligation.state !== state) {
      const order = getOrder(db, orderId);
      if (order) appendEvent(
        db,
        order.runId,
        orderId,
        state === "PROCESSED" ? "REFUND_PROCESSED" : "REFUND_RECONCILED",
        state === "PROCESSED" ? "Razorpay reports this test refund as processed." : "RASOI reconciled the provider-side refund.",
        { providerRefundId: observed.id }
      );
    }
  })();
}

export function createStationFailureObligations(db: RasoiDatabase, runId: string, stationId: string) {
  const rows = db.prepare(`
    SELECT id, runId, localState, createState, persistedCreateBody,
           providerOrderId, checkoutIssuedAtMs, resourceJson
    FROM orders WHERE runId = ? AND localState IN ('AWAITING_PAYMENT', 'QUEUED', 'COOKING')
  `).all(runId) as OrderRow[];

  db.transaction(() => {
    for (const order of rows) {
      const resource = JSON.parse(order.resourceJson) as { stationId?: string };
      if (resource.stationId !== stationId) continue;
      db.prepare("UPDATE orders SET localState = 'CANCELLED', refundRequiredReason = 'station_failure' WHERE id = ?").run(order.id);
      const payments = db.prepare("SELECT * FROM payments WHERE orderId = ? AND status = 'captured'").all(order.id) as Array<{ providerPaymentId: string; amountPaise: number; currency: "INR"; status: "captured"; providerOrderId: string; amountRefundedPaise: number }>;
      for (const payment of payments) {
        ensureRefundObligation(db, order, {
          id: payment.providerPaymentId,
          entity: "payment",
          order_id: payment.providerOrderId,
          amount: payment.amountPaise,
          currency: payment.currency,
          status: payment.status,
          amount_refunded: payment.amountRefundedPaise
        }, "station_failure");
      }
      appendEvent(db, runId, order.id, payments.length ? "ORDER_CANCELLED_REFUND_REQUIRED" : "ORDER_CANCELLED_PAYMENT_MONITORED", payments.length ? "The station failed after capture; the meal was cancelled and a full refund is required." : "The station failed before capture; fulfillment was cancelled and any later capture will be refunded.", { stationId });
    }
  })();
}

export async function dispatchRequiredRefunds(db: RasoiDatabase, provider: PaymentProvider, runId: string, now = Date.now()) {
  const rows = db.prepare(`
    SELECT refunds.id, refunds.orderId, refunds.paymentId, refunds.stableKey,
           refunds.immutableBody, orders.runId
    FROM refunds JOIN orders ON orders.id = refunds.orderId
    JOIN runs ON runs.id = orders.runId
    WHERE orders.runId = ? AND runs.mode = 'RAZORPAY_TEST' AND refunds.state IN ('REQUIRED', 'UNKNOWN')
      AND (refunds.nextCheckAtMs IS NULL OR refunds.nextCheckAtMs <= ?)
      AND refunds.attempts < 5
  `).all(runId, now) as Array<{ id: string; orderId: string; paymentId: string; stableKey: string; immutableBody: string; runId: string }>;

  for (const row of rows) {
    const claimed = db.prepare("UPDATE refunds SET state = 'SENT', attempts = attempts + 1 WHERE id = ? AND state IN ('REQUIRED', 'UNKNOWN')").run(row.id);
    if (claimed.changes !== 1) continue;
    const body = JSON.parse(row.immutableBody) as RefundBody;
    try {
      const existing = await provider.fetchPaymentRefunds(row.paymentId);
      applyRefundObservations(db, row.orderId, row.paymentId, existing);
      const reconciled = db.prepare("SELECT state FROM refunds WHERE id = ?").get(row.id) as { state: string };
      if (["PENDING", "PROCESSED"].includes(reconciled.state)) continue;
      const refund = await provider.createRefund(row.paymentId, row.stableKey, body);
      if (refund.payment_id !== row.paymentId || refund.amount !== body.amount || refund.currency !== "INR") {
        throw new ProviderRequestError("Refund response did not match the obligation.", true);
      }
      const state = refund.status === "processed" ? "PROCESSED" : refund.status === "pending" ? "PENDING" : "REVIEW";
      db.transaction(() => {
        db.prepare("UPDATE refunds SET providerRefundId = ?, state = ?, nextCheckAtMs = ? WHERE id = ?").run(refund.id, state, state === "PENDING" ? now + RECHECK_DELAYS_MS[0] : null, row.id);
        appendEvent(db, row.runId, row.orderId, state === "PROCESSED" ? "REFUND_PROCESSED" : "REFUND_REQUESTED", state === "PROCESSED" ? "Razorpay reports this test refund as processed." : "A full test refund was requested; provider completion is still pending.", { providerRefundId: refund.id });
      })();
    } catch (error) {
      const ambiguous = error instanceof ProviderRequestError ? error.ambiguous : true;
      const attempt = db.prepare("SELECT attempts FROM refunds WHERE id = ?").get(row.id) as { attempts: number };
      const exhausted = ambiguous && attempt.attempts >= 5;
      db.prepare("UPDATE refunds SET state = ?, nextCheckAtMs = ? WHERE id = ?")
        .run(ambiguous && !exhausted ? "UNKNOWN" : "REVIEW", ambiguous && !exhausted ? now + recheckDelay(attempt.attempts) : null, row.id);
      appendEvent(
        db,
        row.runId,
        row.orderId,
        ambiguous && !exhausted ? "REFUND_UNKNOWN" : "REFUND_REVIEW",
        ambiguous && !exhausted ? "Refund dispatch is uncertain; the same key and body will be preserved for reconciliation." : exhausted ? "Five uncertain refund attempts were exhausted; the immutable obligation requires review." : "Razorpay rejected the refund; manual review is required.",
        error instanceof ProviderRequestError ? { statusCode: error.statusCode, providerCode: error.providerCode, providerDescription: error.providerDescription, providerDetails: error.providerDetails } : {}
      );
    }
  }
}

export class PaymentFlowError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}
