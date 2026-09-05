import type { RasoiDatabase } from "./db.js";
import { applyRefundObservations, checkOrderStatus, createPersistedProviderOrder, deferOrderStatusCheck, dispatchRequiredRefunds, type PaymentProvider } from "./payments.js";

type DueOrder = { id: string; runId: string };

export function recoverInterruptedFinancialWork(db: RasoiDatabase, now = Date.now()): void {
  const interruptedOrders = db.prepare(`
    SELECT id, runId FROM orders
    WHERE createState = 'SENT' AND providerCreateClaimedAtMs IS NOT NULL AND providerOrderId IS NULL
  `).all() as DueOrder[];
  const interruptedRefunds = db.prepare(`
    SELECT refunds.id, orders.id AS orderId, orders.runId
    FROM refunds JOIN orders ON orders.id = refunds.orderId
    WHERE refunds.state = 'SENT'
  `).all() as Array<{ id: string; orderId: string; runId: string }>;
  db.transaction(() => {
    for (const order of interruptedOrders) {
      db.prepare("UPDATE orders SET createState = 'UNKNOWN' WHERE id = ? AND createState = 'SENT'").run(order.id);
      db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, ?, 'ORDER_CREATE_UNKNOWN', ?, '{}', ?)`)
        .run(order.runId, order.id, now, "The process restarted after provider creation began; checkout remains blocked and the Order will not be recreated blindly.");
    }
    for (const refund of interruptedRefunds) {
      db.prepare("UPDATE refunds SET state = 'UNKNOWN', nextCheckAtMs = ? WHERE id = ? AND state = 'SENT'").run(now, refund.id);
      db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, ?, 'REFUND_UNKNOWN', ?, '{}', ?)`)
        .run(refund.runId, refund.orderId, now, "The process restarted during refund dispatch; reconciliation will preserve the original key and body.");
    }
  })();
}

export async function reconcileDueFinancialWork(db: RasoiDatabase, provider: PaymentProvider, now = Date.now()): Promise<void> {
  const unclaimedCreates = db.prepare(`
    SELECT orders.id, orders.runId
    FROM orders JOIN runs ON runs.id = orders.runId
    WHERE runs.mode = 'RAZORPAY_TEST' AND orders.createState = 'SENT'
      AND orders.providerCreateClaimedAtMs IS NULL AND orders.providerOrderId IS NULL
    ORDER BY orders.createdAtMs
  `).all() as DueOrder[];
  for (const order of unclaimedCreates) {
    try {
      await createPersistedProviderOrder(db, provider, order.id);
    } catch {
      // The creation function persists a definitive UNKNOWN/REJECTED outcome.
      // A concurrent claimant returns PAYMENT_PENDING without another call.
    }
  }

  const dueOrders = db.prepare(`
    SELECT orders.id, orders.runId
    FROM orders JOIN runs ON runs.id = orders.runId
    WHERE runs.mode = 'RAZORPAY_TEST'
      AND orders.providerOrderId IS NOT NULL
      AND orders.nextPaymentCheckAtMs IS NOT NULL
      AND orders.nextPaymentCheckAtMs <= ?
    ORDER BY orders.nextPaymentCheckAtMs, orders.createdAtMs
  `).all(now) as DueOrder[];

  for (const order of dueOrders) {
    // Claim before crossing the network boundary. A concurrent pass will skip it.
    const claimed = db.prepare(`
      UPDATE orders SET nextPaymentCheckAtMs = ?
      WHERE id = ? AND nextPaymentCheckAtMs IS NOT NULL AND nextPaymentCheckAtMs <= ?
    `).run(now + 60_000, order.id, now);
    if (claimed.changes !== 1) continue;
    try {
      await checkOrderStatus(db, provider, order.id, now);
    } catch {
      deferOrderStatusCheck(db, order.id, now);
    }
  }

  const dueRuns = db.prepare(`
    SELECT DISTINCT orders.runId
    FROM refunds JOIN orders ON orders.id = refunds.orderId
    WHERE refunds.state IN ('REQUIRED', 'UNKNOWN')
      AND refunds.attempts < 5
      AND (refunds.nextCheckAtMs IS NULL OR refunds.nextCheckAtMs <= ?)
    ORDER BY orders.runId
  `).all(now) as Array<{ runId: string }>;
  for (const { runId } of dueRuns) await dispatchRequiredRefunds(db, provider, runId, now);

  const pendingRefunds = db.prepare(`
    SELECT refunds.id, refunds.orderId, refunds.paymentId, refunds.providerRefundId
    FROM refunds
    WHERE refunds.state = 'PENDING'
      AND refunds.providerRefundId IS NOT NULL
      AND (refunds.nextCheckAtMs IS NULL OR refunds.nextCheckAtMs <= ?)
    ORDER BY refunds.nextCheckAtMs, refunds.createdAtMs
  `).all(now) as Array<{ id: string; orderId: string; paymentId: string; providerRefundId: string }>;
  for (const refund of pendingRefunds) {
    const claimed = db.prepare(`
      UPDATE refunds SET nextCheckAtMs = ?
      WHERE id = ? AND state = 'PENDING'
        AND (nextCheckAtMs IS NULL OR nextCheckAtMs <= ?)
    `).run(now + 60_000, refund.id, now);
    if (claimed.changes !== 1) continue;
    try {
      const observed = await provider.fetchPaymentRefunds(refund.paymentId);
      applyRefundObservations(db, refund.orderId, refund.paymentId, observed);
    } catch {
      // A known provider refund remains a liability and is checked again. Reads
      // do not rotate the mutation key or consume the five mutation attempts.
      db.prepare("UPDATE refunds SET nextCheckAtMs = ? WHERE id = ? AND state = 'PENDING'")
        .run(now + 60_000, refund.id);
    }
  }
}

export function startFinancialReconciler(
  db: RasoiDatabase,
  provider: PaymentProvider,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {}
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let active: Promise<void> | undefined;

  const schedule = () => {
    if (!stopped) timer = setTimeout(trigger, intervalMs);
  };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileDueFinancialWork(db, provider);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      schedule();
    }
  };

  const trigger = () => {
    active = run();
    void active;
  };

  trigger();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}
