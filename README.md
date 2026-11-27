# @drrozen-med/jev-classify

The Jev (TypeSafe "System One") classification machinery, packaged so every
repo in the org classifies content against a frozen taxonomy the same way.

Three pieces:

1. **Jev client** — typed questions in, structured answers with calibrated
   confidence out. Ported from the BoardsBridge claim classifier
   (`src/lib/jev-provider.ts`).
2. **Stepwise classifier** — walks an item down a topic tree, one typed choice
   question per level, batching items that share a branch into one request.
3. **Cost telemetry** — every call is recorded (requests, questions, characters,
   tokens when reported, duration, outcome) and summarised per run, with a rate
   table that turns billable units into an estimate. No rate configured means
   the summary says *unpriced* rather than inventing a number.

## Install

```bash
npm install @drrozen-med/jev-classify --registry=https://npm.pkg.github.com
```

GitHub Packages needs authentication even for public packages:

```bash
# .npmrc
@drrozen-med:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

## Use

```ts
import {
  buildTree,
  classifyItems,
  CostTracker,
  createJevClient,
} from "@drrozen-med/jev-classify";

const tree = buildTree(
  [
    { path: "aba", title: "Anesthesia" },
    { path: "aba.airway", title: "Airway Management" },
    { path: "aba.airway.emergency-airway", title: "Emergency Airway" },
  ],
  "aba",
);

const tracker = new CostTracker({
  runId: "run-2026-11-27-a",
  promptVersion: "mcq-usa-anesthesia-v1",
  rates: { perRequestUsd: 0.001 },
});

const results = await classifyItems(
  [{ id: "MCQ_1", text: "cannot intubate, cannot oxygenate" }],
  { tree, client: createJevClient(), tracker, minConfidence: 0.7 },
);

tracker.setItemCount(results.length);
console.log(tracker.formatSummary());
```

Environment: `TYPESAFE_API_KEY` or `JEV_CLASSIFICATION` (server-side only).

## How the walk works

- At every level the model is offered the children of the current topic, plus
  honest outs: `__stay_here__` (the item belongs at this topic) and
  `__none_fit__` (it belongs nowhere here).
- A placement is `accepted` only when the final step's confidence clears
  `minConfidence` (default 0.7). Below that it is `needs_review` and keeps the
  path it reached, so a human can look at it.
- A path that is not in the tree is never written.
- Every step is kept in `steps`, so a run can be audited later.

## Cost monitoring

`CostTracker` records one entry per API call and writes JSON Lines:

```ts
tracker.toJsonl(); // one JSON object per call
tracker.summary(); // calls, requests, questions, tokens, duration, estimated cost
tracker.formatSummary(); // one-line human summary
```

Rate fields are all optional (`perRequestUsd`, `perInputTokenUsd`,
`perOutputTokenUsd`). When none is set, `costStatus` is `unpriced` and
`estimatedCostUsd` is `null` — the run still reports its billable units.

## Provenance

Extracted from the BoardsBridge ABA claim pipeline
(`docs/aba/KCC-PIPELINE-SSOT.md`), which classified tens of thousands of
clinical claims against the `usa-anesthesia` taxonomy with Jev. The rules kept
here are the ones that survived that run: batched questions, honest outs,
confidence gating, and no invented paths.

## Tests

```bash
npm test        # node --test, no network, no database
npm run typecheck
```
