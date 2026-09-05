import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RasoiDatabase } from "../src/server/db.js";
import { openDatabase } from "../src/server/db.js";
import { createRun, getRunSnapshot, setStationStatus } from "../src/server/run-store.js";

describe("run store", () => {
  let db: RasoiDatabase;
  beforeEach(() => { db = openDatabase(":memory:"); });
  afterEach(() => db.close());

  it("creates the seven required tables", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["runs", "orders", "payments", "refunds", "webhook_inbox", "events", "agent_calls"]));
  });

  it("changes station state and appends an audit event atomically", () => {
    const { runId } = createRun(db, "MOCK", 1_000);
    setStationStatus(db, runId, "tawa", "DOWN", 2_000);
    const snapshot = getRunSnapshot(db, runId, false);
    expect(snapshot?.stations.tawa.status).toBe("DOWN");
    expect(snapshot?.version).toBe(2);
    expect(snapshot?.events[0]).toMatchObject({ type: "STATION_DISABLED", timeMs: 2_000 });
  });
});
