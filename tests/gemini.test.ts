// TS-only tests of src/gemini.ts: the port of main.py's Gemini helpers and the
// @google/genai adapter. main.py's Gemini behavior through the entry point is
// covered by tests/main-routing.test.ts and the golden replay; these pin the
// SDK findings the adapter relies on (status attribute, retries, output_text,
// API key), using the real SDK with a stubbed `fetch`, so nothing leaves the
// process.

import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_MODEL,
  GEMINI_NO_API_KEY_MESSAGE,
  GEMINI_REQUEST_OPTIONS,
  GEMINI_TRANSIENT_FAILURE_MESSAGE,
  RuntimeError,
  createGeminiClient,
  externalErrorStatusCode,
  geminiApiKey,
  geminiClientFromSdk,
  generateGeminiText,
  isTransientGeminiStatus,
  sdkErrorStatus,
  withPythonStatusCode,
  type GeminiClient,
  type GeminiRequest,
  type GeminiSdk,
} from "../src/gemini.ts";
import { HTTPError, HttpResponse } from "../src/http.ts";
import { ValueError, getPyCause } from "../src/python-compat.ts";
import { sdkStatusError } from "./equivalence/replay.ts";

function clientReturning(outputText: unknown, requests: GeminiRequest[] = []): GeminiClient {
  return {
    interactions: {
      async create(request) {
        requests.push(request);
        return { output_text: outputText };
      },
    },
  };
}

function clientThrowing(error: unknown): GeminiClient {
  return {
    interactions: {
      async create() {
        throw error;
      },
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

test("constants: main.py's model and transient message", () => {
  assert.equal(GEMINI_MODEL, "gemini-3.5-flash-lite");
  assert.equal(GEMINI_TRANSIENT_FAILURE_MESSAGE, "Gemini is currently experiencing high demand. Please try again shortly.");
});

test("generateGeminiText: a new client per call, interactions.create(model, input) only, output_text stripped as str.strip()", async () => {
  const requests: GeminiRequest[] = [];
  let clients = 0;
  const createClient = () => {
    clients += 1;
    return clientReturning(" \u001c\tAnswer  \n\u0085", requests);
  };

  assert.equal(await generateGeminiText("first prompt", createClient), "Answer");
  assert.equal(await generateGeminiText("second prompt", createClient), "Answer");

  assert.equal(clients, 2);
  assert.deepEqual(requests, [
    { model: GEMINI_MODEL, input: "first prompt" },
    { model: GEMINI_MODEL, input: "second prompt" },
  ]);
});

test("generateGeminiText: a non-str output_text fails like None.strip()", async () => {
  for (const outputText of [null, undefined, 3]) {
    assert.ok((await rejection(generateGeminiText("p", () => clientReturning(outputText)))) instanceof TypeError);
  }
});

test("generateGeminiText: 401 or 403 from create or from the client constructor is a RuntimeError with no cause", async (t) => {
  const shapes: Array<[string, (status: number) => unknown]> = [
    ["error.response.status_code", (status) => Object.assign(new Error("secret body"), { response: { status_code: status } })],
    ["error.status_code", (status) => Object.assign(new Error("secret body"), { status_code: status })],
    ["error.code", (status) => Object.assign(new Error("secret body"), { code: status })],
    ["an http.ts HTTPError", (status) => new HTTPError(new HttpResponse(status, new Headers(), "secret body"))],
  ];
  for (const [shape, makeError] of shapes) {
    for (const status of [401, 403]) {
      await t.test(`${shape} ${status}`, async () => {
        for (const createClient of [
          () => clientThrowing(makeError(status)),
          (): GeminiClient => {
            throw makeError(status);
          },
        ]) {
          const error = await rejection(generateGeminiText("p", createClient));
          assert.ok(error instanceof RuntimeError);
          assert.equal(error.message, `Gemini authentication failed (HTTP ${status}).`);
          assert.equal(getPyCause(error), null);
          assert.equal(error.cause, undefined);
        }
      });
    }
  }
});

test("generateGeminiText: any other error is re-thrown as the same object", async () => {
  for (const original of [
    Object.assign(new Error("rate limited"), { response: { status_code: 429 } }),
    Object.assign(new Error("server"), { status_code: 503 }),
    Object.assign(new Error("bad request"), { code: 400 }),
    Object.assign(new Error("not a status"), { code: "ECONNRESET" }),
    new TypeError("no status"),
  ]) {
    assert.equal(await rejection(generateGeminiText("p", () => clientThrowing(original))), original);
    assert.equal(
      await rejection(
        generateGeminiText("p", () => {
          throw original;
        }),
      ),
      original,
    );
  }
});

test("externalErrorStatusCode: response.status_code, then status_code, then code; the first int (a bool counts, as in Python)", () => {
  assert.equal(externalErrorStatusCode({ response: { status_code: 401 }, status_code: 500, code: 429 }), 401);
  assert.equal(externalErrorStatusCode({ response: { status_code: "401" }, status_code: 500, code: 429 }), 500);
  assert.equal(externalErrorStatusCode({ response: null, status_code: 4.5, code: 429 }), 429);
  assert.equal(externalErrorStatusCode({ code: true }), 1);
  assert.equal(externalErrorStatusCode({ code: "ECONNRESET" }), null);
  // The @google/genai error's own attributes are not read here: the adapter adds status_code.
  assert.equal(externalErrorStatusCode({ status: 401, statusCode: 401 }), null);
  assert.equal(externalErrorStatusCode(null), null);
  assert.equal(externalErrorStatusCode("error"), null);
});

test("isTransientGeminiStatus: 429 and 5xx only", () => {
  for (const status of [429, 500, 503, 599]) assert.equal(isTransientGeminiStatus(status), true);
  for (const status of [null, 400, 401, 403, 404, 408, 409, 499, 600]) assert.equal(isTransientGeminiStatus(status), false);
});

// ---------------------------------------------------------------------------
// The @google/genai adapter
// ---------------------------------------------------------------------------

test("geminiClientFromSdk: passes {model, input} with google-genai 2.30's retry policy (3 retries) and no timeout", async () => {
  const calls: unknown[][] = [];
  const sdk: GeminiSdk = {
    interactions: {
      async create(...args) {
        calls.push(args);
        return { id: "i", steps: [], output_text: "text" };
      },
    },
  };

  const response = await geminiClientFromSdk(sdk).interactions.create({ model: "m", input: "i" });

  assert.deepEqual(response, { output_text: "text" });
  assert.deepEqual(calls, [[{ model: "m", input: "i" }, GEMINI_REQUEST_OPTIONS]]);
  assert.deepEqual(GEMINI_REQUEST_OPTIONS, {
    retries: {
      strategy: "attempt-count-backoff",
      maxRetries: 3,
      backoff: { initialInterval: 500, maxInterval: 8000, exponent: 2, maxElapsedTime: 30000 },
      retryConnectionErrors: true,
    },
  });
});

test("geminiClientFromSdk: an Interaction without trailing text has output_text '', as Python's Interaction model", async () => {
  for (const interaction of [{ id: "i", steps: [] }, { id: "i", steps: [], output_text: 5 }]) {
    const sdk: GeminiSdk = { interactions: { create: async () => interaction } };
    assert.deepEqual(await geminiClientFromSdk(sdk).interactions.create({ model: "m", input: "i" }), { output_text: "" });
  }
});

test("geminiClientFromSdk: the real @google/genai HTTP error is re-thrown as the same object, with Python's status_code added", async () => {
  for (const [status, name] of [[401, "AuthenticationError"], [403, "PermissionDeniedError"], [429, "RateLimitError"], [400, "BadRequestError"], [503, "InternalServerError"]] as const) {
    const sdkError = await sdkStatusError(status);
    assert.equal(sdkError.name, name);
    assert.equal(sdkErrorStatus(sdkError), status);
    const sdk: GeminiSdk = {
      interactions: {
        create: async () => {
          throw sdkError;
        },
      },
    };

    const thrown = await rejection(geminiClientFromSdk(sdk).interactions.create({ model: "m", input: "i" }));

    assert.equal(thrown, sdkError);
    assert.equal(externalErrorStatusCode(thrown), status);
    // Not enumerable: printing the error shows nothing new.
    assert.ok(!Object.keys(thrown as object).includes("status_code"));
  }
});

test("withPythonStatusCode: only an SDK-shaped error gains status_code; an existing one is kept", () => {
  const plain = new Error("x");
  assert.equal(withPythonStatusCode(plain), plain);
  assert.equal(externalErrorStatusCode(plain), null);
  const mismatched = Object.assign(new Error("x"), { status: 401, statusCode: 403 });
  withPythonStatusCode(mismatched);
  assert.equal(externalErrorStatusCode(mismatched), null);
  const notAnError = { status: 401, statusCode: 401 };
  withPythonStatusCode(notAnError);
  assert.equal(externalErrorStatusCode(notAnError), null);
  const existing = Object.assign(new Error("x"), { status: 401, statusCode: 401, status_code: 500 });
  withPythonStatusCode(existing);
  assert.equal(externalErrorStatusCode(existing), 500);
});

test("geminiApiKey: GOOGLE_API_KEY, else GEMINI_API_KEY, stripped; ValueError when neither is set", () => {
  assert.equal(geminiApiKey({ GEMINI_API_KEY: "  gemini-key \n" }), "gemini-key");
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: "google-key", GEMINI_API_KEY: "gemini-key" }), "google-key");
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: "", GEMINI_API_KEY: "gemini-key" }), "gemini-key");
  // A whitespace-only GOOGLE_API_KEY is "set" and strips to "", as in Python.
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: "  ", GEMINI_API_KEY: "gemini-key" }), "");
  for (const environment of [{}, { GEMINI_API_KEY: "" }, { GOOGLE_API_KEY: "", GEMINI_API_KEY: "" }]) {
    assert.throws(() => geminiApiKey(environment), (error: unknown) => {
      assert.ok(error instanceof ValueError);
      assert.equal(error.message, GEMINI_NO_API_KEY_MESSAGE);
      return true;
    });
  }
});

test("createGeminiClient: no API key is a ValueError before any request, which generateGeminiText re-throws", async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("no network");
  };
  try {
    const error = await rejection(generateGeminiText("p", () => createGeminiClient({})));
    assert.ok(error instanceof ValueError);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// The real SDK behind a stubbed fetch
// ---------------------------------------------------------------------------

type Fetched = { url: string; method: string; apiKey: string | null; body: unknown };

/**
 * Run `body` with fetch answering `responses` in order (the last one repeats)
 * and every timer firing at once, recording each request and each timer delay.
 */
async function withStubbedNetwork<T>(
  responses: Array<{ status: number; json: unknown }>,
  body: (fetched: Fetched[], delays: number[]) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const fetched: Fetched[] = [];
  const delays: number[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    fetched.push({
      url: request.url,
      method: request.method,
      apiKey: request.headers.get("x-goog-api-key"),
      body: JSON.parse(await request.text()),
    });
    const next = responses[Math.min(fetched.length - 1, responses.length - 1)] as { status: number; json: unknown };
    return new Response(JSON.stringify(next.json), { status: next.status, headers: { "content-type": "application/json" } });
  };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0);
    return realSetTimeout(callback, 0, ...args);
  }) as typeof setTimeout;
  try {
    return await body(fetched, delays);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
}

const ENVIRONMENT = { GEMINI_API_KEY: " test-gemini-key " };

function interactionWithText(text: string): unknown {
  return {
    id: "interaction-id",
    status: "completed",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
  };
}

test("SDK: one POST to the Interactions API with the model, the prompt and the stripped key; output_text is stripped", async () => {
  await withStubbedNetwork([{ status: 200, json: interactionWithText("  Hej!\n") }], async (fetched) => {
    assert.equal(await generateGeminiText("the prompt", () => createGeminiClient(ENVIRONMENT)), "Hej!");
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]?.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(fetched[0]?.method, "POST");
    assert.equal(fetched[0]?.apiKey, "test-gemini-key");
    assert.deepEqual(fetched[0]?.body, { model: GEMINI_MODEL, input: "the prompt" });
  });
});

test("SDK: a completed Interaction without text gives '' (Python's output_text), not a crash", async () => {
  await withStubbedNetwork([{ status: 200, json: { id: "i", status: "completed", steps: [] } }], async () => {
    assert.equal(await generateGeminiText("p", () => createGeminiClient(ENVIRONMENT)), "");
  });
});

test("SDK: a 503 is attempted 4 times (3 retries, as google-genai 2.30) and surfaces as a transient error", async () => {
  await withStubbedNetwork([{ status: 503, json: { error: { code: 503, message: "overloaded" } } }], async (fetched, delays) => {
    const error = await rejection(generateGeminiText("p", () => createGeminiClient(ENVIRONMENT)));
    assert.equal(fetched.length, 4);
    // The backoff waits between attempts: 0.5 s, 1 s, 2 s, each less up to 25% jitter.
    const backoff = delays.filter((delay) => delay > 0);
    assert.equal(backoff.length, 3);
    backoff.forEach((delay, index) => {
      const nominal = 500 * 2 ** index;
      assert.ok(delay <= nominal && delay >= nominal * 0.75, `delay ${delay}`);
    });
    assert.ok(error instanceof Error);
    assert.equal(error.name, "InternalServerError");
    assert.equal(isTransientGeminiStatus(externalErrorStatusCode(error)), true);
  });
});

test("SDK: a 429 that then succeeds is retried inside the SDK and returns the text", async () => {
  await withStubbedNetwork(
    [
      { status: 429, json: { error: { code: 429, message: "rate limited" } } },
      { status: 200, json: interactionWithText("After retry") },
    ],
    async (fetched) => {
      assert.equal(await generateGeminiText("p", () => createGeminiClient(ENVIRONMENT)), "After retry");
      assert.equal(fetched.length, 2);
    },
  );
});

test("SDK: a 401 or 403 is not retried and becomes the secret-free RuntimeError", async () => {
  for (const status of [401, 403]) {
    await withStubbedNetwork([{ status, json: { error: { code: status, message: "API key not valid" } } }], async (fetched) => {
      const error = await rejection(generateGeminiText("p", () => createGeminiClient(ENVIRONMENT)));
      assert.equal(fetched.length, 1);
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.message, `Gemini authentication failed (HTTP ${status}).`);
      assert.equal(error.cause, undefined);
    });
  }
});

test("SDK: a 400 is not retried and is re-thrown, not transient", async () => {
  await withStubbedNetwork([{ status: 400, json: { error: { code: 400, message: "bad" } } }], async (fetched) => {
    const error = await rejection(generateGeminiText("p", () => createGeminiClient(ENVIRONMENT)));
    assert.equal(fetched.length, 1);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "BadRequestError");
    assert.equal(externalErrorStatusCode(error), 400);
    assert.equal(isTransientGeminiStatus(externalErrorStatusCode(error)), false);
  });
});
