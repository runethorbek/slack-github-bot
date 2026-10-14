// Port of tests/test_attention_summary.py (AttentionSummaryTests,
// SlackDmPosterTests, MainTests), plus TS-only tests of the entry point's
// process concerns: the top-level error handler and the real
// `node src/attention-summary.ts` guard (security invariant S7).
//
// Conventions as in people-due.test.ts: each test title starts with the Python
// method name; Mock objects become recording functions whose `calls` list holds
// each call's arguments, and Python's keyword arguments are the TS options
// object. Fake Notion and Slack responses are real http.ts HttpResponse
// objects; `failing_response(status)` (a Mock whose raise_for_status raises
// NotionHttpError(status) with empty headers) is an HttpResponse with that
// status and no headers, whose raise_for_status() throws the real HTTPError.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AttentionSummaryError,
  SlackDmDeliveryError,
  UNSUPPORTED_NODE_MESSAGE,
  buildSlackDmPoster,
  describeSourceError,
  entryPointMode,
  main,
  runEntryPoint,
  sendAttentionSummary,
  uncaughtErrorLine,
} from "../src/attention-summary.ts";
import { HTTPError, HttpResponse, Timeout, type GetOptions, type Http, type PostOptions } from "../src/http.ts";
import { findDuePeople } from "../src/people-due.ts";
import { makeDate, type PlainDate } from "../src/plain-date.ts";
import { KeyError, casefold, withPyCause } from "../src/python-compat.ts";
import {
  NotionAuthenticationError,
  TaskListCommandError,
  selectTasksNeedingAttention,
  type NotionResponse,
} from "../src/tasks-list.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_POINT = path.join(REPO_ROOT, "src", "attention-summary.ts");

const FIXED_TODAY: PlainDate = makeDate(2026, 9, 28); // A Monday.
const TASKS_SOURCE = "tasks-source";
const PEOPLE_SOURCE = "people-source";
const INTERACTIONS_SOURCE = "interactions-source";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type Mock<A extends unknown[], R> = ((...args: A) => R) & { calls: A[] };

function mock<A extends unknown[], R>(impl: (...args: A) => R): Mock<A, R> {
  const calls: A[] = [];
  const fn = ((...args: A): R => {
    calls.push(args);
    return impl(...args);
  }) as Mock<A, R>;
  fn.calls = calls;
  return fn;
}

type NotionPostMock = Mock<[string, PostOptions], Promise<NotionResponse>>;
type PostMock = Mock<[string], Promise<unknown>>;
type LogMock = Mock<[string], void>;

function response(results: unknown, hasMore = false, nextCursor: string | null = null): HttpResponse {
  return new HttpResponse(
    200,
    new Headers(),
    JSON.stringify({ results, has_more: hasMore, next_cursor: nextCursor }),
  );
}

function failingResponse(statusCode: number): HttpResponse {
  return new HttpResponse(statusCode, new Headers(), "");
}

function jsonResponse(body: unknown): HttpResponse {
  return new HttpResponse(200, new Headers(), JSON.stringify(body));
}

type Page = { url: string; properties: Record<string, unknown> };

function task(name: string, followUp: string | null = null, priority: string | null = null, status = "Ikke startet"): Page {
  return {
    url: `https://www.notion.so/${casefold(name).replaceAll(" ", "-")}`,
    properties: {
      Navn: { id: "title", type: "title", title: [{ plain_text: name }] },
      Status: { type: "status", status: { name: status } },
      Priority: {
        type: "select",
        select: priority ? { name: priority } : null,
      },
      "Follow-up": {
        type: "date",
        date: followUp ? { start: followUp } : null,
      },
    },
  };
}

function person(pageId: string, name: string, cadence = "1 month"): Record<string, unknown> {
  return {
    id: pageId,
    properties: {
      Name: { type: "title", title: [{ plain_text: name }] },
      "Contact cadence": { type: "select", select: { name: cadence } },
    },
  };
}

function interaction(dateValue: string, personId: string): Record<string, unknown> {
  return {
    properties: {
      Date: { type: "date", date: { start: dateValue } },
      People: { type: "relation", relation: [{ id: personId }] },
    },
  };
}

function environment(): Record<string, string> {
  return {
    NOTION_API_KEY: "secret-token",
    NOTION_TASKS_DATA_SOURCE_ID: TASKS_SOURCE,
    NOTION_PEOPLE_DATA_SOURCE_ID: PEOPLE_SOURCE,
    NOTION_INTERACTIONS_DATA_SOURCE_ID: INTERACTIONS_SOURCE,
  };
}

type RoutingOptions = {
  tasks?: readonly unknown[];
  people?: readonly unknown[];
  interactions?: readonly unknown[];
  tasksResponse?: HttpResponse | null;
  peopleResponse?: HttpResponse | null;
};

/** Route each Notion query to its data source's canned response. */
function routingNotionPost({
  tasks = [],
  people = [],
  interactions = [],
  tasksResponse = null,
  peopleResponse = null,
}: RoutingOptions = {}): NotionPostMock {
  return mock(async (url: string, _options: PostOptions): Promise<NotionResponse> => {
    if (url.includes(`/${TASKS_SOURCE}/`)) {
      return tasksResponse ?? response([...tasks]);
    }
    if (url.includes(`/${PEOPLE_SOURCE}/`)) {
      return peopleResponse ?? response([...people]);
    }
    if (url.includes(`/${INTERACTIONS_SOURCE}/`)) {
      return response([...interactions]);
    }
    throw new assert.AssertionError({ message: `Unexpected Notion URL ${url}` });
  });
}

// ---------------------------------------------------------------------------
// AttentionSummaryTests helpers
// ---------------------------------------------------------------------------

async function runSummary(notionPost: NotionPostMock): Promise<[boolean, PostMock, LogMock]> {
  const postDirectMessage: PostMock = mock(async (_message: string) => undefined);
  const log: LogMock = mock((_line: string) => undefined);
  const sent = await sendAttentionSummary(postDirectMessage, notionPost, environment(), {
    today: FIXED_TODAY,
    sleep: mock((_seconds: number) => undefined),
    log,
  });
  return [sent, postDirectMessage, log];
}

async function runFailingSummary(
  notionPost: NotionPostMock,
  env: Record<string, string> | null = null,
): Promise<[string, PostMock, LogMock]> {
  const postDirectMessage: PostMock = mock(async (_message: string) => undefined);
  const log: LogMock = mock((_line: string) => undefined);
  let caught: unknown = null;
  try {
    await sendAttentionSummary(postDirectMessage, notionPost, env ?? environment(), {
      today: FIXED_TODAY,
      sleep: mock((_seconds: number) => undefined),
      log,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AttentionSummaryError, "AttentionSummaryError not raised");
  return [caught.message, postDirectMessage, log];
}

function sentMessage(postDirectMessage: PostMock): string {
  assert.equal(postDirectMessage.calls.length, 1);
  return (postDirectMessage.calls[0] as [string])[0];
}

function logged(log: LogMock): string {
  return log.calls.map((call) => String(call[0])).join("\n");
}

function withoutStatus(page: Page): Page {
  delete page.properties["Status"];
  return page;
}

// ---------------------------------------------------------------------------
// AttentionSummaryTests: composition
// ---------------------------------------------------------------------------

test("test_tasks_only", async () => {
  const [sent, post] = await runSummary(
    routingNotionPost({ tasks: [task("Ship report", "2026-09-27", "High")] }),
  );

  assert.equal(sent, true);
  const message = sentMessage(post);
  assert.ok(message.includes("*Tasks*"));
  assert.ok(
    message.includes(
      "• <https://www.notion.so/ship-report|Ship report> — Priority: High — Overdue: 2026-09-27",
    ),
  );
  assert.ok(!message.includes("*People due*"));
  assert.ok(!message.includes("unavailable"));
});

test("test_people_only", async () => {
  const [sent, post] = await runSummary(
    routingNotionPost({
      people: [person("p1", "Alex"), person("p2", "Blair")],
      interactions: [interaction("2026-08-01", "p1")],
    }),
  );

  assert.equal(sent, true);
  const message = sentMessage(post);
  assert.ok(message.includes("*People due*"));
  assert.ok(message.includes("• Alex — Next contact due: 2026-09-01"));
  assert.ok(message.includes("• Blair — No previous interaction"));
  assert.ok(!message.includes("*Tasks*"));
});

test("test_both_sections", async () => {
  const [sent, post] = await runSummary(
    routingNotionPost({
      tasks: [task("Call bank", "2026-09-30")],
      people: [person("p1", "Alex")],
    }),
  );

  assert.equal(sent, true);
  const message = sentMessage(post);
  assert.ok(message.startsWith("*Attention summary*"));
  assert.ok(message.indexOf("*Tasks*") < message.indexOf("*People due*"));
  assert.ok(message.includes("Follow-up: 2026-09-30"));
  assert.ok(message.includes("• Alex — No previous interaction"));
});

test("test_nothing_needs_attention_posts_nothing", async () => {
  const [sent, post, log] = await runSummary(
    routingNotionPost({
      tasks: [task("Later", "2026-10-06"), task("Done", "2026-09-01", null, "Færdig")],
      people: [person("p1", "Alex")],
      interactions: [interaction("2026-09-10", "p1")],
    }),
  );

  assert.equal(sent, false);
  assert.equal(post.calls.length, 0);
  assert.ok(logged(log).includes("no DM sent"));
});

// ---------------------------------------------------------------------------
// AttentionSummaryTests: truncation and undated count
// ---------------------------------------------------------------------------

test("test_dated_tasks_are_capped_at_five_with_more_hint", async () => {
  const tasks = Array.from({ length: 7 }, (_, index) => task(`Task ${index}`, `2026-09-2${index}`));

  const [, post] = await runSummary(routingNotionPost({ tasks }));

  const message = sentMessage(post);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(message.includes(`|Task ${index}>`));
  }
  assert.ok(!message.includes("|Task 5>"));
  assert.ok(!message.includes("|Task 6>"));
  assert.ok(message.includes("+2 more — run /tasks list"));
});

test("test_exactly_five_dated_tasks_has_no_more_hint", async () => {
  const tasks = Array.from({ length: 5 }, (_, index) => task(`Task ${index}`, `2026-09-2${index}`));

  const [, post] = await runSummary(routingNotionPost({ tasks }));

  assert.ok(!sentMessage(post).includes("more"));
});

test("test_undated_tasks_are_shown_as_a_count_only", async () => {
  const tasks = Array.from({ length: 7 }, (_, index) => task(`Undated ${index}`));
  tasks.push(task("Dated", "2026-09-29"));

  const [, post] = await runSummary(routingNotionPost({ tasks }));

  const message = sentMessage(post);
  assert.ok(message.includes("7 open tasks without follow-up date"));
  assert.ok(message.includes("|Dated>"));
  assert.ok(!message.includes("Undated"));
});

test("test_single_undated_task_uses_singular_noun", async () => {
  const [, post] = await runSummary(routingNotionPost({ tasks: [task("Undated")] }));

  assert.ok(sentMessage(post).includes("1 open task without follow-up date"));
});

test("test_counts_are_not_limited_by_the_tasks_list_display_cap", async () => {
  const pad = (index: number) => String(index).padStart(2, "0");
  const dated = Array.from({ length: 22 }, (_, index) => task(`Dated ${pad(index)}`, "2026-09-29"));
  const undated = Array.from({ length: 4 }, (_, index) => task(`Undated ${pad(index)}`));

  const [, post] = await runSummary(routingNotionPost({ tasks: [...dated, ...undated] }));

  const message = sentMessage(post);
  assert.ok(message.includes("+17 more — run /tasks list"));
  assert.ok(message.includes("4 open tasks without follow-up date"));
});

test("test_due_people_are_capped_at_five_with_more_hint", async () => {
  const people = Array.from({ length: 8 }, (_, index) => person(`p${index}`, `Person ${index}`));

  const [, post] = await runSummary(routingNotionPost({ people }));

  const message = sentMessage(post);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(message.includes(`• Person ${index} —`));
  }
  assert.ok(!message.includes("Person 5"));
  assert.ok(message.includes("+3 more — run /people due"));
});

test("test_people_are_plain_text_without_suggest_buttons", async () => {
  const [, post] = await runSummary(routingNotionPost({ people: [person("p1", "Alex")] }));

  assert.ok(!sentMessage(post).includes("Suggest"));
  // No `blocks` keyword: post_direct_message gets the message alone.
  assert.equal((post.calls[0] as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// AttentionSummaryTests: reuse of existing selection logic
// ---------------------------------------------------------------------------

test("test_task_selection_and_order_match_tasks_list", async () => {
  const pages = [
    task("Low later", "2026-10-02", "Low"),
    task("Too far", "2026-10-06", "High"),
    task("High soon", "2026-10-02", "High"),
    task("Overdue", "2026-09-01"),
    task("Finished", "2026-09-01", null, "Færdig"),
    task("No date"),
  ];
  const [expected] = selectTasksNeedingAttention(pages, FIXED_TODAY);
  const expectedDated = expected.filter((t) => t.followUp !== null).map((t) => t.name);

  const [, post] = await runSummary(routingNotionPost({ tasks: pages }));

  const message = sentMessage(post);
  const positions = expectedDated.map((name) => message.indexOf(`|${name}>`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(expectedDated, ["Overdue", "High soon", "Low later"]);
  assert.ok(!message.includes("Too far"));
  assert.ok(!message.includes("Finished"));
  assert.ok(message.includes("1 open task without follow-up date"));
});

test("test_people_selection_and_order_match_people_due", async () => {
  const people = [person("p1", "A"), person("p2", "B"), person("p3", "C"), person("p4", "Not due")];
  const interactions = [
    interaction("2026-08-01", "p1"),
    interaction("2026-06-01", "p2"),
    interaction("2026-07-01", "p3"),
    interaction("2026-09-20", "p4"),
  ];
  const [expected] = await findDuePeople(
    routingNotionPost({ people, interactions }),
    "secret-token",
    PEOPLE_SOURCE,
    INTERACTIONS_SOURCE,
    FIXED_TODAY,
    mock((_seconds: number) => undefined),
  );

  const [, post] = await runSummary(routingNotionPost({ people, interactions }));

  const message = sentMessage(post);
  const names = expected.map((due) => due.person.name);
  assert.deepEqual(names, ["B", "C", "A"]);
  const positions = names.map((name) => message.indexOf(`• ${name} —`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(positions.every((position) => position >= 0));
  assert.ok(!message.includes("Not due"));
});

// ---------------------------------------------------------------------------
// AttentionSummaryTests: incomplete scans
// ---------------------------------------------------------------------------

test("test_incomplete_task_scan_without_items_is_reported", async () => {
  // has_more without a cursor cannot be claimed complete.
  const [sent, post] = await runSummary(
    routingNotionPost({ tasksResponse: response([task("Later", "2026-10-06")], true) }),
  );

  assert.equal(sent, true);
  const message = sentMessage(post);
  assert.ok(message.includes("*Tasks*\nMore tasks may need attention."));
  assert.ok(!message.includes("Later"));
  assert.ok(!message.includes("*People due*"));
});

test("test_incomplete_people_scan_without_items_is_reported", async () => {
  const [sent, post] = await runSummary(routingNotionPost({ peopleResponse: response([], true) }));

  assert.equal(sent, true);
  const message = sentMessage(post);
  assert.ok(
    message.includes(
      "*People due*\nSome People or Interactions could not be scanned; results may be incomplete.",
    ),
  );
  assert.ok(!message.includes("*Tasks*"));
});

test("test_complete_scans_without_items_send_nothing", async () => {
  const [sent, post] = await runSummary(
    routingNotionPost({
      tasks: [task("Later", "2026-10-06")],
      people: [person("p1", "Alex")],
      interactions: [interaction("2026-09-10", "p1")],
    }),
  );

  assert.equal(sent, false);
  assert.equal(post.calls.length, 0);
});

// ---------------------------------------------------------------------------
// AttentionSummaryTests: skipped malformed rows
// ---------------------------------------------------------------------------

test("test_skipped_malformed_task_is_reported_in_shown_section", async () => {
  const broken = withoutStatus(task("Broken"));

  const [, post] = await runSummary(routingNotionPost({ tasks: [broken, task("Valid", "2026-09-29")] }));

  const message = sentMessage(post);
  assert.ok(message.includes("Skipped 1 malformed task."));
  assert.ok(!message.includes("Broken"));
});

test("test_skipped_malformed_tasks_use_plural", async () => {
  const broken = [0, 1].map((index) => withoutStatus(task(`Broken ${index}`)));

  const [, post] = await runSummary(routingNotionPost({ tasks: [...broken, task("Valid", "2026-09-29")] }));

  assert.ok(sentMessage(post).includes("Skipped 2 malformed tasks."));
});

test("test_skipped_malformed_people_are_reported_in_shown_section", async () => {
  const [, post] = await runSummary(
    routingNotionPost({
      people: [person("p1", "Alex"), person("p2", "Bad one", "weekly"), person("p3", "Bad two", "weekly")],
    }),
  );

  const message = sentMessage(post);
  assert.ok(message.includes("Skipped 2 malformed people."));
  assert.ok(!message.includes("Bad"));
});

test("test_skipped_malformed_person_uses_singular", async () => {
  const [, post] = await runSummary(
    routingNotionPost({ people: [person("p1", "Alex"), person("p2", "Bad", "weekly")] }),
  );

  assert.ok(sentMessage(post).includes("Skipped 1 malformed person."));
});

test("test_skipped_rows_alone_send_nothing", async () => {
  const broken = withoutStatus(task("Broken"));

  const [sent, post] = await runSummary(
    routingNotionPost({ tasks: [broken], people: [person("p1", "Bad", "weekly")] }),
  );

  assert.equal(sent, false);
  assert.equal(post.calls.length, 0);
});

test("test_skipped_count_is_not_shown_for_a_hidden_section", async () => {
  const broken = withoutStatus(task("Broken"));

  const [, post] = await runSummary(routingNotionPost({ tasks: [broken], people: [person("p1", "Alex")] }));

  const message = sentMessage(post);
  assert.ok(!message.includes("*Tasks*"));
  assert.ok(!message.includes("malformed task"));
});

// ---------------------------------------------------------------------------
// AttentionSummaryTests: failure behavior
// ---------------------------------------------------------------------------

test("test_tasks_failure_sends_people_then_fails (S11: degrades to a partial summary, still fails the run)", async () => {
  const [error, post, log] = await runFailingSummary(
    routingNotionPost({ tasksResponse: failingResponse(500), people: [person("p1", "Alex")] }),
  );

  const message = sentMessage(post);
  assert.ok(message.includes("Tasks unavailable right now."));
  assert.ok(message.includes("• Alex — No previous interaction"));
  assert.equal(error, "Tasks unavailable; partial summary sent.");
  assert.ok(logged(log).includes("::error::Tasks unavailable: TaskListCommandError (HTTP 500)"));
});

test("test_people_failure_sends_tasks_then_fails (S11: a Notion 401 fails the run)", async () => {
  const [error, post, log] = await runFailingSummary(
    routingNotionPost({ tasks: [task("Call bank", "2026-09-30")], peopleResponse: failingResponse(401) }),
  );

  const message = sentMessage(post);
  assert.ok(message.includes("People unavailable right now."));
  assert.ok(message.includes("|Call bank>"));
  assert.equal(error, "People unavailable; partial summary sent.");
  assert.ok(logged(log).includes("::error::People unavailable: Notion authentication failed (HTTP 401)."));
});

test("test_one_source_failing_and_other_empty_sends_nothing_and_fails", async () => {
  const [error, post, log] = await runFailingSummary(
    routingNotionPost({ tasksResponse: failingResponse(500) }),
  );

  assert.equal(post.calls.length, 0);
  assert.equal(error, "Tasks unavailable; no summary sent.");
  assert.ok(logged(log).includes("::error::Tasks unavailable"));
});

test("test_both_sources_failing_sends_nothing_and_fails", async () => {
  const [error, post, log] = await runFailingSummary(
    routingNotionPost({ tasksResponse: failingResponse(500), peopleResponse: failingResponse(503) }),
  );

  assert.equal(post.calls.length, 0);
  assert.equal(error, "Tasks and People are both unavailable; no summary sent.");
  const output = logged(log);
  assert.ok(output.includes("::error::Tasks unavailable: TaskListCommandError (HTTP 500)"));
  assert.ok(output.includes("::error::People unavailable: TaskListCommandError (HTTP 503)"));
});

test("test_failure_without_http_status_logs_type_name_only (S7)", async () => {
  // Timeout("https://api.notion.com secret-token"): http.ts's Timeout has a
  // fixed message, so the secret-bearing message is set on the instance.
  const timeout = new Timeout();
  timeout.message = "https://api.notion.com secret-token";
  const timingOut = mock(async (_url: string, _options: PostOptions): Promise<NotionResponse> => {
    throw timeout;
  });
  const malformed = jsonResponse({ results: "private person contents" });

  const notionPost: NotionPostMock = mock(async (url: string, options: PostOptions) => {
    if (url.includes(`/${TASKS_SOURCE}/`)) {
      return timingOut(url, options);
    }
    return malformed;
  });

  const [, , log] = await runFailingSummary(notionPost);

  const output = logged(log);
  const logLines = output.split("\n");
  assert.ok(logLines.includes("::error::Tasks unavailable: TaskListCommandError"));
  assert.ok(logLines.includes("::error::People unavailable: PeopleDueCommandError"));
  assert.ok(!output.includes("HTTP"));
  assert.ok(!output.includes("secret-token"));
  assert.ok(!output.includes("private person contents"));
});

test("test_missing_configuration_is_reported_by_name", async () => {
  const env = environment();
  delete env["NOTION_TASKS_DATA_SOURCE_ID"];

  const [, , log] = await runFailingSummary(routingNotionPost({ people: [person("p1", "Alex")] }), env);

  assert.ok(logged(log).includes("Tasks unavailable: missing configuration NOTION_TASKS_DATA_SOURCE_ID"));
});

test("test_unknown_key_error_is_described_by_type_name_only (S7)", () => {
  assert.equal(describeSourceError(new KeyError("Private task name")), "KeyError");
  assert.equal(describeSourceError(new KeyError("NOTION_API_KEY")), "missing configuration NOTION_API_KEY");
});

test("test_logs_contain_no_private_content_or_secrets (S7)", async () => {
  const [error, , log] = await runFailingSummary(
    routingNotionPost({ tasks: [task("Private task", "2026-09-27")], peopleResponse: failingResponse(503) }),
  );

  const output = `${logged(log)}\n${error}`;
  assert.ok(!output.includes("Private task"));
  assert.ok(!output.includes("notion.so"));
  assert.ok(!output.includes("secret-token"));
});

// ---------------------------------------------------------------------------
// SlackDmPosterTests
// ---------------------------------------------------------------------------

type SlackPostMock = Mock<[string, PostOptions?], Promise<HttpResponse>>;

function slackPostReturning(slackResponse: HttpResponse): SlackPostMock {
  return mock(async (_url: string, _options?: PostOptions) => slackResponse);
}

test("test_posts_to_the_authorized_user_id", async () => {
  const slackPost = slackPostReturning(jsonResponse({ ok: true, ts: "1.2" }));

  await buildSlackDmPoster("xoxb-secret", "U123", slackPost)("hello");

  assert.equal(slackPost.calls.length, 1);
  const [url, options] = slackPost.calls[0] as [string, PostOptions];
  assert.equal(url, "https://slack.com/api/chat.postMessage");
  assert.deepEqual(options.json, { channel: "U123", text: "hello", mrkdwn: true });
});

test("test_slack_api_error_raises_a_safe_message (S7)", async () => {
  const slackPost = slackPostReturning(jsonResponse({ ok: false, error: "invalid_auth" }));

  let caught: unknown = null;
  try {
    await buildSlackDmPoster("xoxb-secret", "U123", slackPost)("private text");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SlackDmDeliveryError);
  assert.match(caught.message, /^Slack DM delivery failed \(invalid_auth\)\.$/);
  assert.ok(!caught.message.includes("xoxb-secret"));
  assert.ok(!caught.message.includes("private text"));
});

test("test_http_error_raises_a_safe_message", async () => {
  const slackPost = slackPostReturning(failingResponse(500));

  await assert.rejects(
    buildSlackDmPoster("xoxb-secret", "U123", slackPost)("hello"),
    (error: unknown) =>
      error instanceof SlackDmDeliveryError && /^Slack DM delivery failed \(HTTP 500\)\.$/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// MainTests: main() turns every failure into an ::error:: line and exit code 1
// ---------------------------------------------------------------------------

/** An http whose `get` must not be called. */
function httpWithPost(post: Http["post"]): Http {
  return {
    post,
    get: async (_url: string, _options?: GetOptions) => {
      throw new assert.AssertionError({ message: "requests.get must not be called" });
    },
  };
}

async function runMain(slackResponse: HttpResponse, tasksResponse: HttpResponse | null = null): Promise<[number, string]> {
  const notionPost = routingNotionPost({
    tasks: [task("Private task", "2026-01-01")],
    tasksResponse,
  });

  const fakePost = async (url: string, options: PostOptions = {}): Promise<HttpResponse> => {
    if (url.startsWith("https://slack.com/")) {
      return slackResponse;
    }
    return (await notionPost(url, options)) as HttpResponse;
  };

  const env = { ...environment(), SLACK_BOT_TOKEN: "xoxb-secret", AUTHORIZED_SLACK_USER_ID: "U123" };
  // redirect_stdout: print's lines are collected.
  let stdout = "";
  const exitCode = await main(env, {
    http: httpWithPost(fakePost),
    log: (line) => {
      stdout += `${line}\n`;
    },
  });
  return [exitCode, stdout];
}

test("test_successful_send_exits_zero", async () => {
  const [exitCode, output] = await runMain(jsonResponse({ ok: true }));

  assert.equal(exitCode, 0);
  assert.ok(output.includes("Attention summary DM sent"));
});

test("test_slack_delivery_failure_is_annotated_and_exits_non_zero (S7)", async () => {
  const [exitCode, output] = await runMain(jsonResponse({ ok: false, error: "channel_not_found" }));

  assert.equal(exitCode, 1);
  assert.ok(output.includes("::error::Slack DM delivery failed (channel_not_found)."));
  assert.ok(!output.includes("Private task"));
  assert.ok(!output.includes("xoxb-secret"));
});

test("test_source_failure_is_annotated_and_exits_non_zero", async () => {
  // 400 is not retried, so no real sleep happens.
  const [exitCode, output] = await runMain(jsonResponse({ ok: true }), failingResponse(400));

  assert.equal(exitCode, 1);
  assert.ok(output.includes("::error::Tasks unavailable: TaskListCommandError (HTTP 400)"));
  assert.ok(output.includes("::error::Tasks unavailable; no summary sent."));
});

// ---------------------------------------------------------------------------
// TS-only: describeSourceError, the Slack poster's error branches, main's
// configuration check
// ---------------------------------------------------------------------------

test("describeSourceError: a NotionAuthenticationError is its message; a command error adds only its cause's HTTP status", () => {
  assert.equal(
    describeSourceError(new NotionAuthenticationError("Notion authentication failed (HTTP 401).")),
    "Notion authentication failed (HTTP 401).",
  );
  const httpCause = new HTTPError(new HttpResponse(502, new Headers(), "private body secret-token"));
  assert.equal(describeSourceError(withPyCause(new TaskListCommandError(), httpCause)), "TaskListCommandError (HTTP 502)");
  // The error's own response is not consulted, only __cause__'s.
  assert.equal(describeSourceError(httpCause), "HTTPError");
  assert.equal(describeSourceError(new TaskListCommandError("secret-token")), "TaskListCommandError");
  assert.equal(describeSourceError(new TypeError("private")), "TypeError");
});

test("buildSlackDmPoster: a transport error is its Python type name; a non-dict or ok-less body is 'unknown'; nothing is chained", async (t) => {
  const cases: Array<[string, () => Promise<HttpResponse>, string]> = [
    ["Timeout", async () => {
      throw new Timeout();
    }, "Slack DM delivery failed (Timeout)."],
    ["invalid JSON", async () => new HttpResponse(200, new Headers(), "not json secret"), "Slack DM delivery failed (JSONDecodeError)."],
    ["a list body", async () => jsonResponse([1]), "Slack DM delivery failed (unknown)."],
    ["ok false without error", async () => jsonResponse({ ok: false }), "Slack DM delivery failed (unknown)."],
    ["ok missing, error empty", async () => jsonResponse({ error: "" }), "Slack DM delivery failed (unknown)."],
    ["HTTP 429 with an ok body", async () => new HttpResponse(429, new Headers(), '{"ok": true}'), "Slack DM delivery failed (HTTP 429)."],
  ];
  for (const [what, slackPost, expected] of cases) {
    await t.test(what, async () => {
      let caught: unknown = null;
      try {
        await buildSlackDmPoster("xoxb-secret", "U123", slackPost)("private text");
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof SlackDmDeliveryError);
      assert.equal(caught.message, expected);
      assert.equal(Object.hasOwn(caught, "pyCause"), false);
      assert.equal(caught.cause, undefined);
    });
  }
});

test("buildSlackDmPoster: the exact request (headers, json, timeout) and the result is Slack's body", async () => {
  const slackPost = slackPostReturning(jsonResponse({ ok: true, ts: "1.2" }));

  const result = await buildSlackDmPoster("xoxb-secret", "U123", slackPost)("hello");

  assert.deepEqual(result, { ok: true, ts: "1.2" });
  assert.deepEqual(slackPost.calls[0]?.[1], {
    headers: { Authorization: "Bearer xoxb-secret", "Content-Type": "application/json" },
    json: { channel: "U123", text: "hello", mrkdwn: true },
    timeout: 10,
  });
});

test("main: a missing or empty SLACK_BOT_TOKEN or AUTHORIZED_SLACK_USER_ID prints the config error and makes no call", async (t) => {
  const environments: Array<[string, Record<string, string>]> = [
    ["empty environment", {}],
    ["no token", { AUTHORIZED_SLACK_USER_ID: "U123" }],
    ["no user", { SLACK_BOT_TOKEN: "xoxb-secret" }],
    ["empty token", { SLACK_BOT_TOKEN: "", AUTHORIZED_SLACK_USER_ID: "U123" }],
    ["empty user", { SLACK_BOT_TOKEN: "xoxb-secret", AUTHORIZED_SLACK_USER_ID: "" }],
  ];
  for (const [what, env] of environments) {
    await t.test(what, async () => {
      const lines: string[] = [];
      const exitCode = await main(
        { ...environment(), ...env },
        {
          http: httpWithPost(async () => {
            throw new assert.AssertionError({ message: "no call expected" });
          }),
          log: (line) => lines.push(line),
        },
      );
      assert.equal(exitCode, 1);
      assert.deepEqual(lines, ["::error::SLACK_BOT_TOKEN and AUTHORIZED_SLACK_USER_ID are required"]);
    });
  }
});

// ---------------------------------------------------------------------------
// TS-only: the top-level error handler (security invariant S7)
// ---------------------------------------------------------------------------

test("S7: uncaughtErrorLine is the name, plus the message only for application error classes", () => {
  const secret = new Error("https://hooks.slack.com/commands/CANARY-RESPONSE-URL secret-token");
  withPyCause(secret, new Error("cause secret-token"));
  assert.equal(uncaughtErrorLine(secret), "Error");
  assert.equal(uncaughtErrorLine(new TypeError("Cannot read properties of private")), "TypeError");
  assert.equal(uncaughtErrorLine(new KeyError("Private task name")), "KeyError");
  assert.equal(uncaughtErrorLine("a thrown string secret-token"), "Error");
  assert.equal(uncaughtErrorLine(null), "Error");
  assert.equal(
    uncaughtErrorLine(new NotionAuthenticationError("Notion authentication failed (HTTP 401).")),
    "NotionAuthenticationError: Notion authentication failed (HTTP 401).",
  );
  assert.equal(
    uncaughtErrorLine(new AttentionSummaryError("Tasks unavailable; no summary sent.")),
    "AttentionSummaryError: Tasks unavailable; no summary sent.",
  );
  assert.equal(
    uncaughtErrorLine(new HTTPError(new HttpResponse(500, new Headers(), "private body"))),
    "HTTPError: HTTP error 500",
  );
  // Always exactly one line, and a name that is not an identifier is not printed.
  assert.equal(uncaughtErrorLine(new TaskListCommandError("a\nb\r\nc")), "TaskListCommandError: a b c");
  const renamed = new Error("x");
  renamed.name = "secret-token in a name";
  assert.equal(uncaughtErrorLine(renamed), "Error");
});

test("S7: runEntryPoint reports an error escaping main as one secret-free stderr line and exit code 1", async () => {
  const secretError = new Error("private Notion data secret-token");
  withPyCause(secretError, new Error("https://api.notion.com secret-token"));
  let stderr = "";
  const exitCode = await runEntryPoint(
    { ...environment(), SLACK_BOT_TOKEN: "xoxb-secret", AUTHORIZED_SLACK_USER_ID: "U123" },
    {
      http: httpWithPost(async (url) => {
        if (url.startsWith("https://slack.com/")) return jsonResponse({ ok: true });
        return response([]);
      }),
      today: FIXED_TODAY,
      // The first print fails: nothing catches it before the top-level handler.
      log: () => {
        throw secretError;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    },
  );
  assert.equal(exitCode, 1);
  assert.equal(stderr, "Error\n");
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

test("entryPointMode: run when import.meta.main is true; on a Node without it (undefined), fail loudly only when the module is the started script", () => {
  const moduleUrl = new URL("../src/attention-summary.ts", import.meta.url).href;
  const other = path.join(REPO_ROOT, "tests", "attention-summary.test.ts");
  assert.equal(entryPointMode(true, ENTRY_POINT, moduleUrl), "run");
  assert.equal(entryPointMode(false, ENTRY_POINT, moduleUrl), "imported");
  assert.equal(entryPointMode(false, other, moduleUrl), "imported");
  // Node < 24.2: import.meta.main is undefined.
  assert.equal(entryPointMode(undefined, ENTRY_POINT, moduleUrl), "unsupported");
  assert.equal(entryPointMode(undefined, path.relative(process.cwd(), ENTRY_POINT), moduleUrl), "unsupported");
  assert.equal(entryPointMode(undefined, other, moduleUrl), "imported");
  assert.equal(entryPointMode(undefined, undefined, moduleUrl), "imported");
  assert.equal(UNSUPPORTED_NODE_MESSAGE, "This entry point requires Node.js >= 24.2 (import.meta.main).");
  assert.ok(!UNSUPPORTED_NODE_MESSAGE.includes("\n"));
});

// A preload for the real process: fetch answers Notion with empty results and
// records nothing reaches anywhere else (no network access).
const FAKE_NOTION_FETCH = `
globalThis.fetch = async (url) => {
  if (!String(url).startsWith("https://api.notion.com/")) throw new Error("unexpected fetch");
  return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
};
`;

const SECRET_ENVIRONMENT = {
  SLACK_BOT_TOKEN: "xoxb-CANARY-SLACK-TOKEN",
  AUTHORIZED_SLACK_USER_ID: "U-AUTH",
  NOTION_API_KEY: "secret_CANARY_NOTION_KEY",
  NOTION_TASKS_DATA_SOURCE_ID: "ds-tasks",
  NOTION_PEOPLE_DATA_SOURCE_ID: "ds-people",
  NOTION_INTERACTIONS_DATA_SOURCE_ID: "ds-interactions",
};

test("entry point: node src/attention-summary.ts with an empty environment prints Python's config error on stdout and exits 1", () => {
  const result = runEntryPointProcess({});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "::error::SLACK_BOT_TOKEN and AUTHORIZED_SLACK_USER_ID are required\n");
  assert.equal(result.stderr, "");
});

test("entry point: node src/attention-summary.ts runs main with process.env and exits 0 when nothing needs attention", () => {
  const result = runEntryPointProcess(SECRET_ENVIRONMENT, FAKE_NOTION_FETCH);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Nothing needs attention; no DM sent\n");
  assert.equal(result.status, 0);
});

test("S7: the real process reports an uncaught error as one secret-free stderr line and exits 1", () => {
  // print fails with an error whose message and cause hold canaries.
  const preload = `${FAKE_NOTION_FETCH}
const secret = new Error("xoxb-CANARY-SLACK-TOKEN CANARY-PRIVATE", { cause: new Error("secret_CANARY_NOTION_KEY") });
process.stdout.write = () => { throw secret; };
`;
  const result = runEntryPointProcess(SECRET_ENVIRONMENT, preload);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Error\n");
  assert.equal(result.stdout, "");
});

test("S7: the real process reports an error outside main's chain as one line and keeps exit code 1", () => {
  // An unhandled rejection fires while main runs; main itself then succeeds.
  const preload = `${FAKE_NOTION_FETCH}
setTimeout(() => { Promise.reject(new TypeError("CANARY-PRIVATE", { cause: new Error("xoxb-CANARY-SLACK-TOKEN") })); }, 0);
`;
  const result = runEntryPointProcess(SECRET_ENVIRONMENT, preload);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "TypeError\n");
  assert.equal(result.stdout, "Nothing needs attention; no DM sent\n");
});

// ---------------------------------------------------------------------------
// TS-only: the workflow cutover (ACCEPTANCE.md G7)
// ---------------------------------------------------------------------------

const WORKFLOW_ENV_NAMES = [
  "SLACK_BOT_TOKEN",
  "AUTHORIZED_SLACK_USER_ID",
  "NOTION_API_KEY",
  "NOTION_TASKS_DATA_SOURCE_ID",
  "NOTION_PEOPLE_DATA_SOURCE_ID",
  "NOTION_INTERACTIONS_DATA_SOURCE_ID",
];

test("G7: attention-summary.yml runs node src/attention-summary.ts on Node 24 with the unchanged triggers and env mapping", () => {
  const text = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "attention-summary.yml"), "utf8");
  const lines = text.split(/\r?\n/);
  const meaningful = lines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

  // Triggers: the Monday/Thursday cron and workflow_dispatch, nothing else.
  const onStart = meaningful.indexOf("on:");
  const jobsStart = meaningful.indexOf("jobs:");
  assert.ok(onStart >= 0 && jobsStart > onStart);
  assert.deepEqual(meaningful.slice(onStart, jobsStart), [
    "on:",
    "  schedule:",
    '    - cron: "0 6 * * 1,4"',
    "  workflow_dispatch:",
  ]);

  // Node 24 via setup-node@v7, the production-only install, the TS entry point.
  const setupNode = meaningful.indexOf("      - uses: actions/setup-node@v7");
  assert.ok(setupNode >= 0, "actions/setup-node@v7");
  assert.deepEqual(meaningful.slice(setupNode + 1, setupNode + 3), ['        with:', '          node-version: "24"']);
  const runs = meaningful.filter((line) => /^\s+run: /.test(line)).map((line) => line.trim());
  assert.deepEqual(runs, ["run: npm ci --omit=dev", "run: node src/attention-summary.ts"]);

  // Exactly the six env mappings of the Python workflow, each to the same-named secret.
  const envLines = meaningful.filter((line) => /^\s+env:\s*$/.test(line));
  assert.equal(envLines.length, 1, "one env: block");
  const envStart = meaningful.indexOf(envLines[0] as string);
  const mappings: Array<[string, string]> = [];
  for (const line of meaningful.slice(envStart + 1)) {
    const match = /^ {10}([A-Z_]+): (.*)$/.exec(line);
    if (match === null) break;
    mappings.push([match[1] as string, match[2] as string]);
  }
  assert.deepEqual(
    mappings,
    WORKFLOW_ENV_NAMES.map((name) => [name, `\${{ secrets.${name} }}`]),
  );
  assert.equal(meaningful[envStart + 1 + mappings.length]?.trim(), "run: node src/attention-summary.ts");

  // No Python left.
  assert.ok(!text.includes("setup-python"));
  assert.ok(!text.includes("requirements.txt"));
  assert.ok(!/\bpython\b/.test(text));
});
