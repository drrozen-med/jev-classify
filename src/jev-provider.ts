/**
 * Client for Jev, TypeSafe's "System One" model: typed questions go in,
 * structured answers with calibrated confidence come out.
 *
 * Ported from the BoardsBridge classifier (`src/lib/jev-provider.ts`), with
 * the response usage kept so callers can meter cost.
 *
 * Server-side only: it reads an API key from the environment and must never
 * be bundled into a browser app.
 *
 * Key env: TYPESAFE_API_KEY or JEV_CLASSIFICATION.
 * Create keys at https://console.typesafe.ai/keys
 */
import type {
  JevAnswer,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevClient,
  JevNoulQuestion,
  JevQuestion,
  JevResponse,
  JevScoreQuestion,
} from "./types.ts";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

export interface JevCallOptions {
  model?: string;
  timeoutMs?: number;
  /** Extra headers (used by tests and by proxies). */
  headers?: Record<string, string>;
}

/** Reads the API key from the environment. Throws when neither key is set. */
export function jevApiKey(env: Record<string, string | undefined> = process.env): string {
  const key = env.TYPESAFE_API_KEY ?? env.JEV_CLASSIFICATION;
  if (!key) {
    throw new Error(
      "TYPESAFE_API_KEY (or JEV_CLASSIFICATION) is required — https://console.typesafe.ai/keys",
    );
  }
  return key;
}

/**
 * Evaluate a map of questions against one state.
 * Questions in one call are evaluated in parallel against the same state, so
 * a batch of items costs one request. Transient failures are the caller's
 * problem — this is a primitive, not a retry policy.
 */
export async function systemOne(
  state: string,
  questions: Record<string, JevQuestion>,
  opts: JevCallOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<JevResponse> {
  const res = await fetch(JEV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jevApiKey(env)}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify({
      state,
      model: opts.model ?? DEFAULT_MODEL,
      questions,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`jev_status_${res.status}: ${text}`);
  }
  return (await res.json()) as JevResponse;
}

/** Convenience wrapper for the all-Choice case used by the classifier. */
export async function jevChoices(
  state: string,
  questions: Record<string, { instructions: string; criteria: Record<string, string> }>,
  opts: JevCallOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, JevChoiceAnswer>> {
  const mapped: Record<string, JevQuestion> = {};
  for (const [k, q] of Object.entries(questions)) {
    mapped[k] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
  }
  const res = await systemOne(state, mapped, opts, env);
  return res.answers as unknown as Record<string, JevChoiceAnswer>;
}

/** A JevClient over the real HTTP API. */
export function createJevClient(env: Record<string, string | undefined> = process.env): JevClient {
  return {
    systemOne: (state, questions, opts) => systemOne(state, questions, opts, env),
  };
}

export type { JevAnswer, JevChoiceAnswer, JevChoiceQuestion, JevNoulQuestion, JevScoreQuestion };
