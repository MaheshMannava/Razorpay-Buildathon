PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('MOCK', 'RAZORPAY_TEST')),
  tokenHash TEXT NOT NULL,
  tokenExpiresAtMs INTEGER NOT NULL,
  scenario TEXT NOT NULL,
  clockMs INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  stationJson TEXT NOT NULL,
  stockJson TEXT NOT NULL,
  actorJson TEXT NOT NULL,
  latestIntentJson TEXT,
  salesStopped INTEGER NOT NULL DEFAULT 0 CHECK (salesStopped IN (0, 1)),
  createdAtMs INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id),
  actorId TEXT NOT NULL,
  intentId TEXT NOT NULL,
  intentVersion INTEGER NOT NULL,
  clientCommandId TEXT NOT NULL,
  requestHash TEXT NOT NULL,
  immutableQuoteJson TEXT NOT NULL,
  quoteHash TEXT NOT NULL,
  resourceJson TEXT NOT NULL,
  localState TEXT NOT NULL,
  createState TEXT NOT NULL,
  stableReceipt TEXT NOT NULL UNIQUE,
  persistedCreateBody TEXT NOT NULL,
  providerOrderId TEXT UNIQUE,
  checkoutIssuedAtMs INTEGER,
  providerCreateClaimedAtMs INTEGER,
  paymentCheckAttempts INTEGER NOT NULL DEFAULT 0,
  nextPaymentCheckAtMs INTEGER,
  refundRequiredReason TEXT,
  createdAtMs INTEGER NOT NULL,
  UNIQUE (runId, clientCommandId),
  UNIQUE (runId, intentId, intentVersion)
);

CREATE TABLE IF NOT EXISTS payments (
  providerPaymentId TEXT PRIMARY KEY,
  orderId TEXT NOT NULL REFERENCES orders(id),
  providerOrderId TEXT NOT NULL,
  amountPaise INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  amountRefundedPaise INTEGER NOT NULL DEFAULT 0,
  lastObservedAtMs INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  orderId TEXT NOT NULL REFERENCES orders(id),
  paymentId TEXT NOT NULL REFERENCES payments(providerPaymentId),
  amountPaise INTEGER NOT NULL,
  reason TEXT NOT NULL,
  stableKey TEXT NOT NULL UNIQUE,
  immutableBody TEXT NOT NULL,
  providerRefundId TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  nextCheckAtMs INTEGER,
  createdAtMs INTEGER NOT NULL,
  UNIQUE (paymentId, reason)
);

CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_id_unique
ON refunds(providerRefundId)
WHERE providerRefundId IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_inbox (
  eventId TEXT PRIMARY KEY,
  payloadHash TEXT NOT NULL,
  normalizedJson TEXT NOT NULL,
  receivedAtMs INTEGER NOT NULL,
  processedAtMs INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  runId TEXT NOT NULL REFERENCES runs(id),
  orderId TEXT REFERENCES orders(id),
  type TEXT NOT NULL,
  timeMs INTEGER NOT NULL,
  detailsJson TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(runId, sequence);

CREATE TABLE IF NOT EXISTS agent_calls (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id),
  requestId TEXT NOT NULL,
  inputHash TEXT NOT NULL,
  modelVersion TEXT NOT NULL,
  promptVersion TEXT NOT NULL,
  extractionJson TEXT NOT NULL,
  latencyMs INTEGER NOT NULL,
  validationResult TEXT NOT NULL,
  createdAtMs INTEGER NOT NULL,
  UNIQUE (runId, requestId)
);
