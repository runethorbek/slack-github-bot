import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  ChunkedEncodingError,
  ConnectionError,
  HTTPError,
  HttpResponse,
  InvalidHeader,
  InvalidURL,
  JSONDecodeError,
  ReadTimeout,
  RequestException,
  Timeout,
  createHttp,
  encodeParams,
  type FetchImpl,
} from "../src/http.ts";
import { ValueError } from "../src/python-compat.ts";

const SECRET_URL = "https://hooks.slack.test/actions/T000/secret-response-token?token=query-secret";
const SECRET_TOKEN = "xoxb-secret-token";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: FetchImpl;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}

// Asserts that nothing secret appears anywhere in an error, including when
// Node prints it (which would show a `cause` chain).
function assertSecretFree(error: unknown): void {
  const printed = inspect(error, { depth: 10 });
  for (const secret of ["secret", "hooks.slack.test", "token=", SECRET_TOKEN, "body-secret"]) {
    assert.ok(!printed.includes(secret), `error output contains ${secret}: ${printed}`);
  }
  assert.equal((error as Error).cause, undefined);
}

test("post sends JSON with the requests-style Content-Type and a timeout signal", async () => {
  const fake = fakeFetch(() => new Response('{"ok": true}', { status: 200 }));
  const http = createHttp(fake.fetch);

  const response = await http.post("https://slack.com/api/chat.postMessage", {
    headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
    json: { channel: "C1", text: "Hej æøå" },
    timeout: 10,
  });

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0] as Call;
  assert.equal(call.url, "https://slack.com/api/chat.postMessage");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body as string), { channel: "C1", text: "Hej æøå" });
  const headers = call.init.headers as Headers;
  assert.equal(headers.get("authorization"), `Bearer ${SECRET_TOKEN}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.ok(call.init.signal instanceof AbortSignal);

  assert.equal(response.status_code, 200);
  assert.deepEqual(response.json(), { ok: true });
  response.raise_for_status();
});

test("post keeps a caller-supplied Content-Type and sends no body without json", async () => {
  const fake = fakeFetch(() => new Response("", { status: 200 }));
  const http = createHttp(fake.fetch);

  await http.post("https://slack.com/api/x", {
    headers: { "content-type": "application/json; charset=utf-8" },
    json: {},
  });
  await http.post("https://slack.com/api/y");

  const [withJson, withoutJson] = fake.calls as [Call, Call];
  assert.equal((withJson.init.headers as Headers).get("content-type"), "application/json; charset=utf-8");
  assert.equal(withoutJson.init.body, undefined);
  assert.equal((withoutJson.init.headers as Headers).get("content-type"), null);
  assert.equal(withoutJson.init.signal, undefined);
});

test("get encodes params the way requests does", async () => {
  const fake = fakeFetch(() => new Response("{}", { status: 200 }));
  const http = createHttp(fake.fetch);

  await http.get("https://slack.com/api/conversations.replies", {
    headers: { Authorization: `Bearer ${SECRET_TOKEN}` },
    params: { channel: "C123", ts: "1700000000.000100" },
    timeout: 10,
  });

  const call = fake.calls[0] as Call;
  assert.equal(call.init.method, "GET");
  assert.equal(call.url, "https://slack.com/api/conversations.replies?channel=C123&ts=1700000000.000100");
  assert.equal(call.init.body, undefined);
});

test("encodeParams matches requests for reserved and non-ASCII characters", () => {
  // Expected values printed by requests under Python 3.12.
  assert.equal(
    encodeParams("https://example.test/x?a=1", { q: "a b&c=d/é~*'!()+%", ø: "1" }),
    "https://example.test/x?a=1&q=a+b%26c%3Dd%2F%C3%A9~%2A%27%21%28%29%2B%25&%C3%B8=1",
  );
  assert.equal(encodeParams("https://example.test/x#frag", { k: "v" }), "https://example.test/x?k=v#frag");
  assert.equal(encodeParams("https://example.test/x", {}), "https://example.test/x");
  assert.equal(encodeParams("https://example.test/x", undefined), "https://example.test/x");
});

test("headers are case-insensitive, so Retry-After reads either way", async () => {
  const fake = fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "2" } }));
  const response = await createHttp(fake.fetch).get("https://api.notion.com/v1/pages/x");

  assert.equal(response.headers.get("Retry-After"), "2");
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(response.headers.get("X-Missing"), null);
});

test("raise_for_status throws HTTPError with .response for 400-599 only", async () => {
  for (const status of [200, 201, 204, 302, 399]) {
    new HttpResponse(status, new Headers(), "").raise_for_status();
  }
  for (const status of [400, 401, 403, 404, 429, 500, 503, 599]) {
    const fake = fakeFetch(() => new Response("body-secret", { status }));
    const response = await createHttp(fake.fetch).post(SECRET_URL, { json: { text: "x" }, timeout: 10 });
    assert.equal(response.status_code, status);
    assert.throws(
      () => response.raise_for_status(),
      (error: unknown) => {
        assert.ok(error instanceof HTTPError);
        assert.ok(error instanceof RequestException);
        assert.equal(error.response, response);
        assert.equal(error.response.status_code, status);
        assert.equal(error.message, `HTTP error ${status}`);
        assertSecretFree(error);
        return true;
      },
    );
  }
  // Statuses outside 400-599 do not raise, as in requests.
  new HttpResponse(600, new Headers(), "").raise_for_status();
});

test("a printed response shows neither headers nor body", () => {
  const response = new HttpResponse(500, new Headers({ "x-secret": "body-secret" }), "body-secret");
  assert.ok(!inspect(response).includes("secret"));
  assert.equal(response.text, "body-secret");
  assert.equal(response.headers.get("X-Secret"), "body-secret");
});

test("the body is read eagerly, so json() is synchronous and repeatable", async () => {
  let streamed = false;
  const body = new ReadableStream({
    pull(controller) {
      streamed = true;
      controller.enqueue(new TextEncoder().encode('{"results": [1, 2]}'));
      controller.close();
    },
  });
  const fake = fakeFetch(() => new Response(body, { status: 200 }));
  const response = await createHttp(fake.fetch).get("https://api.notion.com/v1/x");

  assert.ok(streamed);
  assert.equal(response.text, '{"results": [1, 2]}');
  const first = response.json();
  assert.ok(!(first instanceof Promise));
  assert.deepEqual(first, { results: [1, 2] });
  assert.deepEqual(response.json(), { results: [1, 2] });
});

test("json() throws a secret-free JSONDecodeError, which is a ValueError", async () => {
  const fake = fakeFetch(() => new Response("<html>body-secret</html>", { status: 502 }));
  const response = await createHttp(fake.fetch).get("https://api.notion.com/v1/x");

  assert.throws(
    () => response.json(),
    (error: unknown) => {
      assert.ok(error instanceof JSONDecodeError);
      assert.ok(error instanceof ValueError);
      assertSecretFree(error);
      return true;
    },
  );
  assert.throws(() => new HttpResponse(200, new Headers(), "").json(), JSONDecodeError);
});

test("a timeout throws ReadTimeout without .response", async () => {
  const fake = fakeFetch(
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  const http = createHttp(fake.fetch);

  await assert.rejects(http.post(SECRET_URL, { json: { text: "body-secret" }, timeout: 0.01 }), (error) => {
    assert.ok(error instanceof ReadTimeout);
    assert.ok(error instanceof Timeout);
    assert.ok(error instanceof RequestException);
    assert.ok(!(error instanceof ConnectionError));
    assert.equal("response" in error, false);
    assertSecretFree(error);
    return true;
  });
});

test("a TimeoutError from fetch is classified as ReadTimeout", async () => {
  const fake = fakeFetch(() => {
    throw new DOMException(`timed out calling ${SECRET_URL}`, "TimeoutError");
  });
  await assert.rejects(createHttp(fake.fetch).get(SECRET_URL), (error) => {
    assert.ok(error instanceof ReadTimeout);
    assertSecretFree(error);
    return true;
  });
});

test("a timeout while reading the body is a ConnectionError, as in requests", async () => {
  const fake = fakeFetch(({ init }) => {
    const body = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });
    return new Response(body, { status: 200 });
  });
  await assert.rejects(createHttp(fake.fetch).get("https://api.notion.com/v1/x", { timeout: 0.01 }), (error) => {
    assert.ok(error instanceof ConnectionError);
    assert.ok(!(error instanceof Timeout));
    assertSecretFree(error);
    return true;
  });
});

test("a network failure throws ConnectionError without .response or cause", async () => {
  const fake = fakeFetch(() => {
    throw new TypeError("fetch failed", {
      cause: new Error(`connect ECONNREFUSED ${SECRET_URL} ${SECRET_TOKEN}`),
    });
  });
  const http = createHttp(fake.fetch);

  await assert.rejects(
    http.get(SECRET_URL, { headers: { Authorization: `Bearer ${SECRET_TOKEN}` }, timeout: 10 }),
    (error) => {
      assert.ok(error instanceof ConnectionError);
      assert.ok(error instanceof RequestException);
      assert.ok(!(error instanceof Timeout));
      assert.equal("response" in error, false);
      assertSecretFree(error);
      return true;
    },
  );
});

test("a failure while reading the body is a ChunkedEncodingError, not a ConnectionError", async () => {
  const fake = fakeFetch(() => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error(`socket closed body-secret ${SECRET_URL}`));
      },
    });
    return new Response(body, { status: 200 });
  });
  await assert.rejects(createHttp(fake.fetch).get("https://api.notion.com/v1/x"), (error) => {
    assert.ok(error instanceof ChunkedEncodingError);
    assert.ok(error instanceof RequestException);
    assert.ok(!(error instanceof ConnectionError));
    assert.ok(!(error instanceof Timeout));
    assertSecretFree(error);
    return true;
  });
});

test("error names equal the Python class names that type(error).__name__ logs", () => {
  const response = new HttpResponse(500, new Headers(), "");
  const errors: [Error, string][] = [
    [new RequestException("x"), "RequestException"],
    [new HTTPError(response), "HTTPError"],
    [new ConnectionError(), "ConnectionError"],
    [new ChunkedEncodingError(), "ChunkedEncodingError"],
    [new Timeout(), "Timeout"],
    [new ReadTimeout(), "ReadTimeout"],
    [new InvalidURL(), "InvalidURL"],
    [new InvalidHeader(), "InvalidHeader"],
    [new JSONDecodeError(), "JSONDecodeError"],
  ];
  for (const [error, pythonName] of errors) {
    assert.equal(error.name, pythonName);
    assert.equal(error.constructor.name, pythonName);
  }
});

test("an invalid URL or header fails before fetch, with a secret-free error", async () => {
  const fake = fakeFetch(() => new Response("", { status: 200 }));
  const http = createHttp(fake.fetch);

  await assert.rejects(http.post("not a url secret-response-token"), (error) => {
    assert.ok(error instanceof InvalidURL);
    assert.ok(error instanceof RequestException);
    assertSecretFree(error);
    return true;
  });
  await assert.rejects(
    http.get("https://slack.com/api/x", { headers: { Authorization: `Bearer ${SECRET_TOKEN}\nX-Injected: 1` } }),
    (error) => {
      assert.ok(error instanceof InvalidHeader);
      assertSecretFree(error);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});

test("createHttp defaults to the global fetch", () => {
  const http = createHttp();
  assert.equal(typeof http.post, "function");
  assert.equal(typeof http.get, "function");
});
