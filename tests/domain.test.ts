import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntentState } from "../src/shared/contracts.js";
import { CATALOG, acceptQuote, confirmIntent, createStationAlternative, DomainFlowError, submitMealRequest } from "../src/server/domain.js";
import type { RasoiDatabase } from "../src/server/db.js";
import { openDatabase } from "../src/server/db.js";
import { createRun, getRunSnapshot, setStationStatus } from "../src/server/run-store.js";

describe("four-dish domain guard", () => {
  let db: RasoiDatabase;
  let runId: string;
  const base = 1_800_000_000_000;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runId = createRun(db, "MOCK", base).runId;
  });
  afterEach(() => db.close());

  function requestAndConfirm(text: string, overrides: Partial<{
    budgetPaise: number; latestReadyAtMs: number; excludedIngredients: Array<"onion" | "dairy" | "peanuts">;
    preferredDishIds: Array<"plain_dosa" | "masala_dosa" | "lemon_rice" | "curd_rice">; allowSubstitutes: boolean;
  }> = {}, offset = 0): IntentState {
    submitMealRequest(db, runId, randomUUID(), text, base + offset);
    const draft = getRunSnapshot(db, runId, false)!.intent!.draft;
    confirmIntent(db, runId, {
      id: draft.id, version: draft.version, budgetPaise: overrides.budgetPaise ?? draft.budgetPaise ?? 15000,
      latestReadyAtMs: overrides.latestReadyAtMs ?? base + 10 * 60_000,
      excludedIngredients: overrides.excludedIngredients ?? [], preferredDishIds: overrides.preferredDishIds ?? [],
      allowSubstitutes: overrides.allowSubstitutes ?? true
    }, base + offset + 10);
    return getRunSnapshot(db, runId, false)!.intent!;
  }

  it("uses only the four immutable PRD catalog entries", () => {
    expect(CATALOG.map(({ id, pricePaise, stationId, cookSeconds }) => ({ id, pricePaise, stationId, cookSeconds }))).toEqual([
      { id: "plain_dosa", pricePaise: 12000, stationId: "tawa", cookSeconds: 60 },
      { id: "masala_dosa", pricePaise: 15000, stationId: "tawa", cookSeconds: 90 },
      { id: "lemon_rice", pricePaise: 10000, stationId: "bowls", cookSeconds: 30 },
      { id: "curd_rice", pricePaise: 11000, stationId: "bowls", cookSeconds: 30 }
    ]);
  });

  it("enforces budget and recipe facts outside the extractor", () => {
    const onion = requestAndConfirm("Maximum ₹150, within five minutes, masala dosa; another dish is okay.", {
      excludedIngredients: ["onion"], preferredDishIds: ["masala_dosa"], allowSubstitutes: true
    });
    expect(onion.quote?.dishId).toBe("lemon_rice");
    expect(onion.quote?.amountPaise).toBeLessThanOrEqual(15000);

    const dairy = requestAndConfirm("Maximum ₹120, within five minutes, curd rice only.", {
      budgetPaise: 12000, excludedIngredients: ["dairy"], preferredDishIds: ["curd_rice"], allowSubstitutes: false
    }, 100);
    expect(dairy.quote).toBeNull();
  });

  it("rejects a stale draft after a newer request", () => {
    submitMealRequest(db, runId, randomUUID(), "Maximum ₹120, within five minutes, plain dosa only.", base);
    const stale = getRunSnapshot(db, runId, false)!.intent!.draft;
    submitMealRequest(db, runId, randomUUID(), "Maximum ₹150, within ten minutes, any dish.", base + 1);
    expect(() => confirmIntent(db, runId, {
      id: stale.id, version: stale.version, budgetPaise: 12000, latestReadyAtMs: base + 300_000,
      excludedIngredients: [], preferredDishIds: ["plain_dosa"], allowSubstitutes: false
    }, base + 2)).toThrowError(expect.objectContaining({ code: "STALE_INTENT" }));
  });

  it("selects a real alternative when a station is down", () => {
    setStationStatus(db, runId, "bowls", "DOWN", base + 1);
    const state = requestAndConfirm("Maximum ₹120, within five minutes, any dish.", { budgetPaise: 12000 }, 2);
    expect(state.quote?.dishId).toBe("plain_dosa");
    expect(state.quote?.stationId).toBe("tawa");
  });

  it("invalidates an unaccepted offer when its station goes down", () => {
    const state = requestAndConfirm("Maximum ₹120, within five minutes, plain dosa only.", {
      budgetPaise: 12000, preferredDishIds: ["plain_dosa"], allowSubstitutes: false
    });
    expect(state.quote?.stationId).toBe("tawa");
    setStationStatus(db, runId, "tawa", "DOWN", base + 100);
    const snapshot = getRunSnapshot(db, runId, false)!;
    expect(snapshot.intent?.quote).toBeNull();
    expect(snapshot.events[0].type).toBe("OFFER_INVALIDATED");
  });

  it("offers at most one feasible replacement after invalidation", () => {
    const state = requestAndConfirm("Maximum ₹150, within five minutes, any dish.", { budgetPaise: 15000 });
    expect(state.quote?.dishId).toBe("lemon_rice");
    expect(setStationStatus(db, runId, "bowls", "DOWN", base + 100)).toBe(true);
    createStationAlternative(db, runId, "bowls", base + 101);
    const alternative = getRunSnapshot(db, runId, false)!.intent!.quote;
    expect(alternative?.dishId).toBe("plain_dosa");
    expect(alternative?.reason).toContain("bowl station is unavailable");
    createStationAlternative(db, runId, "bowls", base + 102);
    expect(getRunSnapshot(db, runId, false)!.intent!.quote?.id).toBe(alternative?.id);
  });

  it("serializes acceptance and allocates non-overlapping station intervals", () => {
    const first = requestAndConfirm("Maximum ₹120, within ten minutes, plain dosa only.", {
      budgetPaise: 12000, preferredDishIds: ["plain_dosa"], allowSubstitutes: false
    });
    const commandOne = randomUUID();
    const firstOrder = acceptQuote(db, runId, {
      quoteId: first.quote!.id, quoteHash: first.quote!.contentHash, intentId: first.confirmed!.id,
      intentVersion: first.confirmed!.version, clientCommandId: commandOne
    }, base + 20);
    expect(acceptQuote(db, runId, {
      quoteId: first.quote!.id, quoteHash: first.quote!.contentHash, intentId: first.confirmed!.id,
      intentVersion: first.confirmed!.version, clientCommandId: commandOne
    }, base + 21)).toBe(firstOrder);
    expect(() => acceptQuote(db, runId, {
      quoteId: first.quote!.id, quoteHash: first.quote!.contentHash, intentId: first.confirmed!.id,
      intentVersion: first.confirmed!.version, clientCommandId: randomUUID()
    }, base + 22)).toThrowError(DomainFlowError);

    const second = requestAndConfirm("Maximum ₹120, within ten minutes, plain dosa only.", {
      budgetPaise: 12000, preferredDishIds: ["plain_dosa"], allowSubstitutes: false
    }, 30);
    acceptQuote(db, runId, {
      quoteId: second.quote!.id, quoteHash: second.quote!.contentHash, intentId: second.confirmed!.id,
      intentVersion: second.confirmed!.version, clientCommandId: randomUUID()
    }, base + 40);
    const resources = db.prepare("SELECT resourceJson FROM orders ORDER BY createdAtMs").all() as Array<{ resourceJson: string }>;
    const [left, right] = resources.map((row) => JSON.parse(row.resourceJson) as { slotStartMs: number; slotEndMs: number });
    expect(left.slotEndMs <= right.slotStartMs || right.slotEndMs <= left.slotStartMs).toBe(true);
  });
});
