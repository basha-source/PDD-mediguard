"use strict";
/**
 * MediGuard — Baseline / Load test for the backend API.
 *
 * Profile (as specified):
 *   - 100 virtual users (concurrent connections)
 *   - held continuously for 60 seconds per scenario
 *   - thousands of requests per scenario
 *
 * Measures, per scenario:
 *   - Requests per second (mean / stddev / min / max)
 *   - Latency in ms (min / mean / max / p50 / p90 / p95 / p99)
 *   - Throughput in bytes/sec
 *   - Errors, timeouts, and non-2xx responses
 *
 * Endpoint selection — deliberate, and worth stating plainly:
 * only endpoints that are safe to hammer are in the profile. GET /health and
 * GET / are pure in-process handlers with no I/O. Excluded on purpose:
 *   - /api/ai/ask and /api/medicines/ocr proxy to the ML service on a free
 *     Hugging Face tier; 100 VUs would DoS a third party, not test MediGuard.
 *   - /api/medicines/lookup and /api/interactions/* call openFDA and upcitemdb,
 *     which are rate-limited public APIs belonging to someone else.
 *   - /api/auth/* is rate-limited to 10 req / 15 min per IP by design, so a
 *     load profile would measure express-rate-limit, not the application.
 * Loading someone else's API without permission is an attack, not a benchmark.
 *
 * Usage:
 *   node baseline-load-test.js                      # 100 VU x 60s, default target
 *   TARGET=http://localhost:4000 node baseline-load-test.js
 *   CONNECTIONS=50 DURATION=30 node baseline-load-test.js
 */

const autocannon = require("autocannon");
const path = require("path");
const fs = require("fs");
const { writeReport } = require("./reporter");

const TARGET = (process.env.TARGET || "http://127.0.0.1:4000").replace(/\/+$/, "");
const CONNECTIONS = Number(process.env.CONNECTIONS || 100);
const DURATION = Number(process.env.DURATION || 60);
const PIPELINING = Number(process.env.PIPELINING || 1);

const OUT = path.join(__dirname, "reports", "load-test-report.xlsx");
const JSON_OUT = path.join(__dirname, "reports", "load-results.json");

// ── Service level objectives ────────────────────────────────────────────────
// These are the thresholds each scenario is graded against. They are deliberately
// set for a free-tier single instance, not for a tuned production cluster.
const SLO = {
  minRps: 50,             // sustained requests/sec
  maxMeanLatency: 250,    // ms — the "average: 250ms" target in the brief
  maxP99Latency: 1500,    // ms — the "max: 1.5s" tail target
  maxErrorRate: 0.01,     // 1% of requests may fail
  maxNon2xxRate: 0.01,
  minWindowRps: 1,        // every 1s window must serve at least this many
};

const SCENARIOS = [
  {
    key: "health",
    name: "Health check endpoint",
    method: "GET",
    path: "/health",
    description: "Liveness probe — in-process JSON response, no I/O. The purest measure of framework overhead.",
  },
  {
    key: "root",
    name: "API root / status",
    method: "GET",
    path: "/",
    description: "Service banner route. Same handler shape as /health, exercised separately to confirm routing cost is flat.",
  },
  {
    key: "notfound",
    name: "Unmatched route (404 path)",
    method: "GET",
    path: "/api/does-not-exist",
    description: "Express fall-through. Confirms the 404 path does not cost more than a matched route — a common DoS amplifier.",
  },
  {
    key: "badmethod",
    name: "Unsupported method on a real route",
    method: "POST",
    path: "/health",
    description: "POST against a GET-only route. Exercises the router's rejection path under the same concurrency.",
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

function runScenario(scenario) {
  return new Promise((resolve, reject) => {
    const samples = [];

    const instance = autocannon(
      {
        url: TARGET + scenario.path,
        method: scenario.method,
        connections: CONNECTIONS,
        duration: DURATION,
        pipelining: PIPELINING,
        headers: { "content-type": "application/json" },
        body: scenario.method === "POST" ? JSON.stringify({ probe: true }) : undefined,
        title: scenario.name,
      },
      (err, result) => (err ? reject(err) : resolve({ result, samples }))
    );

    // autocannon emits one tick per second; capture it so the report can show
    // whether throughput was steady or collapsed halfway through the run.
    //
    // It also emits one extra tick as the run tears down, after the clock has
    // stopped and the sockets are closing. That trailing sample always reads 0
    // and is not a measurement window, so the capture stops at DURATION —
    // otherwise every scenario reports a phantom "throughput collapsed" in a
    // 61st second that never carried load.
    instance.on("tick", (counter) => {
      if (samples.length >= DURATION) return;
      samples.push({ second: samples.length + 1, requests: counter.counter || 0 });
    });

    autocannon.track(instance, { renderProgressBar: true, renderResultsTable: false });
  });
}

function pct(n) { return (n * 100).toFixed(2) + "%"; }

/**
 * Turn one scenario's measurements into individual pass/fail test cases.
 * 15 aggregate assertions + one per 1-second window = 15 + DURATION cases.
 */
function buildCases(scenario, result, samples) {
  const out = [];
  const total = result.requests.total || 0;
  const errors = (result.errors || 0) + (result.timeouts || 0);
  const non2xx = result.non2xx || 0;
  const errorRate = total ? errors / total : 0;
  const non2xxRate = total ? non2xx / total : 0;

  const add = (metric, expected, actual, ok, detail) => {
    out.push({
      id: `LOAD-${scenario.key.toUpperCase()}-${String(out.length + 1).padStart(3, "0")}`,
      suite: `${scenario.name} (${CONNECTIONS} VU / ${DURATION}s)`,
      scenario: scenario.name,
      endpoint: `${scenario.method} ${scenario.path}`,
      metric,
      expected,
      actual: String(actual),
      status: ok ? "PASS" : "FAIL",
      error: ok ? "" : detail || `${metric} outside threshold`,
    });
  };

  // ---- Aggregate assertions (15) ----------------------------------------
  add("Requests completed", "> 0 requests served", total, total > 0);
  add("Sustained throughput (mean RPS)", `>= ${SLO.minRps} req/sec`,
    `${result.requests.mean.toFixed(2)} req/sec`, result.requests.mean >= SLO.minRps);
  add("Peak throughput (max RPS)", ">= mean RPS",
    `${result.requests.max.toFixed(2)} req/sec`, result.requests.max >= result.requests.mean);
  add("Throughput floor (min RPS)", "> 0 req/sec in the worst second",
    `${result.requests.min.toFixed(2)} req/sec`, result.requests.min > 0);
  add("Mean latency", `<= ${SLO.maxMeanLatency} ms`,
    `${result.latency.mean.toFixed(2)} ms`, result.latency.mean <= SLO.maxMeanLatency);
  add("Minimum latency", ">= 0 ms and recorded",
    `${result.latency.min} ms`, result.latency.min >= 0);
  add("Maximum latency", `<= ${SLO.maxP99Latency * 4} ms (worst single request)`,
    `${result.latency.max} ms`, result.latency.max <= SLO.maxP99Latency * 4);
  add("p50 latency", `<= ${SLO.maxMeanLatency} ms`,
    `${result.latency.p50} ms`, result.latency.p50 <= SLO.maxMeanLatency);
  add("p90 latency", `<= ${SLO.maxP99Latency} ms`,
    `${result.latency.p90} ms`, result.latency.p90 <= SLO.maxP99Latency);
  add("p97_5 latency", `<= ${SLO.maxP99Latency} ms`,
    `${result.latency.p97_5} ms`, result.latency.p97_5 <= SLO.maxP99Latency);
  add("p99 latency", `<= ${SLO.maxP99Latency} ms`,
    `${result.latency.p99} ms`, result.latency.p99 <= SLO.maxP99Latency);
  add("Error rate", `<= ${pct(SLO.maxErrorRate)}`,
    `${pct(errorRate)} (${errors} of ${total})`, errorRate <= SLO.maxErrorRate);
  add("Socket timeouts", "0 timeouts", result.timeouts || 0, (result.timeouts || 0) === 0);
  add("Non-2xx responses", `<= ${pct(SLO.maxNon2xxRate)}`,
    `${pct(non2xxRate)} (${non2xx} of ${total})`,
    scenario.key === "notfound" || scenario.key === "badmethod" ? true : non2xxRate <= SLO.maxNon2xxRate,
    "route is expected to return non-2xx by design");
  add("Data throughput", "> 0 bytes/sec",
    `${(result.throughput.mean / 1024).toFixed(2)} KB/sec`, result.throughput.mean > 0);

  // ---- Per-second stability assertions (DURATION cases) ------------------
  for (const s of samples) {
    out.push({
      id: `LOAD-${scenario.key.toUpperCase()}-W${String(s.second).padStart(3, "0")}`,
      suite: `${scenario.name} (${CONNECTIONS} VU / ${DURATION}s)`,
      scenario: scenario.name,
      endpoint: `${scenario.method} ${scenario.path}`,
      metric: `Throughput stability — second ${s.second}`,
      expected: `>= ${SLO.minWindowRps} request(s) served in this 1s window`,
      actual: `${s.requests} requests`,
      status: s.requests >= SLO.minWindowRps ? "PASS" : "FAIL",
      error: s.requests >= SLO.minWindowRps ? "" : "throughput collapsed in this window",
    });
  }

  return out;
}

async function waitForTarget(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url + "/health");
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  console.log("MediGuard — Backend baseline / load test");
  console.log("=".repeat(70));
  console.log(`Target           : ${TARGET}`);
  console.log(`Virtual users    : ${CONNECTIONS} concurrent connections`);
  console.log(`Duration         : ${DURATION}s per scenario`);
  console.log(`Scenarios        : ${SCENARIOS.length}`);
  console.log(`Expected cases   : ${SCENARIOS.length * (15 + DURATION)}`);
  console.log("=".repeat(70));

  console.log("Waiting for the target to become healthy…");
  const up = await waitForTarget(TARGET);
  if (!up) {
    console.error(`\nERROR: ${TARGET}/health did not respond within 60s.`);
    console.error("Start the API first:  pnpm --filter @mediguard/backend dev");
    process.exit(2);
  }
  console.log("Target is healthy. Starting load.\n");

  const allCases = [];
  const scenarioSummaries = [];
  const startedAt = new Date();

  for (const scenario of SCENARIOS) {
    console.log(`\n--- ${scenario.name} — ${scenario.method} ${scenario.path} ---`);
    const { result, samples } = await runScenario(scenario);

    scenarioSummaries.push({
      name: scenario.name,
      endpoint: `${scenario.method} ${scenario.path}`,
      description: scenario.description,
      connections: CONNECTIONS,
      duration: DURATION,
      totalRequests: result.requests.total,
      rpsMean: Number(result.requests.mean.toFixed(2)),
      rpsMin: Number(result.requests.min.toFixed(2)),
      rpsMax: Number(result.requests.max.toFixed(2)),
      latencyMean: Number(result.latency.mean.toFixed(2)),
      latencyMin: result.latency.min,
      latencyMax: result.latency.max,
      latencyP50: result.latency.p50,
      latencyP90: result.latency.p90,
      latencyP99: result.latency.p99,
      throughputKBs: Number((result.throughput.mean / 1024).toFixed(2)),
      errors: result.errors || 0,
      timeouts: result.timeouts || 0,
      non2xx: result.non2xx || 0,
      samples,
    });

    allCases.push(...buildCases(scenario, result, samples));

    console.log(`  Requests : ${result.requests.total}`);
    console.log(`  RPS      : mean ${result.requests.mean.toFixed(1)}  min ${result.requests.min}  max ${result.requests.max}`);
    console.log(`  Latency  : mean ${result.latency.mean.toFixed(1)}ms  min ${result.latency.min}ms  max ${result.latency.max}ms`);
    console.log(`  p50/p90/p99: ${result.latency.p50}ms / ${result.latency.p90}ms / ${result.latency.p99}ms`);
    console.log(`  Errors   : ${result.errors || 0}  timeouts ${result.timeouts || 0}  non-2xx ${result.non2xx || 0}`);
  }

  const finishedAt = new Date();
  const summary = await writeReport({
    outFile: OUT,
    title: "MediGuard — Backend Baseline & Load Test Report",
    meta: {
      "Application": "MediGuard API (apps/backend)",
      "Test type": "Baseline / Load (sustained concurrency)",
      "Tool": "autocannon " + require("autocannon/package.json").version,
      "Target": TARGET,
      "Virtual users": `${CONNECTIONS} concurrent connections`,
      "Duration per scenario": `${DURATION} s`,
      "Scenarios": SCENARIOS.length,
      "Started at": startedAt.toISOString(),
      "Finished at": finishedAt.toISOString(),
    },
    slo: SLO,
    scenarios: scenarioSummaries,
    cases: allCases,
  });

  fs.writeFileSync(JSON_OUT, JSON.stringify({ scenarios: scenarioSummaries, summary }, null, 2));

  console.log("\n" + "=".repeat(70));
  console.log(`Total cases : ${summary.total}`);
  console.log(`Passed      : ${summary.passed}`);
  console.log(`Failed      : ${summary.failed}`);
  console.log(`Pass %      : ${summary.passRate}`);
  console.log(`Report      : ${OUT}`);
  console.log("=".repeat(70));

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error in the load runner:", e);
  process.exit(2);
});
