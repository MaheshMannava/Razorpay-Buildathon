import { createHash, randomUUID } from "node:crypto";
import type { ConfirmedIntent, DishId, Exclusion, IntentState, Quote, StationId } from "../shared/contracts.js";
import { extractWithRules, hashRequest } from "./agent.js";
import type { RasoiDatabase } from "./db.js";

export const CATALOG_VERSION = "rasoi-catalog-v1" as const;

export type CatalogDish = {
  id: DishId;
  name: string;
  pricePaise: number;
  stationId: StationId;
  cookSeconds: number;
  ingredients: Record<string, number>;
  facts: Exclusion[];
};

export const CATALOG: readonly CatalogDish[] = [
  { id: "plain_dosa", name: "Plain dosa", pricePaise: 12000, stationId: "tawa", cookSeconds: 60, ingredients: { batter: 1, oil: 1 }, facts: [] },
  { id: "masala_dosa", name: "Masala dosa", pricePaise: 15000, stationId: "tawa", cookSeconds: 90, ingredients: { batter: 1, potato_mix: 1, oil: 1 }, facts: ["onion"] },
  { id: "lemon_rice", name: "Lemon rice", pricePaise: 10000, stationId: "bowls", cookSeconds: 30, ingredients: { rice: 1, lemon_mix: 1, peanuts: 1 }, facts: ["peanuts"] },
  { id: "curd_rice", name: "Curd rice", pricePaise: 11000, stationId: "bowls", cookSeconds: 30, ingredients: { rice: 1, curd: 1 }, facts: ["dairy"] }
];

type RunDomainRow = {
  id: string;
  mode: "MOCK" | "RAZORPAY_TEST";
  clockMs: number;
  version: number;
  stationJson: string;
  stockJson: string;
  latestIntentJson: string | null;
  salesStopped: 0 | 1;
};

type ResourceReservation = {
  stationId: StationId;
  slotStartMs?: number;
  slotEndMs?: number;
  ingredients?: Record<string, number>;
};

export class DomainFlowError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
  }
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function runRow(db: RasoiDatabase, runId: string): RunDomainRow {
  const row = db.prepare(`
    SELECT id, mode, clockMs, version, stationJson, stockJson, latestIntentJson, salesStopped
    FROM runs WHERE id = ?
  `).get(runId) as RunDomainRow | undefined;
  if (!row) throw new DomainFlowError("RUN_NOT_FOUND", "This run does not exist.", 404);
  return row;
}

function activeReservations(db: RasoiDatabase, runId: string): ResourceReservation[] {
  const rows = db.prepare(`
    SELECT resourceJson FROM orders
    WHERE runId = ? AND localState IN ('AWAITING_PAYMENT', 'QUEUED', 'COOKING', 'READY')
  `).all(runId) as Array<{ resourceJson: string }>;
  return rows.map((row) => JSON.parse(row.resourceJson) as ResourceReservation);
}

function availableStock(stock: Record<string, number>, reservations: ResourceReservation[]): Record<string, number> {
  const available = { ...stock };
  for (const reservation of reservations) {
    for (const [ingredient, units] of Object.entries(reservation.ingredients ?? {})) {
      available[ingredient] = (available[ingredient] ?? 0) - units;
    }
  }
  return available;
}

function findSlot(stationId: StationId, durationMs: number, earliestMs: number, reservations: ResourceReservation[]) {
  let startMs = earliestMs;
  const intervals = reservations
    .filter((reservation) => reservation.stationId === stationId && reservation.slotStartMs !== undefined && reservation.slotEndMs !== undefined)
    .map((reservation) => ({ startMs: reservation.slotStartMs!, endMs: reservation.slotEndMs! }))
    .sort((left, right) => left.startMs - right.startMs);
  for (const interval of intervals) {
    const endMs = startMs + durationMs;
    if (startMs < interval.endMs && endMs > interval.startMs) startMs = interval.endMs;
  }
  return { startMs, endMs: startMs + durationMs };
}

function chooseQuote(db: RasoiDatabase, row: RunDomainRow, intent: ConfirmedIntent, now: number): Quote | null {
  const stations = JSON.parse(row.stationJson) as Record<StationId, { status: "UP" | "DOWN" }>;
  const stock = JSON.parse(row.stockJson) as Record<string, number>;
  const reservations = activeReservations(db, row.id);
  const available = availableStock(stock, reservations);
  const preferred = new Set(intent.preferredDishIds);
  const baseCandidates = intent.preferredDishIds.length > 0 && !intent.allowSubstitutes
    ? CATALOG.filter((dish) => preferred.has(dish.id))
    : CATALOG;
  const candidates = baseCandidates
    .filter((dish) => dish.pricePaise <= intent.budgetPaise)
    .filter((dish) => stations[dish.stationId].status === "UP")
    .filter((dish) => !dish.facts.some((fact) => intent.excludedIngredients.includes(fact)))
    .filter((dish) => Object.entries(dish.ingredients).every(([ingredient, units]) => (available[ingredient] ?? 0) >= units))
    .map((dish) => {
      const paymentHoldMs = row.mode === "MOCK" ? 2_000 : 90_000;
      const slot = findSlot(dish.stationId, dish.cookSeconds * 1000, now + 30_000 + paymentHoldMs, reservations);
      return { dish, promisedReadyAtMs: slot.endMs + 5_000 };
    })
    .filter(({ promisedReadyAtMs }) => promisedReadyAtMs <= intent.latestReadyAtMs)
    .sort((left, right) => Number(preferred.has(right.dish.id)) - Number(preferred.has(left.dish.id))
      || left.dish.pricePaise - right.dish.pricePaise
      || left.dish.id.localeCompare(right.dish.id));
  const selected = candidates[0];
  if (!selected) return null;
  const content = {
    id: randomUUID(), intentId: intent.id, intentVersion: intent.version, catalogVersion: CATALOG_VERSION,
    dishId: selected.dish.id, dishName: selected.dish.name, amountPaise: selected.dish.pricePaise,
    currency: "INR" as const, stationId: selected.dish.stationId, ingredients: Object.keys(selected.dish.ingredients),
    promisedReadyAtMs: selected.promisedReadyAtMs, expiresAtMs: now + 30_000,
    reason: preferred.has(selected.dish.id) ? "Your preferred dish meets every confirmed constraint." : "This is the lowest-priced available dish that meets every confirmed constraint."
  };
  return { ...content, contentHash: canonicalHash(content) };
}

export function submitMealRequest(db: RasoiDatabase, runId: string, requestId: string, text: string, now = Date.now()): void {
  const row = runRow(db, runId);
  const inputHash = hashRequest(text);
  const existing = db.prepare("SELECT inputHash FROM agent_calls WHERE runId = ? AND requestId = ?").get(runId, requestId) as { inputHash: string } | undefined;
  if (existing) {
    if (existing.inputHash !== inputHash) throw new DomainFlowError("REQUEST_ID_CONFLICT", "That request ID was already used for different text.");
    return;
  }
  const started = performance.now();
  const extraction = extractWithRules(text);
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const previous = row.latestIntentJson ? JSON.parse(row.latestIntentJson) as IntentState : null;
  const draft = {
    id: randomUUID(), version: (previous?.draft.version ?? 0) + 1, requestText: text, requestReceivedAtMs: now,
    budgetPaise: extraction.budgetPaise, deadlineSeconds: extraction.deadlineSeconds,
    exclusions: extraction.exclusions, preferredDishIds: extraction.preferredDishIds,
    allowSubstitutes: extraction.substitutesAllowed, clarificationReasons: extraction.clarificationReasons,
    safetyLimitationRequired: extraction.safetyLimitationRequired
  };
  const state: IntentState = { draft, confirmed: null, quote: null };
  db.transaction(() => {
    db.prepare(`INSERT INTO agent_calls (id, runId, requestId, inputHash, modelVersion, promptVersion, extractionJson, latencyMs, validationResult, createdAtMs)
      VALUES (?, ?, ?, ?, 'rules-v1', 'rasoi-intent-v1', ?, ?, ?, ?)`)
      .run(randomUUID(), runId, requestId, inputHash, JSON.stringify(extraction), latencyMs, extraction.clarificationReasons.length ? "CLARIFICATION_REQUIRED" : "VALID", now);
    db.prepare("UPDATE runs SET latestIntentJson = ?, clockMs = ?, version = version + 1 WHERE id = ?")
      .run(JSON.stringify(state), now, runId);
    db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, NULL, 'REQUEST_INTERPRETED', ?, ?, ?)`)
      .run(runId, now, JSON.stringify({ requestId, intentId: draft.id, intentVersion: draft.version, fallbackUsed: true }),
        extraction.clarificationReasons.length ? "The request needs a customer clarification before confirmation." : "The request was converted into editable constraints.");
  })();
}

export function confirmIntent(db: RasoiDatabase, runId: string, input: Omit<ConfirmedIntent, "actorId">, now = Date.now()): void {
  const row = runRow(db, runId);
  if (row.salesStopped) throw new DomainFlowError("SALES_STOPPED", "New meal sales are stopped for this run.");
  const state = row.latestIntentJson ? JSON.parse(row.latestIntentJson) as IntentState : null;
  if (!state || state.draft.id !== input.id || state.draft.version !== input.version) {
    throw new DomainFlowError("STALE_INTENT", "These constraints are stale. Review the latest request before confirming.");
  }
  if (state.draft.safetyLimitationRequired) {
    throw new DomainFlowError("NEEDS_CLARIFICATION", "RASOI cannot promise allergy or cross-contact safety. Edit the request without a safety guarantee.");
  }
  if (input.latestReadyAtMs <= now + 5_000) throw new DomainFlowError("NEEDS_CLARIFICATION", "Choose a deadline that is still in the future.", 400);
  const confirmed: ConfirmedIntent = { ...input, actorId: "human" };
  const quote = chooseQuote(db, row, confirmed, now);
  const next: IntentState = { ...state, confirmed, quote };
  db.transaction(() => {
    db.prepare("UPDATE runs SET latestIntentJson = ?, clockMs = ?, version = version + 1 WHERE id = ?")
      .run(JSON.stringify(next), now, runId);
    db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, NULL, 'CONSTRAINTS_CONFIRMED', ?, ?, ?)`)
      .run(runId, now, JSON.stringify({ intentId: confirmed.id, intentVersion: confirmed.version, quoteId: quote?.id ?? null }),
        quote ? `${quote.dishName} is feasible and reserved only after acceptance.` : "No catalog dish currently meets every confirmed constraint.");
  })();
}

export function createStationAlternative(db: RasoiDatabase, runId: string, failedStation: StationId, now = Date.now()): void {
  const row = runRow(db, runId);
  const state = row.latestIntentJson ? JSON.parse(row.latestIntentJson) as IntentState : null;
  if (!state?.confirmed || state.quote) return;
  const candidate = chooseQuote(db, row, state.confirmed, now);
  let quote = candidate;
  if (candidate) {
    const { contentHash: _oldHash, ...content } = candidate;
    void _oldHash;
    const withReason = { ...content, reason: `The ${failedStation === "tawa" ? "tawa" : "bowl station"} is unavailable. This alternative still meets every confirmed constraint.` };
    quote = { ...withReason, contentHash: canonicalHash(withReason) };
  }
  db.transaction(() => {
    db.prepare("UPDATE runs SET latestIntentJson = ?, clockMs = ?, version = version + 1 WHERE id = ?")
      .run(JSON.stringify({ ...state, quote }), now, runId);
    db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, NULL, ?, ?, ?, ?)`)
      .run(runId, quote ? "ALTERNATIVE_OFFERED" : "NO_ALTERNATIVE", now, JSON.stringify({ failedStation, quoteId: quote?.id ?? null }),
        quote ? `${quote.dishName} is the one feasible replacement after the station change.` : "No alternative meets every confirmed constraint after the station change.");
  })();
}

export function acceptQuote(db: RasoiDatabase, runId: string, input: { quoteId: string; quoteHash: string; intentId: string; intentVersion: number; clientCommandId: string }, now = Date.now()): string {
  const requestHash = canonicalHash(input);
  const existingCommand = db.prepare("SELECT id, requestHash FROM orders WHERE runId = ? AND clientCommandId = ?").get(runId, input.clientCommandId) as { id: string; requestHash: string } | undefined;
  if (existingCommand) {
    if (existingCommand.requestHash !== requestHash) throw new DomainFlowError("REQUEST_ID_CONFLICT", "That acceptance ID was already used with different details.");
    return existingCommand.id;
  }
  let orderId = "";
  db.transaction(() => {
    const row = runRow(db, runId);
    if (row.salesStopped) throw new DomainFlowError("SALES_STOPPED", "New meal sales are stopped for this run.");
    const state = row.latestIntentJson ? JSON.parse(row.latestIntentJson) as IntentState : null;
    const intent = state?.confirmed;
    const quote = state?.quote;
    if (!intent || !quote || quote.id !== input.quoteId || quote.contentHash !== input.quoteHash
      || intent.id !== input.intentId || intent.version !== input.intentVersion) {
      throw new DomainFlowError("QUOTE_NO_LONGER_FEASIBLE", "This offer no longer matches the confirmed constraints.");
    }
    if (now > quote.expiresAtMs) throw new DomainFlowError("QUOTE_EXPIRED", "This offer expired. Confirm the constraints again for a fresh offer.");
    const alreadyAccepted = db.prepare("SELECT id FROM orders WHERE runId = ? AND intentId = ? AND intentVersion = ?").get(runId, intent.id, intent.version) as { id: string } | undefined;
    if (alreadyAccepted) throw new DomainFlowError("INTENT_ALREADY_ACCEPTED", "These confirmed constraints already have an accepted meal.");
    const dish = CATALOG.find((candidate) => candidate.id === quote.dishId)!;
    const stations = JSON.parse(row.stationJson) as Record<StationId, { status: "UP" | "DOWN" }>;
    const reservations = activeReservations(db, runId);
    const stock = availableStock(JSON.parse(row.stockJson) as Record<string, number>, reservations);
    if (stations[dish.stationId].status !== "UP" || dish.pricePaise > intent.budgetPaise
      || dish.facts.some((fact) => intent.excludedIngredients.includes(fact))
      || !Object.entries(dish.ingredients).every(([ingredient, units]) => (stock[ingredient] ?? 0) >= units)) {
      throw new DomainFlowError("QUOTE_NO_LONGER_FEASIBLE", "Kitchen state changed and this offer is no longer feasible.");
    }
    const paymentHoldMs = row.mode === "MOCK" ? 2_000 : 90_000;
    const slot = findSlot(dish.stationId, dish.cookSeconds * 1000, now + paymentHoldMs, reservations);
    if (slot.endMs + 5_000 > quote.promisedReadyAtMs || slot.endMs + 5_000 > intent.latestReadyAtMs) {
      throw new DomainFlowError("QUOTE_NO_LONGER_FEASIBLE", "Kitchen capacity changed and the promised ready time can no longer be kept.");
    }
    orderId = randomUUID();
    const resource = { dishId: dish.id, dishName: dish.name, amountPaise: dish.pricePaise, currency: "INR", stationId: dish.stationId, ingredients: dish.ingredients, slotStartMs: slot.startMs, slotEndMs: slot.endMs };
    const receipt = `${row.mode === "MOCK" ? "sim" : "rs"}_${randomUUID().replaceAll("-", "")}`;
    const createBody = row.mode === "RAZORPAY_TEST" ? {
      amount: dish.pricePaise,
      currency: "INR",
      receipt,
      notes: { rasoi_order_id: orderId, rasoi_run_id: runId }
    } : {};
    db.prepare(`INSERT INTO orders (id, runId, actorId, intentId, intentVersion, clientCommandId, requestHash, immutableQuoteJson, quoteHash, resourceJson, localState, createState, stableReceipt, persistedCreateBody, providerOrderId, checkoutIssuedAtMs, refundRequiredReason, createdAtMs)
      VALUES (?, ?, 'human', ?, ?, ?, ?, ?, ?, ?, 'AWAITING_PAYMENT', ?, ?, ?, NULL, NULL, NULL, ?)`)
      .run(orderId, runId, intent.id, intent.version, input.clientCommandId, requestHash, JSON.stringify(quote), quote.contentHash, JSON.stringify(resource), row.mode === "MOCK" ? "NOT_SENT" : "SENT", receipt, JSON.stringify(createBody), now);
    db.prepare("UPDATE runs SET clockMs = ?, version = version + 1 WHERE id = ?").run(now, runId);
    db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, ?, 'OFFER_ACCEPTED', ?, ?, ?)`)
      .run(runId, orderId, now, JSON.stringify({ dishId: dish.id, intentId: intent.id, intentVersion: intent.version }), `${dish.name} stock and ${dish.stationId} capacity were reserved atomically.`);
    if (row.mode === "RAZORPAY_TEST") {
      db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, ?, 'ORDER_CREATE_SENT', ?, ?, ?)`)
        .run(runId, orderId, now, JSON.stringify({ amountPaise: dish.pricePaise, receipt }), "The accepted quote's exact test Order request was persisted before contacting Razorpay.");
    }
  })();
  return orderId;
}
