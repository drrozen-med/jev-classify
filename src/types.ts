/**
 * Shared types for the Jev classification machinery.
 *
 * The vocabulary here is deliberately small: a topic tree (a frozen release of
 * a taxonomy), items to classify (a claim, an MCQ, a rapid card), the walk the
 * classifier performs, and the cost telemetry it produces.
 */

/** One topic of a taxonomy release. `path` is the canonical path, e.g. `aba.airway.difficult-airway-algorithm`. */
export interface TopicNode {
  path: string;
  title: string;
  /** Optional ltree form of the path, when the release stores one. */
  ltree?: string | null;
}

/** Something to classify: an id, the text the model reasons about, and any extra context. */
export interface ClassifiableItem {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** Outcome of classifying one item. */
export type ClassificationStatus = "accepted" | "needs_review" | "unclassified";

/** One decision the model made while walking an item down the tree. */
export interface WalkStep {
  /** The topic the decision was made at. */
  at: string;
  /** The option that was chosen (a child path, the stay key, or the none key). */
  choice: string;
  /** The model's confidence in this decision, 0..1. */
  confidence: number;
}

/** The result of classifying one item. */
export interface ClassificationResult {
  id: string;
  /** The canonical path the item was placed at, or null when nothing fit. */
  path: string | null;
  status: ClassificationStatus;
  /** Confidence at the final step (null when the model never answered). */
  confidence: number | null;
  /** The lowest confidence across all steps — a useful "how shaky was this" signal. */
  minConfidence: number | null;
  steps: WalkStep[];
  /** Why the item ended the way it did, in plain words. */
  reason: string;
  metadata?: Record<string, unknown>;
}

/** A Jev choice question. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** A Jev score question. */
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

/** A Jev noul question. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevAnswer {
  type: string;
  [key: string]: unknown;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The minimum the classifier needs from a Jev client, so tests can supply a fake. */
export interface JevClient {
  systemOne(
    state: string,
    questions: Record<string, JevQuestion>,
    opts?: { model?: string; timeoutMs?: number },
  ): Promise<JevResponse>;
}
