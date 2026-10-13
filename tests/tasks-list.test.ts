// Port of tests/test_tasks_list.py (TasksListCommandTests).
//
// Each test title starts with the Python method name. Python's Mock objects
// become small recording functions (`mock`): `calls` holds the arguments of
// every call, so `assert_called_once_with(...)` is a deepEqual on `calls`.
// Fake Notion responses are real http.ts HttpResponse objects; a non-2xx
// status makes `raise_for_status()` throw the real HTTPError, which carries
// `.response.status_code` and `.response.headers` as requests' HTTPError does.

import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  ChunkedEncodingError,
  ConnectionError,
  HTTPError,
  HttpResponse,
  ReadTimeout,
  Timeout,
  type GetOptions,
  type PostOptions,
} from "../src/http.ts";
import { makeDate, type PlainDate } from "../src/plain-date.ts";
import { KeyError, OverflowError, ValueError, casefold, getPyCause } from "../src/python-compat.ts";
import {
  NotionAuthenticationError,
  TaskListCommandError,
  callNotionWithRetries,
  externalErrorStatusCode,
  handleTasksCommand,
  isRetryableNotionError,
  retryDelay,
  selectTasksNeedingAttention,
  sleepSeconds,
  type NotionResponse,
} from "../src/tasks-list.ts";

const FIXED_TODAY: PlainDate = makeDate(2026, 8, 29);
const NOTION_QUERY_URL = "https://api.notion.com/v1/data_sources/data-source-id/query";

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

// Mock(side_effect=[...]): each call returns the next value, or throws it when
// it is an exception. Running out is an error, as StopIteration is in Python.
function sideEffects<T>(values: readonly (T | Error)[]): () => T {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error("StopIteration: no more side effects");
    const next = queue.shift() as T | Error;
    if (next instanceof Error) throw next;
    return next;
  };
}

/** An HttpResponse that counts `raise_for_status()` calls, like a Mock does. */
class RecordingResponse extends HttpResponse {
  raiseForStatusCalls = 0;

  override raise_for_status(): void {
    this.raiseForStatusCalls += 1;
    super.raise_for_status();
  }
}

function jsonResponse(body: unknown): RecordingResponse {
  return new RecordingResponse(200, new Headers(), JSON.stringify(body === undefined ? null : body));
}

function textResponse(text: string): RecordingResponse {
  return new RecordingResponse(200, new Headers(), text);
}

function errorResponse(statusCode: number, headers: Record<string, string> = {}): RecordingResponse {
  return new RecordingResponse(statusCode, new Headers(headers), "");
}

/** The Python test's NotionHttpError: an exception with a fake response whose headers are a dict. */
class NotionHttpError extends Error {
  readonly response: { status_code: number; headers: Record<string, string> };

  constructor(statusCode: number, headers: Record<string, string> | null = null) {
    super("NotionHttpError");
    this.response = { status_code: statusCode, headers: headers ?? {} };
  }
}

type SlackOptions = { threadTs?: string; blocks?: unknown };
type SlackMock = Mock<[string, SlackOptions?], Promise<Record<string, unknown>>>;
type NotionPostMock = Mock<[string, PostOptions], Promise<NotionResponse>>;
type NotionGetMock = Mock<[string, GetOptions], Promise<NotionResponse>>;
type SleepMock = Mock<[number], void>;

function slackMockAlwaysRoot(): SlackMock {
  // Mock(side_effect=lambda message, thread_ts=None: {"ts": "123.456"})
  return mock(async (_message: string, _options?: SlackOptions) => ({ ts: "123.456" }));
}

function notionPostMock(values: readonly (NotionResponse | Error)[]): NotionPostMock {
  const next = sideEffects(values);
  return mock(async (_url: string, _options: PostOptions) => next());
}

function notionPostReturning(response: NotionResponse): NotionPostMock {
  return mock(async (_url: string, _options: PostOptions) => response);
}

function notionGetMock(values: readonly (NotionResponse | Error)[]): NotionGetMock {
  const next = sideEffects(values);
  return mock(async (_url: string, _options: GetOptions) => next());
}

function sleepMock(): SleepMock {
  return mock((_seconds: number) => undefined);
}

// ---------------------------------------------------------------------------
// Fixtures (the Python test class's helper methods)
// ---------------------------------------------------------------------------

function notionPage(results: unknown[], hasMore = false, nextCursor: string | null = null): Record<string, unknown> {
  return { results, has_more: hasMore, next_cursor: nextCursor };
}

function slug(name: string): string {
  return casefold(name).replaceAll(" ", "-");
}

type TaskFixture = {
  url: string;
  properties: Record<string, Record<string, unknown>>;
};

function task(
  name: string,
  followUp: string | null = null,
  { priority = null, status = "Ikke startet", trackIds = null }: {
    priority?: string | null;
    status?: string;
    trackIds?: string[] | null;
  } = {},
): TaskFixture {
  return {
    url: `https://www.notion.so/${slug(name)}`,
    properties: {
      Navn: {
        id: "title",
        type: "title",
        title: [{ plain_text: name }],
      },
      Status: { type: "status", status: { name: status } },
      Priority: {
        type: "select",
        select: priority ? { name: priority } : null,
      },
      "Follow-up": {
        type: "date",
        date: followUp ? { start: followUp } : null,
      },
      Track: {
        type: "relation",
        relation: (trackIds ?? []).map((trackId) => ({ id: trackId })),
      },
    },
  };
}

function track(name: string, priority: string | null = null): Record<string, unknown> {
  return {
    properties: {
      Navn: {
        type: "title",
        title: name ? [{ plain_text: name }] : [],
      },
      Priority: {
        type: "select",
        select: priority ? { name: priority } : null,
      },
    },
  };
}

function authorizedEnvironment(): Record<string, string> {
  return {
    TASKS_SLACK_CHANNEL_ID: "C-allowed",
    NOTION_API_KEY: "secret-token",
    NOTION_TASKS_DATA_SOURCE_ID: "data-source-id",
  };
}

function notionHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
    "Notion-Version": "2025-09-03",
  };
}

/** Messages posted with a truthy thread_ts, joined by newlines. */
function threadOutput(postSlackMessage: SlackMock): string {
  return postSlackMessage.calls
    .filter(([, options]) => Boolean(options?.threadTs))
    .map(([message]) => message)
    .join("\n");
}

function assertOrderedLinks(output: string, names: string[]): void {
  const positions: number[] = [];
  for (const name of names) {
    const link = `<https://www.notion.so/${slug(name)}|${name}>`;
    assert.ok(output.includes(link), `missing ${link}`);
    positions.push(output.indexOf(link));
  }
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function runList(
  pages: unknown[],
  { text = "list", trackPages = null }: { text?: string; trackPages?: Record<string, unknown> | null } = {},
): Promise<{ notionPost: NotionPostMock; notionGet: NotionGetMock; postSlackMessage: SlackMock }> {
  const responses = pages.map((page) => jsonResponse(page));
  const notionPost = notionPostMock(responses);

  const notionGet: NotionGetMock = mock(async (url: string, _options: GetOptions) => {
    const trackId = url.slice(url.lastIndexOf("/") + 1);
    const value = (trackPages ?? {})[trackId];
    if (value instanceof Error) throw value;
    return jsonResponse(value);
  });

  const postSlackMessage: SlackMock = mock(async (_message: string, options?: SlackOptions) => {
    if (options?.threadTs === undefined) return { ts: "123.456" };
    return {};
  });

  const handled = await handleTasksCommand(
    "/tasks",
    text,
    "C-allowed",
    postSlackMessage,
    notionPost,
    authorizedEnvironment(),
    { today: FIXED_TODAY, notionGet },
  );
  assert.equal(handled, true);
  for (const response of responses) {
    assert.equal(response.raiseForStatusCalls, 1);
  }
  if (trackPages === null) {
    assert.equal(notionGet.calls.length, 0);
  }
  return { notionPost, notionGet, postSlackMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("test_retries_a_rate_limited_query_twice_at_most_and_respects_retry_after", async () => {
  const rateLimited = errorResponse(429, { "Retry-After": "7" });
  const successful = jsonResponse(notionPage([task("Recovered")]));
  const notionPost = notionPostMock([rateLimited, successful]);
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  const handled = await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage, notionPost,
    authorizedEnvironment(), { today: FIXED_TODAY, sleep },
  );

  assert.equal(handled, true);
  assert.equal(notionPost.calls.length, 2);
  assert.deepEqual(sleep.calls, [[7.0]]);
  assert.ok(threadOutput(postSlackMessage).includes("Recovered"));
});

test("test_credential_failure_fails_with_a_safe_notion_specific_message (S11)", async () => {
  const unauthorized = errorResponse(401);
  const notionPost = notionPostReturning(unauthorized);
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  let caught: unknown;
  await assert.rejects(
    handleTasksCommand(
      "/tasks", "list", "C-allowed", postSlackMessage, notionPost,
      authorizedEnvironment(), { today: FIXED_TODAY, sleep },
    ),
    (error: unknown) => {
      caught = error;
      return (
        error instanceof NotionAuthenticationError &&
        /^Notion authentication failed \(HTTP 401\)\.$/.test(error.message)
      );
    },
  );

  assert.equal(notionPost.calls.length, 1);
  assert.equal(sleep.calls.length, 0);
  assert.equal(postSlackMessage.calls.length, 1);
  assert.equal(getPyCause(caught), null);
  assert.ok(!(caught as Error).message.includes("secret-token"));
});

test("test_stops_after_two_retries_for_a_transient_query_failure", async () => {
  const failedResponses = [errorResponse(503), errorResponse(503), errorResponse(503)];
  const notionPost = notionPostMock(failedResponses);
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage, notionPost,
    authorizedEnvironment(), { today: FIXED_TODAY, sleep },
  );

  assert.equal(notionPost.calls.length, 3);
  assert.deepEqual(sleep.calls, [[1], [2]]);
  assert.equal(
    threadOutput(postSlackMessage),
    "Unable to retrieve tasks right now. Please try again later.",
  );
});

test("test_does_not_retry_a_malformed_query_response", async () => {
  const malformed = jsonResponse({ results: "private task contents" });
  const notionPost = notionPostReturning(malformed);
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage, notionPost,
    authorizedEnvironment(), { today: FIXED_TODAY, sleep },
  );

  assert.equal(notionPost.calls.length, 1);
  assert.equal(sleep.calls.length, 0);
  assert.ok(!threadOutput(postSlackMessage).includes("private task contents"));
});

test("test_skips_malformed_tasks_and_reports_the_count", async () => {
  const malformed = task("Broken");
  delete malformed.properties["Status"];

  const { postSlackMessage } = await runList([notionPage([malformed, task("Valid")])]);

  const output = threadOutput(postSlackMessage);
  assert.ok(output.includes("Valid"));
  assert.ok(!output.includes("Broken"));
  assert.ok(output.includes("Skipped 1 malformed task."));
});

test("test_retries_a_transient_track_lookup", async () => {
  const queryResponse = jsonResponse(notionPage([task("Task", null, { trackIds: ["track-id"] })]));
  const trackResponse = jsonResponse(track("Recovered track"));
  const notionGet = notionGetMock([new Timeout(), trackResponse]);
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage,
    notionPostReturning(queryResponse), authorizedEnvironment(),
    { today: FIXED_TODAY, notionGet, sleep },
  );

  assert.equal(notionGet.calls.length, 2);
  assert.deepEqual(sleep.calls, [[1]]);
  assert.ok(threadOutput(postSlackMessage).includes("Recovered track"));
});

test("test_recovers_from_a_connection_error_and_a_server_error", async () => {
  const connectionRecovery = jsonResponse(notionPage([task("Connected")]));
  const connectionPost = notionPostMock([new ConnectionError(), connectionRecovery]);
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage, connectionPost,
    authorizedEnvironment(), { today: FIXED_TODAY, sleep },
  );

  assert.equal(connectionPost.calls.length, 2);
  assert.deepEqual(sleep.calls, [[1]]);
  assert.ok(threadOutput(postSlackMessage).includes("Connected"));

  const serverError = errorResponse(503);
  const serverRecovery = jsonResponse(notionPage([task("Recovered")]));
  const serverPost = notionPostMock([serverError, serverRecovery]);
  const serverSleep = sleepMock();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage, serverPost,
    authorizedEnvironment(), { today: FIXED_TODAY, sleep: serverSleep },
  );

  assert.equal(serverPost.calls.length, 2);
  assert.deepEqual(serverSleep.calls, [[1]]);
});

test("test_invalid_retry_after_values_use_backoff", () => {
  assert.equal(retryDelay(new NotionHttpError(429), 0), 1);
  assert.equal(retryDelay(new NotionHttpError(429, { "Retry-After": "nope" }), 0), 1);
  assert.equal(retryDelay(new NotionHttpError(429, { "Retry-After": "NaN" }), 1), 2);
  assert.equal(
    retryDelay(new NotionHttpError(429, { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }), 1),
    0,
  );
});

test("test_malformed_query_json_is_not_retried", async () => {
  // malformed.json.side_effect = ValueError("not JSON"): HttpResponse.json()
  // throws JSONDecodeError, which is a ValueError.
  const malformed = textResponse("not JSON");
  const notionPost = notionPostReturning(malformed);
  const postSlackMessage = slackMockAlwaysRoot();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage, notionPost,
    authorizedEnvironment(), { today: FIXED_TODAY, sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 1);
  assert.equal(
    threadOutput(postSlackMessage),
    "Unable to retrieve tasks right now. Please try again later.",
  );
});

test("test_unexpected_task_parsing_error_is_not_reported_as_malformed", () => {
  // Python patches tasks_list.task_from_notion_page to raise AssertionError.
  // ES module bindings cannot be patched, so the page itself raises an
  // AssertionError the moment the parser reads it.
  const page = task("Task") as unknown as Record<string, unknown>;
  Object.defineProperty(page, "properties", {
    enumerable: true,
    get() {
      throw new assert.AssertionError({ message: "unexpected" });
    },
  });

  assert.throws(() => selectTasksNeedingAttention([page], FIXED_TODAY), assert.AssertionError);
});

test("test_terminal_track_permission_failure_is_isolated", async () => {
  const queryResponse = jsonResponse(notionPage([task("Task", null, { trackIds: ["forbidden"] })]));
  const forbidden = errorResponse(403);
  const postSlackMessage = slackMockAlwaysRoot();

  await handleTasksCommand(
    "/tasks", "list", "C-allowed", postSlackMessage,
    notionPostReturning(queryResponse), authorizedEnvironment(),
    {
      today: FIXED_TODAY,
      notionGet: mock(async (_url: string, _options: GetOptions) => forbidden),
      sleep: sleepMock(),
    },
  );

  assert.ok(threadOutput(postSlackMessage).includes("Track unavailable"));
});

test("test_other_commands_are_not_owned", async () => {
  const notionPost = notionPostMock([]);
  const postSlackMessage = slackMockAlwaysRoot();

  const handled = await handleTasksCommand(
    "/testbot", "hello", "C-channel", postSlackMessage, notionPost, {},
  );

  assert.equal(handled, false);
  assert.equal(notionPost.calls.length, 0);
  assert.equal(postSlackMessage.calls.length, 0);
});

test("test_invalid_task_commands_return_usage_without_accessing_notion", async (t) => {
  for (const text of ["", "   ", "show", "list extra"]) {
    await t.test(`text=${JSON.stringify(text)}`, async () => {
      const notionPost = notionPostMock([]);
      const postSlackMessage = slackMockAlwaysRoot();

      const handled = await handleTasksCommand(
        "/tasks", text, "C-channel", postSlackMessage, notionPost, {},
      );

      assert.equal(handled, true);
      assert.equal(notionPost.calls.length, 0);
      assert.deepEqual(postSlackMessage.calls, [["Usage: /tasks list"]]);
    });
  }
});

test("test_lists_eligible_tasks_in_date_priority_and_name_order", async () => {
  const pages = [
    notionPage([
      task("Finished", "2026-08-20", { status: "Færdig" }),
      task("Too far away", "2026-09-06"),
      task("Same date high beta", "2026-09-01", { priority: "High" }),
      task("Undated no priority"),
      task("Today high", "2026-08-29", { priority: "High" }),
      task("Same date medium", "2026-09-01", { priority: "Medium" }),
      task("Overdue low", "2026-08-28", { priority: "Low" }),
      task("Same date high alpha", "2026-09-01", { priority: "High" }),
      task("Undated high", null, { priority: "High" }),
      task("Seven days away", "2026-09-05", { priority: "Low" }),
    ]),
  ];

  const { notionPost, postSlackMessage } = await runList(pages);

  assert.deepEqual(notionPost.calls, [
    [
      NOTION_QUERY_URL,
      {
        headers: notionHeaders(),
        json: {
          filter: {
            property: "Status",
            status: { does_not_equal: "Færdig" },
          },
          page_size: 100,
        },
        timeout: 10,
      },
    ],
  ]);
  const output = threadOutput(postSlackMessage);
  assertOrderedLinks(output, [
    "Overdue low",
    "Today high",
    "Same date high alpha",
    "Same date high beta",
    "Same date medium",
    "Seven days away",
    "Undated high",
    "Undated no priority",
  ]);
  assert.ok(!output.includes("Finished"));
  assert.ok(!output.includes("Too far away"));
});

test("test_empty_result_uses_the_specified_message", async () => {
  const { postSlackMessage } = await runList([notionPage([task("Later", "2026-09-06")])]);

  assert.equal(threadOutput(postSlackMessage), "No tasks need attention right now.");
});

test("test_renders_no_more_than_twenty_eligible_tasks (S10: 20 displayed)", async () => {
  const tasks = [];
  for (let number = 1; number < 22; number += 1) {
    tasks.push(task(`Task ${String(number).padStart(2, "0")}`));
  }
  const { postSlackMessage } = await runList([notionPage(tasks)]);

  const output = threadOutput(postSlackMessage);
  assert.equal(countOf(output, "https://www.notion.so/"), 20);
  assert.ok(output.includes("Task 20"));
  assert.ok(!output.includes("Task 21"));
});

test("test_stops_after_five_pages_and_avoids_a_false_empty_claim (S10: 500 scanned)", async () => {
  const pages = [];
  for (let page = 1; page < 6; page += 1) {
    const results = [];
    for (let item = 0; item < 100; item += 1) {
      results.push(task(`Later ${page}-${item}`, "2026-09-06"));
    }
    pages.push(notionPage(results, true, `cursor-${page + 1}`));
  }

  const { notionPost, postSlackMessage } = await runList(pages);

  assert.equal(notionPost.calls.length, 5);
  const expectedQueries: Record<string, unknown>[] = [
    {
      filter: {
        property: "Status",
        status: { does_not_equal: "Færdig" },
      },
      page_size: 100,
    },
  ];
  for (let page = 2; page < 6; page += 1) {
    expectedQueries.push({
      filter: {
        property: "Status",
        status: { does_not_equal: "Færdig" },
      },
      page_size: 100,
      start_cursor: `cursor-${page}`,
    });
  }
  assert.deepEqual(
    notionPost.calls.map(([, options]) => options.json),
    expectedQueries,
  );
  const output = casefold(threadOutput(postSlackMessage));
  assert.ok(output.includes("more tasks may need attention"));
  assert.ok(!output.includes("no tasks need attention right now"));
  // Python's \d and \s are Unicode-aware; the u flag with \p{Nd} keeps the
  // digit class as wide, and the output contains no non-ASCII whitespace.
  assert.doesNotMatch(output, /\b\p{Nd}+\s+more\b/u);
});

test("test_normalized_list_commands_use_the_task_path", async (t) => {
  for (const text of ["list", "LIST", " list", "list ", "  LiSt  "]) {
    await t.test(`text=${JSON.stringify(text)}`, async () => {
      const { notionPost, postSlackMessage } = await runList(
        [notionPage([task("Known task")])],
        { text },
      );
      assert.equal(notionPost.calls.length, 1);
      assert.ok(threadOutput(postSlackMessage).includes("Known task"));
    });
  }
});

test("test_renders_zero_one_and_exactly_three_tracks", async () => {
  const trackPages = {
    high: track("Alpha", "High"),
    medium: track("Middle", "Medium"),
    low: track("Lowly", "Low"),
  };
  const { notionGet, postSlackMessage } = await runList(
    [
      notionPage([
        task("No relation"),
        task("One relation", null, { trackIds: ["medium"] }),
        task("Exactly three", null, { trackIds: ["low", "medium", "high"] }),
      ]),
    ],
    { trackPages },
  );

  const output = threadOutput(postSlackMessage);
  assert.ok(output.includes("Track: No track"));
  assert.ok(output.includes("Track: Middle"));
  assert.ok(output.includes("Track: Alpha, Middle, Lowly"));
  assert.ok(!output.includes("+1 more"));
  assert.equal(notionGet.calls.length, 3);
});

test("test_truncates_after_ordering_and_reports_the_remainder", async () => {
  const trackPages = {
    none: track("Unprioritized"),
    low: track("Lowly", "Low"),
    "high-zulu": track("Zulu", "High"),
    medium: track("Middle", "Medium"),
    "high-alpha": track("Alpha", "High"),
  };
  const { notionGet, postSlackMessage } = await runList(
    [
      notionPage([
        task("Many relations", null, {
          trackIds: ["none", "low", "high-zulu", "medium", "high-alpha"],
        }),
      ]),
    ],
    { trackPages },
  );

  const output = threadOutput(postSlackMessage);
  assert.ok(output.includes("Track: Alpha, Zulu, Middle, +2 more"));
  assert.ok(!output.includes("Lowly"));
  assert.ok(!output.includes("Unprioritized"));
  assert.equal(notionGet.calls.length, 5);
});

test("test_unavailable_tracks_count_toward_the_cap_and_remainder", async () => {
  const trackPages = {
    high: track("Alpha", "High"),
    medium: track("Middle", "Medium"),
    "failed-one": new Error("Notion lookup failed"),
    "failed-two": new Error("Notion lookup failed"),
  };
  const { postSlackMessage } = await runList(
    [
      notionPage([
        task("Partial failure", null, {
          trackIds: ["failed-one", "medium", "high", "failed-two"],
        }),
      ]),
    ],
    { trackPages },
  );

  const output = threadOutput(postSlackMessage);
  assert.ok(output.includes("Track: Alpha, Middle, Track unavailable, +1 more"));
  assert.equal(countOf(output, "Track unavailable"), 1);
});

test("test_reuses_track_lookups_and_keeps_tasks_when_a_track_is_unavailable", async () => {
  const trackPages = {
    shared: track("Shared", "Medium"),
    "missing-name": {
      properties: {
        "Other title": {
          type: "title",
          title: [{ plain_text: "Wrong title" }],
        },
      },
    },
    failed: new Error("Notion lookup failed"),
  };
  const { notionGet, postSlackMessage } = await runList(
    [
      notionPage([
        task("First", null, { trackIds: ["shared", "failed"] }),
        task("Second", null, { trackIds: ["shared", "missing-name"] }),
      ]),
    ],
    { trackPages },
  );

  const output = threadOutput(postSlackMessage);
  assert.ok(output.includes("Track: Shared, Track unavailable"));
  assert.equal(countOf(output, "Shared"), 2);
  assert.equal(countOf(output, "Track unavailable"), 2);
  const requestedUrls = notionGet.calls.map(([url]) => url);
  assert.equal(
    requestedUrls.filter((url) => url === "https://api.notion.com/v1/pages/shared").length,
    1,
  );
  assert.equal(notionGet.calls.length, 3);
});

test("test_only_displayed_tasks_trigger_track_resolution", async () => {
  const tasks = [];
  const trackPages: Record<string, unknown> = {};
  for (let number = 1; number < 22; number += 1) {
    const padded = String(number).padStart(2, "0");
    tasks.push(task(`Task ${padded}`, null, { trackIds: [`track-${padded}`] }));
    trackPages[`track-${padded}`] = track(`Track ${padded}`, "Low");
  }

  const { notionGet } = await runList([notionPage(tasks)], { trackPages });

  assert.equal(notionGet.calls.length, 20);
  const requestedUrls = new Set(notionGet.calls.map(([url]) => url));
  assert.ok(!requestedUrls.has("https://api.notion.com/v1/pages/track-21"));
});

// ---------------------------------------------------------------------------
// Additional TS-only tests (no Python counterpart). They pin Python behavior
// that later slices and the security invariants rely on.
// ---------------------------------------------------------------------------

test("S11: a 401 on a Track lookup fails the run without a cause", async () => {
  const queryResponse = jsonResponse(notionPage([task("Task", null, { trackIds: ["track-id"] })]));
  const postSlackMessage = slackMockAlwaysRoot();
  const sleep = sleepMock();

  let caught: unknown;
  await assert.rejects(
    handleTasksCommand(
      "/tasks", "list", "C-allowed", postSlackMessage,
      notionPostReturning(queryResponse), authorizedEnvironment(),
      { today: FIXED_TODAY, notionGet: notionGetMock([errorResponse(401)]), sleep },
    ),
    (error: unknown) => {
      caught = error;
      return error instanceof NotionAuthenticationError &&
        error.message === "Notion authentication failed (HTTP 401).";
    },
  );
  assert.equal(getPyCause(caught), null);
  assert.equal(sleep.calls.length, 0);
  assert.equal(postSlackMessage.calls.length, 1);
});

test("TD2: a Follow-up with a time is parsed with date.fromisoformat and skipped as malformed", async () => {
  const { postSlackMessage } = await runList([
    notionPage([task("Timed", "2026-08-29T09:00:00.000+02:00"), task("Dated", "2026-08-29")]),
  ]);

  const output = threadOutput(postSlackMessage);
  assert.ok(!output.includes("Timed"));
  assert.ok(output.includes("<https://www.notion.so/dated|Dated> — Priority: No priority — Track: No track — Follow-up: today"));
  assert.ok(output.includes("Skipped 1 malformed task."));
});

test("callNotionWithRetries: the final TaskListCommandError carries the request error as its cause", async () => {
  const responses = [errorResponse(503), errorResponse(503), errorResponse(503)];
  const next = sideEffects(responses);
  const sleep = sleepMock();

  let caught: unknown;
  await assert.rejects(callNotionWithRetries(async () => next(), sleep), (error: unknown) => {
    caught = error;
    return error instanceof TaskListCommandError && error.message === "";
  });
  assert.ok(getPyCause(caught) instanceof HTTPError);
  assert.equal(externalErrorStatusCode(getPyCause(caught)), 503);
  assert.equal((caught as Error).cause, undefined);
  assert.ok(!inspect(caught, { depth: 10 }).includes("503"));
  assert.deepEqual(sleep.calls, [[1], [2]]);
});

test("callNotionWithRetries: is_retryable narrows retries and 403 is a credential failure by default", async () => {
  const sleep = sleepMock();
  const notRetried = sideEffects([errorResponse(503)]);
  await assert.rejects(
    callNotionWithRetries(async () => notRetried(), sleep, {
      isRetryable: (error) => externalErrorStatusCode(error) === 429,
    }),
    TaskListCommandError,
  );
  assert.equal(sleep.calls.length, 0);

  const forbidden = sideEffects([errorResponse(403)]);
  await assert.rejects(
    callNotionWithRetries(async () => forbidden(), sleep),
    (error: unknown) =>
      error instanceof NotionAuthenticationError && error.message === "Notion authentication failed (HTTP 403).",
  );
});

test("isRetryableNotionError matches the requests classification", () => {
  assert.equal(isRetryableNotionError(new ReadTimeout()), true);
  assert.equal(isRetryableNotionError(new ConnectionError()), true);
  assert.equal(isRetryableNotionError(new ChunkedEncodingError()), false);
  assert.equal(isRetryableNotionError(new HTTPError(errorResponse(429))), true);
  assert.equal(isRetryableNotionError(new HTTPError(errorResponse(500))), true);
  assert.equal(isRetryableNotionError(new HTTPError(errorResponse(400))), false);
  assert.equal(isRetryableNotionError(new Error("other")), false);
  assert.equal(externalErrorStatusCode(null), null);
  assert.equal(externalErrorStatusCode(new Error("no response")), null);
});

test("retryDelay reads Retry-After case-insensitively from an HttpResponse and honors a future HTTP-date", () => {
  assert.equal(retryDelay(new HTTPError(errorResponse(429, { "retry-after": "1_0" })), 0), 10);
  assert.equal(retryDelay(new HTTPError(errorResponse(429, { "Retry-After": "-1" })), 1), 2);
  const delay = retryDelay(new HTTPError(errorResponse(429, { "Retry-After": "Fri, 01 Jan 2100 00:00:00 GMT" })), 0);
  assert.ok(delay > 0);
});

test("a missing NOTION_API_KEY raises KeyError after the root message, as environment[...] does", async () => {
  const notionPost = notionPostMock([]);
  const postSlackMessage = slackMockAlwaysRoot();

  await assert.rejects(
    handleTasksCommand("/tasks", "list", "C-allowed", postSlackMessage, notionPost, {}, { today: FIXED_TODAY }),
    (error: unknown) => error instanceof KeyError && error.key === "NOTION_API_KEY",
  );
  assert.deepEqual(postSlackMessage.calls, [["/tasks list"]]);
  assert.equal(notionPost.calls.length, 0);
});

test("sleepSeconds raises what Python 3.12's time.sleep raises, at once", async (t) => {
  // Values and messages observed with py -3.12 (see sleepSeconds).
  const overflow = (error: unknown): boolean =>
    error instanceof OverflowError && error.message === "timestamp out of range for platform time_t";
  for (const seconds of [9223372036.854776, 1e20, Infinity, -Infinity, -9223372036.854778, -1e20]) {
    await assert.rejects(sleepSeconds(seconds), overflow, String(seconds));
  }
  await assert.rejects(
    sleepSeconds(NaN),
    (error: unknown) => error instanceof ValueError && error.message === "Invalid value NaN (not a number)",
  );
  const negative = (error: unknown): boolean =>
    error instanceof ValueError && error.message === "sleep length must be non-negative";
  for (const seconds of [-1, -1e-10, -9223372036.854776]) {
    await assert.rejects(sleepSeconds(seconds), negative, String(seconds));
  }

  t.mock.timers.enable({ apis: ["setTimeout"] });
  // -0.0 and 0 return without waiting for a timer.
  for (const seconds of [-0, 0]) {
    await sleepSeconds(seconds);
  }
  // A sub-nanosecond value is not an error (Python rounds it up to 1 ns).
  const tiny = sleepSeconds(1e-12);
  t.mock.timers.tick(1);
  await tiny;
  // A short sleep waits for its timer.
  let shortDone = false;
  const short = sleepSeconds(0.25).then(() => {
    shortDone = true;
  });
  t.mock.timers.tick(249);
  await Promise.resolve();
  assert.equal(shortDone, false);
  t.mock.timers.tick(1);
  await short;
  assert.equal(shortDone, true);
  // The largest value that CPython accepts sleeps (in setTimeout-sized steps)
  // instead of raising. The mocked timer never fires, so it stays pending.
  let settled = false;
  void sleepSeconds(9223372036.854774).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  t.mock.timers.tick(2_147_483_647);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(settled, false);
});
