import assert from "node:assert/strict";
import test from "node:test";

import { classifyItems } from "../src/classifier.ts";
import { buildTree, NONE_KEY, STAY_KEY } from "../src/taxonomy-tree.ts";
import type { JevAnswer, JevClient, JevQuestion, JevResponse, TopicNode } from "../src/types.ts";

const topics: TopicNode[] = [
  { path: "aba", title: "Anesthesia" },
  { path: "aba.airway", title: "Airway Management" },
  { path: "aba.airway.difficult-airway-algorithm", title: "Difficult Airway Algorithm" },
  { path: "aba.airway.emergency-airway", title: "Emergency Airway" },
  { path: "aba.vascular", title: "Vascular Anesthesia" },
  { path: "aba.vascular.thoracic-aortic-surgery", title: "Thoracic Aortic Surgery" },
];

type AnswerPlan = Record<string, { choice: string; confidence: number }>;
/** "all" answers every question of that call that has no explicit script. */

/** A fake client that answers with a scripted plan per call, in call order. */
function fakeClient(plans: AnswerPlan[], defaultChoice?: { choice: string; confidence: number }): {
  client: JevClient;
  calls: Array<{ state: string; questions: Record<string, JevQuestion> }>;
} {
  const calls: Array<{ state: string; questions: Record<string, JevQuestion> }> = [];
  let index = 0;
  const client: JevClient = {
    systemOne: async (state, questions): Promise<JevResponse> => {
      calls.push({ state, questions });
      const plan = plans[index] ?? {};
      index += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const key of Object.keys(questions)) {
        const scripted = plan[key] ?? (plan.all as { choice: string; confidence: number } | undefined) ?? defaultChoice;
        answers[key] = scripted
          ? { type: "choice", choice: scripted.choice, confidence: scripted.confidence, probabilities: {} }
          : { type: "choice", choice: NONE_KEY, confidence: 0.1, probabilities: {} };
      }
      return { model: "jev-latest", answers, usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  return { client, calls };
}

test("an item is walked down to a leaf and accepted", async () => {
  const tree = buildTree(topics);
  const { client, calls } = fakeClient([
    { i0: { choice: "aba.airway", confidence: 0.9 } },
    { i0: { choice: "aba.airway.difficult-airway-algorithm", confidence: 0.85 } },
  ]);
  const results = await classifyItems([{ id: "m1", text: "videolaryngoscopy in c-spine injury" }], {
    tree,
    client,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.path, "aba.airway.difficult-airway-algorithm");
  assert.equal(results[0]!.status, "accepted");
  assert.equal(results[0]!.steps.length, 2);
  assert.equal(calls.length, 2);
});

test("a low-confidence final step lands in needs_review but keeps the path", async () => {
  const tree = buildTree(topics);
  const { client } = fakeClient([
    { i0: { choice: "aba.vascular", confidence: 0.9 } },
    { i0: { choice: "aba.vascular.thoracic-aortic-surgery", confidence: 0.5 } },
  ]);
  const results = await classifyItems([{ id: "m1", text: "aortic repair" }], { tree, client });
  assert.equal(results[0]!.path, "aba.vascular.thoracic-aortic-surgery");
  assert.equal(results[0]!.status, "needs_review");
  assert.equal(results[0]!.minConfidence, 0.5);
});

test("none-of-these lands unclassified with no path", async () => {
  const tree = buildTree(topics);
  const { client } = fakeClient([{ i0: { choice: NONE_KEY, confidence: 0.95 } }]);
  const results = await classifyItems([{ id: "m1", text: "not clinical content" }], { tree, client });
  assert.equal(results[0]!.path, null);
  assert.equal(results[0]!.status, "needs_review");
  assert.match(results[0]!.reason, /none of the offered topics/);
});

test("stay places the item at the current topic", async () => {
  const tree = buildTree(topics);
  const { client } = fakeClient([
    { i0: { choice: "aba.vascular", confidence: 0.9 } },
    { i0: { choice: STAY_KEY, confidence: 0.8 } },
  ]);
  const results = await classifyItems([{ id: "m1", text: "vascular in general" }], { tree, client });
  assert.equal(results[0]!.path, "aba.vascular");
  assert.equal(results[0]!.status, "accepted");
});

test("items sharing a branch are asked in one call", async () => {
  const tree = buildTree(topics);
  const { client, calls } = fakeClient([
    { i0: { choice: "aba.airway", confidence: 0.9 }, i1: { choice: "aba.airway", confidence: 0.9 } },
    {
      i0: { choice: "aba.airway.emergency-airway", confidence: 0.8 },
      i1: { choice: "aba.airway.difficult-airway-algorithm", confidence: 0.8 },
    },
  ]);
  const results = await classifyItems(
    [
      { id: "m1", text: "cannot intubate" },
      { id: "m2", text: "difficult airway" },
    ],
    { tree, client },
  );
  // Level 1: one call for both items (same branch). Level 2: one call for that branch.
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(calls[0]!.questions).length, 2);
  assert.equal(results[0]!.path, "aba.airway.emergency-airway");
  assert.equal(results[1]!.path, "aba.airway.difficult-airway-algorithm");
});

test("a failed request leaves the item unclassified", async () => {
  const tree = buildTree(topics);
  const client: JevClient = {
    systemOne: async () => {
      throw new Error("jev_status_429: slow down");
    },
  };
  const results = await classifyItems([{ id: "m1", text: "anything" }], { tree, client });
  assert.equal(results[0]!.status, "unclassified");
  assert.match(results[0]!.reason, /request failed/);
});

test("a choice outside the offered options is refused", async () => {
  const tree = buildTree(topics);
  const { client } = fakeClient([{ i0: { choice: "aba.not.a.topic", confidence: 0.99 } }]);
  const results = await classifyItems([{ id: "m1", text: "invented branch" }], { tree, client });
  assert.equal(results[0]!.path, null);
  assert.equal(results[0]!.status, "needs_review");
});

test("wide groups are split into batches the API will accept", async () => {
  const tree = buildTree(topics);
  const { client, calls } = fakeClient([
    { all: { choice: "aba.airway", confidence: 0.9 } },
    { all: { choice: "aba.airway", confidence: 0.9 } },
    { all: { choice: "aba.airway", confidence: 0.9 } },
    { all: { choice: "aba.airway.emergency-airway", confidence: 0.9 } },
    { all: { choice: "aba.airway.emergency-airway", confidence: 0.9 } },
    { all: { choice: "aba.airway.emergency-airway", confidence: 0.9 } },
  ]);
  const items = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, text: `item ${i}` }));
  const results = await classifyItems(items, { tree, client, maxItemsPerCall: 20 });
  // Level 1: 45 items → 3 calls of 20/20/5. Level 2: 3 calls of 20/20/5.
  assert.equal(calls.length, 6);
  assert.equal(Object.keys(calls[0]!.questions).length, 20);
  assert.equal(Object.keys(calls[2]!.questions).length, 5);
  assert.equal(results.length, 45);
  assert.equal(results.filter((r) => r.status === "accepted").length, 45);
});
