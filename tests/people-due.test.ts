// Port of tests/test_people_due.py (PeopleDueTests, PeopleDueListTests,
// PeopleDueSuggestButtonTests, PeopleDueRobustnessTests).
//
// Conventions as in tasks-list.test.ts: each test title starts with the Python
// method name; Mock objects become recording functions whose `calls` list holds
// each call's arguments, and Python's keyword arguments are the TS options
// object (`call.kwargs["json"]` is `calls[i][1].json`). Fake Notion responses
// are real http.ts HttpResponse objects; `Mock().raise_for_status.side_effect =
// NotionHttpError(status, headers)` becomes a response with that status and
// headers, whose raise_for_status() throws the real HTTPError.
//
// Two Python tests drive the real suggest path
// (test_clicking_the_button_reuses_the_existing_suggest_command_route and
// test_notion_get_is_threaded_through_to_suggest_for_track_resolution); they
// were deferred from S3 and ported in S5 with the real people-suggest.ts.

import assert from "node:assert/strict";
import test from "node:test";

import { HttpResponse, type GetOptions, type PostOptions } from "../src/http.ts";
import {
  CadenceStatus,
  INCOMPLETE_SCAN_MESSAGE,
  MAX_DISPLAYED_PEOPLE,
  NO_DUE_PERSON_MESSAGE,
  PEOPLE_FAILURE_MESSAGE,
  PEOPLE_SUGGEST_ACTION_ID,
  PeopleDueCommandError,
  addCalendarMonths,
  buildDuePeopleBlocks,
  duePersonBlock,
  evaluateCadence,
  fetchNotionPages,
  findDuePeople,
  findOneDuePerson,
  formatDuePeople,
  formatDuePerson,
  handlePeopleCommand,
  parseNotionDate,
  personFromNotionPage,
  type DuePerson,
  type Person,
} from "../src/people-due.ts";
import { makeDate, type PlainDate } from "../src/plain-date.ts";
import { ValueError, getPyCause } from "../src/python-compat.ts";
import { NotionAuthenticationError, type NotionResponse } from "../src/tasks-list.ts";

const FIXED_TODAY: PlainDate = makeDate(2026, 9, 20);
const PEOPLE_URL = "https://api.notion.com/v1/data_sources/people-id/query";
const INTERACTIONS_URL = "https://api.notion.com/v1/data_sources/interactions-id/query";

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

type SlackOptions = { threadTs?: string; blocks?: unknown };
type SlackMock = Mock<[string, SlackOptions?], Promise<Record<string, unknown>>>;
type NotionPostMock = Mock<[string, PostOptions], Promise<NotionResponse>>;
type SleepMock = Mock<[number], void>;

function notionPostMock(values: readonly (NotionResponse | Error)[]): NotionPostMock {
  const next = sideEffects(values);
  return mock(async (_url: string, _options: PostOptions) => next());
}

function notionPostReturning(response: NotionResponse): NotionPostMock {
  return mock(async (_url: string, _options: PostOptions) => response);
}

function slackMock(): SlackMock {
  // Mock(side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"})
  return mock(async (_message: string, _options?: SlackOptions) => ({ ts: "123.456" }));
}

function sleepMock(): SleepMock {
  return mock((_seconds: number) => undefined);
}

/** `call_args_list[-1]`: [message, options]. */
function lastCall(postSlackMessage: SlackMock): [string, SlackOptions?] {
  const call = postSlackMessage.calls.at(-1);
  assert.ok(call, "post_slack_message was not called");
  return call;
}

/** `call_args_list[-1].args[0]`. */
function lastMessage(postSlackMessage: SlackMock): string {
  return lastCall(postSlackMessage)[0];
}

function postedJson(notionPost: NotionPostMock, index: number): Record<string, any> {
  return (notionPost.calls[index] as [string, PostOptions])[1].json as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Fixtures (the Python test classes' helper methods; identical in each class)
// ---------------------------------------------------------------------------

function environment(): Record<string, string> {
  return {
    NOTION_API_KEY: "secret-token",
    NOTION_PEOPLE_DATA_SOURCE_ID: "people-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };
}

function response(results: unknown): HttpResponse {
  return new HttpResponse(200, new Headers(), JSON.stringify({ results }));
}

function pagedResponse(results: unknown[], hasMore = false, nextCursor: string | null = null): HttpResponse {
  return new HttpResponse(
    200,
    new Headers(),
    JSON.stringify({ results, has_more: hasMore, next_cursor: nextCursor }),
  );
}

function errorResponse(statusCode: number, headers: Record<string, string> = {}): HttpResponse {
  return new HttpResponse(statusCode, new Headers(headers), "");
}

type Page = { id: string; properties: Record<string, unknown> };

function person(pageId: string, name: string, cadence: string | null, linkedin: string | null = null): Page {
  return {
    id: pageId,
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: name }],
      },
      "Contact cadence": {
        type: "select",
        select: cadence ? { name: cadence } : null,
      },
      ...(linkedin !== null ? { LinkedIn: { type: "url", url: linkedin } } : {}),
    },
  };
}

function malformedPerson(pageId: string): Page {
  return {
    id: pageId,
    properties: {
      "Contact cadence": {
        type: "select",
        select: { name: "1 month" },
      },
      // "Name" is missing entirely.
    },
  };
}

function interaction(interactionDate: string | null, personIds: readonly string[] = ["p1"]): Record<string, unknown> {
  return {
    properties: {
      Date: {
        type: "date",
        date: interactionDate !== null ? { start: interactionDate } : null,
      },
      People: {
        type: "relation",
        relation: personIds.map((personId) => ({ id: personId })),
      },
    },
  };
}

function makePerson(pageId: string, name: string, cadence: string, linkedinUrl: string | null = null): Person {
  return { pageId, name, cadence, linkedinUrl };
}

function makeDuePerson(
  personValue: Person,
  latestInteraction: PlainDate | null,
  nextContactDue: PlainDate | null,
): DuePerson {
  return { person: personValue, latestInteraction, nextContactDue };
}

/** PeopleDueListTests.due_person(name, latest_interaction=None, next_contact_due=None). */
function listDuePerson(
  name: string,
  latestInteraction: PlainDate | null = null,
  nextContactDue: PlainDate | null = null,
): DuePerson {
  return makeDuePerson(makePerson(name, name, "1 month"), latestInteraction, nextContactDue);
}

/** PeopleDueSuggestButtonTests.due_person(name, cadence, latest_interaction=None, ...). */
function buttonDuePerson(
  name: string,
  cadence: string,
  {
    latestInteraction = null,
    nextContactDue = null,
    linkedinUrl = null,
  }: { latestInteraction?: PlainDate | null; nextContactDue?: PlainDate | null; linkedinUrl?: string | null } = {},
): DuePerson {
  return makeDuePerson(makePerson("p1", name, cadence, linkedinUrl), latestInteraction, nextContactDue);
}

function findDue(notionPost: NotionPostMock): Promise<DuePerson | null> {
  return findOneDuePerson(notionPost, "secret-token", "people-id", "interactions-id", FIXED_TODAY, sleepMock());
}

function callFindDuePeople(notionPost: NotionPostMock): Promise<[DuePerson[], boolean, number]> {
  return findDuePeople(notionPost, "secret-token", "people-id", "interactions-id", FIXED_TODAY, sleepMock());
}

async function runDue(notionPost: NotionPostMock, sleep: SleepMock = sleepMock()): Promise<SlackMock> {
  const postSlackMessage = slackMock();
  await handlePeopleCommand("/people", "due", postSlackMessage, notionPost, environment(), {
    today: FIXED_TODAY,
    sleep,
  });
  return postSlackMessage;
}

function names(duePeople: readonly DuePerson[]): string[] {
  return duePeople.map((duePerson) => duePerson.person.name);
}

// ---------------------------------------------------------------------------
// PeopleDueTests
// ---------------------------------------------------------------------------

test("test_each_supported_cadence_uses_calendar_months", async (t) => {
  const cases: Record<string, PlainDate> = {
    "1 month": makeDate(2026, 2, 15),
    "2 months": makeDate(2026, 3, 15),
    "3 months": makeDate(2026, 4, 15),
    "6 months": makeDate(2026, 7, 15),
    "12 months": makeDate(2027, 1, 15),
  };

  for (const [cadence, expectedDueDate] of Object.entries(cases)) {
    await t.test(`cadence=${cadence}`, () => {
      const result = evaluateCadence(cadence, ["2026-01-15"], makeDate(2026, 1, 15));

      assert.equal(result.nextDueDate, expectedDueDate);
      assert.equal(result.status, CadenceStatus.NOT_DUE);
    });
  }
});

test("test_no_valid_previous_interaction_is_due", () => {
  const result = evaluateCadence("1 month", [], FIXED_TODAY);

  assert.equal(result.status, CadenceStatus.DUE_WITH_NO_PREVIOUS_INTERACTION);
  assert.equal(result.isDue, true);
  assert.equal(result.latestInteractionDate, null);
  assert.equal(result.nextDueDate, null);
});

test("test_missing_invalid_and_future_interaction_dates_are_ignored", () => {
  const result = evaluateCadence("1 month", [null, "not-a-date", "2026-13-40", "2026-10-01"], FIXED_TODAY);

  assert.equal(result.status, CadenceStatus.DUE_WITH_NO_PREVIOUS_INTERACTION);
  assert.equal(result.latestInteractionDate, null);
});

test("test_latest_valid_interaction_wins", () => {
  const result = evaluateCadence(
    "2 months",
    ["2026-01-10", "2026-06-15", "2027-01-01", "invalid"],
    FIXED_TODAY,
  );

  assert.equal(result.latestInteractionDate, makeDate(2026, 6, 15));
  assert.equal(result.nextDueDate, makeDate(2026, 8, 15));
  assert.equal(result.status, CadenceStatus.OVERDUE);
});

test("test_due_exactly_today", () => {
  const result = evaluateCadence("1 month", ["2026-08-20"], FIXED_TODAY);

  assert.equal(result.status, CadenceStatus.DUE_TODAY);
  assert.equal(result.isDue, true);
});

test("test_one_day_before_due_is_not_due", () => {
  const result = evaluateCadence("1 month", ["2026-08-21"], FIXED_TODAY);

  assert.equal(result.nextDueDate, makeDate(2026, 9, 21));
  assert.equal(result.status, CadenceStatus.NOT_DUE);
  assert.equal(result.isDue, false);
});

test("test_past_due_date_is_overdue", () => {
  const result = evaluateCadence("1 month", ["2026-08-19"], FIXED_TODAY);

  assert.equal(result.status, CadenceStatus.OVERDUE);
  assert.equal(result.isDue, true);
});

test("test_month_end_and_leap_year_arithmetic", async (t) => {
  const cases: [PlainDate, number, PlainDate][] = [
    [makeDate(2024, 1, 31), 1, makeDate(2024, 2, 29)],
    [makeDate(2024, 2, 29), 12, makeDate(2025, 2, 28)],
  ];

  for (const [value, months, expected] of cases) {
    await t.test(`value=${value}, months=${months}`, () => {
      assert.equal(addCalendarMonths(value, months), expected);
    });
  }
});

test("test_people_without_cadence_are_ignored_defensively", async () => {
  const notionPost = notionPostReturning(response([person("p1", "Alex", null)]));

  const result = await findDue(notionPost);

  assert.equal(result, null);
  assert.equal(notionPost.calls.length, 1);
});

test("test_person_with_cadence_and_no_interaction_is_due", async () => {
  const notionPost = notionPostMock([response([person("p1", "Alex", "1 month")]), response([])]);

  const result = await findDue(notionPost);

  assert.ok(result);
  assert.equal(result.person.name, "Alex");
  assert.equal(result.latestInteraction, null);
  assert.equal(result.nextContactDue, null);
});

test("test_latest_valid_interaction_is_used", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "2 months")]),
    response([interaction("2026-01-10"), interaction("2026-06-15"), interaction(null)]),
  ]);

  const result = await findDue(notionPost);

  assert.ok(result);
  assert.equal(result.latestInteraction, makeDate(2026, 6, 15));
  assert.equal(result.nextContactDue, makeDate(2026, 8, 15));
});

test("test_future_interaction_is_ignored", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month")]),
    response([interaction("2027-01-01"), interaction("2026-08-20")]),
  ]);

  const result = await findDue(notionPost);

  assert.ok(result);
  assert.equal(result.latestInteraction, makeDate(2026, 8, 20));
  assert.equal(result.nextContactDue, FIXED_TODAY);
});

test("test_stops_after_the_first_due_person", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month"), person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const result = await findDue(notionPost);

  assert.ok(result);
  assert.equal(result.person.name, "Alex");
  assert.equal(notionPost.calls.length, 2);
});

test("test_not_due_person_is_skipped_and_empty_result_is_deterministic", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "3 months")]),
    response([interaction("2026-08-20")]),
  ]);
  const postSlackMessage = slackMock();

  const handled = await handlePeopleCommand("/people", "due", postSlackMessage, notionPost, environment(), {
    today: FIXED_TODAY,
    sleep: sleepMock(),
  });

  assert.equal(handled, true);
  assert.equal(lastMessage(postSlackMessage), NO_DUE_PERSON_MESSAGE);
});

test("test_output_includes_required_fields_and_queries_are_read_only", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Private name", "6 months")]),
    response([interaction("2026-02-28")]),
  ]);

  const postSlackMessage = await runDue(notionPost);

  const output = lastMessage(postSlackMessage);
  assert.ok(output.includes("Private name"));
  assert.ok(output.includes("Contact cadence: 6 months"));
  assert.ok(output.includes("Latest interaction: 2026-02-28"));
  assert.ok(output.includes("Next contact due: 2026-08-28"));
  assert.deepEqual(
    notionPost.calls.map(([url]) => url),
    [PEOPLE_URL, INTERACTIONS_URL],
  );
  assert.ok(notionPost.calls.every(([url]) => url.endsWith("/query")));
  const interactionQuery = postedJson(notionPost, 1);
  assert.equal(interactionQuery["page_size"], 100);
  assert.deepEqual(interactionQuery["sorts"], [{ property: "Date", direction: "descending" }]);
});

test("test_no_interaction_output_says_so_without_a_due_date", async () => {
  const notionPost = notionPostMock([response([person("p1", "Alex", "12 months")]), response([])]);

  const postSlackMessage = await runDue(notionPost);

  const output = lastMessage(postSlackMessage);
  assert.ok(output.includes("Latest interaction: No previous interaction"));
  assert.ok(!output.includes("Next contact due:"));
});

test("test_calendar_month_addition_clamps_month_end", () => {
  assert.equal(addCalendarMonths(makeDate(2026, 1, 31), 1), makeDate(2026, 2, 28));
});

test("test_unknown_cadence_is_skipped_without_being_interpreted", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "weekly"), person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const result = await findDue(notionPost);

  assert.ok(result);
  assert.equal(result.person.name, "Blair");
  assert.equal(notionPost.calls.length, 2);
  const interactionFilter = postedJson(notionPost, 1)["filter"];
  assert.equal(interactionFilter["and"][0]["relation"]["contains"], "p2");
});

// ---------------------------------------------------------------------------
// PeopleDueListTests
// ---------------------------------------------------------------------------

test("test_multiple_due_people_are_returned", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month"), person("p2", "Blair", "1 month")]),
    response([interaction("2026-06-01", ["p1"]), interaction("2026-08-01", ["p2"])]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Alex", "Blair"]);
});

test("test_people_not_due_are_excluded", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month"), person("p2", "Blair", "1 month")]),
    response([
      // Alex's next contact isn't due until 2026-10-01.
      interaction("2026-09-01", ["p1"]),
      // Blair's next contact was due 2026-07-01.
      interaction("2026-06-01", ["p2"]),
    ]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Blair"]);
});

test("test_ordering_places_most_overdue_first", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "A", "1 month"), person("p2", "B", "1 month"), person("p3", "C", "1 month")]),
    response([
      interaction("2026-08-01", ["p1"]), // due 09-01
      interaction("2026-06-01", ["p2"]), // due 07-01
      interaction("2026-07-01", ["p3"]), // due 08-01
    ]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["B", "C", "A"]);
});

test("test_no_previous_interaction_people_are_ordered_after_dated_overdue", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Aaron", "1 month"), person("p2", "Zack", "1 month")]),
    response([
      // Only Zack has an Interaction; Aaron has none.
      interaction("2026-06-01", ["p2"]),
    ]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Zack", "Aaron"]);
  assert.equal(duePeople[1]?.nextContactDue, null);
});

test("test_name_is_a_stable_tiebreaker_within_each_group", async () => {
  const notionPost = notionPostMock([
    response([
      person("p1", "Zoe", "1 month"),
      person("p2", "Amy", "1 month"),
      person("p3", "Zed", "1 month"),
      person("p4", "Ann", "1 month"),
    ]),
    response([
      // Zoe and Amy share the same next contact due date.
      interaction("2026-06-01", ["p1"]),
      interaction("2026-06-01", ["p2"]),
      // Zed and Ann have no Interaction (no-interaction group).
    ]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Amy", "Zoe", "Ann", "Zed"]);
});

test("test_person_without_cadence_is_excluded_from_bulk_evaluation", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "NoCadence", null), person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Blair"]);
  assert.equal(notionPost.calls.length, 2);
});

test("test_no_due_people_produces_the_deterministic_empty_state", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month"), person("p2", "Blair", "1 month")]),
    response([interaction("2026-09-10", ["p1"]), interaction("2026-09-15", ["p2"])]),
  ]);

  const postSlackMessage = await runDue(notionPost);

  assert.equal(lastMessage(postSlackMessage), NO_DUE_PERSON_MESSAGE);
});

test("test_reads_are_query_only_and_bounded_to_two_notion_calls", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month"), person("p2", "Blair", "1 month")]),
    response([interaction("2026-06-01", ["p1"]), interaction("2026-08-01", ["p2"])]),
  ]);

  await callFindDuePeople(notionPost);

  assert.equal(notionPost.calls.length, 2);
  assert.ok(notionPost.calls.every(([url]) => url.endsWith("/query")));
});

test("test_person_with_linkedin_url_is_rendered_as_a_clickable_link", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month", "https://www.linkedin.com/in/alex")]),
    response([]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);
  const message = formatDuePeople(duePeople);

  assert.ok(message.includes("<https://www.linkedin.com/in/alex|Alex>"));
  assert.ok(message.includes("Contact cadence: 1 month"));
});

test("test_person_without_linkedin_url_is_rendered_as_plain_text", async () => {
  const notionPost = notionPostMock([response([person("p1", "Alex", "1 month")]), response([])]);

  const [duePeople] = await callFindDuePeople(notionPost);
  const message = formatDuePeople(duePeople);

  assert.ok(message.includes("*Alex*"));
  assert.ok(!message.includes("<"));
});

test("test_mixed_linkedin_and_no_linkedin_people_render_independently", async () => {
  const notionPost = notionPostMock([
    response([
      person("p1", "Alex", "1 month", "https://www.linkedin.com/in/alex"),
      person("p2", "Blair", "1 month"),
    ]),
    response([]),
  ]);

  const [duePeople] = await callFindDuePeople(notionPost);
  const message = formatDuePeople(duePeople);

  assert.ok(message.includes("<https://www.linkedin.com/in/alex|Alex>"));
  assert.ok(message.includes("*Blair*"));
  assert.ok(!message.includes("<Blair"));
});

test("test_result_count_is_bounded_and_shows_a_remainder_indicator (S10: 20 displayed)", () => {
  const duePeople = Array.from({ length: 25 }, (_, index) => listDuePerson(`Person${String(index).padStart(2, "0")}`));

  const message = formatDuePeople(duePeople);

  const blocks = message.split("\n\n");
  assert.equal(blocks.length, MAX_DISPLAYED_PEOPLE + 1);
  assert.equal(blocks.at(-1), "+5 more");
  assert.ok(message.includes("Person00"));
  assert.ok(!message.includes("Person24"));
});

test("test_result_within_the_limit_has_no_remainder_indicator", () => {
  const duePeople = Array.from({ length: 3 }, (_, index) => listDuePerson(`Person${String(index).padStart(2, "0")}`));

  const message = formatDuePeople(duePeople);

  assert.ok(!message.includes("more"));
});

test("test_people_pagination_collects_every_page_when_complete", async () => {
  const notionPost = notionPostMock([
    pagedResponse([person("p1", "Alex", "1 month")], true, "cursor-2"),
    pagedResponse([person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const [duePeople, isIncomplete] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Alex", "Blair"]);
  assert.equal(isIncomplete, false);
  assert.equal(notionPost.calls.length, 3);
  assert.equal(postedJson(notionPost, 1)["start_cursor"], "cursor-2");
});

test("test_people_scan_reaching_the_bound_marks_the_result_incomplete (S10: 500 scanned)", async () => {
  const peoplePages = [1, 2, 3, 4, 5].map((page) =>
    pagedResponse([person(`p${page}`, `Person${page}`, "1 month")], true, `cursor-${page + 1}`),
  );
  const notionPost = notionPostMock([...peoplePages, response([])]);

  const [duePeople, isIncomplete] = await callFindDuePeople(notionPost);

  // All 5 scanned People had no Interaction within the bound, so all are
  // (possibly incorrectly) evaluated as due; isIncomplete tells the caller not
  // to trust this as a complete or reliable result.
  assert.equal(duePeople.length, 5);
  assert.equal(isIncomplete, true);
  assert.equal(notionPost.calls.length, 6);
});

test("test_missing_next_cursor_marks_incomplete_without_looping_forever", async () => {
  const notionPost = notionPostMock([
    pagedResponse([person("p1", "Alex", "1 month")], true, null),
    response([]),
  ]);

  const [, isIncomplete] = await callFindDuePeople(notionPost);

  assert.equal(isIncomplete, true);
  assert.equal(notionPost.calls.length, 2);
});

test("test_interaction_scan_bound_flags_incomplete_instead_of_mislabeling (S10: 500 scanned)", async () => {
  const interactionPages = [1, 2, 3, 4, 5].map((page) =>
    pagedResponse([interaction(`2026-0${page}-01`, ["someone-else"])], true, `cursor-${page + 1}`),
  );
  const notionPost = notionPostMock([response([person("p1", "Alex", "1 month")]), ...interactionPages]);

  const [duePeople, isIncomplete] = await callFindDuePeople(notionPost);

  // Alex's real Interaction, if any, was never reached by the bounded scan
  // (every scanned page belonged to another Person), so Alex is shown due with
  // no previous Interaction. isIncomplete flags that this cannot be trusted as
  // a confirmed "no previous interaction".
  assert.deepEqual(names(duePeople), ["Alex"]);
  assert.equal(duePeople[0]?.latestInteraction, null);
  assert.equal(isIncomplete, true);
  assert.equal(notionPost.calls.length, 6);
});

test("test_incomplete_scan_appends_a_disclaimer_after_the_due_list", async () => {
  const peoplePages = [1, 2, 3, 4, 5].map((page) =>
    pagedResponse([person(`p${page}`, `Person${page}`, "1 month")], true, `cursor-${page + 1}`),
  );
  const notionPost = notionPostMock([...peoplePages, response([])]);

  const postSlackMessage = await runDue(notionPost);

  const output = lastMessage(postSlackMessage);
  assert.ok(output.includes("Person1"));
  assert.ok(output.includes(INCOMPLETE_SCAN_MESSAGE));
});

test("test_incomplete_scan_replaces_the_empty_state_message", async () => {
  const notionPost = notionPostMock([
    pagedResponse([person("p1", "Alex", "1 month")], true, null),
    // Alex's next contact isn't due until 2026-10-01.
    response([interaction("2026-09-01", ["p1"])]),
  ]);

  const postSlackMessage = await runDue(notionPost);

  assert.equal(lastMessage(postSlackMessage), INCOMPLETE_SCAN_MESSAGE);
});

// ---------------------------------------------------------------------------
// PeopleDueSuggestButtonTests
// ---------------------------------------------------------------------------

test("test_due_person_block_has_a_suggest_button_with_the_person_name", () => {
  const duePerson = buttonDuePerson("Jane Doe", "1 month");

  const block = duePersonBlock(duePerson);

  assert.equal(block.type, "section");
  assert.ok(block.text.text.includes("*Jane Doe*"));
  assert.deepEqual(block.accessory, {
    type: "button",
    text: { type: "plain_text", text: "Suggest message" },
    action_id: PEOPLE_SUGGEST_ACTION_ID,
    value: "Jane Doe",
  });
});

test("test_button_value_is_the_exact_person_name_not_the_linkedin_label", () => {
  const personValue = makePerson("p1", "Jane Doe", "1 month", "https://www.linkedin.com/in/janedoe");
  const duePerson = makeDuePerson(personValue, null, null);

  const block = duePersonBlock(duePerson);

  assert.equal(block.accessory?.value, "Jane Doe");
  assert.ok(block.text.text.includes("<https://www.linkedin.com/in/janedoe|Jane Doe>"));
});

test("test_blocks_and_linkedin_link_render_independently_for_mixed_people", () => {
  const withLinkedin = makeDuePerson(
    makePerson("p1", "Alex", "1 month", "https://www.linkedin.com/in/alex"),
    null,
    null,
  );
  const withoutLinkedin = makeDuePerson(makePerson("p2", "Blair", "1 month"), null, null);

  const blocks = buildDuePeopleBlocks([withLinkedin, withoutLinkedin]);

  assert.ok(blocks[0]?.text.text.includes("<https://www.linkedin.com/in/alex|Alex>"));
  assert.equal(blocks[0]?.accessory?.value, "Alex");
  assert.ok(blocks[1]?.text.text.includes("*Blair*"));
  assert.equal(blocks[1]?.accessory?.value, "Blair");
});

test("test_cadence_and_interaction_fields_are_preserved_in_the_block_text", () => {
  const duePerson = buttonDuePerson("Alex", "6 months", {
    latestInteraction: makeDate(2026, 2, 28),
    nextContactDue: makeDate(2026, 8, 28),
  });

  const block = duePersonBlock(duePerson);
  const text = block.text.text;

  assert.ok(text.includes("*Alex*"));
  assert.ok(text.includes("Contact cadence: 6 months"));
  assert.ok(text.includes("Latest interaction: 2026-02-28"));
  assert.ok(text.includes("Next contact due: 2026-08-28"));
  assert.equal(text, formatDuePerson(duePerson));
});

test("test_build_due_people_blocks_bounds_to_the_display_limit_with_a_remainder_block (S10: 20 displayed)", () => {
  const duePeople = Array.from({ length: MAX_DISPLAYED_PEOPLE + 3 }, (_, index) =>
    buttonDuePerson(`Person ${index}`, "1 month"),
  );

  const blocks = buildDuePeopleBlocks(duePeople);

  assert.equal(blocks.length, MAX_DISPLAYED_PEOPLE + 1);
  assert.deepEqual(blocks.at(-1), { type: "section", text: { type: "mrkdwn", text: "+3 more" } });
  assert.ok(!Object.hasOwn(blocks.at(-1) as object, "accessory"));
});

test("test_handle_people_due_passes_blocks_with_buttons_to_post_slack_message", async () => {
  const notionPost = notionPostMock([response([person("p1", "Jane Doe", "1 month")]), response([])]);

  const postSlackMessage = await runDue(notionPost);

  const [, finalOptions] = lastCall(postSlackMessage);
  const blocks = finalOptions?.blocks as Array<Record<string, any>>;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.["accessory"]["value"], "Jane Doe");
  assert.equal(blocks[0]?.["accessory"]["action_id"], PEOPLE_SUGGEST_ACTION_ID);
});

test("test_handle_people_due_passes_no_blocks_when_no_people_are_due", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month")]),
    response([interaction("2026-09-10")]),
  ]);

  const postSlackMessage = await runDue(notionPost);

  const [finalMessage, finalOptions] = lastCall(postSlackMessage);
  assert.equal(finalMessage, NO_DUE_PERSON_MESSAGE);
  // final_call.kwargs["blocks"] is None: the keyword is passed, with None.
  assert.ok(finalOptions && Object.hasOwn(finalOptions, "blocks"));
  assert.equal(finalOptions.blocks, null);
});

type NotionGetMock = Mock<[string, GetOptions], Promise<NotionResponse>>;

/** PeopleDueSuggestButtonTests.type_schema_response() */
function typeSchemaResponse(): HttpResponse {
  return new HttpResponse(
    200,
    new Headers(),
    JSON.stringify({
      properties: {
        Type: {
          type: "select",
          select: { options: [{ name: "Coffee" }] },
        },
      },
    }),
  );
}

test("test_clicking_the_button_reuses_the_existing_suggest_command_route", async () => {
  // The button's synthesized command must reach the suggest path:
  // api/slack-request.js turns a button click into command="/people",
  // text=`suggest ${value}`, and that is handled by the same
  // handlePeopleCommand / handlePeopleSuggest route as a typed
  // `/people suggest <person>` command, with no duplicated logic.
  const duePerson = buttonDuePerson("Jane Doe", "1 month");
  const button = duePersonBlock(duePerson).accessory as { value: string };
  const [command, text] = ["/people", `suggest ${button.value}`];

  const notionPost = notionPostMock([response([person("p1", "Jane Doe", "1 month")]), response([])]);
  const postSlackMessage = slackMock();
  const generateText = mock(async (_prompt: string) => "Hey Jane, been a while!");
  const notionGet: NotionGetMock = mock(async (_url: string, _options: GetOptions) => typeSchemaResponse());

  const handled = await handlePeopleCommand(command, text, postSlackMessage, notionPost, environment(), {
    generateText,
    today: FIXED_TODAY,
    sleep: sleepMock(),
    notionGet,
  });

  assert.equal(handled, true);
  // One Gemini call drafts the recap, another drafts the message.
  assert.equal(generateText.calls.length, 2);
  const output = lastMessage(postSlackMessage);
  assert.equal(
    output,
    "Context:\nHey Jane, been a while!\n\n" + "Suggested message for Jane Doe:\n\nHey Jane, been a while!",
  );
});

test("test_notion_get_is_threaded_through_to_suggest_for_track_resolution", async () => {
  const personPage = person("p1", "Jane Doe", "1 month");
  personPage.properties["Track Goal"] = {
    type: "relation",
    relation: [{ id: "track-1" }],
  };
  const notionPost = notionPostMock([response([personPage]), response([])]);
  const postSlackMessage = slackMock();
  const generateText = mock(async (_prompt: string) => "Draft");
  const trackResponse = new HttpResponse(
    200,
    new Headers(),
    JSON.stringify({
      properties: {
        Navn: { type: "title", title: [{ plain_text: "AI Network" }] },
      },
    }),
  );
  const typeSchemaUrl = "https://api.notion.com/v1/data_sources/interactions-id";
  const notionGet: NotionGetMock = mock(async (url: string, _options: GetOptions) =>
    url === typeSchemaUrl ? typeSchemaResponse() : trackResponse,
  );

  await handlePeopleCommand("/people", "suggest Jane Doe", postSlackMessage, notionPost, environment(), {
    generateText,
    today: FIXED_TODAY,
    sleep: sleepMock(),
    notionGet,
  });

  // One GET for the Track name, one for the unrelated Add Interaction
  // Type-schema fetch.
  const trackCalls = notionGet.calls.filter((call) => call[0] === "https://api.notion.com/v1/pages/track-1");
  assert.equal(trackCalls.length, 1);
});

// ---------------------------------------------------------------------------
// PeopleDueRobustnessTests
// ---------------------------------------------------------------------------

test("test_malformed_person_record_does_not_block_other_people", async () => {
  const notionPost = notionPostMock([
    response([malformedPerson("p1"), person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const [duePeople, isIncomplete, skippedPersonCount] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Blair"]);
  assert.equal(skippedPersonCount, 1);
  assert.equal(isIncomplete, false);
});

test("test_invalid_cadence_is_skipped_without_being_interpreted", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Weekly Alex", "weekly"), person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const [duePeople, , skippedPersonCount] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Blair"]);
  assert.equal(skippedPersonCount, 1);
});

test("test_malformed_linkedin_property_falls_back_to_no_link_without_skipping", async (t) => {
  const malformedVariants: unknown[] = [
    { type: "rich_text", rich_text: [] }, // wrong property type
    { type: "url", url: null }, // empty Notion URL field
    { type: "url", url: "" }, // empty string
    "not-a-dict",
  ];
  for (const linkedinProperty of malformedVariants) {
    await t.test(`linkedin_property=${JSON.stringify(linkedinProperty)}`, () => {
      const page = {
        id: "p1",
        properties: {
          Name: {
            type: "title",
            title: [{ plain_text: "Alex" }],
          },
          "Contact cadence": {
            type: "select",
            select: { name: "1 month" },
          },
          LinkedIn: linkedinProperty,
        },
      };

      const personValue = personFromNotionPage(page);

      assert.notEqual(personValue, null);
      assert.equal(personValue?.linkedinUrl, null);
    });
  }
});

test("test_malformed_interaction_record_does_not_block_valid_people", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month")]),
    response([
      {}, // entirely malformed Interaction page
      interaction("2026-09-01", ["p1"]),
    ]),
  ]);

  const [duePeople, isIncomplete] = await callFindDuePeople(notionPost);

  // Alex's real Interaction on 2026-09-01 makes the next contact due
  // 2026-10-01, so Alex is correctly not due yet. If the malformed record had
  // crashed or corrupted the scan, this would fail.
  assert.deepEqual(duePeople, []);
  assert.equal(isIncomplete, false);
});

test("test_missing_and_invalid_interaction_dates_do_not_crash_the_scan", async () => {
  const notionPost = notionPostMock([
    response([person("p1", "Alex", "1 month")]),
    response([
      {}, // missing "properties" entirely
      interaction(null, ["p1"]), // missing Date value
      {
        properties: {
          Date: { type: "rich_text" },
          People: {
            type: "relation",
            relation: [{ id: "p1" }],
          },
        },
      }, // Date has the wrong property type
    ]),
  ]);

  const [duePeople, isIncomplete] = await callFindDuePeople(notionPost);

  assert.deepEqual(names(duePeople), ["Alex"]);
  assert.equal(duePeople[0]?.latestInteraction, null);
  assert.equal(isIncomplete, false);
});

test("test_malformed_person_is_skipped_and_reported_with_a_count", async () => {
  const notionPost = notionPostMock([
    response([malformedPerson("p1"), person("p2", "Blair", "1 month")]),
    response([]),
  ]);

  const postSlackMessage = await runDue(notionPost);

  const output = lastMessage(postSlackMessage);
  assert.ok(output.includes("Blair"));
  assert.ok(output.includes("Skipped 1 malformed person."));
});

test("test_transient_notion_failure_recovers_via_shared_retry", async () => {
  const peopleResponse = response([person("p1", "Alex", "1 month")]);
  const rateLimited = errorResponse(429, { "Retry-After": "2" });
  const interactionsResponse = response([]);
  const notionPost = notionPostMock([peopleResponse, rateLimited, interactionsResponse]);
  const sleep = sleepMock();

  const [duePeople, isIncomplete] = await findDuePeople(
    notionPost, "secret-token", "people-id", "interactions-id", FIXED_TODAY, sleep,
  );

  assert.equal(notionPost.calls.length, 3);
  assert.deepEqual(sleep.calls, [[2.0]]);
  assert.deepEqual(names(duePeople), ["Alex"]);
  assert.equal(isIncomplete, false);
});

test("test_notion_auth_failure_is_not_retried_and_propagates_uncaught (S11)", async () => {
  const unauthorized = errorResponse(401);
  const notionPost = notionPostReturning(unauthorized);
  const postSlackMessage = slackMock();
  const sleep = sleepMock();

  await assert.rejects(
    handlePeopleCommand("/people", "due", postSlackMessage, notionPost, environment(), {
      today: FIXED_TODAY,
      sleep,
    }),
    NotionAuthenticationError,
  );

  assert.equal(notionPost.calls.length, 1);
  assert.equal(sleep.calls.length, 0);
  // Only the root "/people due" message was posted before the unretryable
  // failure propagated, matching /tasks convention.
  assert.equal(postSlackMessage.calls.length, 1);
});

test("test_exhausted_transient_failure_produces_a_safe_generic_message", async () => {
  const failing = errorResponse(503);
  const notionPost = notionPostReturning(failing);
  const sleep = sleepMock();

  const postSlackMessage = await runDue(notionPost, sleep);

  const output = lastMessage(postSlackMessage);
  assert.equal(output, PEOPLE_FAILURE_MESSAGE);
  assert.ok(!output.includes("secret-token"));
  assert.equal(notionPost.calls.length, 3);
});

test("test_malformed_query_response_produces_a_safe_message_without_raw_payload", async () => {
  const malformed = response("not-a-list-of-people");
  const notionPost = notionPostReturning(malformed);

  const postSlackMessage = await runDue(notionPost);

  const output = lastMessage(postSlackMessage);
  assert.equal(output, PEOPLE_FAILURE_MESSAGE);
  assert.ok(!output.includes("not-a-list-of-people"));
});

// ---------------------------------------------------------------------------
// TS-only tests (no Python counterpart)
// ---------------------------------------------------------------------------

test("handlePeopleCommand: suggest <person> dispatches to the lazily imported people-suggest module", async () => {
  // The branch reaches handlePeopleSuggest with the stripped name (the
  // keyword's case and the whitespace before the name are dropped; the
  // name's own inner spacing is kept), and nothing touches Notion first.
  const notionPost = notionPostReturning(response([]));
  const postSlackMessage = slackMock();

  const handled = await handlePeopleCommand("/people", "  Suggest   Jane  Doe ", postSlackMessage, notionPost, environment(), {
    today: FIXED_TODAY,
    sleep: sleepMock(),
  });

  assert.equal(handled, true);
  assert.deepEqual(postSlackMessage.calls, [
    ["/people suggest Jane  Doe"],
    ['No Person found matching "Jane  Doe".', { threadTs: "123.456" }],
  ]);
  assert.deepEqual(
    notionPost.calls.map((call) => call[0]),
    [PEOPLE_URL],
  );
});

test("handlePeopleCommand: other commands are not owned; invalid text gets the usage response", async (t) => {
  const notionPost = notionPostMock([]);
  const postSlackMessage = slackMock();
  assert.equal(await handlePeopleCommand("/tasks", "due", postSlackMessage, notionPost, environment()), false);
  assert.equal(postSlackMessage.calls.length, 0);

  // "suggest" with no name, or with no whitespace before the name, is not a
  // suggest command.
  for (const text of ["", "   ", "list", "due now", "suggest", "suggest   ", "suggestJane"]) {
    await t.test(`text=${JSON.stringify(text)}`, async () => {
      const usagePost = slackMock();
      const handled = await handlePeopleCommand("/people", text, usagePost, notionPost, environment());

      assert.equal(handled, true);
      assert.deepEqual(usagePost.calls, [["Usage: /people due | /people suggest <person>"]]);
    });
  }
  assert.equal(notionPost.calls.length, 0);

  const ephemeral = mock(async (_message: string) => undefined);
  const channelPost = slackMock();
  await handlePeopleCommand("/people", "nope", channelPost, notionPost, environment(), {
    postEphemeralResponse: ephemeral,
  });
  assert.deepEqual(ephemeral.calls, [["Usage: /people due | /people suggest <person>"]]);
  assert.equal(channelPost.calls.length, 0);
});

test("S6: /people due never calls generateText", async () => {
  const notionPost = notionPostMock([response([person("p1", "Jane Doe", "1 month")]), response([])]);
  const generateText = mock(async (_prompt: string) => "should not be used");

  await handlePeopleCommand("/people", "DUE", slackMock(), notionPost, environment(), {
    generateText,
    today: FIXED_TODAY,
    sleep: sleepMock(),
  });

  assert.equal(generateText.calls.length, 0);
  assert.equal(notionPost.calls.length, 2);
});

test("handlePeopleDue: the incomplete and skipped notes are added to the text and the blocks", async () => {
  const peoplePages = [1, 2, 3, 4, 5].map((page) =>
    pagedResponse(
      page === 1 ? [malformedPerson("bad"), person("p1", "Person1", "1 month")] : [person(`p${page}`, `Person${page}`, "1 month")],
      true,
      `cursor-${page + 1}`,
    ),
  );
  const notionPost = notionPostMock([...peoplePages, response([])]);

  const postSlackMessage = await runDue(notionPost);

  const [message, options] = lastCall(postSlackMessage);
  assert.equal(options?.threadTs, "123.456");
  assert.ok(message.endsWith(`\n\n${INCOMPLETE_SCAN_MESSAGE}\n\nSkipped 1 malformed person.`));
  const blocks = options?.blocks as Array<Record<string, any>>;
  assert.equal(blocks.length, 7);
  assert.deepEqual(blocks.slice(-2), [
    { type: "section", text: { type: "mrkdwn", text: INCOMPLETE_SCAN_MESSAGE } },
    { type: "section", text: { type: "mrkdwn", text: "Skipped 1 malformed person." } },
  ]);

  // With no one due, the skipped note goes in the text only (blocks stay None).
  const emptyPost = await runDue(
    notionPostMock([response([malformedPerson("a"), malformedPerson("b")]), response([])]),
  );
  const [emptyMessage, emptyOptions] = lastCall(emptyPost);
  assert.equal(emptyMessage, `${NO_DUE_PERSON_MESSAGE}\n\nSkipped 2 malformed people.`);
  assert.equal(emptyOptions?.blocks, null);
});

test("fetchNotionPages: a malformed response is a PeopleDueCommandError caused by the parse error, not retried", async (t) => {
  for (const [label, body] of [
    ["not JSON", "not JSON"],
    ["a list body", "[]"],
    ["no results", "{}"],
    ["results not a list", '{"results": {"a": 1}}'],
  ] as const) {
    await t.test(label, async () => {
      const notionPost = notionPostReturning(new HttpResponse(200, new Headers(), body));
      const sleep = sleepMock();
      let caught: unknown;
      await assert.rejects(
        fetchNotionPages(notionPost, "secret-token", "people-id", () => ({}), 500, 100, sleep),
        (error: unknown) => {
          caught = error;
          return error instanceof PeopleDueCommandError;
        },
      );
      assert.notEqual(getPyCause(caught), null);
      assert.equal(notionPost.calls.length, 1);
      assert.equal(sleep.calls.length, 0);
    });
  }
});

test("fetchNotionPages: passes each cursor to buildRequestJson and stops at maxScanned // pageSize pages", async () => {
  const notionPost = notionPostMock([
    pagedResponse([1], true, "c2"),
    pagedResponse([2], true, "c3"),
    pagedResponse([3], true, "c4"),
  ]);
  const cursors: unknown[] = [];

  const [pages, isIncomplete] = await fetchNotionPages(
    notionPost,
    "secret-token",
    "people-id",
    (cursor) => {
      cursors.push(cursor);
      return { cursor };
    },
    250,
    100,
    sleepMock(),
  );

  assert.deepEqual(pages, [1, 2]);
  assert.equal(isIncomplete, true);
  assert.deepEqual(cursors, [null, "c2"]);
  assert.deepEqual(notionPost.calls[0], [
    PEOPLE_URL,
    {
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "Notion-Version": "2025-09-03",
      },
      json: { cursor: null },
      timeout: 10,
    },
  ]);
});

test("parseNotionDate: a datetime keeps the date written in its own offset (quirk 1)", () => {
  assert.equal(parseNotionDate("2026-09-20"), makeDate(2026, 9, 20));
  assert.equal(parseNotionDate("2026-09-20T23:30:00-02:00"), makeDate(2026, 9, 20));
  assert.equal(parseNotionDate("2026-09-20T23:30:00Z"), makeDate(2026, 9, 20));
  for (const value of [null, "", 20260920, "2026-09-20T25:00:00"]) {
    assert.throws(() => parseNotionDate(value), ValueError);
  }
  // A datetime Interaction counts, and is compared by that date.
  const result = evaluateCadence("1 month", ["2026-08-20T23:59:00.000+02:00"], FIXED_TODAY);
  assert.equal(result.status, CadenceStatus.DUE_TODAY);
});

test("findDuePeople: Python dict-key semantics for Person ids", async () => {
  // An unhashable page id or relation id raises TypeError, uncaught, as
  // dict.get / dict.setdefault do in Python.
  const listId = { ...person("p1", "Alex", "1 month"), id: ["p1"] };
  await assert.rejects(callFindDuePeople(notionPostMock([response([listId]), response([])])), TypeError);
  const listRelation = {
    properties: {
      Date: { type: "date", date: { start: "2026-09-01" } },
      People: { type: "relation", relation: [{ id: ["x"] }] },
    },
  };
  await assert.rejects(callFindDuePeople(notionPostMock([response([]), response([listRelation])])), TypeError);

  // True == 1 as a dict key: the Interaction counts for the Person with id 1,
  // who is then not due.
  const numericId = { ...person("p1", "Alex", "1 month"), id: 1 };
  const trueRelation = {
    properties: {
      Date: { type: "date", date: { start: "2026-09-01" } },
      People: { type: "relation", relation: [{ id: true }] },
    },
  };
  const [duePeople] = await callFindDuePeople(notionPostMock([response([numericId]), response([trueRelation])]));
  assert.deepEqual(duePeople, []);

  // An unhashable cadence is a malformed Person (TypeError inside the try).
  const dictCadence = person("p1", "Alex", "1 month");
  (dictCadence.properties["Contact cadence"] as Record<string, unknown>)["select"] = { name: { x: 1 } };
  assert.equal(personFromNotionPage(dictCadence), null);
});
