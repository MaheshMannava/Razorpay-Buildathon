import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATALOG, CATALOG_VERSION, type CatalogDish } from "../src/server/domain.js";

const BENCHMARK_VERSION = "rasoi-economics-v1";
const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const POLICIES = ["static-menu", "inventory-only", "rasoi", "diagnostic-control"] as const;
const SCENARIOS = ["normal-demand", "tawa-outage-before-sale", "tawa-outage-after-capture", "ingredient-exhaustion", "short-deadline-burst"] as const;
type Policy = typeof POLICIES[number];
type Scenario = typeof SCENARIOS[number];
type DishId = CatalogDish["id"];

type Request = {
  id: string;
  actorId: "human" | "asha" | "kabir";
  arrivalSeconds: number;
  budgetPaise: number;
  deadlineSeconds: number;
  excluded: string[];
  preferredDishId: DishId | null;
  allowSubstitutes: boolean;
};

type Metrics = {
  requests: number;
  accepted: number;
  served: number;
  refusals: number;
  acceptedButUnfulfillable: number;
  proposedHardConstraintViolations: number;
  acceptedHardConstraintViolations: number;
  fulfillmentHardConstraintViolations: number;
  promiseMisses: number;
  refundRequiredPaise: number;
  refundProcessedPaise: number;
  refundOutstandingPaise: number;
  safeFulfilledGmvPaise: number;
  alternativeEligible: number;
  validAlternativeRecoveries: number;
  materialWasteCostPaise: number;
  unresolvedRecords: number;
};

type ScenarioConfig = {
  initialStock: Record<string, number>;
  outage: { stationId: "tawa" | "bowls"; startSeconds: number; endSeconds: number } | null;
  requests: Request[];
};

function blankMetrics(): Metrics {
  return {
    requests: 0, accepted: 0, served: 0, refusals: 0, acceptedButUnfulfillable: 0,
    proposedHardConstraintViolations: 0, acceptedHardConstraintViolations: 0, fulfillmentHardConstraintViolations: 0,
    promiseMisses: 0, refundRequiredPaise: 0, refundProcessedPaise: 0, refundOutstandingPaise: 0,
    safeFulfilledGmvPaise: 0, alternativeEligible: 0, validAlternativeRecoveries: 0,
    materialWasteCostPaise: 0, unresolvedRecords: 0
  };
}

function seededUnit(seed: number, text: string): number {
  let value = seed * 2_654_435_761;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 1_597_334_677);
  return (value >>> 0) / 4_294_967_296;
}

function request(id: number, arrivalSeconds: number, overrides: Partial<Request> = {}): Request {
  const actorId = (["human", "asha", "kabir"] as const)[id % 3]!;
  return {
    id: `request-${id}`, actorId, arrivalSeconds, budgetPaise: 15000, deadlineSeconds: 300,
    excluded: [], preferredDishId: null, allowSubstitutes: true, ...overrides
  };
}

function scenarioConfig(scenario: Scenario): ScenarioConfig {
  const initialStock = { batter: 6, oil: 6, potato_mix: 3, rice: 6, lemon_mix: 3, peanuts: 3, curd: 3 };
  if (scenario === "normal-demand") return {
    initialStock, outage: null,
    requests: [0, 35, 70, 110, 150, 195, 240, 285, 330].map((arrival, index) => request(index, arrival, {
      preferredDishId: (["plain_dosa", "lemon_rice", "curd_rice"] as DishId[])[index % 3]!, allowSubstitutes: true
    }))
  };
  if (scenario === "tawa-outage-before-sale") return {
    initialStock, outage: { stationId: "tawa", startSeconds: 0, endSeconds: 180 },
    requests: [20, 35, 55, 80, 110, 145].map((arrival, index) => request(index, arrival, { preferredDishId: "plain_dosa", budgetPaise: 12000, allowSubstitutes: true }))
  };
  if (scenario === "tawa-outage-after-capture") return {
    initialStock, outage: { stationId: "tawa", startSeconds: 75, endSeconds: 190 },
    requests: [30, 40, 52, 210, 230, 250].map((arrival, index) => request(index, arrival, { preferredDishId: "plain_dosa", budgetPaise: 12000, allowSubstitutes: false }))
  };
  if (scenario === "ingredient-exhaustion") return {
    initialStock: { ...initialStock, rice: 2, lemon_mix: 1, peanuts: 1, curd: 1 }, outage: null,
    requests: [0, 12, 24, 36, 48, 60, 72, 84].map((arrival, index) => request(index, arrival, { preferredDishId: "lemon_rice", budgetPaise: 12000, allowSubstitutes: true }))
  };
  return {
    initialStock, outage: null,
    requests: [0, 5, 10, 15, 20, 25, 30, 35].map((arrival, index) => request(index, arrival, {
      preferredDishId: "plain_dosa", budgetPaise: 12000, deadlineSeconds: 105, allowSubstitutes: false
    }))
  };
}

function matchesHardConstraints(dish: CatalogDish, input: Request): boolean {
  return dish.pricePaise <= input.budgetPaise
    && !dish.facts.some((fact) => input.excluded.includes(fact))
    && (!input.preferredDishId || input.allowSubstitutes || dish.id === input.preferredDishId);
}

function hasStock(dish: CatalogDish, stock: Record<string, number>): boolean {
  return Object.entries(dish.ingredients).every(([ingredient, units]) => (stock[ingredient] ?? 0) >= units);
}

function runScenario(policy: Policy, scenario: Scenario, seed: number): Metrics {
  const config = scenarioConfig(scenario);
  const metrics = blankMetrics();
  const stock = { ...config.initialStock };
  const stationAvailable = { tawa: 0, bowls: 0 };

  for (const input of config.requests) {
    metrics.requests += 1;
    const baseCandidates = CATALOG.filter((dish) => matchesHardConstraints(dish, input));
    const preferred = baseCandidates.find((dish) => dish.id === input.preferredDishId);
    const ordered = preferred ? [preferred, ...baseCandidates.filter((dish) => dish.id !== preferred.id)] : [...baseCandidates].sort((left, right) => left.pricePaise - right.pricePaise);
    const capacityAware = policy === "rasoi" || policy === "diagnostic-control";
    const inventoryAware = policy !== "static-menu";
    const original = input.preferredDishId ? CATALOG.find((dish) => dish.id === input.preferredDishId) ?? null : null;
    const originalUnavailable = Boolean(original && (
      !hasStock(original, stock)
      || (config.outage?.stationId === original.stationId && input.arrivalSeconds >= config.outage.startSeconds && input.arrivalSeconds < config.outage.endSeconds)
      || Math.max(input.arrivalSeconds + 1, stationAvailable[original.stationId]) + original.cookSeconds + 5 > input.arrivalSeconds + input.deadlineSeconds
    ));
    if (originalUnavailable && input.allowSubstitutes) metrics.alternativeEligible += 1;

    let selected: CatalogDish | undefined;
    let scheduledStart = input.arrivalSeconds + 1;
    let promisedReady = 0;
    for (const dish of ordered) {
      if (inventoryAware && !hasStock(dish, stock)) continue;
      let start = capacityAware ? Math.max(input.arrivalSeconds + 1, stationAvailable[dish.stationId]) : input.arrivalSeconds + 1;
      if (capacityAware && config.outage?.stationId === dish.stationId && start >= config.outage.startSeconds && start < config.outage.endSeconds) start = config.outage.endSeconds;
      const promise = start + dish.cookSeconds + 5;
      if (capacityAware && promise > input.arrivalSeconds + input.deadlineSeconds) continue;
      selected = dish;
      scheduledStart = start;
      promisedReady = capacityAware ? promise : input.arrivalSeconds + 1 + dish.cookSeconds + 5;
      break;
    }

    if (!selected || seededUnit(seed, `${scenario}:${input.id}:${input.actorId}`) < 0.12) {
      metrics.refusals += 1;
      continue;
    }
    if (!matchesHardConstraints(selected, input) || promisedReady > input.arrivalSeconds + input.deadlineSeconds) metrics.proposedHardConstraintViolations += 1;
    metrics.accepted += 1;
    if (!matchesHardConstraints(selected, input) || promisedReady > input.arrivalSeconds + input.deadlineSeconds) metrics.acceptedHardConstraintViolations += 1;
    if (originalUnavailable && selected.id !== input.preferredDishId) metrics.validAlternativeRecoveries += 1;

    const actualStart = Math.max(scheduledStart, stationAvailable[selected.stationId]);
    const actualEnd = actualStart + selected.cookSeconds;
    const stockAvailable = hasStock(selected, stock);
    const failsDuringCooking = Boolean(config.outage?.stationId === selected.stationId
      && config.outage.startSeconds > actualStart && config.outage.startSeconds < actualEnd);
    const stationAlreadyDown = Boolean(config.outage?.stationId === selected.stationId
      && actualStart >= config.outage.startSeconds && actualStart < config.outage.endSeconds);
    const canServe = stockAvailable && !failsDuringCooking && !stationAlreadyDown;
    const hardViolation = !matchesHardConstraints(selected, input) || actualEnd + 5 > input.arrivalSeconds + input.deadlineSeconds;

    if (!canServe) {
      metrics.acceptedButUnfulfillable += 1;
      metrics.promiseMisses += 1;
      metrics.refundRequiredPaise += selected.pricePaise;
      metrics.refundProcessedPaise += selected.pricePaise;
      if (failsDuringCooking && stockAvailable) metrics.materialWasteCostPaise += Math.round(selected.pricePaise * 0.35);
      continue;
    }
    stationAvailable[selected.stationId] = actualEnd;
    for (const [ingredient, units] of Object.entries(selected.ingredients)) stock[ingredient] = (stock[ingredient] ?? 0) - units;
    metrics.served += 1;
    if (actualEnd + 5 > promisedReady) metrics.promiseMisses += 1;
    if (hardViolation) metrics.fulfillmentHardConstraintViolations += 1;
    else metrics.safeFulfilledGmvPaise += selected.pricePaise;
  }
  metrics.refundOutstandingPaise = metrics.refundRequiredPaise - metrics.refundProcessedPaise;
  return metrics;
}

function add(target: Metrics, source: Metrics): void {
  for (const key of Object.keys(target) as Array<keyof Metrics>) target[key] += source[key];
}

const policies = POLICIES.map((policy) => {
  const totals = blankMetrics();
  const byScenario = SCENARIOS.map((scenario) => {
    const metrics = blankMetrics();
    for (const seed of SEEDS) add(metrics, runScenario(policy, scenario, seed));
    add(totals, metrics);
    return { scenario, seeds: SEEDS, metrics };
  });
  return {
    policy,
    totals: {
      ...totals,
      acceptedButUnfulfillableRate: totals.accepted ? totals.acceptedButUnfulfillable / totals.accepted : 0,
      promiseMissRate: totals.accepted ? totals.promiseMisses / totals.accepted : 0,
      validAlternativeRecoveryRate: totals.alternativeEligible ? totals.validAlternativeRecoveries / totals.alternativeEligible : 0
    },
    byScenario
  };
});

const report = {
  benchmarkVersion: BENCHMARK_VERSION,
  catalogVersion: CATALOG_VERSION,
  generatedAt: new Date().toISOString(),
  truthLabel: "Synthetic offline simulation; not observed merchant demand, revenue uplift, profit, or food-safety evidence.",
  assumptions: {
    scenarios: SCENARIOS, seeds: SEEDS, actors: ["human", "asha", "kabir"], decisionCostSeconds: 1,
    customerAcceptance: "Every valid offer uses the same seeded rule: reject when deterministic willingness draw is below 0.12.",
    refunds: "All synthetic cancellation liabilities are processed immediately; provider timing and fees are excluded.",
    diagnosticControl: "Uses the same structured inputs and scheduler as RASOI with no language model."
  },
  policies
};

const artifactsDir = resolve(process.cwd(), "artifacts");
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(resolve(artifactsDir, "economics-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);

const table = policies.map(({ policy, totals }) => `| ${policy} | ${totals.accepted} | ${totals.served} | ${(totals.acceptedButUnfulfillableRate * 100).toFixed(1)}% | ${(totals.promiseMissRate * 100).toFixed(1)}% | ₹${(totals.safeFulfilledGmvPaise / 100).toFixed(0)} | ₹${(totals.refundRequiredPaise / 100).toFixed(0)} | ${(totals.validAlternativeRecoveryRate * 100).toFixed(1)}% |`).join("\n");
const markdown = `# RASOI synthetic economics benchmark\n\nGenerated: ${report.generatedAt}\n\n> ${report.truthLabel}\n\nFive fixed scenarios × ten seeds use identical requests, actors, fault schedules, stock, and deterministic customer willingness for every policy. The diagnostic control intentionally matches RASOI because this benchmark uses already-structured inputs; it attributes no scheduling gain to language AI.\n\n| Policy | Accepted | Served | Unfulfillable | Promise miss | Safe fulfilled GMV | Refund liability | Alternative recovery |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\nSee \`artifacts/economics-benchmark.json\` for scenario-level counts, hard-constraint violations, waste estimates, unresolved records, seed/config versions, and assumptions.\n`;
writeFileSync(resolve(process.cwd(), "ECONOMICS_BENCHMARK.md"), markdown);
console.log(markdown);
