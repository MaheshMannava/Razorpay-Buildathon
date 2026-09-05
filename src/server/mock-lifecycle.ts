import type { RunSnapshot, StationId } from "../shared/contracts.js";
import type { RasoiDatabase } from "./db.js";
import { DomainFlowError } from "./domain.js";

type MockOrder = {
  id: string;
  runId: string;
  localState: "AWAITING_PAYMENT" | "QUEUED" | "COOKING" | "READY" | "SERVED" | "CANCELLED";
  stableReceipt: string;
  resourceJson: string;
  createdAtMs: number;
};

type MockResource = {
  stationId: StationId;
  amountPaise: number;
  currency: "INR";
  ingredients: Record<string, number>;
  slotStartMs: number;
  slotEndMs: number;
};

function event(db: RasoiDatabase, order: MockOrder, type: string, reason: string, now: number, details: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(order.runId, order.id, type, now, JSON.stringify(details), reason);
}

export function settleMockPayment(db: RasoiDatabase, orderId: string, outcome: "captured" | "failed", now = Date.now()): void {
  const order = db.prepare(`
    SELECT orders.id, orders.runId, orders.localState, orders.stableReceipt, orders.resourceJson, orders.createdAtMs
    FROM orders JOIN runs ON runs.id = orders.runId
    WHERE orders.id = ? AND runs.mode = 'MOCK'
  `).get(orderId) as MockOrder | undefined;
  if (!order) throw new DomainFlowError("ORDER_NOT_FOUND", "This simulated order does not exist.", 404);
  const existing = db.prepare("SELECT status FROM payments WHERE orderId = ?").get(order.id) as { status: string } | undefined;
  if (existing) {
    if (existing.status !== outcome) throw new DomainFlowError("PAYMENT_ALREADY_SETTLED", "The simulated payment already has a final outcome.");
    return;
  }
  if (order.localState !== "AWAITING_PAYMENT") throw new DomainFlowError("PAYMENT_ALREADY_SETTLED", "This order is no longer awaiting simulated payment.");
  const resource = JSON.parse(order.resourceJson) as MockResource;
  const paymentId = `sim_pay_${order.id}`;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (providerPaymentId, orderId, providerOrderId, amountPaise, currency, status, amountRefundedPaise, lastObservedAtMs)
      VALUES (?, ?, ?, ?, 'INR', ?, 0, ?)
    `).run(paymentId, order.id, order.stableReceipt, resource.amountPaise, outcome, now);
    db.prepare("UPDATE orders SET localState = ? WHERE id = ?").run(outcome === "captured" ? "QUEUED" : "CANCELLED", order.id);
    db.prepare("UPDATE runs SET clockMs = ?, version = version + 1 WHERE id = ?").run(now, order.runId);
    event(db, order, outcome === "captured" ? "SIMULATED_PAYMENT_CAPTURED" : "SIMULATED_PAYMENT_FAILED",
      outcome === "captured" ? "The simulated payment succeeded; kitchen work may now start." : "The simulated payment failed; the reservation was released without fulfillment.",
      now, { providerPaymentId: paymentId });
  })();
}

function setActiveOrder(stations: RunSnapshot["stations"], stationId: StationId, orderId: string | null): RunSnapshot["stations"] {
  return { ...stations, [stationId]: { ...stations[stationId], activeOrderId: orderId } };
}

export function advanceKitchenLifecycle(db: RasoiDatabase, now = Date.now()): void {
  const awaiting = db.prepare(`
    SELECT orders.id, orders.runId, orders.localState, orders.stableReceipt, orders.resourceJson, orders.createdAtMs
    FROM orders JOIN runs ON runs.id = orders.runId
    WHERE runs.mode = 'MOCK' AND orders.localState = 'AWAITING_PAYMENT' AND orders.createdAtMs + 2000 <= ?
    ORDER BY orders.createdAtMs
  `).all(now) as MockOrder[];
  for (const order of awaiting) settleMockPayment(db, order.id, "captured", now);

  const active = db.prepare(`
    SELECT orders.id, orders.runId, orders.localState, orders.stableReceipt, orders.resourceJson, orders.createdAtMs
    FROM orders
    WHERE orders.localState IN ('QUEUED', 'COOKING', 'READY')
    ORDER BY orders.createdAtMs
  `).all() as MockOrder[];

  for (const order of active) {
    const resource = JSON.parse(order.resourceJson) as MockResource;
    let state = order.localState;
    if (state === "QUEUED" && now >= resource.slotStartMs) {
      db.transaction(() => {
        const run = db.prepare("SELECT stationJson FROM runs WHERE id = ?").get(order.runId) as { stationJson: string };
        const stations = setActiveOrder(JSON.parse(run.stationJson) as RunSnapshot["stations"], resource.stationId, order.id);
        db.prepare("UPDATE orders SET localState = 'COOKING' WHERE id = ? AND localState = 'QUEUED'").run(order.id);
        db.prepare("UPDATE runs SET stationJson = ?, clockMs = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(stations), now, order.runId);
        event(db, order, "COOKING_STARTED", "The confirmed simulated payment released this meal to its reserved station.", now, { stationId: resource.stationId });
      })();
      state = "COOKING";
    }
    if (state === "COOKING" && now >= resource.slotEndMs) {
      db.transaction(() => {
        const run = db.prepare("SELECT stationJson FROM runs WHERE id = ?").get(order.runId) as { stationJson: string };
        const stations = setActiveOrder(JSON.parse(run.stationJson) as RunSnapshot["stations"], resource.stationId, null);
        db.prepare("UPDATE orders SET localState = 'READY' WHERE id = ? AND localState = 'COOKING'").run(order.id);
        db.prepare("UPDATE runs SET stationJson = ?, clockMs = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(stations), now, order.runId);
        event(db, order, "MEAL_READY", "The simulated meal completed its reserved cook interval.", now, { stationId: resource.stationId });
      })();
      state = "READY";
    }
    if (state === "READY" && now >= resource.slotEndMs + 5_000) {
      db.transaction(() => {
        const run = db.prepare("SELECT stockJson FROM runs WHERE id = ?").get(order.runId) as { stockJson: string };
        const stock = JSON.parse(run.stockJson) as Record<string, number>;
        for (const [ingredient, units] of Object.entries(resource.ingredients)) stock[ingredient] = Math.max(0, (stock[ingredient] ?? 0) - units);
        db.prepare("UPDATE orders SET localState = 'SERVED' WHERE id = ? AND localState = 'READY'").run(order.id);
        db.prepare("UPDATE runs SET stockJson = ?, clockMs = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(stock), now, order.runId);
        event(db, order, "MEAL_SERVED", "The simulated meal reached pickup and its reserved ingredients were consumed.", now);
      })();
    }
  }

  const refunds = db.prepare(`
    SELECT refunds.id AS refundId, refunds.paymentId, orders.id, orders.runId, orders.localState,
           orders.stableReceipt, orders.resourceJson, orders.createdAtMs, refunds.amountPaise
    FROM refunds JOIN orders ON orders.id = refunds.orderId JOIN runs ON runs.id = orders.runId
    WHERE runs.mode = 'MOCK' AND refunds.state = 'REQUIRED'
  `).all() as Array<MockOrder & { refundId: string; paymentId: string; amountPaise: number }>;
  for (const refund of refunds) {
    db.transaction(() => {
      db.prepare("UPDATE refunds SET providerRefundId = ?, state = 'PROCESSED', nextCheckAtMs = NULL WHERE id = ?")
        .run(`sim_rfnd_${refund.refundId}`, refund.refundId);
      db.prepare("UPDATE payments SET status = 'refunded', amountRefundedPaise = ?, lastObservedAtMs = ? WHERE providerPaymentId = ?")
        .run(refund.amountPaise, now, refund.paymentId);
      db.prepare("UPDATE runs SET clockMs = ?, version = version + 1 WHERE id = ?").run(now, refund.runId);
      event(db, refund, "SIMULATED_REFUND_PROCESSED", "The simulated full refund completed after the station failure.", now);
    })();
  }
}

export function startKitchenLifecycle(db: RasoiDatabase, intervalMs = 250, onError?: (error: unknown) => void): () => void {
  const timer = setInterval(() => {
    try {
      advanceKitchenLifecycle(db);
    } catch (error) {
      onError?.(error);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
