# RASOI

RASOI is a capacity-aware ordering system for food commerce. It converts a natural-language meal request into an offer only after verifying the requested constraints against the kitchen's recipes, inventory, station availability, and production capacity.

Payment begins after the customer accepts a feasible offer. RASOI creates the Razorpay order on the server, uses Razorpay-hosted Checkout, verifies the callback signature and provider state, and starts fulfillment only after confirming a captured payment. If the assigned station fails after capture, the order is cancelled and a full refund obligation is recorded and reconciled.

Built for the Razorpay Buildathon.

## System flow

```text
Customer request
      │
      ▼
Constraint extraction ── budget · deadline · exclusions · preference
      │
      ▼
Feasibility engine ───── recipes · inventory · stations · capacity
      │
      ▼
Server-priced offer
      │ customer accepts
      ▼
Atomic reservation ───── stock · station interval · idempotency record
      │
      ▼
Razorpay order ───────── hosted Checkout · signature verification
      │ captured payment
      ▼
Fulfillment ──────────── or cancellation + full refund obligation
      │
      ▼
Append-only event timeline
```

## Design guarantees

- **Feasibility before payment.** An offer is produced only when the kitchen can satisfy the confirmed constraints.
- **Server-owned commercial state.** Prices, recipes, inventory, capacity, payment state, and refund state are never trusted from the browser.
- **Atomic acceptance.** Quote validation, stock reservation, and station-capacity reservation occur in one SQLite transaction.
- **Idempotent financial operations.** Duplicate acceptance cannot create a second provider order; refund requests persist an immutable body and stable idempotency key.
- **Verified payment state.** Checkout signatures are validated server-side, then payment details are fetched from Razorpay and matched by provider order, amount, currency, and capture status.
- **Recoverable failure handling.** Pre-payment station failures invalidate the offer and may produce an alternative. Post-capture failures create a full refund obligation.
- **Auditable transitions.** Material decisions and state changes are written to an append-only server timeline.

## Architecture

| Component | Responsibility |
|---|---|
| React application | Request entry, constraint confirmation, offer review, Checkout launch, operational controls, and accessible kitchen state |
| Fastify API | Session isolation, validation, orchestration, provider integration, and authoritative state transitions |
| Constraint engine | Deterministic extraction and clarification of budget, deadline, exclusions, preference, and substitution policy |
| Feasibility engine | Recipe matching, exclusion checks, inventory availability, station health, interval capacity, and offer expiry |
| SQLite ledger | Runs, intents, quotes, orders, payments, refunds, reservations, and timeline events |
| Razorpay integration | Test Order creation, hosted Checkout, signature verification, payment observation, refund submission, and signed webhooks |
| Reconciliation workers | Recovery of interrupted payment and refund work and progression of the kitchen lifecycle |

The frontend renders a Three.js kitchen view from confirmed server state. An accessible HTML representation remains available when WebGL is unavailable or reduced motion is enabled.

## Repository layout

```text
api/                  Vercel function adapter
migrations/           SQLite schema migrations
scripts/              Evaluation, benchmark, and webhook utilities
src/server/            API, domain, persistence, provider, and reconciliation code
src/shared/            Shared schemas and API contracts
src/web/               React application and kitchen visualization
tests/                 Unit, integration, provider, and browser tests
```

## Requirements

- Node.js `22.23.1`
- pnpm `9.15.0`
- Razorpay Test Mode account for provider-backed payment flows

Runtime and package-manager versions are pinned in `package.json`. Production dependency versions are exact and the lockfile is committed.

## Local development

Install dependencies and create the local configuration:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

For provider-backed payments, configure these values in `.env`:

```dotenv
ALLOW_RAZORPAY_TEST=true
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

Start the API and web application:

```sh
pnpm dev
```

Open <http://localhost:5173>. Only the Razorpay Test Key ID is sent to the browser. The key secret and webhook secret remain server-side. Test Mode uses Razorpay's provider endpoints and hosted Checkout but does not move real money.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | API bind address |
| `PORT` | `3001` | API port |
| `APP_ORIGIN` | `http://localhost:5173` | Trusted browser origin for payment-sensitive requests |
| `DATABASE_PATH` | `./data/rasoi.sqlite` | SQLite database location |
| `PUBLIC_DEMO_ENABLED` | `true` | Allows public creation of isolated Razorpay Test Mode runs |
| `ALLOW_RAZORPAY_TEST` | `false` | Enables the Razorpay provider integration |
| `RAZORPAY_KEY_ID` | — | Razorpay Test Mode public key identifier |
| `RAZORPAY_KEY_SECRET` | — | Razorpay Test Mode API secret |
| `RAZORPAY_WEBHOOK_SECRET` | — | Secret used to verify raw webhook payloads |
| `AGENT_MODE` | `scripted` | Selects deterministic or OpenAI-backed constraint extraction |
| `OPENAI_API_KEY` | — | Required only when `AGENT_MODE=openai` |
| `LLM_MODEL` | — | Model used by the optional OpenAI extraction path |

Environment files, local databases, logs, build output, and provider audit exports are excluded from version control.

## Webhooks

Razorpay sends signed events to:

```text
POST /api/webhooks/razorpay
```

The handler verifies the HMAC over the raw request body before parsing, deduplicates events, and ignores events that cannot be associated with a persisted RASOI provider order.

For local webhook delivery, expose only the webhook proxy:

```sh
pnpm dev:webhook-proxy
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3003
```

Configure the resulting HTTPS endpoint in the Razorpay Test Mode dashboard. Quick Tunnel URLs are temporary and must be updated when they change.

## Verification

Run the complete local verification suite:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Current baseline:

| Check | Result |
|---|---:|
| TypeScript | Pass |
| ESLint | Pass |
| Unit and integration tests | 41 passing |
| Playwright browser tests | 6 passing |
| Production build | Pass |
| Production dependency audit | No known vulnerabilities |

Tests use controlled provider implementations and do not create Razorpay orders or initiate payments.

Additional offline evaluations:

```sh
pnpm eval:intents
pnpm benchmark
```

The language evaluation measures constraint extraction against curated fixtures. The economics benchmark compares scheduling policies over synthetic workloads; it is not evidence of production revenue or profitability.

## Security model

- Run sessions use cryptographically random tokens stored in HttpOnly, SameSite=Strict cookies; only token hashes are persisted.
- Payment-sensitive browser requests are restricted to the configured application origin.
- Request payloads and provider responses are validated with Zod schemas.
- SQL request values are parameterized.
- Provider calls use bounded timeouts.
- Checkout signatures and webhook signatures are verified with HMAC-SHA256.
- Payment observations must match the server-owned provider order, amount, and currency.
- Cookies and access credentials are redacted from application logs.
- Razorpay configuration accepts Test Mode key identifiers only.

This repository models kitchen operations in software and is not connected to physical kitchen equipment. Razorpay interactions use Test Mode credentials and do not move real funds.

## Deployment

The current implementation is designed for a long-lived Node.js process with persistent local storage. Deploy it on infrastructure that provides:

- durable storage for the SQLite database, or a migration to a shared transactional database;
- a continuously reachable HTTPS webhook endpoint;
- persistent reconciliation and lifecycle workers;
- securely managed Razorpay environment variables; and
- a fixed `APP_ORIGIN` matching the public application URL.

The included Vercel adapter uses ephemeral function storage and disables background workers. It is suitable for frontend and API evaluation only; it is **not approved for provider-backed payment or refund workflows** until persistence and reconciliation are moved to shared durable infrastructure.

## License

No license has been granted for this repository. Add an explicit license before accepting external contributions or reuse.
