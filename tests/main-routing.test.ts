// Port of tests/test_main_routing.py (MainRoutingTests), plus TS-only tests of
// the routing order's security invariants (S1, S2, S3) and of the entry
// point's process concerns (S7).
//
// Python runs main.py with `runpy` after replacing the `requests` and
// `google.genai` modules; here `main(environment, deps)` gets the same fakes
// injected: `requests` is `http` ({post, get}), `genai.Client` is
// `createGeminiClient`, and `print` is `log`. As in Python, `today` and
// `sleep` are not injected (the real clock and time.sleep). `sys.exit(0)`
// (assertRaises(SystemExit) with code 0) is main resolving to 0; an uncaught
// exception is main rejecting with it.
//
// Conventions as in the other ports: each test title starts with the Python
// method name; a Mock is a recording function whose `calls` holds each call's
// arguments, Python's keyword arguments being the TS options object. A Mock
// with `return_value` / `side_effect` keeps those semantics (a side_effect
// list is consumed in order; an Exception in it is raised). Fake Slack and
// Notion responses are real http.ts HttpResponse objects; a Mock response
// whose `raise_for_status` raises an HTTP error is an HttpResponse with that
// status, whose raise_for_status() throws the real HTTPError.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  RuntimeError,
  geminiClientFromSdk,
  type GeminiClient,
  type GeminiRequest,
  type GeminiResponse,
} from "../src/gemini.ts";
import { HttpResponse, type GetOptions, type PostOptions } from "../src/http.ts";
import {
  Exception,
  isAuthorizedSlackUser,
  main,
  parsePersonPayload,
  runEntryPoint,
  uncaughtErrorLine,
  type MainDeps,
} from "../src/main.ts";
import { KeyError, RecursionError, getPyCause } from "../src/python-compat.ts";
import { NotionAuthenticationError } from "../src/tasks-list.ts";
import { sdkStatusError } from "./equivalence/replay.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_POINT = path.join(REPO_ROOT, "src", "main.ts");

// ---------------------------------------------------------------------------
// Fakes: the `requests` and `google.genai` modules
// ---------------------------------------------------------------------------

type HttpCall = [string, Record<string, unknown>];
type Behavior = HttpResponse | Error;

type FakeHttpMethod = ((url: string, options?: PostOptions & GetOptions) => Promise<HttpResponse>) & {
  calls: HttpCall[];
  returnValue: HttpResponse | null;
  sideEffect: Behavior[] | null;
};

/** `Mock(return_value=...)` for requests.post / requests.get. `returnValue: null` is an unconfigured Mock. */
function fakeHttpMethod(returnValue: HttpResponse | null): FakeHttpMethod {
  const method = Object.assign(
    async (url: string, options: PostOptions & GetOptions = {}): Promise<HttpResponse> => {
      method.calls.push([url, options as Record<string, unknown>]);
      if (method.sideEffect !== null) {
        const next = method.sideEffect.shift();
        if (next === undefined) throw new Error("StopIteration");
        if (next instanceof Error) throw next;
        return next;
      }
      if (method.returnValue === null) {
        throw new assert.AssertionError({ message: `unconfigured Mock called: ${url}` });
      }
      return method.returnValue;
    },
    { calls: [] as HttpCall[], returnValue, sideEffect: null as Behavior[] | null },
  );
  return method;
}

type FakeClientFactory = (() => GeminiClient) & { calls: unknown[][]; impl: () => GeminiClient };

/** `genai.Client`: a Mock whose default side_effect is AssertionError("Gemini must not be initialized"). */
function fakeClientFactory(): FakeClientFactory {
  const factory = Object.assign(
    (...args: unknown[]): GeminiClient => {
      factory.calls.push(args);
      return factory.impl();
    },
    {
      calls: [] as unknown[][],
      impl: (): GeminiClient => {
        throw new assert.AssertionError({ message: "Gemini must not be initialized" });
      },
    },
  );
  return factory;
}

type FakeGeminiClient = GeminiClient & { interactions: { create: { calls: GeminiRequest[] } } };

/** A Mock client whose `interactions.create` returns `output_text` or raises `error`. */
function fakeGeminiClient(result: { output_text: string } | Error): FakeGeminiClient {
  const calls: GeminiRequest[] = [];
  const create = Object.assign(
    async (request: GeminiRequest): Promise<GeminiResponse> => {
      calls.push(request);
      if (result instanceof Error) throw result;
      return { output_text: result.output_text };
    },
    { calls },
  );
  return { interactions: { create } };
}

function fakeModules() {
  const requests = { post: fakeHttpMethod(jsonResponse({ ok: true })), get: fakeHttpMethod(null) };
  const genai = { Client: fakeClientFactory() };
  return { requests, genai };
}

type Modules = ReturnType<typeof fakeModules>;

function jsonResponse(body: unknown): HttpResponse {
  return new HttpResponse(200, new Headers(), JSON.stringify(body));
}

/** A bare `Mock()` response: raise_for_status does nothing and the body is not used. */
function bareResponse(): HttpResponse {
  return jsonResponse({});
}

function statusResponse(statusCode: number): HttpResponse {
  return new HttpResponse(statusCode, new Headers(), "");
}

/** An `Exception(message)` with `.response = Mock(status_code=...)` or another attribute set. */
function errorWith(message: string, attributes: Record<string, unknown>): Error {
  return Object.assign(new Error(message), attributes);
}

function deps(modules: Modules, lines: string[]): MainDeps {
  return {
    http: modules.requests,
    createGeminiClient: modules.genai.Client,
    log: (line) => lines.push(line),
  };
}

/** `run_main`: main exits 0 (SystemExit(0)); resolves to the printed lines. */
async function runMain(environment: Record<string, string>, modules: Modules): Promise<string[]> {
  const lines: string[] = [];
  assert.equal(await main(environment, deps(modules, lines)), 0);
  return lines;
}

function postJson(modules: Modules, index: number): Record<string, unknown> {
  const call = modules.requests.post.calls.at(index);
  assert.ok(call, `post call ${index}`);
  return call[1]["json"] as Record<string, unknown>;
}

function postUrls(modules: Modules): string[] {
  return modules.requests.post.calls.map(([url]) => url);
}

function interactionsSchemaResponse(): HttpResponse {
  return jsonResponse({
    properties: {
      "Title of interaction": { type: "title" },
      Type: { type: "select", select: { options: [{ name: "Coffee" }] } },
    },
  });
}

function typeSchemaResponse(): HttpResponse {
  return jsonResponse({
    properties: {
      Type: { type: "select", select: { options: [{ name: "Coffee" }] } },
    },
  });
}

function tasksSchemaResponse(): HttpResponse {
  return jsonResponse({
    properties: {
      Navn: { id: "title", type: "title" },
      Priority: { type: "select", select: { options: [{ name: "High" }, { name: "Low" }] } },
      Status: { type: "status", status: { options: [{ name: "Ikke startet" }] } },
      Description: { type: "rich_text" },
    },
  });
}

function followupTaskEnvironment(userId = "U-authorized"): Record<string, string> {
  return {
    SLACK_EVENT_TYPE: "view_submission",
    SLACK_VIEW_CALLBACK_ID: "add_followup_task_modal",
    SLACK_TEXT: "",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: userId,
    SLACK_CHANNEL_TYPE: "im",
    SLACK_THREAD_TS: "100.001",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
    SLACK_TASK: JSON.stringify({
      name: "Send the article",
      description: "Include the Q3 figures.",
      follow_up: "2026-10-01",
      priority: "High",
      track_id: "",
    }),
    NOTION_API_KEY: "test-notion-token",
    NOTION_TASKS_DATA_SOURCE_ID: "tasks-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };
}

function personPage(name: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "person-id",
    properties: { Name: { type: "title", title: [{ plain_text: name }] }, ...properties },
  };
}

function peopleSuggestModules(geminiResult: { output_text: string } | Error, withReply = true) {
  const modules = fakeModules();
  const posts: Behavior[] = [
    jsonResponse({ ok: true, ts: "123.456" }),
    jsonResponse({ results: [personPage("Jane Doe")] }),
    jsonResponse({ results: [] }),
  ];
  if (withReply) posts.push(jsonResponse({ ok: true }));
  modules.requests.post.sideEffect = posts;
  modules.requests.get.returnValue = typeSchemaResponse();
  const client = fakeGeminiClient(geminiResult);
  modules.genai.Client.impl = () => client;
  return { modules, client };
}

const PEOPLE_SUGGEST_ENVIRONMENT = {
  SLACK_COMMAND: "/people",
  SLACK_TEXT: "suggest Jane Doe",
  SLACK_CHANNEL_ID: "D-private",
  SLACK_USER_ID: "U-authorized",
  SLACK_CHANNEL_TYPE: "im",
  SLACK_BOT_TOKEN: "test-slack-token",
  AUTHORIZED_SLACK_USER_ID: "U-authorized",
  TASKS_SLACK_CHANNEL_ID: "C-allowed",
  NOTION_API_KEY: "test-notion-token",
  NOTION_PEOPLE_DATA_SOURCE_ID: "people-id",
  NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
};

function testbotModules(geminiResult: { output_text: string } | Error | null) {
  const modules = fakeModules();
  modules.requests.post.sideEffect = [jsonResponse({ ok: true, ts: "123.456" }), jsonResponse({ ok: true })];
  modules.requests.get.returnValue = jsonResponse({ ok: true, messages: [{ text: "hello" }] });
  const client = geminiResult === null ? null : fakeGeminiClient(geminiResult);
  if (client !== null) modules.genai.Client.impl = () => client;
  return { modules, client };
}

const TESTBOT_ENVIRONMENT = {
  SLACK_COMMAND: "/testbot",
  SLACK_TEXT: "hello",
  SLACK_CHANNEL_ID: "C-channel",
  SLACK_BOT_TOKEN: "test-slack-token",
};

const TRANSIENT_MESSAGE = "Gemini is currently experiencing high demand. Please try again shortly.";

// ---------------------------------------------------------------------------
// MainRoutingTests
// ---------------------------------------------------------------------------

test("test_authorized_root_dm_replies_under_event_timestamp_without_private_processing", async () => {
  const modules = fakeModules();
  const privateMessage = "private root message";
  const environment = {
    SLACK_TEXT: privateMessage,
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_EVENT_TS: "100.001",
    SLACK_THREAD_TS: "",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_EVENT_TYPE: "message",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
  };

  const lines = await runMain(environment, modules);

  assert.deepEqual(modules.requests.post.calls, [
    [
      "https://slack.com/api/chat.postMessage",
      {
        headers: {
          Authorization: "Bearer test-slack-token",
          "Content-Type": "application/json",
        },
        json: {
          channel: "D-private",
          text: "DM conversation received.",
          mrkdwn: true,
          thread_ts: "100.001",
        },
        timeout: 10,
      },
    ],
  ]);
  assert.equal(modules.requests.get.calls.length, 0);
  assert.equal(modules.genai.Client.calls.length, 0);
  assert.ok(!lines.join(" ").includes(privateMessage));
});

test("test_authorized_dm_follow_up_preserves_existing_thread_timestamp", async () => {
  const modules = fakeModules();
  const environment = {
    SLACK_TEXT: "private follow-up",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_EVENT_TS: "100.002",
    SLACK_THREAD_TS: "100.001",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_EVENT_TYPE: "message",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
  };

  await runMain(environment, modules);

  assert.equal(postJson(modules, -1)["thread_ts"], "100.001");
  assert.equal(modules.requests.get.calls.length, 0);
  assert.equal(modules.genai.Client.calls.length, 0);
});

test("test_unauthorized_dm_uses_exact_user_id_comparison_and_stops_before_private_processing (S1, S2)", async () => {
  const modules = fakeModules();
  const environment = {
    SLACK_COMMAND: "/people",
    SLACK_TEXT: "due",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "u-authorized",
    SLACK_EVENT_TS: "100.001",
    SLACK_THREAD_TS: "",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_EVENT_TYPE: "message",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    NOTION_API_KEY: "must-not-be-used",
    NOTION_PEOPLE_DATA_SOURCE_ID: "must-not-be-used",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "must-not-be-used",
  };

  await runMain(environment, modules);

  assert.equal(modules.requests.post.calls.length, 0);
  assert.equal(modules.requests.get.calls.length, 0);
  assert.equal(modules.genai.Client.calls.length, 0);
});

test("test_unauthorized_dm_commands_stop_before_private_processing (S2)", async (t) => {
  for (const [command, text] of [["/tasks", "list"], ["/people", "due"]] as const) {
    await t.test(command, async () => {
      const modules = fakeModules();
      const environment = {
        SLACK_COMMAND: command,
        SLACK_TEXT: text,
        SLACK_CHANNEL_ID: "D-private",
        SLACK_USER_ID: "U-other",
        SLACK_USER_NAME: "U-authorized",
        SLACK_CHANNEL_TYPE: "im",
        SLACK_EVENT_TYPE: "slash_command",
        SLACK_BOT_TOKEN: "test-slack-token",
        AUTHORIZED_SLACK_USER_ID: "U-authorized",
        TASKS_SLACK_CHANNEL_ID: "C-allowed",
        NOTION_API_KEY: "must-not-be-used",
        NOTION_TASKS_DATA_SOURCE_ID: "must-not-be-used",
        NOTION_PEOPLE_DATA_SOURCE_ID: "must-not-be-used",
        NOTION_INTERACTIONS_DATA_SOURCE_ID: "must-not-be-used",
      };

      await runMain(environment, modules);

      assert.equal(modules.requests.post.calls.length, 0);
      assert.equal(modules.requests.get.calls.length, 0);
      assert.equal(modules.genai.Client.calls.length, 0);
    });
  }
});

test("test_unauthorized_add_interaction_submission_stops_before_notion (S2)", async () => {
  const modules = fakeModules();
  const environment = {
    SLACK_EVENT_TYPE: "view_submission",
    SLACK_TEXT: "",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-other",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_NOTES: "Notes",
    SLACK_INTERACTION_DATE: "2026-09-22",
    NOTION_API_KEY: "must-not-be-used",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "must-not-be-used",
  };

  await runMain(environment, modules);

  assert.equal(modules.requests.post.calls.length, 0);
  assert.equal(modules.requests.get.calls.length, 0);
  assert.equal(modules.genai.Client.calls.length, 0);
});

test("test_authorized_add_interaction_submission_writes_the_interaction_without_gemini", async () => {
  const modules = fakeModules();
  modules.requests.get.returnValue = interactionsSchemaResponse();
  modules.requests.post.sideEffect = [jsonResponse({ id: "new-interaction-id" }), jsonResponse({ ok: true })];
  const environment = {
    SLACK_EVENT_TYPE: "view_submission",
    SLACK_TEXT: "",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_NOTES: "Caught up over coffee.",
    SLACK_INTERACTION_DATE: "2026-09-22",
    NOTION_API_KEY: "test-notion-token",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };

  await runMain(environment, modules);

  assert.equal(modules.genai.Client.calls.length, 0);
  const createCall = modules.requests.post.calls[0] as HttpCall;
  assert.equal(createCall[0], "https://api.notion.com/v1/pages");
  const properties = (createCall[1]["json"] as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(properties["People"], { relation: [{ id: "person-page-id" }] });
  assert.deepEqual(properties["Track"], { relation: [] });
  assert.equal(postJson(modules, -1)["text"], "Interaction added for Jane Doe.");
});

test("test_unauthorized_followup_task_submission_stops_before_notion (S2)", async () => {
  const modules = fakeModules();

  await runMain(followupTaskEnvironment("U-other"), modules);

  assert.equal(modules.requests.post.calls.length, 0);
  assert.equal(modules.requests.get.calls.length, 0);
});

test("test_authorized_followup_task_submission_writes_one_task_without_gemini", async () => {
  const modules = fakeModules();
  modules.requests.get.returnValue = tasksSchemaResponse();
  modules.requests.post.sideEffect = [bareResponse(), jsonResponse({ ok: true })];

  await runMain(followupTaskEnvironment(), modules);

  assert.equal(modules.genai.Client.calls.length, 0);
  assert.deepEqual(postUrls(modules), ["https://api.notion.com/v1/pages", "https://slack.com/api/chat.postMessage"]);
  const createJson = postJson(modules, 0) as { parent: unknown; properties: Record<string, unknown> };
  assert.deepEqual(createJson.parent, { data_source_id: "tasks-id" });
  const properties = createJson.properties;
  assert.deepEqual(properties["People"], { relation: [{ id: "person-page-id" }] });
  assert.deepEqual(properties["Status"], { status: { name: "Ikke startet" } });
  assert.deepEqual(properties["Priority"], { select: { name: "High" } });
  assert.deepEqual(properties["Description"], {
    rich_text: [{ type: "text", text: { content: "Include the Q3 figures." } }],
  });
  const replyJson = postJson(modules, -1);
  assert.equal(replyJson["text"], "Follow-up task added for Jane Doe: Send the article");
  assert.equal(replyJson["thread_ts"], "100.001");
});

test("test_interaction_confirmation_offers_the_followup_task_button", async () => {
  const modules = fakeModules();
  modules.requests.get.sideEffect = [interactionsSchemaResponse(), interactionsSchemaResponse(), tasksSchemaResponse()];
  modules.requests.post.sideEffect = [bareResponse(), jsonResponse({ ok: true })];
  const environment = {
    ...followupTaskEnvironment(),
    SLACK_VIEW_CALLBACK_ID: "",
    SLACK_TASK: "",
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_DATE: "2026-09-22",
  };

  await runMain(environment, modules);

  const replyJson = postJson(modules, -1) as { text: string; blocks: Array<{ elements: Array<Record<string, unknown>> }> };
  assert.equal(replyJson.text, "Interaction added for Jane Doe.");
  const button = replyJson.blocks.at(-1)?.elements[0] as Record<string, unknown>;
  assert.equal(button["action_id"], "add_followup_task");
  assert.deepEqual(JSON.parse(button["value"] as string), {
    page_id: "person-page-id",
    name: "Jane Doe",
    priorities: ["High", "Low"],
  });
});

test("test_interaction_notes_with_a_commitment_offer_a_suggested_task_button", async () => {
  const modules = fakeModules();
  modules.requests.get.sideEffect = [interactionsSchemaResponse(), interactionsSchemaResponse(), tasksSchemaResponse()];
  modules.requests.post.sideEffect = [bareResponse(), jsonResponse({ ok: true })];
  const client = fakeGeminiClient({ output_text: '{"task": {"name": "Send the AI article"}}' });
  modules.genai.Client.impl = () => client;
  const environment = {
    ...followupTaskEnvironment(),
    SLACK_VIEW_CALLBACK_ID: "",
    SLACK_TASK: "",
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_NOTES: "Agreed to send the AI article.",
    SLACK_INTERACTION_DATE: "2026-09-22",
  };

  await runMain(environment, modules);

  assert.equal(client.interactions.create.calls.length, 1);
  assert.deepEqual(postUrls(modules), ["https://api.notion.com/v1/pages", "https://slack.com/api/chat.postMessage"]);
  const replyJson = postJson(modules, -1) as { text: string; blocks: Array<{ elements: Array<Record<string, unknown>> }> };
  assert.equal(replyJson.text, "Interaction added for Jane Doe.");
  const elements = replyJson.blocks.at(-1)?.elements as Array<Record<string, unknown>>;
  assert.equal(elements.length, 2);
  const [existing, suggested] = elements as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(existing["action_id"], "add_followup_task");
  assert.equal(suggested["action_id"], "add_suggested_followup_task");
  assert.equal((suggested["text"] as { text: string }).text, "Add task: Send the AI article");
  assert.equal(JSON.parse(suggested["value"] as string).task_name, "Send the AI article");
});

test("test_interaction_notes_without_a_tasks_data_source_make_no_gemini_call", async () => {
  const modules = fakeModules();
  modules.requests.get.returnValue = interactionsSchemaResponse();
  modules.requests.post.sideEffect = [bareResponse(), jsonResponse({ ok: true })];
  // genai_module.Client = Mock(): any call would be recorded.
  modules.genai.Client.impl = () => fakeGeminiClient({ output_text: "" });
  const environment = {
    ...followupTaskEnvironment(),
    SLACK_VIEW_CALLBACK_ID: "",
    SLACK_TASK: "",
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_NOTES: "Agreed to send the AI article.",
    SLACK_INTERACTION_DATE: "2026-09-22",
    NOTION_TASKS_DATA_SOURCE_ID: "",
  };

  await runMain(environment, modules);

  assert.equal(modules.genai.Client.calls.length, 0);
  const replyJson = postJson(modules, -1);
  assert.equal(replyJson["text"], "Interaction added for Jane Doe.");
  assert.ok(!Object.hasOwn(replyJson, "blocks"));
});

test("test_authorized_add_interaction_submission_writes_a_selected_track", async () => {
  const modules = fakeModules();
  modules.requests.get.returnValue = interactionsSchemaResponse();
  const tracksResponse = jsonResponse({
    results: [
      {
        id: "track-1",
        properties: { Navn: { type: "title", title: [{ plain_text: "AI Network" }] } },
      },
    ],
    has_more: false,
  });
  modules.requests.post.sideEffect = [tracksResponse, jsonResponse({ id: "new-interaction-id" }), jsonResponse({ ok: true })];
  const environment = {
    SLACK_EVENT_TYPE: "view_submission",
    SLACK_TEXT: "",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_NOTES: "Caught up over coffee.",
    SLACK_INTERACTION_DATE: "2026-09-22",
    SLACK_INTERACTION_TRACK_ID: "track-1",
    NOTION_API_KEY: "test-notion-token",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
    NOTION_TRACKS_DATA_SOURCE_ID: "tracks-id",
  };

  await runMain(environment, modules);

  const createCall = modules.requests.post.calls[1] as HttpCall;
  assert.equal(createCall[0], "https://api.notion.com/v1/pages");
  const properties = (createCall[1]["json"] as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(properties["Track"], { relation: [{ id: "track-1" }] });
});

test("test_authorized_add_interaction_submission_rejects_a_track_not_among_live_tracks", async () => {
  const modules = fakeModules();
  modules.requests.get.returnValue = typeSchemaResponse();
  modules.requests.post.sideEffect = [jsonResponse({ results: [], has_more: false }), jsonResponse({ ok: true })];
  const environment = {
    SLACK_EVENT_TYPE: "view_submission",
    SLACK_TEXT: "",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
    SLACK_INTERACTION_TYPE: "Coffee",
    SLACK_INTERACTION_NOTES: "Notes",
    SLACK_INTERACTION_DATE: "2026-09-22",
    SLACK_INTERACTION_TRACK_ID: "forged-track-id",
    NOTION_API_KEY: "test-notion-token",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
    NOTION_TRACKS_DATA_SOURCE_ID: "tracks-id",
  };

  await runMain(environment, modules);

  // The Type-schema GET ran (Type validation), but the title-property GET
  // never did - Track rejection happens first.
  assert.equal(modules.requests.get.calls.length, 1);
  assert.equal(modules.genai.Client.calls.length, 0);
  assert.equal(postJson(modules, -1)["text"], "Unable to add that interaction. Please try again.");
});

test("test_add_interaction_invalid_type_is_rejected_before_notion", async () => {
  // "Before Notion" means before any Notion write: rejecting an unknown Type
  // still requires reading the live Type schema.
  const modules = fakeModules();
  modules.requests.get.returnValue = typeSchemaResponse();
  modules.requests.post.returnValue = jsonResponse({ ok: true });
  const environment = {
    SLACK_EVENT_TYPE: "view_submission",
    SLACK_TEXT: "",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
    SLACK_INTERACTION_TYPE: "Linkedon",
    SLACK_INTERACTION_NOTES: "Notes",
    SLACK_INTERACTION_DATE: "2026-09-22",
    NOTION_API_KEY: "test-notion-token",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };

  await runMain(environment, modules);

  // Only the Type-schema GET happened; the Interaction was never written.
  assert.equal(modules.requests.get.calls.length, 1);
  assert.equal(modules.genai.Client.calls.length, 0);
  assert.equal(modules.requests.post.calls.length, 1);
  assert.equal(postJson(modules, -1)["text"], "Unable to add that interaction. Please try again.");
});

test("test_people_from_another_channel_is_rejected_before_notion (S2)", async () => {
  const modules = fakeModules();
  const environment = {
    SLACK_COMMAND: "/people",
    SLACK_TEXT: "due",
    SLACK_CHANNEL_ID: "C-other",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "channel",
    SLACK_EVENT_TYPE: "slash_command",
    SLACK_RESPONSE_URL: "https://hooks.slack.test/response",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: "must-not-be-used",
    NOTION_PEOPLE_DATA_SOURCE_ID: "must-not-be-used",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "must-not-be-used",
  };

  await runMain(environment, modules);

  assert.deepEqual(modules.requests.post.calls, [
    [
      "https://hooks.slack.test/response",
      {
        json: {
          response_type: "ephemeral",
          text: "The /people command is not available in this channel.",
        },
        timeout: 10,
      },
    ],
  ]);
  assert.equal(modules.requests.get.calls.length, 0);
  assert.equal(modules.genai.Client.calls.length, 0);
});

function duePeopleModules(): Modules {
  const modules = fakeModules();
  modules.requests.post.sideEffect = [
    jsonResponse({ ok: true, ts: "123.456" }),
    jsonResponse({
      results: [personPage("Known person", { "Contact cadence": { type: "select", select: { name: "1 month" } } })],
    }),
    jsonResponse({ results: [] }),
    jsonResponse({ ok: true }),
  ];
  return modules;
}

test("test_people_due_exits_before_gemini_and_only_queries_notion (S6)", async () => {
  const modules = duePeopleModules();
  const environment = {
    SLACK_COMMAND: "/people",
    SLACK_TEXT: "due",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: "test-notion-token",
    NOTION_PEOPLE_DATA_SOURCE_ID: "people-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };

  const lines = await runMain(environment, modules);

  assert.equal(modules.genai.Client.calls.length, 0);
  assert.equal(modules.requests.get.calls.length, 0);
  const notionUrls = postUrls(modules).slice(1, 3);
  assert.deepEqual(notionUrls, [
    "https://api.notion.com/v1/data_sources/people-id/query",
    "https://api.notion.com/v1/data_sources/interactions-id/query",
  ]);
  assert.ok(notionUrls.every((url) => url.endsWith("/query")));
  assert.ok(!lines.join(" ").includes("Known person"));
});

test("test_people_due_reply_includes_a_suggest_button_per_person", async () => {
  const modules = duePeopleModules();
  const environment = {
    SLACK_COMMAND: "/people",
    SLACK_TEXT: "due",
    SLACK_CHANNEL_ID: "C-channel",
    SLACK_BOT_TOKEN: "test-slack-token",
    TASKS_SLACK_CHANNEL_ID: "C-channel",
    NOTION_API_KEY: "test-notion-token",
    NOTION_PEOPLE_DATA_SOURCE_ID: "people-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };

  await runMain(environment, modules);

  const blocks = postJson(modules, -1)["blocks"] as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.["accessory"], {
    type: "button",
    text: { type: "plain_text", text: "Suggest message" },
    action_id: "people_suggest",
    value: "Known person",
  });
});

test("test_people_suggest_reaches_gemini_with_bounded_context_only (S6)", async () => {
  const { modules, client } = peopleSuggestModules({ output_text: "Hey Jane!" });
  modules.requests.post.sideEffect = [
    jsonResponse({ ok: true, ts: "123.456" }),
    jsonResponse({
      results: [
        personPage("Jane Doe", {
          "Why this person": { type: "rich_text", rich_text: [{ plain_text: "Former colleague" }] },
          "Contact cadence": { type: "select", select: { name: "3 months" } },
        }),
      ],
    }),
    jsonResponse({ results: [] }),
    jsonResponse({ ok: true }),
  ];

  await runMain(PEOPLE_SUGGEST_ENVIRONMENT, modules);

  // The only GET is the Add Interaction button's Type-schema fetch.
  assert.equal(modules.requests.get.calls.length, 1);
  // One Gemini call drafts the recap, another drafts the reconnect message;
  // each creates its own Client.
  assert.equal(modules.genai.Client.calls.length, 2);
  assert.equal(client.interactions.create.calls.length, 2);
  for (const call of client.interactions.create.calls) {
    const prompt = call.input;
    assert.ok(prompt.includes("Name: Jane Doe"));
    assert.ok(prompt.includes("Why this person: Former colleague"));
    assert.ok(!prompt.includes("3 months"));
  }
  assert.equal(
    postJson(modules, -1)["text"],
    "Context:\nHey Jane!\n\nSuggested message for Jane Doe:\n\nHey Jane!",
  );
});

test("test_people_suggest_transient_gemini_failure_replies_safely_in_thread", async () => {
  const transientError = errorWith("rate limited payload leak marker XYZ123", { response: { status_code: 429 } });
  const { modules, client } = peopleSuggestModules(transientError);

  await runMain(PEOPLE_SUGGEST_ENVIRONMENT, modules);

  assert.equal(client.interactions.create.calls.length, 1);
  const replyPayload = postJson(modules, -1);
  assert.equal(replyPayload["text"], TRANSIENT_MESSAGE);
  assert.equal(replyPayload["thread_ts"], "123.456");
  assert.ok(!(replyPayload["text"] as string).includes("XYZ123"));
});

test("test_people_suggest_unrelated_gemini_failure_still_crashes", async () => {
  const unrelatedError = errorWith("unexpected malformed response", { response: { status_code: 400 } });
  const { modules } = peopleSuggestModules(unrelatedError, false);

  await assert.rejects(main(PEOPLE_SUGGEST_ENVIRONMENT, deps(modules, [])), /unexpected malformed response/);

  assert.equal(modules.requests.post.calls.length, 3);
});

function tasksListModules(results: unknown[]): Modules {
  const modules = fakeModules();
  modules.requests.post.sideEffect = [
    jsonResponse({ ok: true, ts: "123.456" }),
    jsonResponse({ results }),
    jsonResponse({ ok: true }),
  ];
  return modules;
}

function taskPage(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://www.notion.so/example-task",
    properties: {
      Navn: { id: "title", type: "title", title: [{ plain_text: name }] },
      Status: { type: "status", status: { name: "Ikke startet" } },
      ...extra,
    },
  };
}

test("test_authorized_normalized_tasks_list_exits_before_gemini (S6)", async () => {
  const modules = tasksListModules([taskPage("Known staging task")]);
  const environment = {
    SLACK_COMMAND: "/tasks",
    SLACK_TEXT: "  LIST  ",
    SLACK_CHANNEL_ID: "C-allowed",
    SLACK_BOT_TOKEN: "test-slack-token",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: "secret-token",
    NOTION_TASKS_DATA_SOURCE_ID: "data-source-id",
  };

  await runMain(environment, modules);

  assert.equal(modules.genai.Client.calls.length, 0);
  assert.equal(modules.requests.get.calls.length, 0);
  assert.deepEqual(postUrls(modules), [
    "https://slack.com/api/chat.postMessage",
    "https://api.notion.com/v1/data_sources/data-source-id/query",
    "https://slack.com/api/chat.postMessage",
  ]);
});

test("test_authorized_dm_tasks_list_reaches_existing_task_path", async () => {
  const modules = tasksListModules([]);
  const environment = {
    SLACK_COMMAND: "/tasks",
    SLACK_TEXT: "list",
    SLACK_CHANNEL_ID: "D-private",
    SLACK_USER_ID: "U-authorized",
    SLACK_CHANNEL_TYPE: "im",
    SLACK_EVENT_TYPE: "slash_command",
    SLACK_BOT_TOKEN: "test-slack-token",
    AUTHORIZED_SLACK_USER_ID: "U-authorized",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: "secret-token",
    NOTION_TASKS_DATA_SOURCE_ID: "data-source-id",
  };

  await runMain(environment, modules);

  assert.equal(postUrls(modules)[1], "https://api.notion.com/v1/data_sources/data-source-id/query");
  assert.equal(modules.requests.get.calls.length, 0);
  assert.equal(modules.genai.Client.calls.length, 0);
});

test("test_tasks_outcomes_exit_before_gemini (S2)", async (t) => {
  const cases = [
    ["invalid", "unknown", "C-channel", { TASKS_SLACK_CHANNEL_ID: "C-channel" }],
    ["unauthorized", "list", "C-other", { TASKS_SLACK_CHANNEL_ID: "C-allowed" }],
  ] as const;

  for (const [name, text, channelId, taskEnvironment] of cases) {
    await t.test(name, async () => {
      const modules = fakeModules();
      const environment = {
        SLACK_COMMAND: "/tasks",
        SLACK_TEXT: text,
        SLACK_CHANNEL_ID: channelId,
        SLACK_RESPONSE_URL: "https://hooks.slack.test/response",
        SLACK_BOT_TOKEN: "test-slack-token",
        ...taskEnvironment,
      };

      await runMain(environment, modules);

      assert.equal(modules.genai.Client.calls.length, 0);
      assert.equal(modules.requests.get.calls.length, 0);
      assert.deepEqual(modules.requests.post.calls, [
        [
          "https://hooks.slack.test/response",
          {
            json: {
              response_type: "ephemeral",
              text: name === "invalid" ? "Usage: /tasks list" : "The /tasks command is not available in this channel.",
            },
            timeout: 10,
          },
        ],
      ]);
    });
  }
});

test("test_task_list_thread_reply_exits_before_gemini", async () => {
  const modules = fakeModules();
  modules.requests.get.returnValue = jsonResponse({
    ok: true,
    messages: [{ text: "/tasks list", bot_id: "B-task-bot" }, { text: "Can you update this?" }],
  });
  const environment = {
    SLACK_TEXT: "Can you update this?",
    SLACK_CHANNEL_ID: "C-allowed",
    SLACK_THREAD_TS: "123.456",
    SLACK_EVENT_TYPE: "message",
    SLACK_BOT_TOKEN: "test-slack-token",
  };

  await runMain(environment, modules);

  assert.equal(modules.genai.Client.calls.length, 0);
  assert.deepEqual(modules.requests.post.calls, [
    [
      "https://slack.com/api/chat.postMessage",
      {
        headers: {
          Authorization: "Bearer test-slack-token",
          "Content-Type": "application/json",
        },
        json: {
          channel: "C-allowed",
          text: "Task-list follow-ups are not supported. Run /tasks list.",
          mrkdwn: true,
          thread_ts: "123.456",
        },
        timeout: 10,
      },
    ],
  ]);
});

test("test_testbot_still_reaches_gemini", async () => {
  const { modules, client } = testbotModules({ output_text: "Gemini answer" });

  // No sys.exit: the script runs to its end.
  assert.equal(await main(TESTBOT_ENVIRONMENT, deps(modules, [])), 0);

  // genai.Client() called once, with no arguments.
  assert.deepEqual(modules.genai.Client.calls, [[]]);
  assert.equal(client?.interactions.create.calls.length, 1);
  assert.equal(modules.requests.post.calls.length, 2);
  assert.equal(modules.requests.get.calls.length, 1);
});

test("test_testbot_transient_gemini_failure_replies_safely_in_thread", async () => {
  const transientError = errorWith("internal provider payload leak marker XYZ123", { response: { status_code: 503 } });
  const { modules } = testbotModules(transientError);

  await runMain(TESTBOT_ENVIRONMENT, modules);

  assert.equal(modules.requests.post.calls.length, 2);
  const replyPayload = postJson(modules, -1);
  assert.equal(replyPayload["text"], TRANSIENT_MESSAGE);
  assert.equal(replyPayload["thread_ts"], "123.456");
  assert.ok(!(replyPayload["text"] as string).includes("XYZ123"));
});

test("test_testbot_unrelated_gemini_failure_still_crashes", async () => {
  const unrelatedError = errorWith("unexpected malformed response", { response: { status_code: 400 } });
  const { modules } = testbotModules(unrelatedError);
  modules.requests.post.sideEffect = null;
  modules.requests.post.returnValue = jsonResponse({ ok: true, ts: "123.456" });

  await assert.rejects(main(TESTBOT_ENVIRONMENT, deps(modules, [])), /unexpected malformed response/);

  assert.equal(modules.requests.post.calls.length, 1);
});

test("test_task_data_and_credentials_are_not_logged (S7)", async () => {
  const privateTaskName = "Confidential acquisition task";
  const secretToken = "notion-secret-must-not-be-logged";
  const modules = tasksListModules([
    {
      url: "https://www.notion.so/private-task",
      properties: {
        Navn: { id: "title", type: "title", title: [{ plain_text: privateTaskName }] },
        Status: { type: "status", status: { name: "Ikke startet" } },
        Description: { type: "rich_text", rich_text: [{ plain_text: "private description" }] },
      },
    },
  ]);
  const environment = {
    SLACK_COMMAND: "/tasks",
    SLACK_TEXT: "list",
    SLACK_CHANNEL_ID: "C-allowed",
    SLACK_BOT_TOKEN: "slack-secret-must-not-be-logged",
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: secretToken,
    NOTION_TASKS_DATA_SOURCE_ID: "data-source-id",
  };

  const lines = await runMain(environment, modules);

  const loggedText = lines.join(" ");
  assert.ok(!loggedText.includes(privateTaskName));
  assert.ok(!loggedText.includes("private description"));
  assert.ok(!loggedText.includes(secretToken));
  assert.ok(!loggedText.includes(environment.SLACK_BOT_TOKEN));
});

test("test_slack_authentication_error_is_safe_and_provider_specific (S7)", async () => {
  const modules = fakeModules();
  modules.requests.post.returnValue = jsonResponse({ ok: false, error: "invalid_auth" });
  const environment = {
    SLACK_COMMAND: "/testbot",
    SLACK_TEXT: "hello",
    SLACK_CHANNEL_ID: "C-channel",
    SLACK_BOT_TOKEN: "slack-secret-must-not-be-logged",
  };
  const lines: string[] = [];

  const error = await main(environment, deps(modules, lines)).then(
    () => assert.fail("main must raise"),
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof RuntimeError);
  assert.match(error.message, /^Slack authentication failed \(invalid_auth\)\.$/);
  assert.ok(!error.message.includes(environment.SLACK_BOT_TOKEN));
  assert.equal(getPyCause(error), null);
  assert.equal(error.cause, undefined);
  assert.ok(!lines.join(" ").includes(environment.SLACK_BOT_TOKEN));
});

test("test_ephemeral_slack_authentication_error_is_safe_and_provider_specific (S7)", async (t) => {
  for (const statusCode of [401, 403]) {
    await t.test(`HTTP ${statusCode}`, async () => {
      const modules = fakeModules();
      const responseUrl = "https://hooks.slack.test/signed-response-url";
      modules.requests.post.returnValue = statusResponse(statusCode);
      const environment = {
        SLACK_COMMAND: "/tasks",
        SLACK_TEXT: "invalid",
        SLACK_CHANNEL_ID: "C-channel",
        SLACK_RESPONSE_URL: responseUrl,
        SLACK_BOT_TOKEN: "slack-secret-must-not-be-logged",
      };
      const lines: string[] = [];

      const error = await main(environment, deps(modules, lines)).then(
        () => assert.fail("main must raise"),
        (caught: unknown) => caught,
      );

      assert.ok(error instanceof RuntimeError);
      assert.equal(error.message, `Slack authentication failed (HTTP ${statusCode}).`);
      assert.equal(getPyCause(error), null);
      assert.equal(error.cause, undefined);
      assert.ok(!error.message.includes(responseUrl));
      assert.ok(!lines.join(" ").includes(responseUrl));
      assert.equal(modules.genai.Client.calls.length, 0);
    });
  }
});

test("test_ephemeral_slack_failure_does_not_expose_signed_response_url (S7)", async () => {
  const modules = fakeModules();
  const responseUrl = "https://hooks.slack.test/signed-response-url";
  modules.requests.post.returnValue = statusResponse(404);
  const environment = {
    SLACK_COMMAND: "/tasks",
    SLACK_TEXT: "invalid",
    SLACK_CHANNEL_ID: "C-channel",
    SLACK_RESPONSE_URL: responseUrl,
    SLACK_BOT_TOKEN: "slack-secret-must-not-be-logged",
  };
  const lines: string[] = [];

  const error = await main(environment, deps(modules, lines)).then(
    () => assert.fail("main must raise"),
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof RuntimeError);
  assert.match(error.message, /^Slack response delivery failed\.$/);
  assert.equal(getPyCause(error), null);
  assert.equal(error.cause, undefined);
  assert.ok(!error.message.includes(responseUrl));
  assert.ok(!lines.join(" ").includes(responseUrl));
  assert.equal(modules.genai.Client.calls.length, 0);
});

test("test_gemini_authentication_error_is_safe_and_provider_specific (S7)", async () => {
  const modules = fakeModules();
  modules.requests.post.returnValue = jsonResponse({ ok: true, ts: "123.456" });
  modules.requests.get.returnValue = jsonResponse({ ok: true, messages: [{ text: "hello" }] });
  const geminiError = errorWith("credential rejected", { code: 403 });
  modules.genai.Client.impl = () => {
    throw geminiError;
  };
  const environment = {
    SLACK_COMMAND: "/testbot",
    SLACK_TEXT: "hello",
    SLACK_CHANNEL_ID: "C-channel",
    SLACK_BOT_TOKEN: "test-slack-token",
    GEMINI_API_KEY: "gemini-secret-must-not-be-logged",
  };
  const lines: string[] = [];

  const error = await main(environment, deps(modules, lines)).then(
    () => assert.fail("main must raise"),
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof RuntimeError);
  assert.match(error.message, /^Gemini authentication failed \(HTTP 403\)\.$/);
  assert.ok(!error.message.includes(environment.GEMINI_API_KEY));
  assert.equal(getPyCause(error), null);
  assert.equal(error.cause, undefined);
  assert.ok(!lines.join(" ").includes(environment.GEMINI_API_KEY));
});

// ---------------------------------------------------------------------------
// TS-only: S2, authorization before any Notion or Gemini call
// ---------------------------------------------------------------------------

/** Every private-data request family main.py authorizes, with the environment to reach it. */
const PRIVATE_DATA_REQUESTS: ReadonlyArray<[string, Record<string, string>]> = [
  ["/tasks list", { SLACK_COMMAND: "/tasks", SLACK_TEXT: "list" }],
  ["/tasks (usage)", { SLACK_COMMAND: "/tasks", SLACK_TEXT: "unknown" }],
  ["/people due", { SLACK_COMMAND: "/people", SLACK_TEXT: "due" }],
  ["/people suggest", { SLACK_COMMAND: "/people", SLACK_TEXT: "suggest Jane Doe" }],
  ["/people (usage)", { SLACK_COMMAND: "/people", SLACK_TEXT: "unknown" }],
  [
    "view_submission (Interaction)",
    {
      SLACK_EVENT_TYPE: "view_submission",
      SLACK_TEXT: "",
      SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
      SLACK_INTERACTION_TYPE: "Coffee",
      SLACK_INTERACTION_NOTES: "Agreed to send the AI article.",
      SLACK_INTERACTION_DATE: "2026-09-22",
    },
  ],
  [
    "view_submission (follow-up Task)",
    {
      SLACK_EVENT_TYPE: "view_submission",
      SLACK_TEXT: "",
      SLACK_VIEW_CALLBACK_ID: "add_followup_task_modal",
      SLACK_PERSON: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
      SLACK_TASK: JSON.stringify({ name: "Send the article", follow_up: "2026-10-01", priority: "High" }),
    },
  ],
];

const CONFIGURED = {
  SLACK_BOT_TOKEN: "test-slack-token",
  AUTHORIZED_SLACK_USER_ID: "U-authorized",
  TASKS_SLACK_CHANNEL_ID: "C-allowed",
  SLACK_RESPONSE_URL: "https://hooks.slack.test/response",
  NOTION_API_KEY: "must-not-be-used",
  NOTION_TASKS_DATA_SOURCE_ID: "must-not-be-used",
  NOTION_PEOPLE_DATA_SOURCE_ID: "must-not-be-used",
  NOTION_INTERACTIONS_DATA_SOURCE_ID: "must-not-be-used",
  NOTION_TRACKS_DATA_SOURCE_ID: "must-not-be-used",
  GEMINI_API_KEY: "must-not-be-used",
};

/** Modules that record calls; any HTTP call or Gemini client is a failure of the test, not of main. */
function recordingModules(): Modules {
  const modules = fakeModules();
  modules.requests.post.returnValue = jsonResponse({ ok: true, ts: "123.456" });
  modules.requests.get.returnValue = jsonResponse({ ok: true });
  modules.genai.Client.impl = () => fakeGeminiClient({ output_text: "" });
  return modules;
}

test("S2: an unauthorized DM makes no outbound call at all, for /tasks, /people and view_submission", async (t) => {
  const callers: Array<[string, Record<string, string>]> = [
    ["another user", { SLACK_USER_ID: "U-other" }],
    ["the authorized user ID in another case (S1)", { SLACK_USER_ID: "u-authorized" }],
    ["an empty configured user ID (S1)", { SLACK_USER_ID: "", AUTHORIZED_SLACK_USER_ID: "" }],
  ];
  for (const [request, requestEnvironment] of PRIVATE_DATA_REQUESTS) {
    for (const [caller, callerEnvironment] of callers) {
      await t.test(`${request}, ${caller}`, async () => {
        const modules = recordingModules();
        const environment = {
          ...CONFIGURED,
          SLACK_CHANNEL_ID: "D-private",
          SLACK_CHANNEL_TYPE: "im",
          ...requestEnvironment,
          ...callerEnvironment,
        };

        const lines = await runMain(environment, modules);

        assert.deepEqual(modules.requests.post.calls, []);
        assert.deepEqual(modules.requests.get.calls, []);
        assert.deepEqual(modules.genai.Client.calls, []);
        assert.equal(lines.length, 1);
        assert.match(lines[0] as string, /^Unauthorized (Slack DM command|modal submission) ignored$/);
      });
    }
  }
});

test("S2: an unauthorized channel gets only the ephemeral refusal for /tasks and /people, and nothing for view_submission", async (t) => {
  for (const [request, requestEnvironment] of PRIVATE_DATA_REQUESTS) {
    await t.test(request, async () => {
      const modules = recordingModules();
      modules.requests.post.returnValue = jsonResponse({});
      const environment = {
        ...CONFIGURED,
        SLACK_CHANNEL_ID: "C-other",
        SLACK_CHANNEL_TYPE: "channel",
        // The authorized user, but not in a DM: the channel decides.
        SLACK_USER_ID: "U-authorized",
        ...requestEnvironment,
      };

      const lines = await runMain(environment, modules);

      assert.deepEqual(modules.requests.get.calls, []);
      assert.deepEqual(modules.genai.Client.calls, []);
      if (request.startsWith("view_submission")) {
        assert.deepEqual(modules.requests.post.calls, []);
        assert.deepEqual(lines, ["Unauthorized modal submission ignored"]);
      } else {
        const refusal = request.startsWith("/tasks")
          ? "The /tasks command is not available in this channel."
          : "The /people command is not available in this channel.";
        assert.deepEqual(modules.requests.post.calls, [
          ["https://hooks.slack.test/response", { json: { response_type: "ephemeral", text: refusal }, timeout: 10 }],
        ]);
        assert.deepEqual(lines, ["Unauthorized private-data command rejected"]);
      }
    });
  }
});

test("S2: an authorized request does reach Notion: the configured channel, or the authorized user's own DM", async (t) => {
  // The counterpart of the two tests above, so that they cannot pass by
  // never reaching Notion at all.
  const authorized: Array<[string, Record<string, string>]> = [
    ["the configured channel", { SLACK_CHANNEL_ID: "C-allowed", SLACK_CHANNEL_TYPE: "channel", SLACK_USER_ID: "U-other" }],
    ["the authorized user's DM", { SLACK_CHANNEL_ID: "D-private", SLACK_CHANNEL_TYPE: "im", SLACK_USER_ID: "U-authorized" }],
  ];
  for (const [where, whereEnvironment] of authorized) {
    for (const [request, requestEnvironment] of PRIVATE_DATA_REQUESTS.filter(([name]) => !name.includes("usage"))) {
      await t.test(`${request}, ${where}`, async () => {
        // Slack calls succeed; every Notion call answers 401, so each path
        // stops at its first Notion call (failing the run or degrading, S11).
        const notionCalls: string[] = [];
        const answer = async (url: string): Promise<HttpResponse> => {
          if (!url.startsWith("https://api.notion.com/")) return jsonResponse({ ok: true, ts: "123.456" });
          notionCalls.push(url);
          return statusResponse(401);
        };
        const environment = { ...CONFIGURED, ...requestEnvironment, ...whereEnvironment };

        await main(environment, {
          http: { post: answer, get: answer },
          createGeminiClient: () => fakeGeminiClient({ output_text: "" }),
          log: () => {},
        }).catch((error: unknown) => {
          assert.ok(error instanceof NotionAuthenticationError, String(error));
        });

        assert.ok(notionCalls.length > 0, "an authorized request reaches Notion");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// TS-only: S1 and S3 helpers
// ---------------------------------------------------------------------------

test("S1: isAuthorizedSlackUser is an exact, case-sensitive match, and an empty configured value never matches", () => {
  assert.equal(isAuthorizedSlackUser("U-authorized", "U-authorized"), true);
  assert.equal(isAuthorizedSlackUser("u-authorized", "U-authorized"), false);
  assert.equal(isAuthorizedSlackUser("U-authorized ", "U-authorized"), false);
  assert.equal(isAuthorizedSlackUser("", ""), false);
  assert.equal(isAuthorizedSlackUser("U-other", ""), false);
});

test("S3: parsePersonPayload takes identity only from the structured JSON; anything malformed is absent identity", () => {
  assert.deepEqual(parsePersonPayload(JSON.stringify({ page_id: "p", name: "Jane" })), { page_id: "p", name: "Jane" });
  assert.deepEqual(parsePersonPayload(""), { page_id: "", name: "" });
  assert.deepEqual(parsePersonPayload(null), { page_id: "", name: "" });
  assert.deepEqual(parsePersonPayload("{not json"), { page_id: "", name: "" });
  assert.deepEqual(parsePersonPayload("[1, 2]"), { page_id: "", name: "" });
  assert.deepEqual(parsePersonPayload(JSON.stringify({ page_id: 7, name: ["Jane"] })), { page_id: "", name: "" });
  assert.deepEqual(parsePersonPayload(JSON.stringify({ name: "Jane" })), { page_id: "", name: "Jane" });
  // json.loads accepts NaN; it is not a str, so it is absent.
  assert.deepEqual(parsePersonPayload('{"page_id": NaN, "name": "Jane"}'), { page_id: "", name: "Jane" });
  // `except ValueError` does not catch RecursionError, as in Python.
  assert.throws(() => parsePersonPayload("[".repeat(100_000)), RecursionError);
});

test("S3: a view_submission without a complete Person identity writes nothing", async (t) => {
  for (const person of ["", "{not json", JSON.stringify({ page_id: "person-page-id" }), JSON.stringify({ name: "Jane Doe" })]) {
    await t.test(person || "(empty)", async () => {
      const modules = recordingModules();
      const environment = {
        ...CONFIGURED,
        SLACK_EVENT_TYPE: "view_submission",
        SLACK_TEXT: "",
        SLACK_CHANNEL_ID: "C-allowed",
        SLACK_PERSON: person,
        SLACK_INTERACTION_TYPE: "Coffee",
        SLACK_INTERACTION_DATE: "2026-09-22",
      };

      const lines = await runMain(environment, modules);

      assert.deepEqual(modules.requests.post.calls, []);
      assert.deepEqual(modules.requests.get.calls, []);
      assert.deepEqual(lines, ["Add Interaction submission handled"]);
    });
  }
});

// ---------------------------------------------------------------------------
// TS-only: the environment contract and the entry point (S7)
// ---------------------------------------------------------------------------

test("main: a missing SLACK_TEXT, SLACK_CHANNEL_ID or SLACK_BOT_TOKEN is a KeyError before any call", async (t) => {
  const environment = {
    SLACK_TEXT: "hello",
    SLACK_CHANNEL_ID: "C-channel",
    SLACK_BOT_TOKEN: "test-slack-token",
    SLACK_EVENT_TYPE: "message",
    SLACK_CHANNEL_TYPE: "im",
  };
  for (const name of ["SLACK_TEXT", "SLACK_CHANNEL_ID", "SLACK_BOT_TOKEN"] as const) {
    await t.test(name, async () => {
      const modules = recordingModules();
      const lines: string[] = [];
      const { [name]: _removed, ...rest } = environment;

      await assert.rejects(main(rest, deps(modules, lines)), (error: unknown) => {
        assert.ok(error instanceof KeyError);
        assert.equal(error.key, name);
        return true;
      });
      assert.deepEqual(modules.requests.post.calls, []);
      assert.deepEqual(lines, []);
    });
  }
});

test("S7: uncaughtErrorLine prints main's application messages, and only the name of anything else", () => {
  assert.equal(
    uncaughtErrorLine(new RuntimeError("Slack authentication failed (invalid_auth).")),
    "RuntimeError: Slack authentication failed (invalid_auth).",
  );
  assert.equal(
    uncaughtErrorLine(new Exception("Received Slack message event without SLACK_THREAD_TS")),
    "Exception: Received Slack message event without SLACK_THREAD_TS",
  );
  assert.equal(
    uncaughtErrorLine(new NotionAuthenticationError("Notion authentication failed (HTTP 401).")),
    "NotionAuthenticationError: Notion authentication failed (HTTP 401).",
  );
  assert.equal(uncaughtErrorLine(new KeyError("SLACK_TEXT")), "KeyError");
  assert.equal(uncaughtErrorLine(errorWith("xoxb-secret https://hooks.slack.com/x", { code: 400 })), "Error");
  assert.equal(uncaughtErrorLine(new TypeError("CANARY-PRIVATE")), "TypeError");
});

test("S7: runEntryPoint reports an uncaught error from main as one secret-free stderr line and exit code 1", async () => {
  const modules = fakeModules();
  modules.requests.post.returnValue = jsonResponse({ ok: true, ts: "123.456" });
  modules.requests.get.returnValue = jsonResponse({ ok: true, messages: [{ text: "CANARY-PRIVATE" }] });
  const secretError = errorWith("CANARY-PRIVATE model output", { response: { status_code: 400 } });
  const client = fakeGeminiClient(secretError);
  modules.genai.Client.impl = () => client;
  let stderr = "";

  const exitCode = await runEntryPoint(
    { ...TESTBOT_ENVIRONMENT, SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN" },
    { ...deps(modules, []), writeStderr: (text) => (stderr += text) },
  );

  assert.equal(exitCode, 1);
  assert.equal(stderr, "Error\n");
});

test("S7: runEntryPoint reports a real @google/genai error made with a canary API key as its class name only", async () => {
  // The SDK is configured with the canary key and sends it with the request
  // (as the x-goog-api-key header) to a local error response.
  const sdkError = (await sdkStatusError(400, "CANARY-GEMINI-KEY")) as Error & Record<string, unknown>;
  assert.equal(sdkError.name, "BadRequestError");
  // What the error holds, recorded as fact: its own `headers` are the
  // response's; its `cause` is the SDK's CreateInteractionClientError, with
  // no cause of its own, whose recorded request headers do not include the
  // key. Nothing reachable from the error holds the canary.
  assert.deepEqual([...(sdkError["headers"] as Headers).keys()], ["content-type"]);
  const cause = sdkError.cause as Error & Record<string, unknown>;
  assert.equal(cause.name, "CreateInteractionClientError");
  assert.equal(cause.cause, undefined);
  const request = (cause["data$"] as { httpMeta: { request: Request } }).httpMeta.request;
  assert.deepEqual([...request.headers.keys()].sort(), ["accept", "content-type", "cookie", "user-agent"]);
  assert.ok(!inspect(sdkError, { depth: Infinity, showHidden: true }).includes("CANARY"));

  const modules = fakeModules();
  modules.requests.post.returnValue = jsonResponse({ ok: true, ts: "123.456" });
  modules.requests.get.returnValue = jsonResponse({ ok: true, messages: [{ text: "hello" }] });
  modules.genai.Client.impl = () =>
    geminiClientFromSdk({
      interactions: {
        create: async () => {
          throw sdkError;
        },
      },
    });
  const stdout: string[] = [];
  let stderr = "";

  const exitCode = await runEntryPoint(
    { ...TESTBOT_ENVIRONMENT, GEMINI_API_KEY: "CANARY-GEMINI-KEY" },
    { ...deps(modules, stdout), writeStderr: (text) => (stderr += text) },
  );

  assert.equal(exitCode, 1);
  assert.equal(stderr, "BadRequestError\n");
  assert.ok(!stdout.join("\n").includes("CANARY"));
  assert.ok(!stderr.includes("CANARY"));
});

function runEntryPointProcess(env: Record<string, string>, preload: string | null = null) {
  const args = preload === null ? [] : ["--import", `data:text/javascript,${encodeURIComponent(preload)}`];
  // Only what Node needs to start, plus the scenario variables.
  const childEnv: Record<string, string> = { ...env };
  for (const name of ["PATH", "SYSTEMROOT", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  return spawnSync(process.execPath, [...args, ENTRY_POINT], { env: childEnv, encoding: "utf8", timeout: 30_000 });
}

// No outbound call may happen in these processes.
const NO_NETWORK = `
globalThis.fetch = async () => { throw new Error("CANARY-PRIVATE network access"); };
`;

test("entry point: node src/main.ts without SLACK_TEXT exits 1 with only the KeyError name on stderr", () => {
  const result = runEntryPointProcess({ SLACK_CHANNEL_ID: "C-channel", SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN" }, NO_NETWORK);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "KeyError\n");
});

test("entry point: node src/main.ts with an unauthorized DM prints Python's line, makes no call and exits 0", () => {
  const result = runEntryPointProcess(
    {
      SLACK_TEXT: "CANARY-PRIVATE",
      SLACK_CHANNEL_ID: "D-private",
      SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN",
      SLACK_EVENT_TYPE: "message",
      SLACK_CHANNEL_TYPE: "im",
      SLACK_USER_ID: "U-other",
      AUTHORIZED_SLACK_USER_ID: "U-authorized",
    },
    NO_NETWORK,
  );
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Unauthorized Slack DM ignored\n");
  assert.equal(result.status, 0);
});

test("S7: the real process reports an uncaught error with canaries as one secret-free stderr line and exits 1", () => {
  // The Slack post fails at the transport with an error whose message and
  // cause hold canaries; http.ts drops both, and the handler prints one line.
  const preload = `
globalThis.fetch = async () => {
  throw new TypeError("fetch failed https://hooks.slack.com/commands/CANARY-RESPONSE-URL", { cause: new Error("xoxb-CANARY-SLACK-TOKEN") });
};
`;
  const result = runEntryPointProcess(
    {
      SLACK_TEXT: "CANARY-PRIVATE",
      SLACK_CHANNEL_ID: "D-private",
      SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN",
      SLACK_EVENT_TYPE: "message",
      SLACK_CHANNEL_TYPE: "im",
      SLACK_USER_ID: "U-authorized",
      SLACK_EVENT_TS: "100.001",
      AUTHORIZED_SLACK_USER_ID: "U-authorized",
      SLACK_RESPONSE_URL: "https://hooks.slack.com/commands/CANARY-RESPONSE-URL",
      GEMINI_API_KEY: "CANARY-GEMINI-KEY",
      NOTION_API_KEY: "secret_CANARY_NOTION_KEY",
    },
    preload,
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "ConnectionError: HTTP connection failed\n");
  for (const canary of ["CANARY", "xoxb", "secret_"]) {
    assert.ok(!result.stderr.includes(canary));
  }
});

test("S7: the real process reports an error thrown with secrets from inside main as its name only", () => {
  // print fails with an error whose message and cause hold canaries.
  const preload = `${NO_NETWORK}
const secret = new Error("xoxb-CANARY-SLACK-TOKEN CANARY-PRIVATE", { cause: new Error("secret_CANARY_NOTION_KEY") });
process.stdout.write = () => { throw secret; };
`;
  const result = runEntryPointProcess(
    {
      SLACK_TEXT: "CANARY-PRIVATE",
      SLACK_CHANNEL_ID: "D-private",
      SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN",
      SLACK_EVENT_TYPE: "message",
      SLACK_CHANNEL_TYPE: "im",
      SLACK_USER_ID: "U-other",
      AUTHORIZED_SLACK_USER_ID: "U-authorized",
    },
    preload,
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Error\n");
  assert.equal(result.stdout, "");
});

test("S7: the real process reports an error outside main's chain as one line and keeps exit code 1", () => {
  // An unhandled rejection fires while main runs; main itself then succeeds.
  const preload = `${NO_NETWORK}
setTimeout(() => { Promise.reject(new TypeError("CANARY-PRIVATE", { cause: new Error("xoxb-CANARY-SLACK-TOKEN") })); }, 0);
`;
  const result = runEntryPointProcess(
    {
      SLACK_TEXT: "CANARY-PRIVATE",
      SLACK_CHANNEL_ID: "D-private",
      SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN",
      SLACK_EVENT_TYPE: "message",
      SLACK_CHANNEL_TYPE: "im",
      SLACK_USER_ID: "U-other",
      AUTHORIZED_SLACK_USER_ID: "U-authorized",
    },
    preload,
  );
  // main finishes synchronously-fast here; the rejection may land before or
  // after it, and either way the exit code is 1 and the line is the name.
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "TypeError\n");
  assert.ok(!result.stdout.includes("CANARY"));
});
