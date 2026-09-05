import { z } from "zod";

export const runModeSchema = z.enum(["MOCK", "RAZORPAY_TEST"]);
export type RunMode = z.infer<typeof runModeSchema>;

export const stationIdSchema = z.enum(["tawa", "bowls"]);
export type StationId = z.infer<typeof stationIdSchema>;

export const stationStateSchema = z.record(
  stationIdSchema,
  z.object({
    status: z.enum(["UP", "DOWN"]),
    activeOrderId: z.string().nullable()
  })
);
export type StationState = z.infer<typeof stationStateSchema>;

export const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["HUMAN", "SCRIPTED"]),
  status: z.enum(["READY", "INACTIVE"])
});
export type Actor = z.infer<typeof actorSchema>;

export const eventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.string(),
  timeMs: z.number().int().nonnegative(),
  reason: z.string(),
  orderId: z.string().nullable(),
  details: z.record(z.string(), z.unknown())
});
export type TimelineEvent = z.infer<typeof eventSchema>;

export const dishIdSchema = z.enum(["plain_dosa", "masala_dosa", "lemon_rice", "curd_rice"]);
export type DishId = z.infer<typeof dishIdSchema>;
export const exclusionSchema = z.enum(["onion", "dairy", "peanuts"]);
export type Exclusion = z.infer<typeof exclusionSchema>;

export const intentDraftSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  requestText: z.string(),
  requestReceivedAtMs: z.number().int().positive(),
  budgetPaise: z.number().int().positive().nullable(),
  deadlineSeconds: z.number().int().positive().nullable(),
  exclusions: z.array(z.enum(["onion", "dairy", "peanuts", "nuts"])),
  preferredDishIds: z.array(dishIdSchema),
  allowSubstitutes: z.boolean(),
  clarificationReasons: z.array(z.string()),
  safetyLimitationRequired: z.boolean()
});
export type IntentDraft = z.infer<typeof intentDraftSchema>;

export const confirmedIntentSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  actorId: z.literal("human"),
  budgetPaise: z.number().int().positive(),
  latestReadyAtMs: z.number().int().positive(),
  excludedIngredients: z.array(exclusionSchema),
  preferredDishIds: z.array(dishIdSchema),
  allowSubstitutes: z.boolean()
});
export type ConfirmedIntent = z.infer<typeof confirmedIntentSchema>;

export const quoteSchema = z.object({
  id: z.string().uuid(),
  intentId: z.string().uuid(),
  intentVersion: z.number().int().positive(),
  catalogVersion: z.literal("rasoi-catalog-v1"),
  dishId: dishIdSchema,
  dishName: z.string(),
  amountPaise: z.number().int().positive(),
  currency: z.literal("INR"),
  stationId: stationIdSchema,
  ingredients: z.array(z.string()),
  promisedReadyAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string()
});
export type Quote = z.infer<typeof quoteSchema>;

export const intentStateSchema = z.object({
  draft: intentDraftSchema,
  confirmed: confirmedIntentSchema.nullable(),
  quote: quoteSchema.nullable()
});
export type IntentState = z.infer<typeof intentStateSchema>;

export const runSnapshotSchema = z.object({
  runId: z.string(),
  mode: runModeSchema,
  clockMs: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  stations: stationStateSchema,
  stock: z.record(z.string(), z.number().int().nonnegative()),
  actors: z.array(actorSchema),
  salesStopped: z.boolean(),
  razorpayEnabled: z.boolean(),
  intent: intentStateSchema.nullable(),
  currentOrder: z.object({
    id: z.string(),
    dishId: z.string(),
    dishName: z.string(),
    amountPaise: z.number().int().positive(),
    currency: z.literal("INR"),
    stationId: stationIdSchema,
    localState: z.enum(["AWAITING_PAYMENT", "QUEUED", "COOKING", "READY", "SERVED", "CANCELLED"]),
    createState: z.enum(["NOT_SENT", "SENT", "CREATED", "UNKNOWN", "REJECTED"]),
    paymentStatus: z.string().nullable(),
    refundState: z.enum(["REQUIRED", "SENT", "UNKNOWN", "PENDING", "PROCESSED", "REVIEW"]).nullable(),
    checkoutIssued: z.boolean(),
    providerOrderIdSuffix: z.string().nullable(),
    providerPaymentIdSuffix: z.string().nullable(),
    providerRefundIdSuffix: z.string().nullable()
  }).nullable(),
  events: z.array(eventSchema)
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const createRunRequestSchema = z.object({
  accessCode: z.string().min(1).max(256).optional(),
  mode: runModeSchema
});

export const resumeRunRequestSchema = z.object({
  accessCode: z.string().min(1).max(256).optional()
});

export const stationCommandSchema = z.object({
  stationId: stationIdSchema,
  status: z.enum(["UP", "DOWN"])
});

export const createSmokeOrderRequestSchema = z.object({
  clientCommandId: z.string().uuid()
});

export const mealRequestSchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().trim().min(1).max(1000)
});

export const confirmIntentRequestSchema = z.object({
  intentId: z.string().uuid(),
  intentVersion: z.number().int().positive(),
  budgetPaise: z.number().int().min(100).max(50000),
  latestReadyAtMs: z.number().int().positive(),
  excludedIngredients: z.array(exclusionSchema).max(3),
  preferredDishIds: z.array(dishIdSchema).max(4),
  allowSubstitutes: z.boolean()
});

export const acceptQuoteRequestSchema = z.object({
  quoteId: z.string().uuid(),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  intentId: z.string().uuid(),
  intentVersion: z.number().int().positive(),
  clientCommandId: z.string().uuid()
});

export const checkoutConfigSchema = z.object({
  keyId: z.string().startsWith("rzp_test_"),
  orderId: z.string(),
  localOrderId: z.string(),
  amountPaise: z.number().int().positive(),
  currency: z.literal("INR"),
  name: z.literal("RASOI"),
  description: z.string()
});
export type CheckoutConfig = z.infer<typeof checkoutConfigSchema>;

export const checkoutConfirmationSchema = z.object({
  razorpay_payment_id: z.string().min(1).max(255),
  razorpay_order_id: z.string().min(1).max(255),
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i)
});

export const mockPaymentRequestSchema = z.object({
  outcome: z.enum(["captured", "failed"])
});

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string()
});

export type ApiError = z.infer<typeof apiErrorSchema>;
