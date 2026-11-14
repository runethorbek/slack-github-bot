// Port of tests/test_cross_layer_contract.py (SlackToPythonContractTests),
// plus the S8 mapping check (ACCEPTANCE.md security invariant S8).
//
// Python ran each Slack request through the real Vercel handler in a `node`
// subprocess and fed the captured dispatch into main.py. Here every layer runs
// in-process: `handleSlackRequest` is imported from api/slack-request.js, the
// request is signed exactly as the Python tests' Node snippets sign it, the
// payload it hands the direct runner is captured, and the real adapter
// mapping (`directEnvironment` in api/_direct-runtime.js) turns it into main's
// environment, as in production. That mapping itself is pinned in
// direct-runtime.test.ts. The fakes follow main-routing.test.ts's conventions
// (real HttpResponse objects).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { GeminiClient, GeminiRequest, GeminiResponse } from "../src/gemini.ts";
import { HttpResponse, type GetOptions, type PostOptions } from "../src/http.ts";
import { main } from "../src/main.ts";

type SlackRequestDeps = {
  signingSecret: string;
  now: () => number;
  runDirect: (payload: Record<string, unknown>, label: string) => Promise<unknown>;
  defer: (promise: Promise<unknown>) => void;
};
type HandleSlackRequest = (request: Request, deps: SlackRequestDeps) => Promise<Response>;

// api/ has no type declarations; it is imported as it is.
const SLACK_REQUEST_MODULE = new URL("../api/slack-request.js", import.meta.url).href;
const { handleSlackRequest } = (await import(SLACK_REQUEST_MODULE)) as { handleSlackRequest: HandleSlackRequest };
const DIRECT_RUNTIME_MODULE = new URL("../api/_direct-runtime.js", import.meta.url).href;
const { directEnvironment } = (await import(DIRECT_RUNTIME_MODULE)) as {
  directEnvironment: (payload: Record<string, unknown>, sourceEnvironment: Record<string, string>) => Record<string, string>;
};

// ---------------------------------------------------------------------------
// The Vercel layer: a signed request in, the dispatched payload out
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "fake-signing-secret";
const TIMESTAMP = 1_700_000_000;

/** Sign and handle one Slack request, as the Python tests' Node snippets do; return the first dispatch. */
async function captureDispatch(body: string, contentType: string): Promise<Record<string, unknown>> {
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${TIMESTAMP}:${body}`).digest("hex")}`;
  const request = new Request("https://example.test/api/slack", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(TIMESTAMP),
      "x-slack-signature": signature,
    },
    body,
  });
  const dispatched: Array<Record<string, unknown>> = [];
  const deferred: Array<Promise<unknown>> = [];
  await handleSlackRequest(request, {
    signingSecret: SIGNING_SECRET,
    now: () => TIMESTAMP * 1000,
    runDirect: async (payload) => dispatched.push(payload),
    defer: (promise) => deferred.push(promise),
  });
  await Promise.all(deferred);
  // Through JSON, as the Python tests read the subprocess's stdout.
  return JSON.parse(JSON.stringify(dispatched[0])) as Record<string, unknown>;
}

function captureJavascriptDmDispatch(): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    type: "event_callback",
    event: {
      type: "message",
      text: "private root",
      channel: "D-private",
      user: "U-authorized",
      ts: "100.001",
      channel_type: "im",
    },
  });
  return captureDispatch(body, "application/json");
}

function captureJavascriptBlockActionDispatch(): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      actions: [{ action_id: "people_suggest", value: "Jane Doe" }],
      response_url: "https://hooks.slack.test/interaction",
      channel: { id: "D-private" },
      user: { id: "U-authorized" },
    }),
  }).toString();
  return captureDispatch(body, "application/x-www-form-urlencoded");
}

function captureJavascriptDispatch(): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    command: "/tasks",
    text: "list",
    response_url: "https://hooks.slack.test/response",
    channel_id: "C-allowed",
    user_id: "U-user",
  }).toString();
  return captureDispatch(body, "application/x-www-form-urlencoded");
}

// ---------------------------------------------------------------------------
// The adapter layer: the payload and secrets to main's environment
// ---------------------------------------------------------------------------

/** main's environment for `payload`, as api/_direct-runtime.js builds it. */
function adapterEnvironment(payload: Record<string, unknown>, secrets: Record<string, string>): Record<string, string> {
  for (const value of Object.values(payload)) {
    assert.equal(typeof value, "string", "every dispatched payload field is a string");
  }
  return directEnvironment(payload, secrets);
}

// ---------------------------------------------------------------------------
// Fakes for main (as in main-routing.test.ts)
// ---------------------------------------------------------------------------

type HttpCall = [string, Record<string, unknown>];

type FakeHttpMethod = ((url: string, options?: PostOptions & GetOptions) => Promise<HttpResponse>) & {
  calls: HttpCall[];
};

/** `Mock(side_effect=[...])` (consumed in order) or `Mock(return_value=...)`. */
function fakeHttpMethod(behavior: HttpResponse[] | HttpResponse): FakeHttpMethod {
  const queue = Array.isArray(behavior) ? [...behavior] : null;
  const method = Object.assign(
    async (url: string, options: PostOptions & GetOptions = {}): Promise<HttpResponse> => {
      method.calls.push([url, options as Record<string, unknown>]);
      if (queue === null) return behavior as HttpResponse;
      const next = queue.shift();
      if (next === undefined) throw new Error("StopIteration");
      return next;
    },
    { calls: [] as HttpCall[] },
  );
  return method;
}

function jsonResponse(body: unknown): HttpResponse {
  return new HttpResponse(200, new Headers(), JSON.stringify(body));
}

type FakeClientFactory = (() => GeminiClient) & { calls: unknown[][] };

function fakeClientFactory(client: GeminiClient | null): FakeClientFactory {
  const factory = Object.assign(
    (...args: unknown[]): GeminiClient => {
      factory.calls.push(args);
      if (client === null) throw new assert.AssertionError({ message: "Gemini must not be initialized" });
      return client;
    },
    { calls: [] as unknown[][] },
  );
  return factory;
}

function fakeGeminiClient(outputText: string): GeminiClient & { calls: GeminiRequest[] } {
  const calls: GeminiRequest[] = [];
  return {
    calls,
    interactions: {
      async create(request: GeminiRequest): Promise<GeminiResponse> {
        calls.push(request);
        return { output_text: outputText };
      },
    },
  };
}

/** `fake_python_modules()`: the /tasks list path. */
function fakePythonModules() {
  const notionResponse = jsonResponse({
    results: [
      {
        url: "https://www.notion.so/example-task",
        properties: {
          Navn: { id: "title", type: "title", title: [{ plain_text: "Known staging task" }] },
          Status: { type: "status", status: { name: "Ikke startet" } },
          Track: { type: "relation", relation: [{ id: "track-id" }] },
        },
      },
    ],
  });
  const trackResponse = jsonResponse({
    properties: {
      Navn: { type: "title", title: [{ plain_text: "Known staging track" }] },
      Priority: { type: "select", select: { name: "High" } },
    },
  });
  return {
    requests: {
      post: fakeHttpMethod([jsonResponse({ ok: true, ts: "123.456" }), notionResponse, jsonResponse({ ok: true })]),
      get: fakeHttpMethod(trackResponse),
    },
    Client: fakeClientFactory(null),
  };
}

/** `fake_people_suggest_modules()`: the /people suggest path. */
function fakePeopleSuggestModules() {
  const peopleResponse = jsonResponse({
    results: [{ id: "person-id", properties: { Name: { type: "title", title: [{ plain_text: "Jane Doe" }] } } }],
  });
  // Type schema read for the Add Interaction button: the only Notion GET
  // this route makes when there are no Track ids to resolve.
  const typeSchemaResponse = jsonResponse({
    properties: {
      Type: { type: "select", select: { options: [{ name: "Coffee" }, { name: "Walk" }] } },
    },
  });
  return {
    requests: {
      post: fakeHttpMethod([
        jsonResponse({ ok: true, ts: "123.456" }),
        peopleResponse,
        jsonResponse({ results: [] }),
        jsonResponse({ ok: true }),
      ]),
      get: fakeHttpMethod(typeSchemaResponse),
    },
    Client: fakeClientFactory(fakeGeminiClient("Hey Jane, been a while!\n")),
  };
}

// ---------------------------------------------------------------------------
// SlackToPythonContractTests
// ---------------------------------------------------------------------------

test("test_signed_root_dm_reaches_authorized_python_route_with_transport_identity", async () => {
  const payload = await captureJavascriptDmDispatch();
  assert.equal(payload["user_id"], "U-authorized");
  assert.equal(payload["channel_id"], "D-private");
  assert.equal(payload["event_ts"], "100.001");
  assert.equal(payload["thread_ts"], "");
  assert.equal(payload["channel_type"], "im");

  const post = fakeHttpMethod(jsonResponse({ ok: true }));
  const get = fakeHttpMethod([]);
  const Client = fakeClientFactory(null);
  const environment = adapterEnvironment(payload, {
    SLACK_BOT_TOKEN: "fake-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
  });

  const exitCode = await main(environment, { http: { post, get }, createGeminiClient: Client, log: () => {} });

  assert.equal(exitCode, 0);
  assert.deepEqual(post.calls.at(-1)?.[1]["json"], {
    channel: "D-private",
    text: "DM conversation received.",
    mrkdwn: true,
    thread_ts: "100.001",
  });
  assert.equal(get.calls.length, 0);
  assert.equal(Client.calls.length, 0);
});

test("test_adapter_maps_dm_identity_and_authorization_configuration (S8)", () => {
  const environment = directEnvironment(
    {
      user_id: "U-mapped",
      event_ts: "100.001",
      channel_type: "im",
      callback_id: "add_followup_task_modal",
      task: '{"name":"Send it"}',
    },
    { AUTHORIZED_SLACK_USER_ID: "U-authorized" },
  );

  assert.equal(environment["SLACK_USER_ID"], "U-mapped");
  assert.equal(environment["SLACK_EVENT_TS"], "100.001");
  assert.equal(environment["SLACK_CHANNEL_TYPE"], "im");
  assert.equal(environment["AUTHORIZED_SLACK_USER_ID"], "U-authorized");
  assert.equal(environment["SLACK_VIEW_CALLBACK_ID"], "add_followup_task_modal");
  assert.equal(environment["SLACK_TASK"], '{"name":"Send it"}');
});

test("test_authenticated_tasks_dispatch_reaches_notion_and_slack_without_gemini (S6)", async () => {
  const payload = await captureJavascriptDispatch();
  const { requests, Client } = fakePythonModules();
  const environment = adapterEnvironment(payload, {
    SLACK_BOT_TOKEN: "fake-slack-token",
    TASKS_SLACK_CHANNEL_ID: payload["channel_id"] as string,
    NOTION_API_KEY: "fake-notion-token",
    NOTION_TASKS_DATA_SOURCE_ID: "fake-data-source-id",
  });
  // The Python test set these from the same payload fields.
  assert.equal(environment["SLACK_COMMAND"], payload["command"]);
  assert.equal(environment["SLACK_TEXT"], payload["text"]);
  assert.equal(environment["SLACK_EVENT_TYPE"], payload["slack_event_type"]);

  const exitCode = await main(environment, { http: requests, createGeminiClient: Client, log: () => {} });

  assert.equal(exitCode, 0);
  assert.equal(Client.calls.length, 0);
  assert.deepEqual(requests.get.calls, [
    [
      "https://api.notion.com/v1/pages/track-id",
      {
        headers: {
          Authorization: "Bearer fake-notion-token",
          "Content-Type": "application/json",
          "Notion-Version": "2025-09-03",
        },
        timeout: 10,
      },
    ],
  ]);
  assert.deepEqual(
    requests.post.calls.map(([url]) => url),
    [
      "https://slack.com/api/chat.postMessage",
      "https://api.notion.com/v1/data_sources/fake-data-source-id/query",
      "https://slack.com/api/chat.postMessage",
    ],
  );
  const replyText = requests.post.calls.at(-1)?.[1]["json"] as { text: string };
  assert.ok(replyText.text.includes("Track: Known staging track"));
});

test("test_authenticated_people_suggest_button_click_reaches_the_existing_suggest_route", async () => {
  // A /people due button click must reuse the suggest route: a signed Slack
  // block_actions click through the real JS webhook handler, its dispatch fed
  // into the real main, lands on the same path a typed `/people suggest
  // <name>` command does.
  const payload = await captureJavascriptBlockActionDispatch();
  assert.equal(payload["command"], "/people");
  assert.equal(payload["text"], "suggest Jane Doe");
  assert.equal(payload["slack_event_type"], "block_actions");
  assert.equal(payload["channel_type"], "im");

  const { requests, Client } = fakePeopleSuggestModules();
  const environment = adapterEnvironment(payload, {
    SLACK_BOT_TOKEN: "fake-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: "fake-notion-token",
    NOTION_PEOPLE_DATA_SOURCE_ID: "fake-people-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "fake-interactions-id",
  });

  const exitCode = await main(environment, { http: requests, createGeminiClient: Client, log: () => {} });

  assert.equal(exitCode, 0);
  const reply = requests.post.calls.at(-1)?.[1]["json"] as { text: string };
  assert.equal(
    reply.text,
    "Context:\nHey Jane, been a while!\n\n" + "Suggested message for Jane Doe:\n\nHey Jane, been a while!",
  );
});
