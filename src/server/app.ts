import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { acceptQuoteRequestSchema, checkoutConfirmationSchema, confirmIntentRequestSchema, createRunRequestSchema, createSmokeOrderRequestSchema, mealRequestSchema, mockPaymentRequestSchema, resumeRunRequestSchema, stationCommandSchema } from "../shared/contracts.js";
import type { RunMode } from "../shared/contracts.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { openDatabase, type RasoiDatabase } from "./db.js";
import { authenticateRun, createRun, getAuditExport, getRunSnapshot, rotateRunToken, setStationStatus, stopSales } from "./run-store.js";
import { razorpayWebhookRoutes } from "./webhooks.js";
import { acceptQuote, confirmIntent, createStationAlternative, DomainFlowError, submitMealRequest } from "./domain.js";
import {
  checkOrderStatus,
  confirmCheckoutPayment,
  createGateAOrder,
  createPersistedProviderOrder,
  createPaymentProvider,
  createStationFailureObligations,
  dispatchRequiredRefunds,
  issueCheckoutConfig,
  PaymentFlowError,
  ProviderRequestError,
  type PaymentProvider
} from "./payments.js";
import { recoverInterruptedFinancialWork, startFinancialReconciler } from "./reconciliation.js";
import { settleMockPayment, startKitchenLifecycle } from "./mock-lifecycle.js";

declare module "fastify" {
  interface FastifyInstance {
    db: RasoiDatabase;
    config: AppConfig;
    paymentProvider: PaymentProvider | null;
  }
}

function codesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function errorReply(reply: FastifyReply, statusCode: number, code: string, message: string, requestId: string) {
  return reply.status(statusCode).send({ code, message, requestId });
}

function matchesConfiguredCode(accessCode: string | undefined, config: AppConfig): boolean {
  return Boolean(accessCode && config.demoAccessCode && codesMatch(accessCode, config.demoAccessCode));
}

function isPublicRunRequest(accessCode: string | undefined, _mode: RunMode, config: AppConfig): boolean {
  return config.publicDemoEnabled && !accessCode;
}

function isPublicRun(db: RasoiDatabase, runId: string): boolean {
  const row = db.prepare("SELECT mode FROM runs WHERE id = ?").get(runId) as { mode: RunMode } | undefined;
  return Boolean(row);
}

function isEquivalentDevelopmentOrigin(actual: string | undefined, configured: string): boolean {
  if (!actual) return false;
  try {
    const actualUrl = new URL(actual);
    const configuredUrl = new URL(configured);
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return actualUrl.protocol === configuredUrl.protocol
      && actualUrl.port === configuredUrl.port
      && loopbackHosts.has(actualUrl.hostname)
      && loopbackHosts.has(configuredUrl.hostname);
  } catch {
    return false;
  }
}

function requireBrowserOrigin(request: FastifyRequest, reply: FastifyReply, config: AppConfig, publicMock = false): boolean {
  if (config.publicDemoEnabled && publicMock) return true;
  const matchesOrigin = request.headers.origin === config.appOrigin
    || (config.nodeEnv === "development" && isEquivalentDevelopmentOrigin(request.headers.origin, config.appOrigin));
  if (!matchesOrigin) {
    void errorReply(reply, 403, "ORIGIN_REJECTED", "This request did not come from the configured RASOI app.", request.id);
    return false;
  }
  return true;
}

function requireRun(request: FastifyRequest, reply: FastifyReply, runId: string): boolean {
  if (!authenticateRun(request.server.db, runId, request.cookies.rasoi_demo)) {
    void errorReply(reply, 401, "ACCESS_REQUIRED", "This demo session is no longer active. Re-enter the private demo access code or start a new run.", request.id);
    return false;
  }
  return true;
}

export async function buildApp(config: AppConfig, dependencies: { paymentProvider?: PaymentProvider | null } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== "test" ? { redact: ["req.headers.cookie", "req.body.accessCode"] } : false,
    bodyLimit: 256 * 1024
  });
  const db = openDatabase(config.databasePath);
  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("paymentProvider", dependencies.paymentProvider === undefined ? createPaymentProvider(config) : dependencies.paymentProvider);
  recoverInterruptedFinancialWork(db);
  const isVercel = Boolean(process.env.VERCEL);
  const stopReconciler = app.paymentProvider && config.nodeEnv !== "test" && !isVercel
    ? startFinancialReconciler(db, app.paymentProvider, { onError: (error) => app.log.error({ err: error }, "financial reconciliation failed") })
    : null;
  const stopKitchenLifecycle = config.nodeEnv !== "test" && !isVercel ? startKitchenLifecycle(db, 1_000, (error) => app.log.error({ err: error }, "kitchen lifecycle failed")) : null;
  app.addHook("onClose", async () => {
    await stopReconciler?.();
    stopKitchenLifecycle?.();
    db.close();
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(razorpayWebhookRoutes, { prefix: "/api/webhooks" });

  const webRoot = resolve(process.cwd(), "dist/web");
  if (config.nodeEnv === "production" && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
      return errorReply(reply, 404, "NOT_FOUND", "That RASOI endpoint does not exist.", request.id);
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      void errorReply(reply, 400, "INVALID_REQUEST", "Check the submitted fields and try again.", request.id);
      return;
    }
    if (error instanceof PaymentFlowError) {
      void errorReply(reply, error.statusCode, error.code, error.message, request.id);
      return;
    }
    if (error instanceof DomainFlowError) {
      void errorReply(reply, error.statusCode, error.code, error.message, request.id);
      return;
    }
    if (error instanceof ProviderRequestError) {
      void errorReply(reply, 502, "PROVIDER_UNAVAILABLE", "Razorpay did not return a usable response. Check status before trying again.", request.id);
      return;
    }
    request.log.error({ err: error }, "request failed");
    void errorReply(reply, 500, "INTERNAL_ERROR", "RASOI could not complete that request.", request.id);
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.post("/api/runs", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = createRunRequestSchema.parse(request.body);
    const publicRunRequest = isPublicRunRequest(input.accessCode, input.mode, config);
    if (!requireBrowserOrigin(request, reply, config, publicRunRequest)) return;
    if (!publicRunRequest && !matchesConfiguredCode(input.accessCode, config)) {
      return errorReply(reply, 401, "ACCESS_REQUIRED", "This run requires the private demo access code.", request.id);
    }
    if (input.mode === "RAZORPAY_TEST" && !config.allowRazorpayTest) {
      return errorReply(reply, 409, "MODE_MISMATCH", "Razorpay test mode is disabled until test credentials are configured.", request.id);
    }

    const result = createRun(db, input.mode);
    reply.setCookie("rasoi_demo", result.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.nodeEnv === "production",
      path: "/",
      maxAge: 60 * 60
    });
    return reply.status(201).send({ runId: result.runId });
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = resumeRunRequestSchema.parse(request.body);
    const run = db.prepare("SELECT mode FROM runs WHERE id = ?").get(request.params.id) as { mode: RunMode } | undefined;
    const publicResume = config.publicDemoEnabled && Boolean(run) && !input.accessCode;
    if (!requireBrowserOrigin(request, reply, config, publicResume)) return;
    if (!publicResume && !matchesConfiguredCode(input.accessCode, config)) return errorReply(reply, 401, "ACCESS_REQUIRED", "This run requires the private demo access code.", request.id);
    const result = rotateRunToken(db, request.params.id);
    if (!result) return errorReply(reply, 404, "RUN_NOT_FOUND", "This run does not exist.", request.id);
    reply.setCookie("rasoi_demo", result.token, { httpOnly: true, sameSite: "strict", secure: config.nodeEnv === "production", path: "/", maxAge: 60 * 60 });
    return { runId: request.params.id };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/state", async (request, reply) => {
    if (!requireRun(request, reply, request.params.id)) return;
    const snapshot = getRunSnapshot(db, request.params.id, config.allowRazorpayTest);
    if (!snapshot) return errorReply(reply, 404, "RUN_NOT_FOUND", "This run does not exist.", request.id);
    return snapshot;
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/audit", async (request, reply) => {
    if (!requireRun(request, reply, request.params.id)) return;
    const audit = getAuditExport(db, request.params.id);
    if (!audit) return errorReply(reply, 404, "RUN_NOT_FOUND", "This run does not exist.", request.id);
    return audit;
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop-sales", async (request, reply) => {
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, request.params.id))) return;
    if (!requireRun(request, reply, request.params.id)) return;
    stopSales(db, request.params.id);
    return getRunSnapshot(db, request.params.id, config.allowRazorpayTest);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/station", async (request, reply) => {
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, request.params.id))) return;
    if (!requireRun(request, reply, request.params.id)) return;
    const command = stationCommandSchema.parse(request.body);
    const offerInvalidated = setStationStatus(db, request.params.id, command.stationId, command.status);
    if (command.status === "DOWN") {
      createStationFailureObligations(db, request.params.id, command.stationId);
      if (app.paymentProvider) await dispatchRequiredRefunds(db, app.paymentProvider, request.params.id);
      if (offerInvalidated) createStationAlternative(db, request.params.id, command.stationId);
    }
    return getRunSnapshot(db, request.params.id, config.allowRazorpayTest);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/request", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, request.params.id))) return;
    if (!requireRun(request, reply, request.params.id)) return;
    const input = mealRequestSchema.parse(request.body);
    submitMealRequest(db, request.params.id, input.requestId, input.text);
    return getRunSnapshot(db, request.params.id, config.allowRazorpayTest);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/confirm-intent", async (request, reply) => {
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, request.params.id))) return;
    if (!requireRun(request, reply, request.params.id)) return;
    const input = confirmIntentRequestSchema.parse(request.body);
    confirmIntent(db, request.params.id, {
      id: input.intentId, version: input.intentVersion, budgetPaise: input.budgetPaise,
      latestReadyAtMs: input.latestReadyAtMs, excludedIngredients: input.excludedIngredients,
      preferredDishIds: input.preferredDishIds, allowSubstitutes: input.allowSubstitutes
    });
    return getRunSnapshot(db, request.params.id, config.allowRazorpayTest);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/accept", async (request, reply) => {
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, request.params.id))) return;
    if (!requireRun(request, reply, request.params.id)) return;
    const input = acceptQuoteRequestSchema.parse(request.body);
    const run = db.prepare("SELECT mode FROM runs WHERE id = ?").get(request.params.id) as { mode: "MOCK" | "RAZORPAY_TEST" };
    if (run.mode === "RAZORPAY_TEST" && !app.paymentProvider) return errorReply(reply, 409, "MODE_MISMATCH", "Razorpay test credentials are not configured.", request.id);
    const orderId = acceptQuote(db, request.params.id, input);
    if (run.mode === "RAZORPAY_TEST") await createPersistedProviderOrder(db, app.paymentProvider!, orderId);
    return reply.status(201).send(getRunSnapshot(db, request.params.id, config.allowRazorpayTest));
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/gate-a-order", {
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, request.params.id))) return;
    if (!requireRun(request, reply, request.params.id)) return;
    if (!app.paymentProvider) return errorReply(reply, 409, "MODE_MISMATCH", "Razorpay test credentials are not configured.", request.id);
    const input = createSmokeOrderRequestSchema.parse(request.body);
    await createGateAOrder(db, app.paymentProvider, request.params.id, input.clientCommandId);
    return reply.status(201).send(getRunSnapshot(db, request.params.id, config.allowRazorpayTest));
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/checkout", async (request, reply) => {
    const order = db.prepare("SELECT runId FROM orders WHERE id = ?").get(request.params.id) as { runId: string } | undefined;
    if (!order) return errorReply(reply, 404, "ORDER_NOT_FOUND", "This order does not exist.", request.id);
    if (!requireBrowserOrigin(request, reply, config)) return;
    if (!requireRun(request, reply, order.runId)) return;
    if (!config.razorpayKeyId) return errorReply(reply, 409, "MODE_MISMATCH", "Razorpay test credentials are not configured.", request.id);
    return issueCheckoutConfig(db, request.params.id, config.razorpayKeyId);
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/mock-payment", async (request, reply) => {
    const order = db.prepare("SELECT runId FROM orders WHERE id = ?").get(request.params.id) as { runId: string } | undefined;
    if (!order) return errorReply(reply, 404, "ORDER_NOT_FOUND", "This order does not exist.", request.id);
    if (!requireBrowserOrigin(request, reply, config, isPublicRun(db, order.runId))) return;
    if (!requireRun(request, reply, order.runId)) return;
    const input = mockPaymentRequestSchema.parse(request.body);
    settleMockPayment(db, request.params.id, input.outcome);
    return getRunSnapshot(db, order.runId, config.allowRazorpayTest);
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/confirm", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const order = db.prepare("SELECT runId FROM orders WHERE id = ?").get(request.params.id) as { runId: string } | undefined;
    if (!order) return errorReply(reply, 404, "ORDER_NOT_FOUND", "This order does not exist.", request.id);
    if (!requireBrowserOrigin(request, reply, config)) return;
    if (!requireRun(request, reply, order.runId)) return;
    if (!app.paymentProvider || !config.razorpayKeySecret) return errorReply(reply, 409, "MODE_MISMATCH", "Razorpay test credentials are not configured.", request.id);
    const input = checkoutConfirmationSchema.parse(request.body);
    await confirmCheckoutPayment(db, app.paymentProvider, request.params.id, input, config.razorpayKeySecret);
    return getRunSnapshot(db, order.runId, config.allowRazorpayTest);
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/check", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const order = db.prepare("SELECT runId FROM orders WHERE id = ?").get(request.params.id) as { runId: string } | undefined;
    if (!order) return errorReply(reply, 404, "ORDER_NOT_FOUND", "This order does not exist.", request.id);
    if (!requireBrowserOrigin(request, reply, config)) return;
    if (!requireRun(request, reply, order.runId)) return;
    if (!app.paymentProvider) return errorReply(reply, 409, "MODE_MISMATCH", "Razorpay test credentials are not configured.", request.id);
    await checkOrderStatus(db, app.paymentProvider, request.params.id);
    await dispatchRequiredRefunds(db, app.paymentProvider, order.runId);
    return getRunSnapshot(db, order.runId, config.allowRazorpayTest);
  });

  return app;
}

async function start() {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  void start();
}
