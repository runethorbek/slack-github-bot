// Tests of the two dev scripts (S9 ports of scripts/*.py, which had no
// Python tests): scripts/fetch-notion-schema.ts and
// scripts/preview-people-suggest-prompts.ts. Nothing here reaches the network:
// `main` gets a fake http, and the process runs only take the paths that stop
// before any request (missing environment, usage).
//
// The expected lines and exit codes are the Python scripts' own, compared
// against them on the no-network paths before Python was removed. The one
// intended difference is the usage line, which names the TS command.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main as fetchNotionSchema } from "../scripts/fetch-notion-schema.ts";
import {
  DRY_RUN_GEMINI_TEXT,
  USAGE,
  main as previewPeopleSuggestPrompts,
} from "../scripts/preview-people-suggest-prompts.ts";
import { HttpResponse, type GetOptions, type Http, type PostOptions } from "../src/http.ts";
import { buildRecapPrompt, buildSuggestionPrompt, personNotFoundMessage } from "../src/people-suggest.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "secret_CANARY_NOTION_KEY";

function jsonResponse(body: unknown, status = 200): HttpResponse {
  return new HttpResponse(status, new Headers(), JSON.stringify(body));
}

type Call = { method: "GET" | "POST"; url: string; options: GetOptions | PostOptions };

/** A fake http whose answers come from `route`; every call is recorded. */
function fakeHttp(route: (call: Call) => HttpResponse): Http & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async get(url, options = {}) {
      const call: Call = { method: "GET", url, options };
      calls.push(call);
      return route(call);
    },
    async post(url, options = {}) {
      const call: Call = { method: "POST", url, options };
      calls.push(call);
      return route(call);
    },
  };
}

function noHttp(): Http & { calls: Call[] } {
  return fakeHttp((call) => {
    throw new assert.AssertionError({ message: `unexpected ${call.method} ${call.url}` });
  });
}

function capture() {
  const lines: string[] = [];
  let stderr = "";
  return {
    lines,
    stderr: () => stderr,
    deps: { log: (line: string) => lines.push(line), writeStderr: (text: string) => (stderr += text) },
  };
}

function runScript(script: string, args: string[], env: Record<string, string>) {
  // Only what Node needs to start, plus the given variables; fetch is blocked.
  const childEnv: Record<string, string> = { ...env };
  for (const name of ["PATH", "SYSTEMROOT", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  const preload = 'globalThis.fetch = async () => { throw new Error("network access"); };';
  return spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(REPO_ROOT, "scripts", script), ...args],
    { env: childEnv, encoding: "utf8", timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// scripts/fetch-notion-schema.ts
// ---------------------------------------------------------------------------

test("fetch-notion-schema: without NOTION_API_KEY it prints Python's line, makes no call and exits 1", async () => {
  const out = capture();
  const http = noHttp();
  assert.equal(await fetchNotionSchema({ NOTION_PEOPLE_DATA_SOURCE_ID: "people-ds" }, { http, ...out.deps }), 1);
  assert.equal(out.stderr(), "NOTION_API_KEY is not set; nothing to do.\n");
  assert.deepEqual(out.lines, []);
  assert.equal(http.calls.length, 0);
});

test("fetch-notion-schema: with no data source id it skips all four, fetches nothing and exits 1", async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "schema-dump-"));
  try {
    const out = capture();
    const http = noHttp();
    assert.equal(await fetchNotionSchema({ NOTION_API_KEY: API_KEY }, { http, outputDir, ...out.deps }), 1);
    assert.deepEqual(out.lines, [
      "Skipping people: NOTION_PEOPLE_DATA_SOURCE_ID is not set.",
      "Skipping interactions: NOTION_INTERACTIONS_DATA_SOURCE_ID is not set.",
      "Skipping tasks: NOTION_TASKS_DATA_SOURCE_ID is not set.",
      "Skipping tracks: NOTION_TRACKS_DATA_SOURCE_ID is not set.",
    ]);
    assert.equal(out.stderr(), "No data source ids were set; nothing fetched.\n");
    assert.equal(http.calls.length, 0);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("fetch-notion-schema: a configured source is read with GET and its properties written; the key is never printed", async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "schema-dump-"));
  try {
    const properties = { Name: { type: "title", title: {} }, Status: { type: "status", status: { options: [{ name: "Done…" }] } } };
    const http = fakeHttp(() => jsonResponse({ object: "data_source", properties, title: [{ plain_text: "row data" }] }));
    const out = capture();

    const exitCode = await fetchNotionSchema(
      { NOTION_API_KEY: API_KEY, NOTION_TASKS_DATA_SOURCE_ID: "tasks-ds" },
      { http, outputDir, ...out.deps },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(http.calls, [
      {
        method: "GET",
        url: "https://api.notion.com/v1/data_sources/tasks-ds",
        options: { headers: { Authorization: `Bearer ${API_KEY}`, "Notion-Version": "2025-09-03" }, timeout: 10 },
      },
    ]);
    const outputPath = path.join(outputDir, "tasks.json");
    assert.deepEqual(out.lines, [
      "Skipping people: NOTION_PEOPLE_DATA_SOURCE_ID is not set.",
      "Skipping interactions: NOTION_INTERACTIONS_DATA_SOURCE_ID is not set.",
      `Wrote ${outputPath} (2 properties)`,
      "Skipping tracks: NOTION_TRACKS_DATA_SOURCE_ID is not set.",
    ]);
    assert.equal(out.stderr(), "");
    assert.deepEqual(readdirSync(outputDir), ["tasks.json"]);
    // Only the schema, as json.dumps(indent=2, ensure_ascii=False).
    assert.equal(readFileSync(outputPath, "utf8"), JSON.stringify(properties, null, 2));
    assert.ok(readFileSync(outputPath, "utf8").includes("Done…"));
    assert.ok(!out.lines.join("\n").includes("CANARY"));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("fetch-notion-schema: a Notion error status escapes as the HTTPError from raise_for_status", async () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "schema-dump-"));
  try {
    const http = fakeHttp(() => jsonResponse({ message: "nope" }, 404));
    await assert.rejects(
      fetchNotionSchema({ NOTION_API_KEY: API_KEY, NOTION_PEOPLE_DATA_SOURCE_ID: "people-ds" }, { http, outputDir, ...capture().deps }),
      { name: "HTTPError", message: "HTTP error 404" },
    );
    assert.deepEqual(readdirSync(outputDir), []);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("fetch-notion-schema: node scripts/fetch-notion-schema.ts without NOTION_API_KEY exits 1 with Python's line", () => {
  const result = runScript("fetch-notion-schema.ts", [], {});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "NOTION_API_KEY is not set; nothing to do.\n");
});

// ---------------------------------------------------------------------------
// scripts/preview-people-suggest-prompts.ts
// ---------------------------------------------------------------------------

const PREVIEW_ENVIRONMENT = {
  NOTION_API_KEY: API_KEY,
  NOTION_PEOPLE_DATA_SOURCE_ID: "people-ds",
  NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-ds",
};

test("preview-people-suggest-prompts: the usage line and exit 2 unless given exactly one non-blank name", async () => {
  assert.equal(USAGE, 'Usage: node scripts/preview-people-suggest-prompts.ts "<Person name>"');
  for (const args of [[], [" \t "], ["Anders", "Krog"]]) {
    const out = capture();
    const http = noHttp();
    assert.equal(await previewPeopleSuggestPrompts(args, PREVIEW_ENVIRONMENT, { http, ...out.deps }), 2);
    assert.equal(out.stderr(), `${USAGE}\n`);
    assert.deepEqual(out.lines, []);
    assert.equal(http.calls.length, 0);
  }
});

test("preview-people-suggest-prompts: missing environment variables are listed in order and exit 1", async () => {
  const cases: [Record<string, string>, string][] = [
    [{}, "NOTION_API_KEY, NOTION_PEOPLE_DATA_SOURCE_ID, NOTION_INTERACTIONS_DATA_SOURCE_ID"],
    [{ NOTION_PEOPLE_DATA_SOURCE_ID: "people-ds" }, "NOTION_API_KEY, NOTION_INTERACTIONS_DATA_SOURCE_ID"],
    [{ ...PREVIEW_ENVIRONMENT, NOTION_API_KEY: "" }, "NOTION_API_KEY"],
  ];
  for (const [environment, missing] of cases) {
    const out = capture();
    const http = noHttp();
    assert.equal(await previewPeopleSuggestPrompts(["Anders"], environment, { http, ...out.deps }), 1);
    assert.equal(out.stderr(), `Missing environment variables: ${missing}\n`);
    assert.equal(http.calls.length, 0);
  }
});

function personPage(name: string) {
  return {
    id: "person-page",
    properties: {
      Name: { type: "title", title: [{ plain_text: name }] },
      Interests: { type: "rich_text", rich_text: [{ plain_text: "Sailing" }] },
    },
  };
}

function interactionPage() {
  return {
    id: "interaction-page",
    properties: {
      "Title of interaction": { type: "title", title: [{ plain_text: "Coffee chat" }] },
      Date: { type: "date", date: { start: "2026-01-02" } },
      Type: { type: "select", select: { name: "Coffee" } },
      Notes: { type: "rich_text", rich_text: [{ plain_text: "Talked about the roadmap" }] },
    },
  };
}

/** Notion for one Person with one Interaction and live Type options; nothing else is answered. */
function notionHttp(personName: string) {
  return fakeHttp(({ method, url }) => {
    if (method === "POST" && url === "https://api.notion.com/v1/data_sources/people-ds/query") {
      return jsonResponse({ results: [personPage(personName)], has_more: false, next_cursor: null });
    }
    if (method === "POST" && url === "https://api.notion.com/v1/data_sources/interactions-ds/query") {
      return jsonResponse({ results: [interactionPage()], has_more: false, next_cursor: null });
    }
    if (method === "GET" && url === "https://api.notion.com/v1/data_sources/interactions-ds") {
      return jsonResponse({ properties: { Type: { type: "select", select: { options: [{ name: "Coffee" }, { name: "Call" }] } } } });
    }
    throw new assert.AssertionError({ message: `unexpected ${method} ${url}` });
  });
}

test("preview-people-suggest-prompts: runs the real handler with stubbed Gemini and Slack and prints both prompts", async () => {
  const http = notionHttp("Anders Krog-Meyer");
  const out = capture();

  const exitCode = await previewPeopleSuggestPrompts(["  anders krog-meyer "], PREVIEW_ENVIRONMENT, { http, ...out.deps });

  assert.equal(exitCode, 0);
  assert.equal(out.stderr(), "");
  // Only Notion was called, and only to read: the two queries and the schema.
  assert.deepEqual(
    http.calls.map(({ method, url }) => `${method} ${url}`),
    [
      "POST https://api.notion.com/v1/data_sources/people-ds/query",
      "POST https://api.notion.com/v1/data_sources/interactions-ds/query",
      "GET https://api.notion.com/v1/data_sources/interactions-ds",
    ],
  );

  // The printed prompts are exactly the ones the handler builds for this context.
  const profile = {
    pageId: "person-page",
    name: "Anders Krog-Meyer",
    contextFields: [["Interests", "Sailing"]] as [string, string][],
    trackIds: [],
  };
  const interactions = [
    { date: "2026-01-02", type: "Coffee", title: "Coffee chat", notes: "Talked about the roadmap", trackIds: [] },
  ];
  const recapPrompt = buildRecapPrompt(profile, interactions, {
    personTracks: [],
    otherTracks: [],
    nextStepKinds: ["Coffee", "Call", "Wait"],
  });
  const draftPrompt = buildSuggestionPrompt(profile, interactions, { personTracks: [], otherTracks: [] });
  assert.deepEqual(out.lines, [
    "==================== RECAP / NEXT-STEP PROMPT ====================",
    recapPrompt,
    "",
    "==================== DRAFT-MESSAGE PROMPT ====================",
    draftPrompt,
    "",
  ]);
  assert.ok(!out.lines.join("\n").includes(API_KEY));
  assert.ok(!out.lines.join("\n").includes(DRY_RUN_GEMINI_TEXT));
});

test("preview-people-suggest-prompts: when the command stops before Gemini it prints the reply it would have posted and exits 1", async () => {
  const http = notionHttp("Someone Else");
  const out = capture();

  assert.equal(await previewPeopleSuggestPrompts(["Anders"], PREVIEW_ENVIRONMENT, { http, ...out.deps }), 1);

  // The root message ("/people suggest Anders") is left out, as slack_messages[1:].
  assert.deepEqual(out.lines, [
    "No Gemini prompts were built. The command would have replied:\n",
    personNotFoundMessage("Anders"),
  ]);
  assert.equal(out.stderr(), "");
});

test("preview-people-suggest-prompts: the processes exit 2 with the usage line and 1 with the missing variables", () => {
  const usage = runScript("preview-people-suggest-prompts.ts", [], PREVIEW_ENVIRONMENT);
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.equal(usage.stderr, `${USAGE}\n`);

  const missing = runScript("preview-people-suggest-prompts.ts", ["Anders"], { NOTION_PEOPLE_DATA_SOURCE_ID: "people-ds" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "Missing environment variables: NOTION_API_KEY, NOTION_INTERACTIONS_DATA_SOURCE_ID\n");
});
