import assert from "node:assert/strict";
import test from "node:test";

import { CostTracker } from "../src/cost.ts";

test("an unpriced run reports unpriced rather than a fake zero", () => {
  const tracker = new CostTracker({ runId: "r1" });
  tracker.recordCall({
    questions: 3,
    inputChars: 100,
    outputChars: 20,
    durationMs: 250,
    outcome: "ok",
  });
  const summary = tracker.summary();
  assert.equal(summary.costStatus, "unpriced");
  assert.equal(summary.estimatedCostUsd, null);
  assert.equal(summary.calls, 1);
  assert.equal(summary.questions, 3);
  assert.match(tracker.formatSummary(), /unpriced/);
});

test("a priced run sums requests and tokens", () => {
  const tracker = new CostTracker({
    runId: "r2",
    rates: { perRequestUsd: 0.001, perInputTokenUsd: 0.000002, perOutputTokenUsd: 0.000004 },
  });
  tracker.setItemCount(10);
  tracker.recordCall({
    questions: 2,
    inputChars: 500,
    outputChars: 50,
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 300,
    outcome: "ok",
  });
  tracker.recordCall({
    questions: 1,
    inputChars: 200,
    outputChars: 20,
    inputTokens: 400,
    outputTokens: 80,
    durationMs: 120,
    outcome: "ok",
  });
  const summary = tracker.summary();
  assert.equal(summary.costStatus, "priced");
  assert.equal(summary.calls, 2);
  assert.equal(summary.requests, 2);
  assert.equal(summary.inputTokens, 1400);
  assert.equal(summary.outputTokens, 280);
  // 2 requests * 0.001 + 1400 * 0.000002 + 280 * 0.000004
  assert.equal(Number(summary.estimatedCostUsd!.toFixed(8)), 0.00592);
  assert.equal(Number(summary.costPerItemUsd!.toFixed(8)), 0.000592);
});

test("failed calls are counted and kept", () => {
  const tracker = new CostTracker({ runId: "r3" });
  tracker.recordCall({
    questions: 1,
    inputChars: 10,
    outputChars: 0,
    durationMs: 50,
    outcome: "error",
    error: "jev_status_500",
  });
  const summary = tracker.summary();
  assert.equal(summary.calls, 1);
  assert.equal(summary.failedCalls, 1);
  const lines = tracker.toJsonl().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"outcome":"error"/);
});
