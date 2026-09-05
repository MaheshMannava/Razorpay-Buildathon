import { resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  appOrigin: z.string().url(),
  databasePath: z.string().min(1),
  demoAccessCode: z.string().min(12).optional(),
  publicDemoEnabled: z.boolean(),
  allowRazorpayTest: z.boolean(),
  razorpayWebhookSecret: z.string().min(16).optional(),
  razorpayKeyId: z.string().optional(),
  razorpayKeySecret: z.string().optional()
}).superRefine((config, context) => {
  if (config.allowRazorpayTest && !config.publicDemoEnabled && !config.demoAccessCode) {
    context.addIssue({ code: "custom", path: ["demoAccessCode"], message: "Razorpay test mode requires a private demo access code." });
  }
  if (!config.allowRazorpayTest) return;
  if (!config.razorpayKeyId?.startsWith("rzp_test_")) {
    context.addIssue({ code: "custom", path: ["razorpayKeyId"], message: "Razorpay test mode requires an rzp_test_ key ID." });
  }
  if (!config.razorpayKeySecret || config.razorpayKeySecret.length < 16) {
    context.addIssue({ code: "custom", path: ["razorpayKeySecret"], message: "Razorpay test mode requires a key secret." });
  }
  if (!config.razorpayWebhookSecret) {
    context.addIssue({ code: "custom", path: ["razorpayWebhookSecret"], message: "Razorpay test mode requires a webhook secret." });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const vercelOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
  const defaultDatabasePath = process.env.VERCEL ? "/tmp/rasoi.sqlite" : "./data/rasoi.sqlite";
  return configSchema.parse({
    nodeEnv: process.env.NODE_ENV ?? "development",
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? "3001"),
    appOrigin: process.env.APP_ORIGIN ?? vercelOrigin ?? "http://localhost:5173",
    databasePath: resolve(process.env.DATABASE_PATH ?? defaultDatabasePath),
    demoAccessCode: process.env.DEMO_ACCESS_CODE || undefined,
    publicDemoEnabled: process.env.PUBLIC_DEMO_ENABLED !== "false",
    allowRazorpayTest: process.env.ALLOW_RAZORPAY_TEST === "true",
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || undefined,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || undefined,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || undefined
  });
}
