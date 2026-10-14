// Port of tests/test_cross_layer_contract.py (SlackToPythonContractTests),
// plus the TS-only workflow-cutover test for slack-message.yml (ACCEPTANCE.md
// G7, security invariant S8).
//
// Python ran each Slack request through the real Vercel handler in a `node`
// subprocess and fed the captured dispatch into main.py. Here both layers run
// in-process: `handleSlackRequest` is imported from api/slack-request.js
// (unchanged), the request is signed exactly as the Python tests' Node
// snippets sign it, and the captured `client_payload` becomes main's
// environment the way .github/workflows/slack-message.yml maps it: each
// `env:` entry read from the workflow file itself (a missing payload field or
// secret is "", as GitHub's expression gives), plus SLACK_RESPONSE_URL, which
// the masking step exports from `response_url`. The fakes follow
// main-routing.test.ts's conventions (real HttpResponse objects).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { GeminiClient, GeminiRequest, GeminiResponse } from "../src/gemini.ts";
import { HttpResponse, type GetOptions, type PostOptions } from "../src/http.ts";
import { main } from "../src/main.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "slack-message.yml");

type SlackRequestDeps = {
  signingSecret: string;
  now: () => number;
  triggerGitHub: (payload: Record<string, unknown>) => Promise<unknown>;
  defer: (promise: Promise<unknown>) => void;
};
type HandleSlackRequest = (request: Request, deps: SlackRequestDeps) => Promise<Response>;

// api/slack-request.js has no type declarations; it is imported as it is.
const SLACK_REQUEST_MODULE = new URL("../api/slack-request.js", import.meta.url).href;
const { handleSlackRequest } = (await import(SLACK_REQUEST_MODULE)) as { handleSlackRequest: HandleSlackRequest };

// ---------------------------------------------------------------------------
// The Vercel layer: a signed request in, the dispatched client_payload out
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
    triggerGitHub: async (payload) => dispatched.push(payload),
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
// The workflow layer: client_payload and secrets to main's environment
// ---------------------------------------------------------------------------

function workflowLines(): string[] {
  return readFileSync(WORKFLOW_PATH, "utf8").split(/\r?\n/);
}

/** The bot step's `env:` entries, in order, as [name, expression]. */
function workflowEnvMapping(lines: readonly string[] = workflowLines()): Array<[string, string]> {
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

/** A GitHub expression's value as an environment variable: absent or null is "". */
function expressionValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  assert.equal(typeof value, "string", "every client_payload field is a string");
  return value as string;
}

/** main's environment for `payload`, as slack-message.yml builds it. */
function workflowEnvironment(payload: Record<string, unknown>, secrets: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, expression] of workflowEnvMapping()) {
    const payloadField = /^\$\{\{ github\.event\.client_payload\.([a-z_]+) \}\}$/.exec(expression);
    const secret = /^\$\{\{ secrets\.([A-Z_]+) \}\}$/.exec(expression);
    if (payloadField !== null) {
      environment[name] = expressionValue(payload[payloadField[1] as string]);
    } else if (secret !== null) {
      environment[name] = secrets[secret[1] as string] ?? "";
    } else {
      assert.fail(`unexpected env expression ${expression}`);
    }
  }
  // The masking step exports the response URL through $GITHUB_ENV.
  const responseUrl = payload["response_url"];
  if (typeof responseUrl === "string" && responseUrl) environment["SLACK_RESPONSE_URL"] = responseUrl;
  return environment;
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
  const environment = workflowEnvironment(payload, {
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

test("test_workflow_maps_dm_identity_and_authorization_configuration (S8)", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  const expectedMappings = [
    "SLACK_USER_ID: ${{ github.event.client_payload.user_id }}",
    "SLACK_EVENT_TS: ${{ github.event.client_payload.event_ts }}",
    "SLACK_CHANNEL_TYPE: ${{ github.event.client_payload.channel_type }}",
    "AUTHORIZED_SLACK_USER_ID: ${{ secrets.AUTHORIZED_SLACK_USER_ID }}",
    "SLACK_VIEW_CALLBACK_ID: ${{ github.event.client_payload.callback_id }}",
    "SLACK_TASK: ${{ github.event.client_payload.task }}",
  ];
  for (const mapping of expectedMappings) {
    assert.ok(workflow.includes(mapping), mapping);
  }
  // The follow-up Task fields (task name) must be masked in the log.
  assert.ok(workflow.includes('"notes", "task"]'));
});

test("test_authenticated_tasks_dispatch_reaches_notion_and_slack_without_gemini (S6)", async () => {
  const payload = await captureJavascriptDispatch();
  const { requests, Client } = fakePythonModules();
  const environment = workflowEnvironment(payload, {
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
  const environment = workflowEnvironment(payload, {
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

// ---------------------------------------------------------------------------
// TS-only: the workflow cutover (ACCEPTANCE.md G7, S8)
// ---------------------------------------------------------------------------

// The masking step exactly as at the cutover's base commit (e455682), one
// string per line, followed by the blank line before the next step.
const BASE_MASKING_STEP_LINES = [
  "      - name: Prepare Slack response URL and mask sensitive payload fields",
  "        run: |",
  "          # github.event.client_payload.* values are not secrets.* context,",
  "          # so unlike SLACK_BOT_TOKEN etc. below, GitHub does not auto-mask",
  "          # them - and it prints every step's resolved `env:` block into its",
  "          # log. Without an explicit ::add-mask:: here, the \"Run Python bot\"",
  "          # step's log would show these values (Slack text, person name,",
  "          # interaction type, notes, follow-up task fields) in plaintext,",
  "          # exactly like response_url would without the mask already applied",
  "          # below.",
  "          node -e '",
  "            const fs = require(\"fs\");",
  "            const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, \"utf8\"));",
  "            const payload = event.client_payload || {};",
  "            const out = [];",
  "            if (typeof payload.response_url === \"string\" && payload.response_url) {",
  "              out.push(\"RESPONSE_URL\\t\" + payload.response_url);",
  "            }",
  "            for (const field of [\"text\", \"person\", \"interaction_type\", \"notes\", \"task\"]) {",
  "              const value = payload[field];",
  "              if (typeof value === \"string\" && value) {",
  "                for (const line of value.split(\"\\n\")) {",
  "                  if (line) out.push(\"MASK\\t\" + line);",
  "                }",
  "              }",
  "            }",
  "            process.stdout.write(out.join(\"\\n\") + \"\\n\");",
  "          ' | while IFS=$'\\t' read -r kind value; do",
  "            if [ \"$kind\" = \"RESPONSE_URL\" ]; then",
  "              echo \"::add-mask::$value\"",
  "              echo \"SLACK_RESPONSE_URL=$value\" >> \"$GITHUB_ENV\"",
  "            else",
  "              echo \"::add-mask::$value\"",
  "            fi",
  "          done",
  "",
];

// The `env:` mapping of the bot step at the base commit, in order.
const BASE_ENV_MAPPING: ReadonlyArray<readonly [string, string]> = [
  ["SLACK_COMMAND", "${{ github.event.client_payload.command }}"],
  ["SLACK_TEXT", "${{ github.event.client_payload.text }}"],
  ["SLACK_CHANNEL_ID", "${{ github.event.client_payload.channel_id }}"],
  ["SLACK_USER_ID", "${{ github.event.client_payload.user_id }}"],
  ["SLACK_EVENT_TS", "${{ github.event.client_payload.event_ts }}"],
  ["SLACK_THREAD_TS", "${{ github.event.client_payload.thread_ts }}"],
  ["SLACK_CHANNEL_TYPE", "${{ github.event.client_payload.channel_type }}"],
  ["SLACK_EVENT_TYPE", "${{ github.event.client_payload.slack_event_type }}"],
  ["SLACK_PERSON", "${{ github.event.client_payload.person }}"],
  ["SLACK_INTERACTION_TYPE", "${{ github.event.client_payload.interaction_type }}"],
  ["SLACK_INTERACTION_NOTES", "${{ github.event.client_payload.notes }}"],
  ["SLACK_INTERACTION_DATE", "${{ github.event.client_payload.date }}"],
  ["SLACK_INTERACTION_TRACK_ID", "${{ github.event.client_payload.track_id }}"],
  ["SLACK_VIEW_CALLBACK_ID", "${{ github.event.client_payload.callback_id }}"],
  ["SLACK_TASK", "${{ github.event.client_payload.task }}"],
  ["SLACK_BOT_TOKEN", "${{ secrets.SLACK_BOT_TOKEN }}"],
  ["AUTHORIZED_SLACK_USER_ID", "${{ secrets.AUTHORIZED_SLACK_USER_ID }}"],
  ["GEMINI_API_KEY", "${{ secrets.GEMINI_API_KEY }}"],
  ["NOTION_API_KEY", "${{ secrets.NOTION_API_KEY }}"],
  ["NOTION_PEOPLE_DATA_SOURCE_ID", "${{ secrets.NOTION_PEOPLE_DATA_SOURCE_ID }}"],
  ["NOTION_INTERACTIONS_DATA_SOURCE_ID", "${{ secrets.NOTION_INTERACTIONS_DATA_SOURCE_ID }}"],
  ["NOTION_TASKS_DATA_SOURCE_ID", "${{ secrets.NOTION_TASKS_DATA_SOURCE_ID }}"],
  ["NOTION_TRACKS_DATA_SOURCE_ID", "${{ secrets.NOTION_TRACKS_DATA_SOURCE_ID }}"],
  ["TASKS_SLACK_CHANNEL_ID", "${{ secrets.TASKS_SLACK_CHANNEL_ID }}"],
];

test("G7: slack-message.yml runs node src/main.ts on Node 24 with the masking step and env mapping unchanged", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");
  const lines = text.split(/\r?\n/);

  // The trigger: repository_dispatch of slack_message, nothing else.
  const onStart = lines.indexOf("on:");
  const jobsStart = lines.indexOf("jobs:");
  assert.ok(onStart >= 0 && jobsStart > onStart);
  assert.deepEqual(
    lines.slice(onStart, jobsStart).filter((line) => line.trim() !== ""),
    ["on:", "  repository_dispatch:", "    types: [slack_message]"],
  );

  // The steps, in order: checkout, setup-node before the masking step (which
  // runs `node -e`), the production install, the masking step, the bot.
  const steps = lines.filter((line) => line.startsWith("      - "));
  assert.deepEqual(steps, [
    "      - uses: actions/checkout@v5",
    "      - uses: actions/setup-node@v7",
    "      - name: Install dependencies",
    "      - name: Prepare Slack response URL and mask sensitive payload fields",
    "      - name: Run bot",
  ]);
  const setupNode = lines.indexOf("      - uses: actions/setup-node@v7");
  assert.deepEqual(lines.slice(setupNode + 1, setupNode + 4), [
    "        with:",
    '          node-version: "24"',
    "          cache: npm",
  ]);
  const install = lines.indexOf("      - name: Install dependencies");
  assert.equal(lines[install + 1], "        run: npm ci --omit=dev");

  // The masking step, byte for byte as before the cutover (S8).
  const maskingStart = lines.indexOf(BASE_MASKING_STEP_LINES[0] as string);
  assert.deepEqual(lines.slice(maskingStart, maskingStart + BASE_MASKING_STEP_LINES.length), BASE_MASKING_STEP_LINES);
  assert.equal(lines[maskingStart + BASE_MASKING_STEP_LINES.length], "      - name: Run bot");

  // The env mapping: every key and expression of the base, in order, and no
  // addition; then the TS entry point.
  const mapping = workflowEnvMapping(lines);
  assert.deepEqual(mapping, BASE_ENV_MAPPING);
  const runBot = lines.indexOf("      - name: Run bot");
  assert.equal(lines[runBot + 2 + mapping.length], "        run: node src/main.ts");
  // The response URL is never an env: mapping (it goes through $GITHUB_ENV).
  assert.ok(!mapping.some(([name, expression]) => name === "SLACK_RESPONSE_URL" || expression.includes("response_url")));

  // Every run command; no Python left (the masking step's comment still names
  // the old step, "Run Python bot", as it must stay unchanged).
  const runs = lines.filter((line) => /^\s+run: /.test(line)).map((line) => line.trim());
  assert.deepEqual(runs, ["run: npm ci --omit=dev", "run: |", "run: node src/main.ts"]);
  assert.ok(!text.includes("setup-python"));
  assert.ok(!text.includes("requirements.txt"));
  assert.ok(!text.includes("pip "));
  assert.ok(!/\bpython\b/.test(text));
  assert.ok(!text.includes("main.py"));
});
