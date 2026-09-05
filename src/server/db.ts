import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RasoiDatabase = Database.Database;

function ensureColumn(db: RasoiDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDatabase(path: string): RasoiDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }

  const migrationPath = resolve(process.cwd(), "migrations/001_initial.sql");
  db.exec(readFileSync(migrationPath, "utf8"));
  // Keep the original seven-table design while upgrading databases created by
  // earlier development slices.
  ensureColumn(db, "orders", "paymentCheckAttempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "nextPaymentCheckAtMs", "INTEGER");
  ensureColumn(db, "orders", "providerCreateClaimedAtMs", "INTEGER");
  return db;
}
