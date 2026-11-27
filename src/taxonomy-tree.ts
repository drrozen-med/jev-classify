/**
 * The topic tree: a frozen taxonomy release loaded as a flat list of topics.
 *
 * The classifier walks this tree one level at a time. Everything here is pure
 * so it can be tested without a database or a network.
 */
import type { TopicNode } from "./types.ts";

/** The answer key meaning "the item belongs at the topic we are standing on". */
export const STAY_KEY = "__stay_here__";
/** The answer key meaning "the item fits none of the offered topics". */
export const NONE_KEY = "__none_fit__";

/** Depth of a canonical path: `aba` is 1, `aba.airway` is 2. */
export function depthOf(path: string): number {
  return path.split(".").length;
}

/** A topic tree indexed by canonical path. */
export interface TopicTree {
  /** Every topic of the release, by path. */
  topics: ReadonlyMap<string, TopicNode>;
  /** The paths of every topic, as a set. */
  paths: ReadonlySet<string>;
  /** The root path (the tree top), e.g. `aba`. */
  top: string;
  /** The immediate children of a path, sorted. */
  children(path: string): TopicNode[];
  /** True when the path has no children — nothing can go deeper there. */
  isLeaf(path: string): boolean;
  /** The option map the model is offered: path → title. */
  criteria(path: string): Record<string, string>;
}

/** Build a tree from a flat topic list. */
export function buildTree(topics: readonly TopicNode[], top = "aba"): TopicTree {
  const map = new Map<string, TopicNode>();
  for (const t of topics) map.set(t.path, t);
  const paths = new Set(map.keys());
  const children = (path: string): TopicNode[] =>
    [...paths]
      .filter((p) => p.startsWith(`${path}.`) && depthOf(p) === depthOf(path) + 1)
      .sort()
      .map((p) => map.get(p)!);
  return {
    topics: map,
    paths,
    top,
    children,
    isLeaf: (path: string) => children(path).length === 0,
    criteria: (path: string) =>
      Object.fromEntries(children(path).map((c) => [c.path, c.title])),
  };
}

/** The deepest ancestor of `path` (inclusive) that exists in the tree. */
export function deepestExistingTopic(path: string, tree: TopicTree): string | null {
  const parts = path.split(".");
  for (let n = parts.length; n >= 1; n--) {
    const candidate = parts.slice(0, n).join(".");
    if (tree.paths.has(candidate)) return candidate;
  }
  return null;
}

/** The top-level topics (direct children of the tree top). */
export function topLevelTopics(tree: TopicTree): TopicNode[] {
  return tree.children(tree.top);
}

/** Human-readable one-line summary of a path. */
export function describePath(path: string | null, tree: TopicTree): string {
  if (!path) return "(no path)";
  const titles: string[] = [];
  const parts = path.split(".");
  for (let n = 2; n <= parts.length; n++) {
    const node = tree.topics.get(parts.slice(0, n).join("."));
    if (node) titles.push(node.title);
  }
  return titles.join(" › ");
}
