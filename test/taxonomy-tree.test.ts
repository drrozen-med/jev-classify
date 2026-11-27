import assert from "node:assert/strict";
import test from "node:test";

import { buildTree, describePath, depthOf, deepestExistingTopic, NONE_KEY, STAY_KEY } from "../src/taxonomy-tree.ts";
import type { TopicNode } from "../src/types.ts";

const topics: TopicNode[] = [
  { path: "aba", title: "Anesthesia" },
  { path: "aba.airway", title: "Airway Management" },
  { path: "aba.airway.difficult-airway-algorithm", title: "Difficult Airway Algorithm" },
  { path: "aba.airway.difficult-airway-algorithm.da-algorithm-cervical-instability", title: "DA algorithm + cervical instability" },
  { path: "aba.airway.emergency-airway", title: "Emergency Airway" },
  { path: "aba.vascular", title: "Vascular Anesthesia" },
  { path: "aba.vascular.thoracic-aortic-surgery", title: "Thoracic Aortic Surgery" },
  { path: "aba.vascular.endovascular-aaa-repair-evar", title: "Endovascular AAA Repair (EVAR)" },
];

test("depth counts path segments", () => {
  assert.equal(depthOf("aba"), 1);
  assert.equal(depthOf("aba.airway"), 2);
  assert.equal(depthOf("aba.airway.emergency-airway"), 3);
});

test("children are the direct descendants only", () => {
  const tree = buildTree(topics);
  assert.deepEqual(
    tree.children("aba").map((c) => c.path),
    ["aba.airway", "aba.vascular"],
  );
  assert.deepEqual(
    tree.children("aba.airway").map((c) => c.path),
    ["aba.airway.difficult-airway-algorithm", "aba.airway.emergency-airway"],
  );
  assert.deepEqual(tree.children("aba.airway.difficult-airway-algorithm.da-algorithm-cervical-instability"), []);
});

test("leaf detection follows the tree", () => {
  const tree = buildTree(topics);
  assert.equal(tree.isLeaf("aba.vascular"), false);
  assert.equal(tree.isLeaf("aba.vascular.thoracic-aortic-surgery"), true);
});

test("criteria map path to title", () => {
  const tree = buildTree(topics);
  assert.deepEqual(tree.criteria("aba.vascular"), {
    "aba.vascular.endovascular-aaa-repair-evar": "Endovascular AAA Repair (EVAR)",
    "aba.vascular.thoracic-aortic-surgery": "Thoracic Aortic Surgery",
  });
});

test("deepest existing topic walks up to a topic that is in the tree", () => {
  const tree = buildTree(topics);
  assert.equal(
    deepestExistingTopic("aba.airway.difficult-airway-algorithm.gone-branch", tree),
    "aba.airway.difficult-airway-algorithm",
  );
  assert.equal(deepestExistingTopic("nothing.here", tree), null);
});

test("describePath joins titles", () => {
  const tree = buildTree(topics);
  assert.equal(
    describePath("aba.airway.difficult-airway-algorithm.da-algorithm-cervical-instability", tree),
    "Airway Management › Difficult Airway Algorithm › DA algorithm + cervical instability",
  );
  assert.equal(describePath(null, tree), "(no path)");
});

test("escape keys are stable", () => {
  assert.equal(STAY_KEY, "__stay_here__");
  assert.equal(NONE_KEY, "__none_fit__");
});
