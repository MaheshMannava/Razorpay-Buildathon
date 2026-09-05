import { apiErrorSchema, checkoutConfigSchema, runSnapshotSchema, type ApiError, type CheckoutConfig, type RunMode, type RunSnapshot, type StationId } from "../shared/contracts";

async function parseResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw parsed.success ? parsed.data : { code: "UNKNOWN", message: "RASOI returned an unexpected response.", requestId: "unknown" } satisfies ApiError;
  }
  return parse(body);
}

export async function createRun(accessCode: string | undefined, mode: RunMode): Promise<string> {
  const response = await fetch("/api/runs", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(accessCode ? { accessCode, mode } : { mode })
  });
  const result = await parseResponse(response, (value) => value as { runId: string });
  return result.runId;
}

export async function resumeRun(runId: string, accessCode?: string): Promise<void> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(accessCode ? { accessCode } : {})
  });
  await parseResponse(response, () => undefined);
}

export async function getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/state`, {
    credentials: "same-origin",
    signal
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function updateStation(runId: string, stationId: StationId, status: "UP" | "DOWN"): Promise<RunSnapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/station`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stationId, status })
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function stopRunSales(runId: string): Promise<RunSnapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop-sales`, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function submitMealRequest(runId: string, text: string): Promise<RunSnapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/request`, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), text })
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function confirmMealIntent(runId: string, input: {
  intentId: string; intentVersion: number; budgetPaise: number; latestReadyAtMs: number;
  excludedIngredients: Array<"onion" | "dairy" | "peanuts">;
  preferredDishIds: Array<"plain_dosa" | "masala_dosa" | "lemon_rice" | "curd_rice">;
  allowSubstitutes: boolean;
}): Promise<RunSnapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/confirm-intent`, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function acceptMealQuote(runId: string, input: {
  quoteId: string; quoteHash: string; intentId: string; intentVersion: number;
}): Promise<RunSnapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/accept`, {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, clientCommandId: crypto.randomUUID() })
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function issueCheckout(orderId: string): Promise<CheckoutConfig> {
  const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/checkout`, {
    method: "POST",
    credentials: "same-origin"
  });
  return parseResponse(response, (value) => checkoutConfigSchema.parse(value));
}

export async function confirmCheckout(orderId: string, confirmation: {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}): Promise<RunSnapshot> {
  const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/confirm`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmation)
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}

export async function checkOrder(orderId: string): Promise<RunSnapshot> {
  const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/check`, {
    method: "POST",
    credentials: "same-origin"
  });
  return parseResponse(response, (value) => runSnapshotSchema.parse(value));
}
