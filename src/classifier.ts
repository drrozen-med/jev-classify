/**
 * The stepwise classifier: walks an item down a topic tree, asking the model
 * one typed choice question per level, and accepts the placement only when
 * the model's confidence clears the threshold.
 *
 * Items that share the same current topic are asked together in one API call
 * (one question per item), so a batch of items costs a handful of requests
 * rather than one request per item per level.
 *
 * Rules borrowed from the proven BoardsBridge claim pipeline:
 *  - the model is always given honest outs (stay here / none of these);
 *  - a placement is accepted only when the final step is confident enough;
 *  - a path that is not in the tree is never written.
 */
import { CostTracker } from "./cost.ts";
import { NONE_KEY, STAY_KEY, type TopicTree } from "./taxonomy-tree.ts";
import type {
  ClassifiableItem,
  ClassificationResult,
  JevChoiceAnswer,
  JevClient,
  JevQuestion,
  WalkStep,
} from "./types.ts";

export interface ClassifierOptions {
  /** The frozen taxonomy release to classify into. */
  tree: TopicTree;
  /** The Jev client (real or fake). */
  client: JevClient;
  /** Confidence at or above which a placement is accepted. Default 0.7. */
  minConfidence?: number;
  /** Maximum levels to walk down. Default 8. */
  maxDepth?: number;
  /**
   * Maximum items asked in one API call. The API rejects a request whose
   * answer would exceed its output budget ("max_tokens_exceeded"), so wide
   * groups are split into several calls. Default 20.
   */
  maxItemsPerCall?: number;
  /** Retries per chunk on a transient failure. Default 2. */
  maxRetries?: number;
  /** Delay between retries. Default 1000 ms. */
  retryDelayMs?: number;
  /** Model name sent to Jev. Default `jev-latest`. */
  model?: string;
  /** Per-request timeout. Default 120000 ms. */
  timeoutMs?: number;
  /** Version tag recorded on every cost record. */
  promptVersion?: string;
  /** Cost tracker to feed. */
  tracker?: CostTracker;
  /** Called after every API call. */
  onCall?: (info: {
    group: string;
    questions: number;
    durationMs: number;
    outcome: "ok" | "error";
    error?: string;
  }) => void;
  /** Extra context per item (rationale, explanation, metadata). */
  contextFor?: (item: ClassifiableItem) => string | undefined;
  /** Custom instructions per item. */
  instructionsFor?: (item: ClassifiableItem, group: string) => string;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_DEPTH = 8;
/** The API refuses a call with too many questions; keep batches modest. */
const DEFAULT_MAX_ITEMS_PER_CALL = 20;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
/** Guards against a pathological state blob; the model does not need more. */
const MAX_ITEM_CHARS = 4000;

interface Pending {
  item: ClassifiableItem;
  at: string;
  steps: WalkStep[];
  done: boolean;
  result?: ClassificationResult;
}

/** Classify a batch of items against the tree. */
export async function classifyItems(
  items: readonly ClassifiableItem[],
  options: ClassifierOptions,
): Promise<ClassificationResult[]> {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxItemsPerCall = Math.max(1, options.maxItemsPerCall ?? DEFAULT_MAX_ITEMS_PER_CALL);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const model = options.model ?? "jev-latest";
  const timeoutMs = options.timeoutMs ?? 120_000;

  const pending: Pending[] = items.map((item) => ({
    item,
    at: options.tree.top,
    steps: [],
    done: false,
  }));

  let level = 0;
  while (level < maxDepth) {
    const active = pending.filter((p) => !p.done);
    if (active.length === 0) break;

    const groups = new Map<string, Pending[]>();
    for (const p of active) {
      const list = groups.get(p.at) ?? [];
      list.push(p);
      groups.set(p.at, list);
    }

    for (const [groupPath, group] of groups) {
      const children = options.tree.children(groupPath);
      const criteria: Record<string, string> = {};
      for (const child of children) criteria[child.path] = child.title;
      if (groupPath !== options.tree.top) {
        const here = options.tree.topics.get(groupPath)?.title ?? groupPath;
        criteria[STAY_KEY] = `STAY at "${here}" — the item is about this topic in general, or no deeper topic fits it`;
      }
      criteria[NONE_KEY] = "NONE — the item does not belong in any of these topics";

      const chunks = chunk(group, maxItemsPerCall);
      for (const chunkItems of chunks) {
        const state = chunkItems
          .map((p, i) => `ITEM ${i + 1} (${p.item.id}):\n${truncate(p.item.text, MAX_ITEM_CHARS)}`)
          .join("\n\n");

        const questions: Record<string, JevQuestion> = {};
        chunkItems.forEach((p, i) => {
          const extra = options.contextFor?.(p.item);
          const defaultInstruction =
            `ITEM ${i + 1} is the item to classify. Pick the single best topic for it.` +
            (extra ? `\nContext: ${truncate(extra, 1500)}` : "") +
            `\nOptions:\n${Object.entries(criteria)
              .map(([k, v]) => `- ${k}: ${v}`)
              .join("\n")}`;
          questions[`i${i}`] = {
            type: "choice",
            instructions: options.instructionsFor
              ? options.instructionsFor(p.item, groupPath)
              : defaultInstruction,
            criteria,
          };
        });

        await runChunk({
          chunkItems,
          groupPath,
          state,
          questions,
          options,
          minConfidence,
          criteria,
          model,
          timeoutMs,
          maxRetries,
          retryDelayMs,
        });
      }
    }
    level += 1;
  }

  for (const p of pending) {
    if (!p.done) {
      p.done = true;
      p.result = result(
        p,
        p.at,
        "needs_review",
        `walk stopped at the depth limit (${maxDepth})`,
        null,
      );
    }
  }

  return pending.map((p) => p.result ?? result(p, null, "unclassified", "no result"));
}

/**
 * Run one chunk of items, retrying transient failures and halving the chunk
 * when the API says the request was too big. Items are only given up on when
 * every attempt failed — a failed call never silently loses content.
 */
async function runChunk(args: {
  chunkItems: Pending[];
  groupPath: string;
  state: string;
  questions: Record<string, JevQuestion>;
  options: ClassifierOptions;
  minConfidence: number;
  criteria: Record<string, string>;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}): Promise<void> {
  const {
    chunkItems,
    groupPath,
    state,
    questions,
    options,
    minConfidence,
    criteria,
    model,
    timeoutMs,
    maxRetries,
    retryDelayMs,
  } = args;

  let attempt = 0;
  let lastError = "";
  while (attempt <= maxRetries) {
    const started = Date.now();
    try {
      const res = await options.client.systemOne(state, questions, { model, timeoutMs });
      const durationMs = Date.now() - started;
      const answers = res.answers as unknown as Record<string, JevChoiceAnswer>;
      const outputChars = JSON.stringify(res.answers ?? {}).length;
      options.tracker?.recordCall({
        questions: chunkItems.length,
        inputChars: state.length + Object.values(questions).reduce((a, q) => a + q.instructions.length, 0),
        outputChars,
        inputTokens: res.usage?.input_tokens ?? null,
        outputTokens: res.usage?.output_tokens ?? null,
        durationMs,
        outcome: "ok",
      });
      options.onCall?.({ group: groupPath, questions: chunkItems.length, durationMs, outcome: "ok" });
      chunkItems.forEach((p, i) => {
        applyPick(p, answers[`i${i}`], options.tree, minConfidence, criteria);
      });
      return;
    } catch (error) {
      const durationMs = Date.now() - started;
      lastError = error instanceof Error ? error.message : String(error);
      options.tracker?.recordCall({
        questions: chunkItems.length,
        inputChars: state.length,
        outputChars: 0,
        durationMs,
        outcome: "error",
        error: lastError,
      });
      options.onCall?.({
        group: groupPath,
        questions: chunkItems.length,
        durationMs,
        outcome: "error",
        error: lastError,
      });
      attempt += 1;
      if (attempt <= maxRetries && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  for (const p of chunkItems) {
    p.done = true;
    p.result = result(p, null, "unclassified", `the classification request failed: ${lastError}`);
  }
}

function applyPick(
  p: Pending,
  answer: JevChoiceAnswer | undefined,
  tree: TopicTree,
  minConfidence: number,
  criteria: Record<string, string>,
): void {
  if (!answer) {
    p.done = true;
    p.result = result(p, null, "unclassified", "the model returned no answer for this item");
    return;
  }
  const choice = answer.choice;
  const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;
  if (choice === NONE_KEY || !(choice in criteria)) {
    p.steps.push({ at: p.at, choice, confidence });
    p.done = true;
    p.result = result(
      p,
      null,
      "needs_review",
      choice === NONE_KEY ? "the model said it fits none of the offered topics" : "the model chose an option that was not offered",
      null,
    );
    return;
  }
  p.steps.push({ at: p.at, choice, confidence });
  if (choice === STAY_KEY) {
    p.done = true;
    p.result = result(p, p.at, confidence >= minConfidence ? "accepted" : "needs_review", "placed at the current topic", confidence);
    return;
  }
  if (!tree.paths.has(choice)) {
    p.done = true;
    p.result = result(p, null, "needs_review", "the chosen path is not part of the tree", confidence);
    return;
  }
  if (tree.isLeaf(choice)) {
    p.done = true;
    p.result = result(p, choice, confidence >= minConfidence ? "accepted" : "needs_review", "placed at a leaf topic", confidence);
    return;
  }
  p.at = choice;
}

function result(
  p: Pending,
  path: string | null,
  status: ClassificationResult["status"],
  reason: string,
  confidence?: number | null,
): ClassificationResult {
  const finalConfidence =
    confidence ?? (p.steps.length > 0 ? (p.steps[p.steps.length - 1]?.confidence ?? null) : null);
  const minConfidence =
    p.steps.length > 0 ? Math.min(...p.steps.map((s) => s.confidence)) : null;
  return {
    id: p.item.id,
    path,
    status,
    confidence: finalConfidence,
    minConfidence,
    steps: p.steps,
    reason,
    ...(p.item.metadata ? { metadata: p.item.metadata } : {}),
  };
}

/** Split a group into batches the API will accept. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
