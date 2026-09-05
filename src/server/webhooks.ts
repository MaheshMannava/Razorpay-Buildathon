import type { FastifyPluginAsync } from "fastify";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { applyPaymentObservation, PaymentFlowError } from "./payments.js";

const SUPPORTED_EVENTS = new Set([
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.created",
  "refund.processed",
  "refund.failed"
]);

const entitySchema = z.object({
  id: z.string().optional(),
  order_id: z.string().nullable().optional(),
  payment_id: z.string().optional(),
  amount: z.number().int().nonnegative().optional(),
  amount_refunded: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  status: z.string().optional()
}).passthrough();

const webhookSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: entitySchema }).optional(),
    order: z.object({ entity: entitySchema }).optional(),
    refund: z.object({ entity: entitySchema }).optional()
  }).passthrough()
}).passthrough();

function signaturesMatch(body: Buffer, signature: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "hex");
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function findOwnedOrder(app: Parameters<FastifyPluginAsync>[0], providerOrderId: string | undefined, providerPaymentId: string | undefined) {
  if (providerOrderId) {
    return app.db.prepare("SELECT id, runId FROM orders WHERE providerOrderId = ?").get(providerOrderId) as { id: string; runId: string } | undefined;
  }
  if (providerPaymentId) {
    return app.db.prepare(`
      SELECT orders.id, orders.runId
      FROM payments JOIN orders ON orders.id = payments.orderId
      WHERE payments.providerPaymentId = ?
    `).get(providerPaymentId) as { id: string; runId: string } | undefined;
  }
  return undefined;
}

export const razorpayWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/razorpay", async (request, reply) => {
    const secret = app.config.razorpayWebhookSecret;
    if (!secret) return reply.status(503).send({ code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook verification is not configured.", requestId: request.id });

    const body = request.body;
    const signatureHeader = request.headers["x-razorpay-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!Buffer.isBuffer(body) || !signature || !signaturesMatch(body, signature, secret)) {
      return reply.status(401).send({ code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature verification failed.", requestId: request.id });
    }

    let parsed: z.infer<typeof webhookSchema>;
    try {
      parsed = webhookSchema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      return reply.status(400).send({ code: "INVALID_WEBHOOK_BODY", message: "Webhook body is not valid JSON.", requestId: request.id });
    }

    if (!SUPPORTED_EVENTS.has(parsed.event)) return reply.status(204).send();

    const eventIdHeader = request.headers["x-razorpay-event-id"];
    const eventId = Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader;
    if (!eventId || eventId.length > 255) {
      return reply.status(400).send({ code: "MISSING_WEBHOOK_EVENT_ID", message: "Webhook event ID is required.", requestId: request.id });
    }

    const payment = parsed.payload.payment?.entity;
    const order = parsed.payload.order?.entity;
    const refund = parsed.payload.refund?.entity;
    const providerOrderId = payment?.order_id ?? order?.id;
    const providerPaymentId = payment?.id ?? refund?.payment_id;
    const ownedOrder = findOwnedOrder(app, providerOrderId ?? undefined, providerPaymentId);

    // Valid Razorpay events for other merchant activity are intentionally ignored.
    if (!ownedOrder) return reply.status(204).send();

    const payloadHash = createHash("sha256").update(body).digest("hex");
    const existing = app.db.prepare("SELECT payloadHash FROM webhook_inbox WHERE eventId = ?").get(eventId) as { payloadHash: string } | undefined;
    if (existing) {
      if (existing.payloadHash === payloadHash) return reply.status(204).send();
      app.db.prepare(`
        INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason)
        VALUES (?, ?, 'WEBHOOK_ID_CONFLICT', ?, ?, 'A webhook event ID arrived with different content; manual review required.')
      `).run(ownedOrder.runId, ownedOrder.id, Date.now(), JSON.stringify({ eventId }));
      return reply.status(409).send({ code: "WEBHOOK_ID_CONFLICT", message: "Webhook event ID was reused with different content.", requestId: request.id });
    }

    const normalized = {
      event: parsed.event,
      orderId: providerOrderId ?? null,
      paymentId: providerPaymentId ?? null,
      refundId: refund?.id ?? null,
      amount: payment?.amount ?? refund?.amount ?? null,
      currency: payment?.currency ?? refund?.currency ?? null,
      status: payment?.status ?? order?.status ?? refund?.status ?? null,
      localOrderId: ownedOrder.id
    };

    app.db.prepare(`
      INSERT INTO webhook_inbox (eventId, payloadHash, normalizedJson, receivedAtMs, processedAtMs)
      VALUES (?, ?, ?, ?, NULL)
    `).run(eventId, payloadHash, JSON.stringify(normalized), Date.now());

    try {
      if (
        payment?.id && payment.order_id && payment.amount && payment.currency === "INR" &&
        payment.status && ["created", "authorized", "captured", "refunded", "failed"].includes(payment.status)
      ) {
        applyPaymentObservation(app.db, ownedOrder.id, {
          id: payment.id,
          entity: "payment",
          order_id: payment.order_id,
          amount: payment.amount,
          currency: "INR",
          status: payment.status as "created" | "authorized" | "captured" | "refunded" | "failed",
          amount_refunded: payment.amount_refunded ?? 0
        });
      }

      if (refund?.id && refund.payment_id && refund.status) {
        const state = refund.status === "processed" ? "PROCESSED" : refund.status === "failed" ? "REVIEW" : "PENDING";
        const existingRefund = app.db.prepare(`
          SELECT id, state FROM refunds
          WHERE providerRefundId = ? OR (paymentId = ? AND providerRefundId IS NULL)
          ORDER BY createdAtMs DESC LIMIT 1
        `).get(refund.id, refund.payment_id) as { id: string; state: string } | undefined;
        if (existingRefund) {
          app.db.prepare("UPDATE refunds SET providerRefundId = COALESCE(providerRefundId, ?), state = ?, nextCheckAtMs = ? WHERE id = ?")
            .run(refund.id, state, Date.now() + 60_000, existingRefund.id);
          if (existingRefund.state !== state) {
            app.db.prepare(`
              INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              ownedOrder.runId,
              ownedOrder.id,
              state === "PROCESSED" ? "REFUND_PROCESSED" : state === "PENDING" ? "REFUND_PENDING" : "REFUND_REVIEW",
              Date.now(),
              JSON.stringify({ providerRefundId: refund.id, webhookEventId: eventId }),
              state === "PROCESSED" ? "Razorpay confirmed the test refund through a signed webhook." : state === "PENDING" ? "Razorpay reports the test refund is pending." : "Razorpay reported a refund failure; review is required."
            );
          }
        }
      }
      app.db.prepare("UPDATE webhook_inbox SET processedAtMs = ? WHERE eventId = ?").run(Date.now(), eventId);
    } catch (error) {
      if (!(error instanceof PaymentFlowError)) throw error;
      app.db.prepare(`
        INSERT INTO events (runId, orderId, type, timeMs, detailsJson, reason)
        VALUES (?, ?, 'WEBHOOK_PAYMENT_REVIEW', ?, ?, 'A signed webhook did not match the immutable local order; manual review is required.')
      `).run(ownedOrder.runId, ownedOrder.id, Date.now(), JSON.stringify({ eventId, code: error.code }));
      app.db.prepare("UPDATE webhook_inbox SET processedAtMs = ? WHERE eventId = ?").run(Date.now(), eventId);
    }

    return reply.status(204).send();
  });
};
