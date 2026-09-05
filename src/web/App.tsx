import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import type { ApiError, DishId, Exclusion, RunSnapshot, StationId } from "../shared/contracts";
import { acceptMealQuote, checkOrder, confirmCheckout, confirmMealIntent, createRun, getRun, issueCheckout, resumeRun, stopRunSales, submitMealRequest, updateStation } from "./api";

const KitchenWorld = lazy(() => import("./KitchenWorld").then((module) => ({ default: module.KitchenWorld })));
const PreviewKitchenWorld = lazy(() => import("./KitchenWorld").then((module) => ({ default: module.PreviewKitchenWorld })));

const SAMPLE_REQUEST = "Maximum ₹150, within five minutes, no onion; rice is okay.";

let checkoutScriptPromise: Promise<void> | undefined;

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;
  checkoutScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => window.Razorpay ? resolve() : reject(new Error("Razorpay Checkout did not initialize."));
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded."));
    document.head.append(script);
  });
  return checkoutScriptPromise;
}

function messageFromError(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) return String((error as ApiError).message);
  return "RASOI could not connect. Try again.";
}

function AccessForm({ onReady }: { onReady: (runId: string) => void }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function startDemo(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError("");
    setLoading(true);
    try {
      onReady(await createRun(undefined, "RAZORPAY_TEST"));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="entry-shell">
      <header className="landing-header">
        <div className="rasoi-wordmark"><span>Rasoi</span><small>Ordering that respects the kitchen</small></div>
      </header>
      <div className="entry-layout">
        <section className="entry-copy" aria-labelledby="entry-title">
          <p className="entry-label">AI ordering for real kitchens</p>
          <h1 id="entry-title">An AI cashier that only sells what the kitchen can make.</h1>
          <div className="product-summary">
            <p>Customers describe the meal they want in plain language.</p>
            <p>Rasoi checks the menu, ingredients, stock, timing, and kitchen capacity.</p>
            <p>It offers only meals the kitchen can fulfill, then uses Razorpay for payment.</p>
            <p>If fulfillment fails, Rasoi cancels the order and starts a full refund.</p>
          </div>
          <form id="demo-access" className="demo-access-form" onSubmit={startDemo} aria-busy={loading}>
            <div className="entry-actions">
              <button className="button primary" type="submit" disabled={loading}>
                {loading ? "Connecting to Razorpay…" : "Start Razorpay demo"}
              </button>
              <a className="button secondary" href="#razorpay-flow">How Razorpay is used</a>
            </div>
          </form>
          {error && <div className="error-banner" role="alert"><strong>Couldn’t start Razorpay Test Mode.</strong><span>{error}</span></div>}
          <p className="entry-note">Every payment event in this demo is created in Razorpay Test Mode. No local payment simulator is used, and no real money is charged.</p>
        </section>
        <section className="entry-stage" aria-labelledby="stage-title">
          <div className="stage-toolbar"><h2 id="stage-title" className="stage-title">Kitchen capacity check</h2><span className="stage-chip">Offer approved</span></div>
          <Suspense fallback={<div className="kitchen-world world-fallback" role="status">Loading the kitchen preview…</div>}>
            <PreviewKitchenWorld />
          </Suspense>
          <div className="decision-receipt" aria-label="Example RASOI decision trace">
            <div><span>Customer asks</span><strong>“Under ₹150 · ready in 5 min · no onion”</strong></div>
            <ol>
              <li><span>Recipe + budget</span><strong>Match</strong></li>
              <li><span>Stock + tawa slot</span><strong>Reserved</strong></li>
              <li className="decision-payment"><span>Payment gate</span><strong>Unlocked only now</strong></li>
            </ol>
          </div>
          <div className="stage-caption"><div><strong>One decision, backed by live operations</strong><span>The 3D kitchen reflects the same server state used to approve the order.</span></div></div>
        </section>
      </div>
      <section className="showcase-section" aria-labelledby="showcase-title">
        <div className="section-kicker"><p className="eyebrow">What Rasoi does</p><h2 id="showcase-title">From meal request to safe fulfillment.</h2><p>The AI understands what the customer wants. The server checks what the kitchen can deliver. Razorpay handles payment only after both sides agree.</p></div>
        <div className="showcase-grid">
          <article><span>Before payment</span><h3>Check whether the meal is possible</h3><p>Recipes, stock, station health, available cooking time, budget, and deadline must all agree.</p><strong>Rasoi returns a real offer—or no offer.</strong></article>
          <article><span>When the customer accepts</span><h3>Reserve first, then take payment</h3><p>Rasoi reserves the ingredients and kitchen slot before creating the Razorpay order.</p><strong>The browser cannot change the price or availability.</strong></article>
          <article><span>If the kitchen fails</span><h3>Cancel safely and refund</h3><p>Rasoi cancels the meal, records why it failed, and creates a full refund obligation.</p><strong>Every decision remains in the server timeline.</strong></article>
        </div>
      </section>
      <section id="razorpay-flow" className="razorpay-section" aria-labelledby="razorpay-title">
        <div className="razorpay-intro">
          <p className="eyebrow">Payments</p>
          <h2 id="razorpay-title">How Rasoi uses Razorpay.</h2>
          <p>Rasoi confirms that the kitchen can fulfill the meal before it asks Razorpay to create an order. Payment success never decides whether a meal is available.</p>
          <p className="environment-note">This demo creates actual Razorpay Test Mode Orders, opens Razorpay-hosted Checkout, verifies the Checkout signature, fetches the provider payment state, and requests refunds through Razorpay’s API. These are test-account transactions; no real money is charged.</p>
        </div>
        <ol className="razorpay-steps">
          <li><span>1</span><div><strong>Reserve the meal</strong><p>The server rechecks the offer and reserves stock and kitchen capacity in one transaction.</p></div><small>Handled by Rasoi</small></li>
          <li><span>2</span><div><strong>Create the payment order</strong><p>The amount and currency come from the server-owned offer, never from the browser.</p></div><small>Razorpay Orders API</small></li>
          <li><span>3</span><div><strong>Verify the payment</strong><p>Rasoi verifies the Checkout signature and fetches Razorpay’s payment state before trusting the result.</p></div><small>Rasoi and Razorpay</small></li>
          <li><span>4</span><div><strong>Refund when fulfillment fails</strong><p>A station failure cancels the meal and starts a full refund through Razorpay.</p></div><small>Rasoi and Razorpay</small></li>
        </ol>
      </section>
      <section className="demo-invitation" aria-labelledby="demo-invitation-title">
        <div><p className="eyebrow">Try the complete story</p><h2 id="demo-invitation-title">Approve an order. Break the kitchen. Watch the system recover.</h2><p>Every action appears in the append-only server timeline, including why the offer was approved, what was reserved, and why a refund became necessary.</p></div>
        <a className="button primary" href="#demo-access">Start the Razorpay demo</a>
      </section>
    </main>
  );
}

function StationCard({ runId, id, label, snapshot, onUpdate }: {
  runId: string;
  id: StationId;
  label: string;
  snapshot: RunSnapshot;
  onUpdate: (snapshot: RunSnapshot) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const station = snapshot.stations[id];
  const nextStatus = station.status === "UP" ? "DOWN" : "UP";

  async function changeStatus() {
    setBusy(true);
    setError("");
    try {
      onUpdate(await updateStation(runId, id, nextStatus));
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`station-card ${station.status.toLowerCase()}`}>
      <div className="station-card-copy">
        <span className="station-index">{id === "tawa" ? "01" : "02"}</span>
        <div>
          <p className="station-name">{label}</p>
          <p className="station-state"><span className="status-dot" aria-hidden="true" /> {station.status === "UP" ? "Available" : "Unavailable"}</p>
        </div>
      </div>
      <button className={station.status === "UP" ? "button danger" : "button secondary"} type="button" onClick={changeStatus} disabled={busy}>
        {busy ? "Updating…" : station.status === "UP" ? `Disable ${label.toLowerCase()}` : `Repair ${label.toLowerCase()}`}
      </button>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </article>
  );
}

function KitchenScene({ snapshot, onUpdate }: { snapshot: RunSnapshot; onUpdate: (snapshot: RunSnapshot) => void }) {
  return (
    <section className="scene-panel" aria-labelledby="kitchen-title">
      <div className="section-heading">
        <div><p className="eyebrow">Kitchen state</p><h2 id="kitchen-title">Capacity and fulfillment</h2></div>
        <div className="scene-heading-meta"><span className="live-indicator">Server connected</span><span className="world-label">Confirmed server state · 3D view</span></div>
      </div>
      <div className="scene-summary" aria-label="Kitchen summary">
        <span><strong>02</strong> stations</span><span><strong>{snapshot.actors.filter((actor) => actor.status === "READY").length}</strong> guests waiting</span><span><strong>{snapshot.currentOrder ? "01" : "—"}</strong> active order</span>
      </div>
      <div className="scene-explainer"><span className="scene-explainer-icon" aria-hidden="true">!</span><p><strong>Test recovery.</strong> Accept an order, then disable its station to see RASOI cancel the meal and create a full refund obligation.</p></div>
      <Suspense fallback={<div className="kitchen-world world-fallback" role="status">Loading the live kitchen view…</div>}>
        <KitchenWorld snapshot={snapshot} />
      </Suspense>
      <div className="station-grid">
        <StationCard runId={snapshot.runId} id="tawa" label="Tawa" snapshot={snapshot} onUpdate={onUpdate} />
        <StationCard runId={snapshot.runId} id="bowls" label="Bowl station" snapshot={snapshot} onUpdate={onUpdate} />
      </div>
    </section>
  );
}

function PaymentHarness({ snapshot, onUpdate }: { snapshot: RunSnapshot; onUpdate: (snapshot: RunSnapshot) => void }) {
  const [busy, setBusy] = useState<"checkout" | "check" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const order = snapshot.currentOrder;
  const stationLabel = order?.stationId === "tawa" ? "tawa" : "bowl station";

  async function openCheckout() {
    if (!order) return;
    setBusy("checkout");
    setError("");
    setMessage("");
    try {
      await loadCheckoutScript();
      const config = await issueCheckout(order.id);
      if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable.");
      const checkout = new window.Razorpay({
        key: config.keyId,
        amount: config.amountPaise,
        currency: config.currency,
        name: config.name,
        description: config.description,
        order_id: config.orderId,
        prefill: { name: "RASOI Test", email: "test@example.com", contact: "+919123456789" },
        retry: { enabled: false },
        // Hosted Checkout requires a concrete color value; keep this aligned with --primary.
        theme: { color: "#a84227" },
        modal: {
          confirm_close: true,
          ondismiss: () => setMessage("Checkout closed. Do not pay again—use Check payment status below.")
        },
        handler: async (response) => {
          setBusy("check");
          try {
            onUpdate(await confirmCheckout(config.localOrderId, response));
            setMessage(`Test payment captured and verified by Razorpay. You can now disable the ${stationLabel} to test the refund path.`);
          } catch (caught) {
            setError(messageFromError(caught));
          } finally {
            setBusy(null);
          }
        }
      });
      checkout.on("payment.failed", () => setMessage("This attempt failed. No meal was started. Check status before trying anything else."));
      checkout.open();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function refreshStatus() {
    if (!order) return;
    setBusy("check");
    setError("");
    try {
      onUpdate(await checkOrder(order.id));
      setMessage("Status refreshed from Razorpay.");
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(null);
    }
  }

  const captured = order?.paymentStatus === "captured";
  return (
    <div className="payment-harness">
      <div className="payment-heading"><div><p className="eyebrow">Razorpay test checkout</p><h3>{order?.dishName ?? "Plain dosa"}</h3></div><strong>₹{(order?.amountPaise ?? 12000) / 100}</strong></div>
      <p className="muted">Razorpay Test Mode only. No real money is charged.</p>
      {order && (
        <div className="payment-status">
          <dl>
            <div><dt>Order</dt><dd>{order.createState.toLowerCase()}</dd></div>
            <div><dt>Payment</dt><dd>{order.paymentStatus ?? "not paid"}</dd></div>
            <div><dt>Refund</dt><dd>{order.refundState?.toLowerCase() ?? "not required"}</dd></div>
          </dl>
          <div className="provider-identifiers" aria-label="Razorpay Test Mode identifiers">
            <p><span>Razorpay order</span><code>{order.providerOrderIdSuffix ? `…${order.providerOrderIdSuffix}` : "waiting"}</code></p>
            <p><span>Razorpay payment</span><code>{order.providerPaymentIdSuffix ? `…${order.providerPaymentIdSuffix}` : "waiting"}</code></p>
            <p><span>Razorpay refund</span><code>{order.providerRefundIdSuffix ? `…${order.providerRefundIdSuffix}` : "not created"}</code></p>
          </div>
          {order.createState === "CREATED" && !order.checkoutIssued && !captured && <button className="button primary" type="button" onClick={openCheckout} disabled={busy !== null}>{busy === "checkout" ? "Opening secure checkout…" : "Open Razorpay Checkout"}</button>}
          {(order.checkoutIssued || order.createState === "UNKNOWN" || order.refundState === "PENDING" || order.refundState === "UNKNOWN") && <button className="button secondary" type="button" onClick={refreshStatus} disabled={busy !== null}>{busy === "check" ? "Checking…" : "Check payment status"}</button>}
          {captured && !order.refundState && <p className="success-note">Captured and server-verified. Disable the {stationLabel} on the left to cancel and request the full test refund.</p>}
          {order.refundState === "PROCESSED" && <p className="success-note">Razorpay reports the full test refund as processed.</p>}
        </div>
      )}
      <div className="action-message" aria-live="polite">{message}</div>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}

function WorkflowPanel({ snapshot, onUpdate }: { snapshot: RunSnapshot; onUpdate: (snapshot: RunSnapshot) => void }) {
  if (snapshot.mode === "RAZORPAY_TEST") return <>
    <MealRequestFlow snapshot={snapshot} onUpdate={onUpdate} />
    {snapshot.currentOrder && <section className="workflow-panel" aria-labelledby="payment-title">
      <div className="step-number" aria-hidden="true">4</div>
      <h2 id="payment-title">Verify payment with Razorpay</h2>
      <p className="muted">After the quote is accepted, RASOI creates one Razorpay Test Mode order and verifies the checkout response on the server.</p>
      <PaymentHarness snapshot={snapshot} onUpdate={onUpdate} />
      <div className="scope-note"><strong>Hosted payment entry</strong><p>Card or UPI details are entered only inside Razorpay Checkout. RASOI never receives them.</p></div>
    </section>}
  </>;
  return <MealRequestFlow snapshot={snapshot} onUpdate={onUpdate} />;
}

const DISH_OPTIONS: Array<{ id: DishId; name: string }> = [
  { id: "plain_dosa", name: "Plain dosa · ₹120" },
  { id: "masala_dosa", name: "Masala dosa · ₹150" },
  { id: "lemon_rice", name: "Lemon rice · ₹100" },
  { id: "curd_rice", name: "Curd rice · ₹110" }
];

function MealRequestFlow({ snapshot, onUpdate }: { snapshot: RunSnapshot; onUpdate: (snapshot: RunSnapshot) => void }) {
  const [request, setRequest] = useState(SAMPLE_REQUEST);
  const [budgetRupees, setBudgetRupees] = useState("");
  const [deadlineMinutes, setDeadlineMinutes] = useState("");
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [preferredDish, setPreferredDish] = useState<DishId | "">("");
  const [allowSubstitutes, setAllowSubstitutes] = useState(false);
  const [busy, setBusy] = useState<"interpret" | "confirm" | "accept" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const draft = snapshot.intent?.draft;
  const quote = snapshot.intent?.quote;

  useEffect(() => {
    if (!draft) return;
    setBudgetRupees(draft.budgetPaise ? String(draft.budgetPaise / 100) : "");
    setDeadlineMinutes(draft.deadlineSeconds ? String(draft.deadlineSeconds / 60) : "");
    setExclusions(draft.exclusions.filter((item): item is Exclusion => item !== "nuts"));
    setPreferredDish(draft.preferredDishIds[0] ?? "");
    setAllowSubstitutes(draft.allowSubstitutes);
  }, [draft?.id]);

  async function interpret(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request.trim()) { setError("Tell the cashier what you need."); return; }
    setBusy("interpret"); setError(""); setMessage("");
    try { onUpdate(await submitMealRequest(snapshot.runId, request)); }
    catch (caught) { setError(messageFromError(caught)); }
    finally { setBusy(null); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const rupees = Number(budgetRupees);
    const minutes = Number(deadlineMinutes);
    if (!Number.isInteger(rupees) || rupees < 1 || rupees > 500) { setError("Enter a whole-number budget from ₹1 to ₹500."); return; }
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) { setError("Enter a deadline from 1 to 60 minutes."); return; }
    setBusy("confirm"); setError(""); setMessage("");
    try {
      const next = await confirmMealIntent(snapshot.runId, {
        intentId: draft.id, intentVersion: draft.version, budgetPaise: rupees * 100,
        latestReadyAtMs: draft.requestReceivedAtMs + Math.round(minutes * 60_000),
        excludedIngredients: exclusions, preferredDishIds: preferredDish ? [preferredDish] : [], allowSubstitutes
      });
      onUpdate(next);
      setMessage(next.intent?.quote ? "Constraints confirmed. The offer uses current stock and kitchen capacity." : "No meal meets all of these constraints.");
    } catch (caught) { setError(messageFromError(caught)); }
    finally { setBusy(null); }
  }

  async function accept() {
    if (!quote) return;
    setBusy("accept"); setError(""); setMessage("");
    try {
      onUpdate(await acceptMealQuote(snapshot.runId, { quoteId: quote.id, quoteHash: quote.contentHash, intentId: quote.intentId, intentVersion: quote.intentVersion }));
      setMessage("Meal accepted. Stock and kitchen capacity are now reserved atomically.");
    } catch (caught) { setError(messageFromError(caught)); }
    finally { setBusy(null); }
  }

  function toggleExclusion(value: Exclusion) {
    setExclusions((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  const currentStage = snapshot.intent?.confirmed ? 3 : draft ? 2 : 1;

  return (
    <section className="workflow-panel" aria-labelledby="request-title">
      <div className="workflow-panel-heading"><div className="step-number" aria-hidden="true">{currentStage}</div><span className="workflow-status">Stage {currentStage} of 3</span></div>
      <p className="eyebrow">Order request</p>
      <h2 id="request-title">What should RASOI find?</h2>
      <p className="muted">Describe the meal, budget, deadline, and anything the recipe must avoid.</p>
      <ol className="stage-rail" aria-label="Meal ordering steps">
        <li className={currentStage >= 1 ? "complete" : ""}><span>01</span><small>Request</small></li>
        <li className={currentStage >= 2 ? "complete" : ""}><span>02</span><small>Confirm</small></li>
        <li className={currentStage >= 3 ? "complete" : ""}><span>03</span><small>Offer</small></li>
      </ol>
      <form onSubmit={interpret} aria-busy={busy === "interpret"}>
        <div className="field">
          <label htmlFor="meal-request">Meal request</label>
          <textarea id="meal-request" rows={4} maxLength={1000} value={request} onChange={(event) => setRequest(event.target.value)} disabled={busy !== null} />
          <p className="field-help">Example: “Maximum ₹150, within five minutes, no onion; rice is okay.”</p>
        </div>
        <button className="button primary" type="submit" disabled={busy !== null}>{busy === "interpret" ? "Extracting constraints…" : draft ? "Update constraints" : "Extract constraints"}</button>
      </form>
      {draft && <form className="constraint-form" onSubmit={confirm} aria-labelledby="constraints-title" aria-busy={busy === "confirm"}>
        <div className="workflow-divider"><span>2</span><strong id="constraints-title">Confirm constraints</strong></div>
        {draft.clarificationReasons.length > 0 && <div className="warning-note" role="status">Some details were missing or conflicted. Correct the fields below before confirming.</div>}
        {draft.safetyLimitationRequired && <div className="warning-note" role="alert">RASOI cannot guarantee allergy or cross-contact safety. This request cannot be confirmed as a safety promise.</div>}
        <div className="compact-fields">
          <div className="field"><label htmlFor="budget">Maximum budget (₹)</label><input id="budget" inputMode="numeric" value={budgetRupees} onChange={(event) => setBudgetRupees(event.target.value)} disabled={busy !== null} /></div>
          <div className="field"><label htmlFor="deadline">Ready within (minutes)</label><input id="deadline" inputMode="decimal" value={deadlineMinutes} onChange={(event) => setDeadlineMinutes(event.target.value)} disabled={busy !== null} /></div>
        </div>
        <fieldset><legend>Exclude recipe ingredients</legend><div className="check-grid">
          {(["onion", "dairy", "peanuts"] as Exclusion[]).map((item) => <label key={item} className="check-option"><input type="checkbox" checked={exclusions.includes(item)} onChange={() => toggleExclusion(item)} disabled={busy !== null} /><span>{item[0].toUpperCase() + item.slice(1)}</span></label>)}
        </div><p className="field-help">Fictional recipe filtering only; this is not an allergen or cross-contact guarantee.</p></fieldset>
        <div className="field"><label htmlFor="preferred-dish">Preferred dish</label><select id="preferred-dish" value={preferredDish} onChange={(event) => setPreferredDish(event.target.value as DishId | "")} disabled={busy !== null}><option value="">Any dish</option>{DISH_OPTIONS.map((dish) => <option key={dish.id} value={dish.id}>{dish.name}</option>)}</select></div>
        <label className="check-option full"><input type="checkbox" checked={allowSubstitutes} onChange={(event) => setAllowSubstitutes(event.target.checked)} disabled={busy !== null} /><span>Other dishes are allowed if my preference is unavailable</span></label>
        <button className="button primary" type="submit" disabled={busy !== null || draft.safetyLimitationRequired}>{busy === "confirm" ? "Checking kitchen…" : "Confirm constraints"}</button>
      </form>}
      {snapshot.intent?.confirmed && <div className="offer-section" aria-labelledby="offer-title">
        <div className="workflow-divider"><span>3</span><strong id="offer-title">Current offer</strong></div>
        {quote ? <article className="offer-card">
          <div className="offer-heading"><div><p className="eyebrow">Feasible now</p><h3>{quote.dishName}</h3></div><strong>₹{quote.amountPaise / 100}</strong></div>
          <dl><div><dt>Ready by</dt><dd>{new Date(quote.promisedReadyAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</dd></div><div><dt>Station</dt><dd>{quote.stationId === "tawa" ? "Tawa" : "Bowls"}</dd></div></dl>
          <p><strong>Ingredients:</strong> {quote.ingredients.join(", ").replaceAll("_", " ")}</p><p className="muted">{quote.reason} Offer rechecked when accepted.</p>
          {!snapshot.currentOrder ? <button className="button primary" type="button" onClick={accept} disabled={busy !== null}>{busy === "accept" ? "Reserving meal…" : snapshot.mode === "MOCK" ? "Accept simulated offer" : "Accept and create test order"}</button> : <p className="success-note">Accepted. The immutable quote is bound to the reserved meal.</p>}
        </article> : <div className="empty-state compact"><strong>No meal meets these constraints</strong><p>Change the budget, deadline, exclusions, or station availability and confirm again.</p></div>}
      </div>}
      <div className="action-message" aria-live="polite">{message}</div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="scope-note"><strong>The server owns the promise.</strong><p>RASOI server code controls menu facts, price, stock, capacity, consent, and payment state.</p></div>
    </section>
  );
}

function Timeline({ events }: { events: RunSnapshot["events"] }) {
  return (
    <section className="timeline-panel" aria-labelledby="timeline-title">
      <div className="section-heading"><div><p className="eyebrow">Append-only server record</p><h2 id="timeline-title">Why each decision happened</h2></div><span>{events.length} {events.length === 1 ? "event" : "events"}</span></div>
      {events.length === 0 ? (
        <div className="empty-state"><strong>No events yet</strong><p>Actions and their plain-language reasons will appear here.</p></div>
      ) : (
        <ol className="timeline-list">
          {events.map((event) => (
            <li key={event.sequence}>
              <time dateTime={new Date(event.timeMs).toISOString()}>{new Date(event.timeMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <span className="event-marker" aria-hidden="true" />
              <div><strong>{event.type.replaceAll("_", " ").toLowerCase()}</strong><p>{event.reason}</p></div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ProofStrip({ snapshot }: { snapshot: RunSnapshot }) {
  const recoveryStarted = Boolean(snapshot.currentOrder?.refundState || snapshot.currentOrder?.localState === "CANCELLED");
  const currentStage = recoveryStarted ? 4 : snapshot.currentOrder ? 3 : snapshot.intent?.confirmed ? 2 : snapshot.intent?.draft ? 1 : 0;
  const steps = [
    { number: "01", label: "Read request", detail: "Text becomes constraints" },
    { number: "02", label: "Prove feasibility", detail: "Stock and stations agree" },
    { number: "03", label: "Cross payment gate", detail: "Reserve before provider order" },
    { number: "04", label: "Test recovery", detail: "Break station → full refund" }
  ];

  return (
    <section className="proof-strip" aria-label="What this demo proves">
      <div className="proof-strip-intro"><p className="eyebrow">Your demo mission</p><strong>Take one order from request to recovery.</strong><span>{snapshot.mode === "MOCK" ? "Internal test run. Disable the assigned station after acceptance to prove the refund path." : "Razorpay Test Mode uses hosted Checkout and server-side verification. No real money moves."}</span></div>
      <ol>
        {steps.map((step, index) => <li key={step.number} className={currentStage > index ? "complete" : currentStage === index ? "active" : ""}><span>{step.number}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></li>)}
      </ol>
    </section>
  );
}

function RunView({ runId }: { runId: string }) {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState("");
  const [accessRequired, setAccessRequired] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [stoppingSales, setStoppingSales] = useState(false);

  async function resume() {
    setResuming(true);
    try {
      await resumeRun(runId);
      setSnapshot(await getRun(runId));
      setAccessRequired(false);
      setError("");
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setResuming(false);
    }
  }

  function startFreshRun() {
    window.sessionStorage.removeItem("rasoi_run_id");
    window.location.reload();
  }

  async function stopNewSales() {
    setStoppingSales(true);
    try {
      setSnapshot(await stopRunSales(runId));
      setError("");
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setStoppingSales(false);
    }
  }

  useEffect(() => {
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let stopped = false;

    async function poll() {
      if (document.hidden) {
        timer = window.setTimeout(poll, 1000);
        return;
      }
      controller?.abort();
      controller = new AbortController();
      let failed = false;
      try {
        const next = await getRun(runId, controller.signal);
        if (!stopped) { setSnapshot(next); setAccessRequired(false); setError(""); }
      } catch (caught) {
        failed = true;
        if (!stopped && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setAccessRequired(typeof caught === "object" && caught !== null && "code" in caught && caught.code === "ACCESS_REQUIRED");
          setError(messageFromError(caught));
        }
      }
      if (!stopped) timer = window.setTimeout(poll, failed ? 3000 : 1000);
    }

    void poll();
    return () => { stopped = true; controller?.abort(); if (timer) window.clearTimeout(timer); };
  }, [runId]);

  if (!snapshot && !error) return <main className="loading-shell" aria-busy="true"><div className="skeleton wide" /><div className="skeleton" /><p>Loading the kitchen…</p></main>;
  if (!snapshot && accessRequired) return (
    <main className="entry-shell">
      <section className="entry-card session-card" aria-labelledby="resume-title">
        <p className="eyebrow">Session checkpoint</p>
        <h1 id="resume-title">Resume this Razorpay run.</h1>
        <p>Your server-side order and payment state are preserved. Continue to rotate the expired session token.</p>
        <div className="demo-access-form" aria-busy={resuming}>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="entry-actions"><button className="button primary" type="button" onClick={resume} disabled={resuming}>{resuming ? "Resuming…" : "Resume Razorpay run"}</button><button className="button secondary" type="button" onClick={startFreshRun}>Start a fresh run</button></div>
        </div>
      </section>
    </main>
  );
  if (!snapshot) return <main className="entry-shell"><section className="entry-card"><h1>Couldn’t load this run</h1><p>{error}</p><button className="button primary" type="button" onClick={() => window.location.reload()}>Try again</button></section></main>;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="rasoi-wordmark app-wordmark"><span>Rasoi</span><small>Ordering that respects the kitchen</small></div>
        <div className="header-actions"><span className={`mode-badge ${snapshot.mode === "MOCK" ? "mock" : "test"}`}>{snapshot.mode === "MOCK" ? "Demo payment" : "Razorpay test payment · no real charge"}</span><button className="button secondary" type="button" onClick={stopNewSales} disabled={snapshot.salesStopped || stoppingSales}>{snapshot.salesStopped ? "Sales stopped" : stoppingSales ? "Stopping…" : "Stop new sales"}</button><button className="button secondary" type="button" onClick={() => { window.sessionStorage.removeItem("rasoi_run_id"); window.location.reload(); }}>New run</button></div>
      </header>
      {error && <div className="connection-banner" role="status">Connection interrupted. Showing last confirmed state. The kitchen will retry automatically.</div>}
      <ProofStrip snapshot={snapshot} />
      <div className="primary-grid">
        <KitchenScene snapshot={snapshot} onUpdate={setSnapshot} />
        <WorkflowPanel snapshot={snapshot} onUpdate={setSnapshot} />
      </div>
      <Timeline events={snapshot.events} />
      <footer><span>{snapshot.mode === "RAZORPAY_TEST" ? "Payment operations use Razorpay Test Mode. No real money is charged." : "Internal mock run."}</span><span>Run {snapshot.runId.slice(0, 8)}</span></footer>
    </main>
  );
}

export function App() {
  const [runId, setRunId] = useState<string | null>(() => window.sessionStorage.getItem("rasoi_run_id"));

  function ready(nextRunId: string) {
    window.sessionStorage.setItem("rasoi_run_id", nextRunId);
    setRunId(nextRunId);
  }

  return runId ? <RunView runId={runId} /> : <AccessForm onReady={ready} />;
}
