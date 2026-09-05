import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IntentState, RunMode, RunSnapshot, StationId } from "../shared/contracts.js";
import type { RasoiDatabase } from "./db.js";

const INITIAL_STATIONS = {
  tawa: { status: "UP" as const, activeOrderId: null },
  bowls: { status: "UP" as const, activeOrderId: null }
};

const INITIAL_STOCK = {
  batter: 6,
  oil: 6,
  potato_mix: 3,
  rice: 6,
  lemon_mix: 3,
  peanuts: 3,
  curd: 3
};

const ACTORS = [
  { id: "human", name: "You", kind: "HUMAN" as const, status: "READY" as const },
  { id: "asha", name: "Asha", kind: "SCRIPTED" as const, status: "READY" as const },
  { id: "kabir", name: "Kabir", kind: "SCRIPTED" as const, status: "READY" as const }
];

type RunRow = {
  id: string;
  mode: RunMode;
  tokenHash: string;
  tokenExpiresAtMs: number;
  clockMs: number;
  version: number;
  stationJson: string;
  stockJson: string;
  actorJson: string;
  latestIntentJson: string | null;
  salesStopped: 0 | 1;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createRun(db: RasoiDatabase, mode: RunMode, now = Date.now()) {
  const runId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const actors = mode === "MOCK"
    ? ACTORS
    : ACTORS.map((actor) => actor.kind === "SCRIPTED" ? { ...actor, status: "INACTIVE" as const } : actor);

  const insert = db.prepare(`
    INSERT INTO runs (
      id, mode, tokenHash, tokenExpiresAtMs, scenario, clockMs, version,
      stationJson, stockJson, actorJson, latestIntentJson, salesStopped, createdAtMs
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, 0, ?)
  `);

  const appendEvent = db.prepare(`
    INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason)
    VALUES (?, NULL, 'RUN_CREATED', ?, ?, ?)
  `);

  db.transaction(() => {
    insert.run(
      runId,
      mode,
      tokenHash,
      now + 60 * 60 * 1000,
      "interactive",
      now,
      JSON.stringify(INITIAL_STATIONS),
      JSON.stringify(INITIAL_STOCK),
      JSON.stringify(actors),
      now
    );
    appendEvent.run(runId, now, JSON.stringify({ mode }), `${mode === "MOCK" ? "Simulated" : "Razorpay test"} run started.`);
  })();

  return { runId, token };
}

export function rotateRunToken(db: RasoiDatabase, runId: string, now = Date.now()): { token: string } | null {
  const exists = db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
  if (!exists) return null;
  const token = randomBytes(32).toString("base64url");
  db.transaction(() => {
    db.prepare("UPDATE runs SET tokenHash = ?, tokenExpiresAtMs = ?, version = version + 1 WHERE id = ?")
      .run(hashToken(token), now + 60 * 60 * 1000, runId);
    db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, NULL, 'RUN_RESUMED', ?, '{}', ?)`)
      .run(runId, now, "Access was reauthenticated and the run token was rotated.");
  })();
  return { token };
}

export function stopSales(db: RasoiDatabase, runId: string, now = Date.now()): void {
  const changed = db.prepare("UPDATE runs SET salesStopped = 1, clockMs = ?, version = version + 1 WHERE id = ? AND salesStopped = 0")
    .run(now, runId);
  if (changed.changes === 1) {
    db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, NULL, 'SALES_STOPPED', ?, '{}', ?)`)
      .run(runId, now, "New meal acceptance was stopped; existing fulfillment and financial recovery remain active.");
  }
}

export function getAuditExport(db: RasoiDatabase, runId: string, now = Date.now()) {
  const exists = db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
  if (!exists) return null;
  const rows = db.prepare(`
    SELECT sequence, type, timeMs, reason, orderId, detailsJson
    FROM events WHERE runId = ? ORDER BY sequence
  `).all(runId) as Array<{ sequence: number; type: string; timeMs: number; reason: string; orderId: string | null; detailsJson: string }>;
  return {
    runId,
    exportedAtMs: now,
    auditType: "append-only-application-audit" as const,
    events: rows.map(({ detailsJson, ...event }) => ({ ...event, details: JSON.parse(detailsJson) as Record<string, unknown> }))
  };
}

export function authenticateRun(db: RasoiDatabase, runId: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const row = db.prepare("SELECT tokenHash, tokenExpiresAtMs FROM runs WHERE id = ?").get(runId) as Pick<RunRow, "tokenHash" | "tokenExpiresAtMs"> | undefined;
  return Boolean(row && row.tokenExpiresAtMs > now && row.tokenHash === hashToken(token));
}

export function getRunSnapshot(db: RasoiDatabase, runId: string, razorpayEnabled: boolean): RunSnapshot | null {
  const row = db.prepare(`
    SELECT id, mode, tokenHash, tokenExpiresAtMs, clockMs, version,
           stationJson, stockJson, actorJson, latestIntentJson, salesStopped
    FROM runs WHERE id = ?
  `).get(runId) as RunRow | undefined;
  if (!row) return null;

  const eventRows = db.prepare(`
    SELECT sequence, type, timeMs, reason, orderId, detailsJson
    FROM events WHERE runId = ? ORDER BY sequence DESC LIMIT 100
  `).all(runId) as Array<{ sequence: number; type: string; timeMs: number; reason: string; orderId: string | null; detailsJson: string }>;

  const order = db.prepare(`
    SELECT id, resourceJson, localState, createState, checkoutIssuedAtMs, providerOrderId
    FROM orders WHERE runId = ? ORDER BY createdAtMs DESC LIMIT 1
  `).get(runId) as {
    id: string;
    resourceJson: string;
    localState: NonNullable<RunSnapshot["currentOrder"]>["localState"];
    createState: NonNullable<RunSnapshot["currentOrder"]>["createState"];
    checkoutIssuedAtMs: number | null;
    providerOrderId: string | null;
  } | undefined;

  let currentOrder: RunSnapshot["currentOrder"] = null;
  if (order) {
    const resource = JSON.parse(order.resourceJson) as {
      dishId: string;
      dishName: string;
      amountPaise: number;
      currency: "INR";
      stationId: StationId;
    };
    const payment = db.prepare(`
      SELECT providerPaymentId, status FROM payments WHERE orderId = ?
      ORDER BY CASE WHEN status = 'captured' THEN 1 ELSE 0 END DESC, lastObservedAtMs DESC LIMIT 1
    `).get(order.id) as { providerPaymentId: string; status: string } | undefined;
    const refund = db.prepare(`
      SELECT providerRefundId, state FROM refunds WHERE orderId = ? ORDER BY createdAtMs DESC LIMIT 1
    `).get(order.id) as { providerRefundId: string | null; state: NonNullable<RunSnapshot["currentOrder"]>["refundState"] } | undefined;

    currentOrder = {
      id: order.id,
      ...resource,
      localState: order.localState,
      createState: order.createState,
      paymentStatus: payment?.status ?? null,
      refundState: refund?.state ?? null,
      checkoutIssued: order.checkoutIssuedAtMs !== null,
      providerOrderIdSuffix: order.providerOrderId?.slice(-8) ?? null,
      providerPaymentIdSuffix: payment?.providerPaymentId.slice(-8) ?? null,
      providerRefundIdSuffix: refund?.providerRefundId?.slice(-8) ?? null
    };
  }

  return {
    runId: row.id,
    mode: row.mode,
    clockMs: row.clockMs,
    version: row.version,
    stations: JSON.parse(row.stationJson) as RunSnapshot["stations"],
    stock: JSON.parse(row.stockJson) as RunSnapshot["stock"],
    actors: JSON.parse(row.actorJson) as RunSnapshot["actors"],
    salesStopped: Boolean(row.salesStopped),
    razorpayEnabled,
    intent: row.latestIntentJson ? JSON.parse(row.latestIntentJson) as RunSnapshot["intent"] : null,
    currentOrder,
    events: eventRows.map(({ detailsJson, ...event }) => ({
      ...event,
      details: JSON.parse(detailsJson) as Record<string, unknown>
    }))
  };
}

export function setStationStatus(db: RasoiDatabase, runId: string, stationId: StationId, status: "UP" | "DOWN", now = Date.now()): boolean {
  const row = db.prepare("SELECT stationJson, latestIntentJson FROM runs WHERE id = ?").get(runId) as { stationJson: string; latestIntentJson: string | null } | undefined;
  if (!row) throw new Error("Run not found");
  const stations = JSON.parse(row.stationJson) as RunSnapshot["stations"];
  const previous = stations[stationId].status;
  if (previous === status) return false;
  stations[stationId] = { ...stations[stationId], status, activeOrderId: status === "DOWN" ? null : stations[stationId].activeOrderId };
  let latestIntentJson = row.latestIntentJson;
  let invalidatedQuoteId: string | null = null;
  if (status === "DOWN" && latestIntentJson) {
    const intentState = JSON.parse(latestIntentJson) as IntentState;
    if (intentState.quote?.stationId === stationId) {
      const accepted = db.prepare("SELECT 1 FROM orders WHERE runId = ? AND intentId = ? AND intentVersion = ?")
        .get(runId, intentState.quote.intentId, intentState.quote.intentVersion);
      if (!accepted) {
        invalidatedQuoteId = intentState.quote.id;
        latestIntentJson = JSON.stringify({ ...intentState, quote: null });
      }
    }
  }

  db.transaction(() => {
    db.prepare("UPDATE runs SET stationJson = ?, latestIntentJson = ?, clockMs = ?, version = version + 1 WHERE id = ?")
      .run(JSON.stringify(stations), latestIntentJson, now, runId);
    db.prepare(`
      INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason)
      VALUES (?, NULL, ?, ?, ?, ?)
    `).run(
      runId,
      status === "DOWN" ? "STATION_DISABLED" : "STATION_REPAIRED",
      now,
      JSON.stringify({ stationId, previous, status }),
      `${stationId === "tawa" ? "Tawa" : "Bowl station"} marked ${status.toLowerCase()}.`
    );
    if (invalidatedQuoteId) {
      db.prepare(`INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason) VALUES (?, NULL, 'OFFER_INVALIDATED', ?, ?, ?)`)
        .run(runId, now, JSON.stringify({ quoteId: invalidatedQuoteId, stationId }), `The ${stationId} became unavailable, so its unaccepted offer was invalidated.`);
    }
  })();
  return invalidatedQuoteId !== null;
}
