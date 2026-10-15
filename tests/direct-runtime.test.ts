// The direct Vercel runtime for /tasks (#36, docs/experiments/
// vercel-runtime-migration ACCEPTANCE.md V1-V14): api/slack-request.js routes
// the /tasks command family to api/_direct-runtime.js, which runs src/main.ts
// in-process instead of dispatching to GitHub Actions. Every other request
// shape must still dispatch exactly as before.
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

/** Answers Slack with ok, the Notion query with one Task, and the Track GET with one Track. */
function recordingHttp({ throwOnPost }: { throwOnPost?: Error } = {}): RecordingHttp {
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
function capturedRunDirect(http: RecordingHttp, output: string[], loadApplication?: () => Promise<unknown>): RunDirect {
  return (payload, label) =>
    runDirect(payload, label, {
      sourceEnvironment: VERCEL_ENVIRONMENT,
      entryPointDeps: {
        http,
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

test("every other request shape is handled exactly as before, with the direct runner present", async (t) => {
  const json = "application/json";
  const metadata = JSON.stringify({
    channel_id: "C-allowed",
    user_id: "U-user",
    person_page_id: "person-page-id",
    person_name: "Jane Doe",
    thread_ts: "111.222",
  });
  const interaction = (payload: unknown) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const buttonValue = JSON.stringify({ page_id: "person-page-id", name: "Jane Doe", types: ["Coffee"] });
  const cases: Array<[string, () => Request]> = [
    ["/people due", () => slackRequest(slashCommand("/people", "due"))],
    ["/people suggest", () => slackRequest(slashCommand("/people", "suggest Jane Doe"))],
    ["/testbot", () => slackRequest(slashCommand("/testbot", "hello"))],
    ["a command that only starts with /tasks", () => slackRequest(slashCommand("/tasksx", "list"))],
    ["an empty command", () => slackRequest(slashCommand("", "list"))],
    [
      "a thread reply event",
      () =>
        slackRequest(
          JSON.stringify({
            type: "event_callback",
            event: { type: "message", text: "/tasks list", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0" },
          }),
          json,
        ),
    ],
    [
      "a DM event",
      () =>
        slackRequest(
          JSON.stringify({
            type: "event_callback",
            event: { type: "message", text: "hi", channel: "D1", user: "U1", ts: "2.0", channel_type: "im" },
          }),
          json,
        ),
    ],
    ["url_verification", () => slackRequest(JSON.stringify({ type: "url_verification", challenge: "abc" }), json)],
    [
      "a Suggest button click",
      () =>
        slackRequest(
          interaction({
            type: "block_actions",
            actions: [{ action_id: "people_suggest", value: "Jane Doe" }],
            response_url: "https://hooks.slack.com/actions/x",
            channel: { id: "C-allowed" },
            user: { id: "U-user" },
          }),
          FORM,
        ),
    ],
    [
      "an Add interaction button click",
      () =>
        slackRequest(
          interaction({
            type: "block_actions",
            trigger_id: "trigger",
            actions: [{ action_id: "people_add_interaction", value: buttonValue }],
            channel: { id: "C-allowed" },
            user: { id: "U-user" },
            message: { ts: "111.222" },
          }),
          FORM,
        ),
    ],
    [
      "an Add interaction modal submission",
      () =>
        slackRequest(
          interaction({
            type: "view_submission",
            view: {
              callback_id: "add_interaction_modal",
              private_metadata: metadata,
              state: {
                values: {
                  type_block: { type_select: { selected_option: { value: "Coffee" } } },
                  date_block: { date_select: { selected_date: "2026-10-15" } },
                },
              },
            },
          }),
          FORM,
        ),
    ],
    [
      "an Add follow-up task modal submission",
      () =>
        slackRequest(
          interaction({
            type: "view_submission",
            view: {
              callback_id: "add_followup_task_modal",
              private_metadata: metadata,
              state: { values: { name_block: { name_input: { value: "Send it" } } } },
            },
          }),
          FORM,
        ),
    ],
  ];

  for (const [name, request] of cases) {
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

test("loading api/slack.js and handling synchronous paths does not load src/main.ts or @google/genai", () => {
  // A fresh process records every module it resolves while it imports the
  // Vercel entry point and handles url_verification, an Add interaction
  // button click (views.open) and a /people command (GitHub dispatch). The
  // last import is the positive control that the hook records src/main.ts.
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
    await handleSlackRequest(request(new URLSearchParams({ command: "/people", text: "due", channel_id: "C1" }).toString(), "application/x-www-form-urlencoded"), deps);
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
