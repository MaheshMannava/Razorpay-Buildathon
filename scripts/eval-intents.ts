import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { extractWithOpenAI, extractWithRules, intentExtractionSchema, type IntentExtraction } from "../src/server/agent.js";

const fixtureSchema = z.object({
  version: z.string(),
  frozenAt: z.string(),
  cases: z.array(z.object({ id: z.number().int(), text: z.string(), gold: intentExtractionSchema }))
});

type ResultRow = { id: number; expected: IntentExtraction; actual: IntentExtraction; latencyMs: number };

function equalList(a: string[], b: string[]) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function summarize(rows: ResultRow[]) {
  const fields = ["budgetPaise", "deadlineSeconds", "exclusions", "preferredDishIds", "substitutesAllowed", "clarificationReasons", "safetyLimitationRequired"] as const;
  const correct = Object.fromEntries(fields.map((field) => [field, 0])) as Record<typeof fields[number], number>;
  let completeHardFields = 0;
  let falseClarifications = 0;
  let missedClarifications = 0;
  let unsupportedFacts = 0;
  let guardRejections = 0;

  for (const row of rows) {
    const fieldMatches = fields.map((field) => {
      const expected = row.expected[field];
      const actual = row.actual[field];
      const matches = Array.isArray(expected) && Array.isArray(actual) ? equalList(expected, actual) : expected === actual;
      if (matches) correct[field] += 1;
      return matches;
    });
    if (fieldMatches.slice(0, 5).every(Boolean)) completeHardFields += 1;
    const expectedClarification = row.expected.clarificationReasons.length > 0;
    const actualClarification = row.actual.clarificationReasons.length > 0;
    if (actualClarification) guardRejections += 1;
    if (actualClarification && !expectedClarification) falseClarifications += 1;
    if (!actualClarification && expectedClarification) missedClarifications += 1;
    if (row.expected.budgetPaise === null && row.actual.budgetPaise !== null) unsupportedFacts += 1;
    if (row.expected.deadlineSeconds === null && row.actual.deadlineSeconds !== null) unsupportedFacts += 1;
    unsupportedFacts += row.actual.exclusions.filter((value) => !row.expected.exclusions.includes(value)).length;
    unsupportedFacts += row.actual.preferredDishIds.filter((value) => !row.expected.preferredDishIds.includes(value)).length;
  }

  return {
    sampleSize: rows.length,
    exactPerField: Object.fromEntries(fields.map((field) => [field, { correct: correct[field], accuracy: correct[field] / rows.length }])),
    completeHardFields: { correct: completeHardFields, accuracy: completeHardFields / rows.length },
    falseClarifications,
    missedClarifications,
    unsupportedFacts,
    guardRejections,
    meanLatencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length
  };
}

async function main() {
  mkdirSync(resolve("artifacts"), { recursive: true });
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(resolve("fixtures/requests.json"), "utf8")));
  const ruleRows: ResultRow[] = fixture.cases.map((testCase) => {
    const start = performance.now();
    const actual = extractWithRules(testCase.text);
    return { id: testCase.id, expected: testCase.gold, actual, latencyMs: performance.now() - start };
  });

  let openAI: { model: string; rows: ResultRow[]; summary: ReturnType<typeof summarize> } | { status: "not_run"; reason: string };
  if (process.env.AGENT_MODE === "openai" && process.env.OPENAI_API_KEY && process.env.LLM_MODEL) {
    const checkpointPath = resolve("artifacts/gate-b-openai-checkpoint.json");
    const checkpointSchema = z.object({ fixtureVersion: z.string(), model: z.string(), rows: z.array(z.object({ id: z.number(), expected: intentExtractionSchema, actual: intentExtractionSchema, latencyMs: z.number() })) });
    const checkpoint = existsSync(checkpointPath)
      ? checkpointSchema.safeParse(JSON.parse(readFileSync(checkpointPath, "utf8")))
      : null;
    const rows: ResultRow[] = checkpoint?.success && checkpoint.data.fixtureVersion === fixture.version && checkpoint.data.model === process.env.LLM_MODEL
      ? checkpoint.data.rows
      : [];
    for (const testCase of fixture.cases) {
      if (rows.some((row) => row.id === testCase.id)) continue;
      const start = performance.now();
      let actual: IntentExtraction | undefined;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2 && !actual; attempt += 1) {
        try {
          actual = await extractWithOpenAI(testCase.text, { apiKey: process.env.OPENAI_API_KEY, model: process.env.LLM_MODEL });
        } catch (error) {
          lastError = error;
          if (attempt === 1) console.warn(`Case ${testCase.id} failed once; retrying with the same prompt and schema.`);
        }
      }
      if (!actual) throw lastError;
      rows.push({ id: testCase.id, expected: testCase.gold, actual, latencyMs: performance.now() - start });
      writeFileSync(checkpointPath, `${JSON.stringify({ fixtureVersion: fixture.version, model: process.env.LLM_MODEL, rows }, null, 2)}\n`, { mode: 0o600 });
      console.log(`OpenAI case ${testCase.id}/${fixture.cases.length} complete.`);
    }
    openAI = { model: process.env.LLM_MODEL, rows, summary: summarize(rows) };
  } else {
    openAI = { status: "not_run", reason: "Set AGENT_MODE=openai, OPENAI_API_KEY, and LLM_MODEL to run the live structured-output comparison." };
  }

  const report = { reportVersion: "gate-b-report-v1", generatedAt: new Date().toISOString(), fixtureVersion: fixture.version, baseline: { method: "rules-v1", rows: ruleRows, summary: summarize(ruleRows) }, openAI };
  writeFileSync(resolve("artifacts/gate-b-evaluation.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ baseline: report.baseline.summary, openAI: "status" in openAI ? openAI : openAI.summary }, null, 2));
}

await main();
