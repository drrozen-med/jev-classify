/**
 * Cost telemetry for Jev runs.
 *
 * Every Jev call is recorded with what was sent, what came back, how long it
 * took and what it cost. Costs are *estimates* built from a rate table: the
 * Typesafe billing model is not a per-token model we can rely on, so the
 * tracker records billable units (requests, questions, characters, tokens
 * when the API reports them) and only converts them to money when a rate is
 * configured. When no rate is configured, the summary says "unpriced" instead
 * of pretending the number is real.
 */

/** Rates used to turn billable units into money. All values are optional. */
export interface CostRates {
  /** USD per API request. */
  perRequestUsd?: number;
  /** USD per input token (only usable when the API reports input tokens). */
  perInputTokenUsd?: number;
  /** USD per output token (only usable when the API reports output tokens). */
  perOutputTokenUsd?: number;
  currency?: string;
}

/** One recorded API call. */
export interface JevCallRecord {
  runId: string;
  at: string;
  provider: string;
  model: string;
  promptVersion: string;
  /** API requests made (one record per request). */
  requests: number;
  /** Questions asked in this call. */
  questions: number;
  /** Characters sent as state + instructions. */
  inputChars: number;
  /** Characters returned. */
  outputChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  outcome: "ok" | "error";
  error?: string;
  /** Estimated cost in USD, or null when no rate is configured. */
  estimatedCostUsd: number | null;
}

/** Aggregated cost for a run. */
export interface CostSummary {
  runId: string;
  provider: string;
  model: string;
  promptVersion: string;
  calls: number;
  failedCalls: number;
  requests: number;
  questions: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  estimatedCostUsd: number | null;
  /** "priced" when a rate produced a number, "unpriced" when it did not. */
  costStatus: "priced" | "unpriced";
  currency: string;
  /** Cost per classified item, when the caller knows how many items ran. */
  costPerItemUsd: number | null;
}

export interface CostTrackerOptions {
  runId: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  rates?: CostRates;
  /** Injected clock, for tests. */
  now?: () => Date;
}

/**
 * Records calls and produces a run summary.
 *
 * The tracker never throws on cost accounting: a metering problem must not
 * fail a classification run.
 */
export class CostTracker {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  private readonly rates: CostRates;
  private readonly now: () => Date;
  private readonly records: JevCallRecord[] = [];
  private itemsSeen = 0;

  constructor(opts: CostTrackerOptions) {
    this.runId = opts.runId;
    this.provider = opts.provider ?? "typesafe";
    this.model = opts.model ?? "jev-latest";
    this.promptVersion = opts.promptVersion ?? "unspecified";
    this.rates = opts.rates ?? {};
    this.now = opts.now ?? (() => new Date());
  }

  /** Record one API call. */
  recordCall(call: {
    requests?: number;
    questions: number;
    inputChars: number;
    outputChars: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    durationMs: number;
    outcome: "ok" | "error";
    error?: string;
  }): JevCallRecord {
    const requests = call.requests ?? 1;
    const estimatedCostUsd = this.estimate({
      requests,
      inputTokens: call.inputTokens ?? null,
      outputTokens: call.outputTokens ?? null,
    });
    const record: JevCallRecord = {
      runId: this.runId,
      at: this.now().toISOString(),
      provider: this.provider,
      model: this.model,
      promptVersion: this.promptVersion,
      requests,
      questions: call.questions,
      inputChars: call.inputChars,
      outputChars: call.outputChars,
      inputTokens: call.inputTokens ?? null,
      outputTokens: call.outputTokens ?? null,
      durationMs: call.durationMs,
      outcome: call.outcome,
      ...(call.error ? { error: call.error } : {}),
      estimatedCostUsd,
    };
    this.records.push(record);
    return record;
  }

  /** Tell the tracker how many items the run classifies, for cost-per-item. */
  setItemCount(count: number): void {
    this.itemsSeen = count;
  }

  /** The raw records, oldest first. */
  get calls(): readonly JevCallRecord[] {
    return this.records;
  }

  /** Aggregate the run. */
  summary(): CostSummary {
    const ok = this.records.filter((r) => r.outcome === "ok");
    const failedCalls = this.records.length - ok.length;
    const sum = (pick: (r: JevCallRecord) => number) =>
      this.records.reduce((acc, r) => acc + pick(r), 0);
    const sumNullable = (pick: (r: JevCallRecord) => number | null): number | null => {
      let total = 0;
      let seen = false;
      for (const r of this.records) {
        const v = pick(r);
        if (v === null || v === undefined) continue;
        total += v;
        seen = true;
      }
      return seen ? total : null;
    };
    const estimatedCostUsd = sumNullable((r) => r.estimatedCostUsd);
    const costStatus: "priced" | "unpriced" = estimatedCostUsd === null ? "unpriced" : "priced";
    return {
      runId: this.runId,
      provider: this.provider,
      model: this.model,
      promptVersion: this.promptVersion,
      calls: this.records.length,
      failedCalls,
      requests: sum((r) => r.requests),
      questions: sum((r) => r.questions),
      inputChars: sum((r) => r.inputChars),
      outputChars: sum((r) => r.outputChars),
      inputTokens: sumNullable((r) => r.inputTokens),
      outputTokens: sumNullable((r) => r.outputTokens),
      durationMs: sum((r) => r.durationMs),
      estimatedCostUsd,
      costStatus,
      currency: this.rates.currency ?? "USD",
      costPerItemUsd:
        estimatedCostUsd !== null && this.itemsSeen > 0
          ? estimatedCostUsd / this.itemsSeen
          : null,
    };
  }

  /** The run's records as JSON Lines, one record per line. */
  toJsonl(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n");
  }

  /** A one-line human summary for logs and CI output. */
  formatSummary(): string {
    const s = this.summary();
    const cost =
      s.estimatedCostUsd === null
        ? "cost: unpriced (no rate configured)"
        : `cost: ~${s.estimatedCostUsd.toFixed(6)} ${s.currency}`;
    const perItem =
      s.costPerItemUsd === null ? "" : ` (${s.costPerItemUsd.toFixed(6)}/item)`;
    return (
      `run ${s.runId}: ${s.calls} call(s), ${s.failedCalls} failed, ` +
      `${s.requests} request(s), ${s.questions} question(s), ` +
      `${s.inputTokens ?? "?"} in / ${s.outputTokens ?? "?"} out tokens, ` +
      `${(s.durationMs / 1000).toFixed(1)}s — ${cost}${perItem}`
    );
  }

  private estimate(input: {
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
  }): number | null {
    const { perRequestUsd, perInputTokenUsd, perOutputTokenUsd } = this.rates;
    const any = perRequestUsd ?? perInputTokenUsd ?? perOutputTokenUsd;
    if (any === undefined) return null;
    let total = 0;
    if (perRequestUsd) total += perRequestUsd * input.requests;
    if (perInputTokenUsd && input.inputTokens !== null) {
      total += perInputTokenUsd * input.inputTokens;
    }
    if (perOutputTokenUsd && input.outputTokens !== null) {
      total += perOutputTokenUsd * input.outputTokens;
    }
    return Number(total.toFixed(8));
  }
}
