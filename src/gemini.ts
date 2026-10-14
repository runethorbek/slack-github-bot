// Port of main.py's Gemini helpers: `generate_gemini_text`, `GEMINI_MODEL`,
// `raise_gemini_credential_error`, `is_transient_gemini_status`,
// `GEMINI_TRANSIENT_FAILURE_MESSAGE` and main.py's own
// `external_error_status_code`, plus the `@google/genai` adapter that stands in
// for `genai.Client()`.
//
// The client is injected (`CreateGeminiClient`, Python's `genai.Client()`
// called with no arguments), so tests and the golden replay never construct a
// real client or touch the network. `createGeminiClient(environment)` is the
// production factory; it adapts the SDK to the shape the Python code uses:
//
// - The API key: Python's `genai.Client()` reads `GOOGLE_API_KEY`, else
//   `GEMINI_API_KEY`, raises ValueError when neither is set (before any
//   request), and strips the key. The JS SDK would only warn and continue, so
//   the factory applies Python's rule and passes the key explicitly.
// - Retries: google-genai 2.30's Interactions client makes up to 4 attempts
//   (`_DEFAULT_MAX_RETRIES + 1` = 3 retries, 0.5 s initial backoff doubling to
//   an 8 s cap, on 408/409/429/5xx and transport errors). The JS SDK's default
//   is 4 retries; GEMINI_REQUEST_OPTIONS sets 3 with the same backoff shape.
//   Neither applies a request timeout by default.
// - `output_text`: Python's Interaction model sets it to "" when the response
//   has no trailing text; the JS SDK leaves the property out. The adapter
//   returns "" then.
// - HTTP errors: Python's SDK raises `APIStatusError` subclasses carrying
//   `.status_code` and `.response.status_code`. The JS SDK raises its own
//   `APIError` subclasses (same class names: AuthenticationError,
//   RateLimitError, InternalServerError, ...) carrying `.status` and
//   `.statusCode`, and no `.response`. The adapter re-throws the same error
//   object with a Python-style `status_code` added, so every status extraction
//   ported from Python (this module's and people-suggest's) reads it unchanged.

import { GoogleGenAI } from "@google/genai";

import { ValueError, pyStrip } from "./python-compat.ts";
import type { Environment } from "./tasks-list.ts";

export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_TRANSIENT_FAILURE_MESSAGE =
  "Gemini is currently experiencing high demand. Please try again shortly.";

/** google-genai's ValueError message when no API key is configured. */
export const GEMINI_NO_API_KEY_MESSAGE =
  "No API key was provided. Please pass a valid API key. Learn how to create an API key at https://ai.google.dev/gemini-api/docs/api-key.";

/**
 * The per-request options for `interactions.create`: the retry policy of
 * google-genai 2.30 (3 retries; the JS SDK's own default backoff shape, which
 * equals Python's). No timeout, as in Python.
 */
export const GEMINI_REQUEST_OPTIONS = {
  retries: {
    strategy: "attempt-count-backoff",
    maxRetries: 3,
    backoff: { initialInterval: 500, maxInterval: 8000, exponent: 2, maxElapsedTime: 30000 },
    retryConnectionErrors: true,
  },
} as const;

/**
 * main.py's RuntimeError. Every message it is constructed with in main.ts and
 * this module is an application constant, at most with an HTTP status code or
 * one of the fixed SLACK_CREDENTIAL_ERRORS codes interpolated, so the top-level
 * handler may print it (security invariant S7).
 */
export class RuntimeError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "RuntimeError";
  }
}

/** `client.interactions.create(model=..., input=...)`'s keyword arguments. */
export type GeminiRequest = { model: string; input: string };

/** What the code reads of the Interaction: `output_text`. */
export type GeminiResponse = { output_text?: unknown };

/** `genai.Client()`'s surface used here. */
export type GeminiClient = {
  interactions: { create(request: GeminiRequest): Promise<GeminiResponse> };
};

/** `genai.Client()`: called with no arguments; may throw, as the constructor can. */
export type CreateGeminiClient = () => GeminiClient;

/** The `interactions.create` of the SDK (or a fake of it): request plus request options. */
export type GeminiSdk = {
  interactions: { create(request: GeminiRequest, options: typeof GEMINI_REQUEST_OPTIONS): Promise<unknown> };
};

function attribute(value: unknown, name: string): unknown {
  // getattr(value, name, None)
  if (value === null || value === undefined) return null;
  const found = (value as Record<string, unknown>)[name];
  return found === undefined ? null : found;
}

/** `isinstance(value, int)`: an integral number, or a bool (an int subclass in Python). */
function pyIntOrNull(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * main.py's `external_error_status_code`: `error.response.status_code`, then
 * `error.status_code`, then `error.code`, the first one that is an int;
 * otherwise null. Used for Slack (http.ts errors) and Gemini errors.
 */
export function externalErrorStatusCode(error: unknown): number | null {
  const responseStatus = pyIntOrNull(attribute(attribute(error, "response"), "status_code"));
  if (responseStatus !== null) return responseStatus;
  for (const name of ["status_code", "code"]) {
    const statusCode = pyIntOrNull(attribute(error, name));
    if (statusCode !== null) return statusCode;
  }
  return null;
}

/** A 401 or 403 becomes a secret-free RuntimeError with no cause (`from None`); anything else returns. */
export function raiseGeminiCredentialError(error: unknown): void {
  const statusCode = externalErrorStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    throw new RuntimeError(`Gemini authentication failed (HTTP ${statusCode}).`);
  }
}

/**
 * A 429 (rate limit) or 5xx Gemini response is transient/high-demand.
 *
 * Distinct from credential failures (401/403, see raiseGeminiCredentialError):
 * callers should tell the requester to retry shortly rather than treat this as
 * a hard failure.
 */
export function isTransientGeminiStatus(statusCode: number | null): boolean {
  return statusCode === 429 || (statusCode !== null && statusCode >= 500 && statusCode < 600);
}

/** `response.output_text.strip()`: a non-str `output_text` fails as `None.strip()` does. */
function strippedOutputText(response: GeminiResponse): string {
  const outputText = attribute(response, "output_text");
  if (typeof outputText !== "string") {
    throw new TypeError("'output_text' has no attribute 'strip'");
  }
  return pyStrip(outputText);
}

/** `generate_gemini_text(prompt)`, with `genai.Client` injected. */
export async function generateGeminiText(prompt: string, createClient: CreateGeminiClient): Promise<string> {
  let client: GeminiClient;
  try {
    client = createClient();
  } catch (error) {
    raiseGeminiCredentialError(error);
    throw error;
  }

  let response: GeminiResponse;
  try {
    response = await client.interactions.create({ model: GEMINI_MODEL, input: prompt });
  } catch (error) {
    raiseGeminiCredentialError(error);
    throw error;
  }

  return strippedOutputText(response);
}

// ---------------------------------------------------------------------------
// The @google/genai adapter
// ---------------------------------------------------------------------------

/**
 * The HTTP status of an `@google/genai` APIError, or null. Its error classes
 * are not exported, so the shape is checked: an Error whose `status` and
 * `statusCode` are the same integer (APIError's constructor sets both).
 */
export function sdkErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const status = (error as { status?: unknown }).status;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isInteger(status) && status === statusCode ? status : null;
}

/**
 * Give an `@google/genai` HTTP error the attribute the Python SDK's error has,
 * `status_code`, and return the same object (Python re-raises the SDK error
 * itself). Any other error is returned unchanged.
 */
export function withPythonStatusCode(error: unknown): unknown {
  const status = sdkErrorStatus(error);
  if (status !== null && attribute(error, "status_code") === null) {
    Object.defineProperty(error, "status_code", {
      value: status,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  return error;
}

/**
 * Adapt an `@google/genai` client (or a fake of its `interactions.create`) to
 * GeminiClient: the request options above, `output_text` as Python's
 * Interaction has it, and Python-style status codes on HTTP errors.
 */
export function geminiClientFromSdk(sdk: GeminiSdk): GeminiClient {
  return {
    interactions: {
      async create(request: GeminiRequest): Promise<GeminiResponse> {
        let interaction: unknown;
        try {
          interaction = await sdk.interactions.create(
            { model: request.model, input: request.input },
            GEMINI_REQUEST_OPTIONS,
          );
        } catch (error) {
          throw withPythonStatusCode(error);
        }
        const outputText = attribute(interaction, "output_text");
        return { output_text: typeof outputText === "string" ? outputText : "" };
      },
    },
  };
}

/** The API key as google-genai reads it: GOOGLE_API_KEY, else GEMINI_API_KEY; ValueError when neither is set. */
export function geminiApiKey(environment: Environment): string {
  const apiKey = environment["GOOGLE_API_KEY"] || environment["GEMINI_API_KEY"];
  if (!apiKey) throw new ValueError(GEMINI_NO_API_KEY_MESSAGE);
  return pyStrip(apiKey);
}

/** The production `genai.Client()`: a real @google/genai client for `environment`'s key. */
export function createGeminiClient(environment: Environment): GeminiClient {
  const sdk = new GoogleGenAI({ apiKey: geminiApiKey(environment) });
  return geminiClientFromSdk({
    interactions: { create: (request, options) => sdk.interactions.create(request, options) },
  });
}
