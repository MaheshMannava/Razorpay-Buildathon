import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptQuote, confirmIntent, submitMealRequest } from "../src/server/domain.js";
import type { RasoiDatabase } from "../src/server/db.js";
import { openDatabase } from "../src/server/db.js";
import { advanceKitchenLifecycle, settleMockPayment } from "../src/server/mock-lifecycle.js";
import { createRun, getRunSnapshot, setStationStatus } from "../src/server/run-store.js";
import { createStationFailureObligations } from "../src/server/payments.js";

describe("MOCK payment and fulfillment lifecycle", () => {
  let db: RasoiDatabase;
  let runId: string;
  let orderId: string;
  const base = 1_800_000_000_000;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runId = createRun(db, "MOCK", base).runId;
    submitMealRequest(db, runId, randomUUID(), "Maximum ₹120, within five minutes, plain dosa only.", base);
    const draft = getRunSnapshot(db, runId, false)!.intent!.draft;
    confirmIntent(db, runId, {
      id: draft.id, version: draft.version, budgetPaise: 12000, latestReadyAtMs: base + 300_000,
      excludedIngredients: [], preferredDishIds: ["plain_dosa"], allowSubstitutes: false
    }, base + 10);
    const intent = getRunSnapshot(db, runId, false)!.intent!;
    orderId = acceptQuote(db, runId, {
      quoteId: intent.quote!.id, quoteHash: intent.quote!.contentHash, intentId: intent.confirmed!.id,
      intentVersion: intent.confirmed!.version, clientCommandId: randomUUID()
    }, base + 20);
  });
  afterEach(() => db.close());

  it("advances an accepted order through captured, cooking, ready, and served", () => {
    const resource = JSON.parse((db.prepare("SELECT resourceJson FROM orders WHERE id = ?").get(orderId) as { resourceJson: string }).resourceJson) as { slotStartMs: number; slotEndMs: number };
    advanceKitchenLifecycle(db, base + 2_020);
    expect(getRunSnapshot(db, runId, false)!.currentOrder).toMatchObject({ localState: "COOKING", paymentStatus: "captured" });
    advanceKitchenLifecycle(db, resource.slotEndMs);
    expect(getRunSnapshot(db, runId, false)!.currentOrder?.localState).toBe("READY");
    advanceKitchenLifecycle(db, resource.slotEndMs + 5_000);
    const snapshot = getRunSnapshot(db, runId, false)!;
    expect(snapshot.currentOrder?.localState).toBe("SERVED");
    expect(snapshot.stock.batter).toBe(5);
    expect(snapshot.stations.tawa.activeOrderId).toBeNull();
  });

  it("releases the reservation without cooking when simulated payment fails", () => {
    settleMockPayment(db, orderId, "failed", base + 1_000);
    const snapshot = getRunSnapshot(db, runId, false)!;
    expect(snapshot.currentOrder).toMatchObject({ localState: "CANCELLED", paymentStatus: "failed" });
    expect(snapshot.stock.batter).toBe(6);
    expect(snapshot.events[0].type).toBe("SIMULATED_PAYMENT_FAILED");
  });

  it("cancels cooking and completes a simulated full refund after station failure", () => {
    advanceKitchenLifecycle(db, base + 2_020);
    expect(getRunSnapshot(db, runId, false)!.currentOrder?.localState).toBe("COOKING");
    setStationStatus(db, runId, "tawa", "DOWN", base + 3_000);
    createStationFailureObligations(db, runId, "tawa");
    advanceKitchenLifecycle(db, base + 3_001);

    const snapshot = getRunSnapshot(db, runId, false)!;
    expect(snapshot.currentOrder).toMatchObject({ localState: "CANCELLED", paymentStatus: "refunded", refundState: "PROCESSED" });
    expect(snapshot.stations.tawa).toMatchObject({ status: "DOWN", activeOrderId: null });
    expect(snapshot.stock.batter).toBe(6);
  });
});
