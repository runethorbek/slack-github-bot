// The direct Vercel runtime (#36, #38 phase 1; docs/experiments/
// vercel-runtime-migration ACCEPTANCE.md V1-V14): api/slack-request.js routes
// every interactive request shape to api/_direct-runtime.js, which runs
// src/main in-process instead of dispatching to GitHub Actions, with the same
// payload, ack and retry guards as before. Without a direct runner, every
// shape still dispatches to GitHub exactly as before (the rollback path).
//
// The workflow mapping is read from slack-message.yml itself, as in
// cross-layer-contract.test.ts, so the adapter cannot drift from it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { GeminiClient, GeminiRequest } from "../src/gemini.ts";
import { HttpResponse, type GetOptions, type PostOptions } from "../src/http.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "slack-message.yml");

type Payload = Record<string, unknown>;
type Environment = Record<string, string>;
type RunDirectOptions = {
  sourceEnvironment?: Record<string, string | undefined>;
  loadApplication?: () => Promise<unknown>;
  entryPointDeps?: Record<string, unknown>;
  log?: (line: string) => void;
  logError?: (line: string) => void;
};
type RunDirect = (payload: Payload, label: string, options?: RunDirectOptions) => Promise<void>;
type SlackRequestDeps = {
  signingSecret: string;
  now: () => number;
  triggerGitHub: (payload: Payload) => Promise<unknown>;
  runDirect?: (payload: Payload, label: string) => Promise<unknown>;
  defer: (promise: Promise<unknown>) => void;
  openModal?: (triggerId: string, view: unknown) => Promise<void>;
  postToResponseUrl?: (url: string, init: RequestInit) => Promise<Response>;
};
type HandleSlackRequest = (request: Request, deps: SlackRequestDeps) => Promise<Response>;

// api/ has no type declarations; it is imported as it is.
const { handleSlackRequest } = (await import(new URL("../api/slack-request.js", import.meta.url).href)) as {
  handleSlackRequest: HandleSlackRequest;
};
type LoadMainOptions = {
  importCompiled?: () => Promise<unknown>;
  importSource?: () => Promise<unknown>;
  compiledUrl?: string;
};
const { runDirect, loadMain, directEnvironment, APPLICATION_SECRET_NAMES } = (await import(
  new URL("../api/_direct-runtime.js", import.meta.url).href
)) as {
  runDirect: RunDirect;
  loadMain: (options?: LoadMainOptions) => Promise<unknown>;
  directEnvironment: (payload: Payload, sourceEnvironment: Record<string, string | undefined>) => Environment;
  APPLICATION_SECRET_NAMES: string[];
};

// ---------------------------------------------------------------------------
// Signed Slack requests
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "fake-signing-secret";
const TIMESTAMP = 1_700_000_000;
const FORM = "application/x-www-form-urlencoded";

function slackRequest(body: string, contentType = FORM, signature?: string, retry = false): Request {
  const headers = new Headers({
    "content-type": contentType,
    "x-slack-request-timestamp": String(TIMESTAMP),
    "x-slack-signature":
      signature ?? `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${TIMESTAMP}:${body}`).digest("hex")}`,
  });
  if (retry) headers.set("x-slack-retry-num", "1");
  return new Request("https://example.test/api/slack", { method: "POST", headers, body });
}

function slashCommand(command: string, text: string, channelId = "C-allowed", userId = "U-user"): string {
  return new URLSearchParams({
    command,
    text,
    response_url: "https://hooks.slack.test/response",
    channel_id: channelId,
    user_id: userId,
  }).toString();
}

type Handled = {
  status: number;
  body: string;
  dispatched: Payload[];
  direct: Array<[Payload, string]>;
  modals: unknown[];
  responseUrlPosts: unknown[];
};

/** Handle one request, with or without a direct runner, and record every effect. */
async function handle(
  request: Request,
  { withDirect = true, runDirectImpl }: { withDirect?: boolean; runDirectImpl?: RunDirect } = {},
): Promise<Handled> {
  const dispatched: Payload[] = [];
  const direct: Array<[Payload, string]> = [];
  const modals: unknown[] = [];
  const responseUrlPosts: unknown[] = [];
  const deferred: Array<Promise<unknown>> = [];
  const deps: SlackRequestDeps = {
    signingSecret: SIGNING_SECRET,
    now: () => TIMESTAMP * 1000,
    triggerGitHub: async (payload) => dispatched.push(payload),
    defer: (promise) => deferred.push(promise),
    openModal: async (triggerId, view) => {
      modals.push([triggerId, view]);
    },
    postToResponseUrl: async (url, init) => {
      responseUrlPosts.push([url, init]);
      return new Response("ok");
    },
  };
  if (withDirect) {
    deps.runDirect = async (payload, label) => {
      direct.push([structuredClone(payload), label]);
      if (runDirectImpl) await runDirectImpl(payload, label);
    };
  }
  const response = await handleSlackRequest(request, deps);
  await Promise.all(deferred);
  return { status: response.status, body: await response.text(), dispatched, direct, modals, responseUrlPosts };
}

// ---------------------------------------------------------------------------
// The workflow mapping, read from slack-message.yml
// ---------------------------------------------------------------------------

function workflowEnvMapping(): Array<[string, string]> {
  const lines = readFileSync(WORKFLOW_PATH, "utf8").split(/\r?\n/);
  const runBot = lines.indexOf("      - name: Run bot");
  assert.ok(runBot >= 0, "the Run bot step");
  assert.equal(lines[runBot + 1], "        env:");
  const mapping: Array<[string, string]> = [];
  for (const line of lines.slice(runBot + 2)) {
    const match = /^ {10}([A-Z_]+): (.*)$/.exec(line);
    if (match === null) break;
    mapping.push([match[1] as string, match[2] as string]);
  }
  return mapping;
}

function workflowSecretNames(): string[] {
  return workflowEnvMapping().flatMap(([, expression]) => {
    const secret = /^\$\{\{ secrets\.([A-Z_]+) \}\}$/.exec(expression);
    return secret === null ? [] : [secret[1] as string];
  });
}

/** main's environment for `payload`, as slack-message.yml builds it. */
function workflowEnvironment(payload: Payload, secrets: Record<string, string>): Environment {
  const environment: Environment = {};
  for (const [name, expression] of workflowEnvMapping()) {
    const payloadField = /^\$\{\{ github\.event\.client_payload\.([a-z_]+) \}\}$/.exec(expression);
    const secret = /^\$\{\{ secrets\.([A-Z_]+) \}\}$/.exec(expression);
    if (payloadField !== null) {
      const value = payload[payloadField[1] as string];
      environment[name] = value === undefined || value === null ? "" : String(value);
    } else if (secret !== null) {
      environment[name] = secrets[secret[1] as string] ?? "";
    } else {
      assert.fail(`unexpected env expression ${expression}`);
    }
  }
  const responseUrl = payload["response_url"];
  if (typeof responseUrl === "string" && responseUrl) environment["SLACK_RESPONSE_URL"] = responseUrl;
  return environment;
}

const SECRETS: Record<string, string> = {
  SLACK_BOT_TOKEN: "fake-slack-token",
  AUTHORIZED_SLACK_USER_ID: "U-authorized",
  GEMINI_API_KEY: "fake-gemini-key",
  NOTION_API_KEY: "fake-notion-token",
  NOTION_PEOPLE_DATA_SOURCE_ID: "fake-people-id",
  NOTION_INTERACTIONS_DATA_SOURCE_ID: "fake-interactions-id",
  NOTION_TASKS_DATA_SOURCE_ID: "fake-tasks-id",
  NOTION_TRACKS_DATA_SOURCE_ID: "fake-tracks-id",
  TASKS_SLACK_CHANNEL_ID: "C-allowed",
};

/** Vercel's environment: the application secrets plus everything that must not reach main. */
const VERCEL_ENVIRONMENT: Record<string, string> = {
  ...SECRETS,
  SLACK_SIGNING_SECRET: "must-not-reach-main-signing",
  GITHUB_TOKEN: "must-not-reach-main-github",
  GITHUB_OWNER: "must-not-reach-main-owner",
  GITHUB_REPO: "must-not-reach-main-repo",
  GOOGLE_API_KEY: "must-not-reach-main-google",
  VERCEL_ENV: "production",
  PATH: "/usr/bin",
};

// ---------------------------------------------------------------------------
// A recording fake http for main (real HttpResponse objects)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): HttpResponse {
  return new HttpResponse(200, new Headers(), JSON.stringify(body));
}

type RecordingHttp = {
  post: (url: string, options?: PostOptions) => Promise<HttpResponse>;
  get: (url: string, options?: GetOptions) => Promise<HttpResponse>;
  posts: Array<[string, unknown]>;
  gets: string[];
};

/** Answers Slack with ok (a thread read with `threadMessages`), the Notion query with one Task, and the Track GET with one Track. */
function recordingHttp({
  throwOnPost,
  threadMessages = [],
}: { throwOnPost?: Error; threadMessages?: unknown[] } = {}): RecordingHttp {
  const posts: Array<[string, unknown]> = [];
  const gets: string[] = [];
  return {
    posts,
    gets,
    async post(url, options = {}) {
      posts.push([url, options.json]);
      if (throwOnPost) throw throwOnPost;
      if (url.startsWith("https://api.notion.com/")) {
        return jsonResponse({
          results: [
            {
              url: "https://www.notion.so/secret-task",
              properties: {
                Navn: { id: "title", type: "title", title: [{ plain_text: "Secret task name" }] },
                Status: { type: "status", status: { name: "Ikke startet" } },
                Track: { type: "relation", relation: [{ id: "track-id" }] },
              },
            },
          ],
        });
      }
      return jsonResponse({ ok: true, ts: "123.456" });
    },
    async get(url) {
      gets.push(url);
      if (url === "https://slack.com/api/conversations.replies") {
        return jsonResponse({ ok: true, messages: threadMessages });
      }
      return jsonResponse({
        properties: {
          Navn: { type: "title", title: [{ plain_text: "Secret track name" }] },
          Priority: { type: "select", select: { name: "High" } },
        },
      });
    },
  };
}

function notionCalls(http: RecordingHttp): string[] {
  return [...http.posts.map(([url]) => url), ...http.gets].filter((url) => url.startsWith("https://api.notion.com/"));
}

/** The real adapter and the real src/main.ts, with every output channel captured. */
type RecordingGemini = { clients: number; requests: GeminiRequest[]; create: () => GeminiClient };

/** A fake genai.Client(): records every client and request; answers `reply` or throws `fail`. */
function recordingGemini({ reply = "Gemini reply", fail }: { reply?: string; fail?: Error } = {}): RecordingGemini {
  const gemini: RecordingGemini = {
    clients: 0,
    requests: [],
    create: () => {
      gemini.clients += 1;
      return {
        interactions: {
          async create(request) {
            gemini.requests.push(request);
            if (fail) throw fail;
            return { output_text: reply };
          },
        },
      };
    },
  };
  return gemini;
}

function capturedRunDirect(
  http: RecordingHttp,
  output: string[],
  loadApplication?: () => Promise<unknown>,
  gemini: RecordingGemini = recordingGemini(),
): RunDirect {
  return (payload, label) =>
    runDirect(payload, label, {
      sourceEnvironment: VERCEL_ENVIRONMENT,
      entryPointDeps: {
        http,
        createGeminiClient: gemini.create,
        sleep: async () => {},
        log: (line: string) => output.push(`main: ${line}`),
        writeStderr: (text: string) => output.push(`stderr: ${text}`),
      },
      log: (line) => output.push(`adapter: ${line}`),
      logError: (line) => output.push(`adapter error: ${line}`),
      ...(loadApplication ? { loadApplication } : {}),
    });
}

// ---------------------------------------------------------------------------
// Routing (AC1, AC2, AC5; V1, V2, V9, V14)
// ---------------------------------------------------------------------------

test("a signed /tasks command (any text) gets the same ack and runs directly once, never via GitHub", async (t) => {
  for (const text of ["list", "foo", "", "  LIST  "]) {
    await t.test(JSON.stringify(text), async () => {
      const body = slashCommand("/tasks", text);
      const baseline = await handle(slackRequest(body), { withDirect: false });
      const handled = await handle(slackRequest(body));

      assert.equal(handled.status, 200);
      assert.equal(handled.body, '{"response_type":"ephemeral","text":"Working on it…"}');
      assert.equal(handled.body, baseline.body);
      assert.deepEqual(handled.dispatched, []);
      // The unchanged payload: exactly what GitHub received before.
      assert.deepEqual(handled.direct, [[baseline.dispatched[0], "/tasks"]]);
      assert.equal(baseline.dispatched.length, 1);
    });
  }
});

test("a /tasks command from a DM keeps its DM identity in the direct payload", async () => {
  const handled = await handle(slackRequest(slashCommand("/tasks", "list", "D-private", "U-authorized")));
  assert.equal(handled.direct[0]?.[0]["channel_type"], "im");
});

// Every request shape api/slack-request.js handles (BASELINE.md §4). `label` is
// the direct runner's fixed label for a migrated shape (#36, #38), or null for
// a shape that still goes to GitHub Actions or never dispatches at all
// (`vercelOnly`).
type Shape = { name: string; request: () => Request; label: string | null; vercelOnly?: boolean };

const JSON_TYPE = "application/json";
const MODAL_METADATA = JSON.stringify({
  channel_id: "C-allowed",
  user_id: "U-user",
  person_page_id: "person-page-id",
  person_name: "Jane Doe",
  thread_ts: "111.222",
});

function interactionRequest(payload: unknown, retry = false): Request {
  return slackRequest(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), FORM, undefined, retry);
}

function eventRequest(event: Record<string, unknown>, retry = false): Request {
  return slackRequest(JSON.stringify({ type: "event_callback", event }), JSON_TYPE, undefined, retry);
}

const THREAD_REPLY = { type: "message", text: "/tasks list", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0" };
const DM_ROOT = { type: "message", text: "hi", channel: "D1", user: "U1", ts: "2.0", channel_type: "im" };
const DM_REPLY = { ...DM_ROOT, ts: "3.0", thread_ts: "2.0" };
const SUGGEST_CLICK = {
  type: "block_actions",
  actions: [{ action_id: "people_suggest", value: "Jane Doe" }],
  response_url: "https://hooks.slack.com/actions/x",
  channel: { id: "C-allowed" },
  user: { id: "U-user" },
};
const ADD_INTERACTION_SUBMISSION = {
  type: "view_submission",
  view: {
    callback_id: "add_interaction_modal",
    private_metadata: MODAL_METADATA,
    state: {
      values: {
        type_block: { type_select: { selected_option: { value: "Coffee" } } },
        notes_block: { notes_input: { value: "Agreed to send the article." } },
        date_block: { date_select: { selected_date: "2026-10-15" } },
      },
    },
  },
};
const ADD_FOLLOWUP_TASK_SUBMISSION = {
  type: "view_submission",
  view: {
    callback_id: "add_followup_task_modal",
    private_metadata: MODAL_METADATA,
    state: { values: { name_block: { name_input: { value: "Send it" } } } },
  },
};
const BUTTON_VALUE = JSON.stringify({ page_id: "person-page-id", name: "Jane Doe", types: ["Coffee"] });

const SHAPES: Shape[] = [
  // Migrated in #36.
  { name: "/tasks list", request: () => slackRequest(slashCommand("/tasks", "list")), label: "/tasks" },
  // P5/P6: the whole /people family; its text is parsed in src/, not in api/.
  { name: "/people due", request: () => slackRequest(slashCommand("/people", "due")), label: "/people" },
  { name: "/people suggest", request: () => slackRequest(slashCommand("/people", "suggest Jane Doe")), label: "/people" },
  { name: "/people (usage)", request: () => slackRequest(slashCommand("/people", "foo")), label: "/people" },
  // P1: DM message events, root or reply. Retried events are not guarded today.
  { name: "a root DM event", request: () => eventRequest(DM_ROOT), label: "DM message" },
  { name: "a DM thread reply event", request: () => eventRequest(DM_REPLY), label: "DM message" },
  { name: "a retried DM event", request: () => eventRequest(DM_ROOT, true), label: "DM message" },
  // P7, P8, P9: Gemini paths.
  { name: "a Suggest button click", request: () => interactionRequest(SUGGEST_CLICK), label: "Suggest button" },
  { name: "a retried Suggest button click", request: () => interactionRequest(SUGGEST_CLICK, true), label: "Suggest button" },
  { name: "/testbot", request: () => slackRequest(slashCommand("/testbot", "hello")), label: "slash command" },
  { name: "a command that only starts with /tasks", request: () => slackRequest(slashCommand("/tasksx", "list")), label: "slash command" },
  { name: "an empty command", request: () => slackRequest(slashCommand("", "list")), label: "slash command" },
  { name: "a channel thread reply event", request: () => eventRequest(THREAD_REPLY), label: "thread reply" },
  { name: "a retried channel thread reply event", request: () => eventRequest(THREAD_REPLY, true), label: "thread reply" },
  // P2, P3: writes.
  { name: "an Add interaction submission", request: () => interactionRequest(ADD_INTERACTION_SUBMISSION), label: "Add interaction submission" },
  { name: "an Add follow-up task submission", request: () => interactionRequest(ADD_FOLLOWUP_TASK_SUBMISSION), label: "Add follow-up task submission" },
  // Handled entirely in Vercel, before and after the migration.
  { name: "url_verification", request: () => slackRequest(JSON.stringify({ type: "url_verification", challenge: "abc" }), JSON_TYPE), label: null, vercelOnly: true },
  { name: "a top-level channel message", request: () => eventRequest({ type: "message", text: "hi", channel: "C1", user: "U1", ts: "2.0" }), label: null, vercelOnly: true },
  { name: "a bot message", request: () => eventRequest({ ...THREAD_REPLY, bot_id: "B1" }), label: null, vercelOnly: true },
  {
    name: "an Add interaction button click (views.open)",
    request: () =>
      interactionRequest({
        type: "block_actions",
        trigger_id: "trigger",
        actions: [{ action_id: "people_add_interaction", value: BUTTON_VALUE }],
        channel: { id: "C-allowed" },
        user: { id: "U-user" },
        message: { ts: "111.222" },
      }),
    label: null,
    vercelOnly: true,
  },
  {
    name: "an unknown block action",
    request: () => interactionRequest({ ...SUGGEST_CLICK, actions: [{ action_id: "other", value: "x" }] }),
    label: null,
    vercelOnly: true,
  },
  { name: "a retried Add interaction submission", request: () => interactionRequest(ADD_INTERACTION_SUBMISSION, true), label: null, vercelOnly: true },
  { name: "a retried Add follow-up task submission", request: () => interactionRequest(ADD_FOLLOWUP_TASK_SUBMISSION, true), label: null, vercelOnly: true },
];

const MIGRATED = SHAPES.filter((shape) => shape.label !== null);

test("every migrated shape runs directly once with the unchanged payload, never via GitHub", async (t) => {
  for (const { name, request, label } of MIGRATED) {
    await t.test(name, async () => {
      const baseline = await handle(request(), { withDirect: false });
      const handled = await handle(request());

      assert.equal(baseline.dispatched.length, 1);
      assert.deepEqual(handled.direct, [[baseline.dispatched[0], label]]);
      assert.deepEqual(handled.dispatched, []);
      // The same ack, modals and Suggest response_url ack as before.
      assert.equal(handled.status, baseline.status);
      assert.equal(handled.body, baseline.body);
      assert.deepEqual(handled.modals, baseline.modals);
      assert.deepEqual(handled.responseUrlPosts, baseline.responseUrlPosts);
    });
  }
});

test("every shape not migrated is handled exactly as before, with the direct runner present", async (t) => {
  for (const { name, request, label } of SHAPES) {
    if (label !== null) continue;
    await t.test(name, async () => {
      const baseline = await handle(request(), { withDirect: false });
      const handled = await handle(request());

      assert.deepEqual(handled.direct, []);
      assert.equal(handled.status, baseline.status);
      assert.equal(handled.body, baseline.body);
      assert.deepEqual(handled.dispatched, baseline.dispatched);
      assert.deepEqual(handled.modals, baseline.modals);
      assert.deepEqual(handled.responseUrlPosts, baseline.responseUrlPosts);
    });
  }
});

test("shapes handled entirely in Vercel run nothing, directly or via GitHub", async (t) => {
  for (const { name, request, vercelOnly } of SHAPES) {
    if (!vercelOnly) continue;
    await t.test(name, async () => {
      const handled = await handle(request());
      assert.deepEqual(handled.direct, []);
      assert.deepEqual(handled.dispatched, []);
    });
  }
});

test("for every migrated shape, runEntryPoint gets the environment slack-message.yml would produce", async (t) => {
  for (const { name, request } of MIGRATED) {
    await t.test(name, async () => {
      const baseline = await handle(request(), { withDirect: false });
      const received: Environment[] = [];
      await handle(request(), {
        runDirectImpl: (payload, label) =>
          runDirect(payload, label, {
            sourceEnvironment: VERCEL_ENVIRONMENT,
            loadApplication: async () => ({
              async runEntryPoint(environment: Environment) {
                received.push(environment);
                return 0;
              },
            }),
            log: () => {},
          }),
      });

      assert.deepEqual(received, [workflowEnvironment(baseline.dispatched[0] as Payload, SECRETS)]);
    });
  }
});

test("an invalid signature on a /tasks request runs nothing", async () => {
  const handled = await handle(slackRequest(slashCommand("/tasks", "list"), FORM, "v0=0000"));
  assert.equal(handled.status, 401);
  assert.deepEqual(handled.direct, []);
  assert.deepEqual(handled.dispatched, []);
});

// ---------------------------------------------------------------------------
// The environment (AC3, AC6; V4, V8)
// ---------------------------------------------------------------------------

test("the application secret allowlist is exactly slack-message.yml's secrets", () => {
  assert.deepEqual([...APPLICATION_SECRET_NAMES].sort(), workflowSecretNames().sort());
});

test("the environment passed to runEntryPoint equals what slack-message.yml would produce", async (t) => {
  const cases: Array<[string, string]> = [
    ["a channel /tasks list", slashCommand("/tasks", "list")],
    ["a DM /tasks with other text", slashCommand("/tasks", "foo bar", "D-private", "U-authorized")],
    ["a /tasks without a response_url", new URLSearchParams({ command: "/tasks", text: "list", channel_id: "C1" }).toString()],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const received: Array<[Environment, unknown]> = [];
      const fakeApplication = {
        async runEntryPoint(environment: Environment, deps: unknown) {
          received.push([environment, deps]);
          return 0;
        },
      };
      const handled = await handle(slackRequest(body), {
        runDirectImpl: (payload, label) =>
          runDirect(payload, label, {
            sourceEnvironment: VERCEL_ENVIRONMENT,
            loadApplication: async () => fakeApplication,
            log: () => {},
          }),
      });

      const payload = handled.direct[0]?.[0] as Payload;
      assert.equal(received.length, 1);
      assert.deepEqual(received[0]?.[0], workflowEnvironment(payload, SECRETS));
    });
  }
});

test("no other Vercel variable reaches main's environment, and an unset secret is empty", () => {
  const payload = { command: "/tasks", text: "list", channel_id: "C1", response_url: "" };
  const environment = directEnvironment(payload, VERCEL_ENVIRONMENT);
  for (const name of ["SLACK_SIGNING_SECRET", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GOOGLE_API_KEY", "VERCEL_ENV", "PATH"]) {
    assert.ok(!(name in environment), name);
  }
  for (const value of Object.values(environment)) {
    assert.ok(!value.startsWith("must-not-reach-main"));
  }
  assert.ok(!("SLACK_RESPONSE_URL" in environment));

  const unset = directEnvironment(payload, {});
  for (const name of APPLICATION_SECRET_NAMES) assert.equal(unset[name], "");
});

// ---------------------------------------------------------------------------
// Authorization through the whole chain (AC4; V3)
// ---------------------------------------------------------------------------

test("an unauthorized /tasks from a channel gets only the ephemeral refusal, with no Notion call", async () => {
  const http = recordingHttp();
  const output: string[] = [];
  await handle(slackRequest(slashCommand("/tasks", "list", "C-other", "U-authorized")), {
    runDirectImpl: capturedRunDirect(http, output),
  });

  assert.deepEqual(notionCalls(http), []);
  assert.deepEqual(http.gets, []);
  assert.deepEqual(http.posts, [
    [
      "https://hooks.slack.test/response",
      { response_type: "ephemeral", text: "The /tasks command is not available in this channel." },
    ],
  ]);
  assert.deepEqual(output, [
    "adapter: Direct runtime: executing /tasks",
    "main: Unauthorized private-data command rejected",
    "adapter: Direct runtime: finished /tasks with exit code 0",
  ]);
});

test("an unauthorized /tasks from a DM produces nothing, with no Notion call", async () => {
  const http = recordingHttp();
  const output: string[] = [];
  await handle(slackRequest(slashCommand("/tasks", "list", "D-private", "U-other")), {
    runDirectImpl: capturedRunDirect(http, output),
  });

  assert.deepEqual(http.posts, []);
  assert.deepEqual(http.gets, []);
  assert.deepEqual(output, [
    "adapter: Direct runtime: executing /tasks",
    "main: Unauthorized Slack DM command ignored",
    "adapter: Direct runtime: finished /tasks with exit code 0",
  ]);
});

test("an authorized /tasks list in the configured channel reaches Notion and posts the list", async () => {
  // The counterpart of the two tests above, so they cannot pass by never
  // reaching Notion at all.
  const http = recordingHttp();
  const output: string[] = [];
  await handle(slackRequest(slashCommand("/tasks", "list")), { runDirectImpl: capturedRunDirect(http, output) });

  assert.deepEqual(notionCalls(http), [
    "https://api.notion.com/v1/data_sources/fake-tasks-id/query",
    "https://api.notion.com/v1/pages/track-id",
  ]);
  const reply = http.posts.at(-1)?.[1] as { text: string };
  assert.ok(reply.text.includes("Secret track name"));
  assert.deepEqual(output, [
    "adapter: Direct runtime: executing /tasks",
    "main: Task command handled",
    "adapter: Direct runtime: finished /tasks with exit code 0",
  ]);
});

const PEOPLE_REFUSAL = { response_type: "ephemeral", text: "The /people command is not available in this channel." };

/** Unauthorized requests on migrated shapes, through the whole chain: no Notion call and no Gemini client. */
const UNAUTHORIZED: Array<{ name: string; request: () => Request; label: string; posts: Array<[string, unknown]>; line: string }> = [
  {
    name: "/people due from another channel",
    request: () => slackRequest(slashCommand("/people", "due", "C-other", "U-authorized")),
    label: "/people",
    posts: [["https://hooks.slack.test/response", PEOPLE_REFUSAL]],
    line: "Unauthorized private-data command rejected",
  },
  {
    name: "/people suggest from another channel",
    request: () => slackRequest(slashCommand("/people", "suggest Jane Doe", "C-other", "U-authorized")),
    label: "/people",
    posts: [["https://hooks.slack.test/response", PEOPLE_REFUSAL]],
    line: "Unauthorized private-data command rejected",
  },
  {
    name: "/people due from another user's DM",
    request: () => slackRequest(slashCommand("/people", "due", "D-private", "U-other")),
    label: "/people",
    posts: [],
    line: "Unauthorized Slack DM command ignored",
  },
  {
    name: "/people suggest from another user's DM",
    request: () => slackRequest(slashCommand("/people", "suggest Jane Doe", "D-private", "U-other")),
    label: "/people",
    posts: [],
    line: "Unauthorized Slack DM command ignored",
  },
  {
    name: "a Suggest click from another channel",
    request: () => interactionRequest({ ...SUGGEST_CLICK, channel: { id: "C-other" }, user: { id: "U-authorized" } }),
    label: "Suggest button",
    posts: [["https://hooks.slack.com/actions/x", PEOPLE_REFUSAL]],
    line: "Unauthorized private-data command rejected",
  },
  {
    name: "a Suggest click from another user's DM",
    request: () => interactionRequest({ ...SUGGEST_CLICK, channel: { id: "D-private" }, user: { id: "U-other" } }),
    label: "Suggest button",
    posts: [],
    line: "Unauthorized Slack DM command ignored",
  },
  {
    name: "an Add interaction submission from another channel",
    request: () =>
      interactionRequest({
        ...ADD_INTERACTION_SUBMISSION,
        view: { ...ADD_INTERACTION_SUBMISSION.view, private_metadata: JSON.stringify({ ...JSON.parse(MODAL_METADATA), channel_id: "C-other" }) },
      }),
    label: "Add interaction submission",
    posts: [],
    line: "Unauthorized modal submission ignored",
  },
  {
    name: "an Add follow-up task submission from another channel",
    request: () =>
      interactionRequest({
        ...ADD_FOLLOWUP_TASK_SUBMISSION,
        view: { ...ADD_FOLLOWUP_TASK_SUBMISSION.view, private_metadata: JSON.stringify({ ...JSON.parse(MODAL_METADATA), channel_id: "C-other" }) },
      }),
    label: "Add follow-up task submission",
    posts: [],
    line: "Unauthorized modal submission ignored",
  },
  {
    name: "a DM message from another user",
    request: () => eventRequest({ ...DM_ROOT, channel: "D-private", user: "U-other" }),
    label: "DM message",
    posts: [],
    line: "Unauthorized Slack DM ignored",
  },
];

test("unauthorized requests on migrated shapes make no Notion call and create no Gemini client", async (t) => {
  for (const { name, request, label, posts, line } of UNAUTHORIZED) {
    await t.test(name, async () => {
      const http = recordingHttp();
      const gemini = recordingGemini();
      const output: string[] = [];
      await handle(request(), { runDirectImpl: capturedRunDirect(http, output, undefined, gemini) });

      assert.deepEqual(notionCalls(http), []);
      assert.deepEqual(http.gets, []);
      assert.equal(gemini.clients, 0);
      assert.deepEqual(http.posts, posts);
      assert.deepEqual(output, [
        `adapter: Direct runtime: executing ${label}`,
        `main: ${line}`,
        `adapter: Direct runtime: finished ${label} with exit code 0`,
      ]);
    });
  }
});

test("/testbot runs the Gemini conversation directly: root, thread read, one Gemini request, reply", async () => {
  const http = recordingHttp({ threadMessages: [{ text: "\u{1F4AC} hello", user: "U-user" }] });
  const gemini = recordingGemini({ reply: "Hi there" });
  const output: string[] = [];
  await handle(slackRequest(slashCommand("/testbot", "hello")), {
    runDirectImpl: capturedRunDirect(http, output, undefined, gemini),
  });

  assert.deepEqual(notionCalls(http), []);
  assert.deepEqual(http.gets, ["https://slack.com/api/conversations.replies"]);
  assert.equal(gemini.clients, 1);
  assert.equal(gemini.requests.length, 1);
  assert.deepEqual(
    http.posts.map(([url, json]) => [url, (json as { text: string }).text]),
    [
      ["https://slack.com/api/chat.postMessage", "\u{1F4AC} hello"],
      ["https://slack.com/api/chat.postMessage", "Hi there"],
    ],
  );
  assert.deepEqual(output, [
    "adapter: Direct runtime: executing slash command",
    "main: Gemini response posted to Slack thread",
    "adapter: Direct runtime: finished slash command with exit code 0",
  ]);
});

test("a reply in a /tasks list thread gets the fixed follow-up text directly, without Gemini", async () => {
  const http = recordingHttp({ threadMessages: [{ text: "/tasks list" }, { text: "/tasks list", user: "U1" }] });
  const gemini = recordingGemini();
  const output: string[] = [];
  await handle(eventRequest(THREAD_REPLY), { runDirectImpl: capturedRunDirect(http, output, undefined, gemini) });

  assert.equal(gemini.clients, 0);
  assert.deepEqual(
    http.posts.map(([url, json]) => [url, (json as { text: string }).text]),
    [["https://slack.com/api/chat.postMessage", "Task-list follow-ups are not supported. Run /tasks list."]],
  );
  assert.deepEqual(output, [
    "adapter: Direct runtime: executing thread reply",
    "adapter: Direct runtime: finished thread reply with exit code 0",
  ]);
});

test("an authorized Add follow-up task submission writes exactly one Task directly, without Gemini", async () => {
  // The Tasks schema for validation, then one page create and the confirmation.
  const posts: Array<[string, unknown]> = [];
  const gets: string[] = [];
  const http: RecordingHttp = {
    posts,
    gets,
    async post(url, options = {}) {
      posts.push([url, options.json]);
      return url === "https://api.notion.com/v1/pages" ? jsonResponse({ id: "new-task" }) : jsonResponse({ ok: true, ts: "1.2" });
    },
    async get(url) {
      gets.push(url);
      return jsonResponse({
        properties: {
          Navn: { id: "title", type: "title" },
          Priority: { type: "select", select: { options: [{ name: "High" }] } },
          Status: { type: "status", status: { options: [{ name: "Ikke startet" }] } },
          Description: { type: "rich_text" },
        },
      });
    },
  };
  const gemini = recordingGemini();
  const output: string[] = [];
  await handle(interactionRequest(ADD_FOLLOWUP_TASK_SUBMISSION), {
    runDirectImpl: capturedRunDirect(http, output, undefined, gemini),
  });

  assert.equal(gemini.clients, 0);
  assert.deepEqual(gets, ["https://api.notion.com/v1/data_sources/fake-tasks-id"]);
  assert.deepEqual(
    posts.map(([url]) => url),
    ["https://api.notion.com/v1/pages", "https://slack.com/api/chat.postMessage"],
  );
  const reply = posts.at(-1)?.[1] as { text: string; thread_ts: string };
  assert.equal(reply.text, "Follow-up task added for Jane Doe: Send it");
  assert.equal(reply.thread_ts, "111.222");
  assert.deepEqual(output, [
    "adapter: Direct runtime: executing Add follow-up task submission",
    "main: Add follow-up Task submission handled",
    "adapter: Direct runtime: finished Add follow-up task submission with exit code 0",
  ]);
});

// ---------------------------------------------------------------------------
// Process hygiene and logging (AC7, AC8; V7, V11)
// ---------------------------------------------------------------------------

const PRIVATE_TEXT = "list private-marker-text";

/** Every value from the request and the environment that must never be logged. */
function privateValues(): string[] {
  return [
    PRIVATE_TEXT,
    "private-marker-text",
    "https://hooks.slack.test/response",
    "C-allowed",
    "U-user",
    "Secret task name",
    "Secret track name",
    "secret-task",
    ...Object.values(VERCEL_ENVIRONMENT).filter((value) => value.length > 8),
  ];
}

test("the direct path adds no process listener, sets no exitCode and does not mutate process.env", async (t) => {
  const outcomes: Array<[string, RecordingHttp, (() => Promise<unknown>) | undefined]> = [
    ["success", recordingHttp(), undefined],
    ["application error", recordingHttp({ throwOnPost: new Error("boom") }), undefined],
    [
      "import failure",
      recordingHttp(),
      async () => {
        throw new Error("cannot load");
      },
    ],
  ];
  for (const [name, http, loadApplication] of outcomes) {
    await t.test(name, async () => {
      const events = ["uncaughtException", "unhandledRejection", "exit", "beforeExit"] as const;
      const listenersBefore = events.map((event) => process.listenerCount(event));
      const exitCodeBefore = process.exitCode;
      const envBefore = { ...process.env };

      await handle(slackRequest(slashCommand("/tasks", "list")), {
        runDirectImpl: capturedRunDirect(http, [], loadApplication),
      });

      assert.deepEqual(
        events.map((event) => process.listenerCount(event)),
        listenersBefore,
      );
      assert.equal(process.exitCode, exitCodeBefore);
      assert.deepEqual({ ...process.env }, envBefore);
    });
  }
});

test("success, an application error and an import failure log only constant text and the exit code", async (t) => {
  const leakyError = new Error(`${PRIVATE_TEXT} https://hooks.slack.test/response fake-notion-token`);
  const outcomes: Array<[string, RecordingHttp, (() => Promise<unknown>) | undefined, string[]]> = [
    [
      "success",
      recordingHttp(),
      undefined,
      [
        "adapter: Direct runtime: executing /tasks",
        "main: Task command handled",
        "adapter: Direct runtime: finished /tasks with exit code 0",
      ],
    ],
    [
      "application error (runEntryPoint returns 1)",
      recordingHttp({ throwOnPost: leakyError }),
      undefined,
      [
        "adapter: Direct runtime: executing /tasks",
        // runEntryPoint's secret-free line: a constant RuntimeError message.
        "stderr: RuntimeError: Slack response delivery failed.\n",
        "adapter: Direct runtime: finished /tasks with exit code 1",
      ],
    ],
    [
      "import failure",
      recordingHttp(),
      async () => {
        throw leakyError;
      },
      [
        "adapter: Direct runtime: executing /tasks",
        "adapter error: Direct runtime: failed to load the application",
        "adapter: Direct runtime: finished /tasks with exit code 1",
      ],
    ],
  ];
  for (const [name, http, loadApplication, expected] of outcomes) {
    await t.test(name, async () => {
      const output: string[] = [];
      // The deferred promise resolves (never rejects with private data).
      await handle(slackRequest(slashCommand("/tasks", PRIVATE_TEXT)), {
        runDirectImpl: capturedRunDirect(http, output, loadApplication),
      });

      assert.deepEqual(output, expected);
      const logged = output.join("\n");
      for (const value of privateValues()) assert.ok(!logged.includes(value), `logged ${value}`);
    });
  }
});

test("every migrated shape logs only constant text when Slack, Notion and Gemini fail with private data", async (t) => {
  // Distinctive request values from SHAPES, plus the leaky error's own text.
  const shapeValues = [
    "Jane Doe",
    "suggest Jane Doe",
    "Agreed to send the article.",
    "Send it",
    "person-page-id",
    "https://hooks.slack.com/actions/x",
    "https://hooks.slack.test/response",
    "C-allowed",
    "U-user",
  ];
  for (const { name, request, label } of MIGRATED) {
    await t.test(name, async () => {
      const leaky = new Error(`${PRIVATE_TEXT} Jane Doe https://hooks.slack.test/response fake-notion-token`);
      const http = recordingHttp({ throwOnPost: leaky });
      const gemini = recordingGemini({ fail: leaky });
      const output: string[] = [];
      await handle(request(), { runDirectImpl: capturedRunDirect(http, output, undefined, gemini) });

      assert.equal(output[0], `adapter: Direct runtime: executing ${label}`);
      assert.match(output.at(-1) as string, new RegExp(`^adapter: Direct runtime: finished ${label} with exit code [01]$`));
      const logged = output.join("\n");
      for (const value of [...privateValues(), ...shapeValues]) assert.ok(!logged.includes(value), `logged ${value}`);
    });
  }
});

test("runDirect reports a rejecting runEntryPoint as one constant line", async () => {
  const output: string[] = [];
  await runDirect({ command: "/tasks", text: PRIVATE_TEXT }, "/tasks", {
    sourceEnvironment: {},
    loadApplication: async () => ({
      runEntryPoint: async () => {
        throw new Error(PRIVATE_TEXT);
      },
    }),
    log: (line) => output.push(line),
    logError: (line) => output.push(`error: ${line}`),
  });
  assert.deepEqual(output, [
    "Direct runtime: executing /tasks",
    "error: Direct runtime: unexpected failure",
    "Direct runtime: finished /tasks with exit code 1",
  ]);
});

test("runDirect resolves even when logging itself throws", async () => {
  await runDirect({ command: "/tasks" }, "/tasks", {
    sourceEnvironment: {},
    loadApplication: async () => ({ runEntryPoint: async () => 0 }),
    log: () => {
      throw new Error("log failed");
    },
    logError: () => {
      throw new Error("logError failed");
    },
  }).catch(() => assert.fail("runDirect rejected"));
});

// ---------------------------------------------------------------------------
// Loading the application: Vercel ships src/main.ts compiled as src/main.js
// ---------------------------------------------------------------------------

/**
 * Real modules on disk, so that the import errors are Node's own: each case
 * directory holds (or lacks) a main.js, as a deployed function would.
 */
function loaderFixtures(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "direct-runtime-loader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mainJs: Record<string, string | null> = {
    compiled: 'export const marker = "compiled";\n',
    missing: null,
    "missing-dependency": 'import "./gone.js";\nexport const marker = "unreachable";\n',
    throwing: 'throw new Error("main.js failed to evaluate");\n',
  };
  const urls: Record<string, string> = {};
  for (const [name, source] of Object.entries(mainJs)) {
    const directory = path.join(root, name);
    mkdirSync(directory);
    if (source !== null) writeFileSync(path.join(directory, "main.js"), source);
    urls[name] = pathToFileURL(path.join(directory, "main.js")).href;
  }
  return urls;
}

/** loadMain for one fixture; records whether the .ts fallback was taken. */
function fixtureLoader(compiledUrl: string) {
  const sourceImports: string[] = [];
  const options: LoadMainOptions = {
    importCompiled: () => import(compiledUrl),
    importSource: async () => {
      sourceImports.push(compiledUrl);
      return { marker: "source" };
    },
    compiledUrl,
  };
  return { options, sourceImports };
}

test("loadMain prefers the compiled main.js when it exists", async (t) => {
  const { options, sourceImports } = fixtureLoader(loaderFixtures(t)["compiled"] as string);
  const application = (await loadMain(options)) as { marker: string };
  assert.equal(application.marker, "compiled");
  assert.deepEqual(sourceImports, []);
});

test("loadMain falls back to main.ts only when main.js itself is the missing module", async (t) => {
  const { options, sourceImports } = fixtureLoader(loaderFixtures(t)["missing"] as string);
  const application = (await loadMain(options)) as { marker: string };
  assert.equal(application.marker, "source");
  assert.equal(sourceImports.length, 1);
});

test("a missing dependency of main.js is a real failure, not a reason to fall back", async (t) => {
  const fixtures = loaderFixtures(t);
  const { options, sourceImports } = fixtureLoader(fixtures["missing-dependency"] as string);
  await assert.rejects(loadMain(options), (error: { code?: string; url?: string }) => {
    // Its message names main.js as the importer; only error.url tells them apart.
    assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
    assert.ok(error.url?.endsWith("/missing-dependency/gone.js"));
    return true;
  });
  assert.deepEqual(sourceImports, []);
});

test("any other failure of main.js is rethrown without falling back", async (t) => {
  const { options, sourceImports } = fixtureLoader(loaderFixtures(t)["throwing"] as string);
  await assert.rejects(loadMain(options), /main\.js failed to evaluate/);
  assert.deepEqual(sourceImports, []);
});

test("a missing dependency of main.js reaches runDirect's constant load-failure line", async (t) => {
  const { options } = fixtureLoader(loaderFixtures(t)["missing-dependency"] as string);
  const output: string[] = [];
  await runDirect({ command: "/tasks", text: PRIVATE_TEXT }, "/tasks", {
    sourceEnvironment: {},
    loadApplication: () => loadMain(options),
    log: (line) => output.push(line),
    logError: (line) => output.push(`error: ${line}`),
  });
  assert.deepEqual(output, [
    "Direct runtime: executing /tasks",
    "error: Direct runtime: failed to load the application",
    "Direct runtime: finished /tasks with exit code 1",
  ]);
});

test("in the source tree, the default loader falls back to src/main.ts", async () => {
  // There is no compiled src/main.js locally; only a Vercel build has one.
  assert.equal(existsSync(path.join(REPO_ROOT, "src", "main.js")), false);
  const application = (await loadMain()) as { runEntryPoint?: unknown };
  const sourceMain = await import("../src/main.ts");
  assert.equal(application, sourceMain);
});

// ---------------------------------------------------------------------------
// Lazy loading (AC9; V12)
// ---------------------------------------------------------------------------

test("loading api/slack.js and handling synchronous paths does not load the application module or @google/genai", () => {
  // A fresh process records every module it resolves while it imports the
  // Vercel entry point and handles url_verification, an Add interaction
  // button click (views.open), an ignored top-level channel message and a
  // retried modal submission: no src/ module at all, neither the compiled
  // src/main.js nor the src/main.ts fallback. The last import is the
  // positive control that the hook records src/main.ts.
  const script = `
    import { registerHooks } from "node:module";
    import { createHmac } from "node:crypto";
    const resolved = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        resolved.push(result.url);
        return result;
      },
    });
    const handler = (await import("./api/slack.js")).default;
    const { handleSlackRequest } = await import("./api/slack-request.js");
    const { runDirect } = await import("./api/_direct-runtime.js");
    const sign = (body) => "v0=" + createHmac("sha256", "s").update("v0:" + Math.floor(Date.now() / 1000) + ":" + body).digest("hex");
    const request = (body, contentType) => new Request("https://example.test/api/slack", {
      method: "POST",
      headers: { "content-type": contentType, "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": sign(body) },
      body,
    });
    process.env.SLACK_SIGNING_SECRET = "s";
    await handler.fetch(request(JSON.stringify({ type: "url_verification", challenge: "c" }), "application/json"));
    const deferred = [];
    const deps = {
      signingSecret: "s",
      triggerGitHub: async () => {},
      runDirect,
      defer: (promise) => deferred.push(promise),
      openModal: async () => {},
    };
    const button = JSON.stringify({ page_id: "p", name: "n", types: ["Coffee"] });
    await handleSlackRequest(request(new URLSearchParams({ payload: JSON.stringify({
      type: "block_actions", trigger_id: "t", actions: [{ action_id: "people_add_interaction", value: button }],
      channel: { id: "C1" }, user: { id: "U1" }, message: { ts: "1.0" },
    }) }).toString(), "application/x-www-form-urlencoded"), deps);
    await handleSlackRequest(request(JSON.stringify({ type: "event_callback", event: { type: "message", text: "hi", channel: "C1", user: "U1", ts: "1.0" } }), "application/json"), deps);
    const retried = request(new URLSearchParams({ payload: JSON.stringify({
      type: "view_submission", view: { callback_id: "add_interaction_modal", private_metadata: "{}" },
    }) }).toString(), "application/x-www-form-urlencoded");
    retried.headers.set("x-slack-retry-num", "1");
    await handleSlackRequest(retried, deps);
    await Promise.all(deferred);
    const before = resolved.filter((url) => url.includes("/src/") || url.includes("@google/genai"));
    await import("./src/main.ts");
    const control = resolved.some((url) => url.endsWith("/src/main.ts"));
    process.stdout.write(JSON.stringify({ before, control }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const { before, control } = JSON.parse(output) as { before: string[]; control: boolean };
  assert.deepEqual(before, []);
  assert.equal(control, true);
});
