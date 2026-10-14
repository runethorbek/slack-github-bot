// Port of tests/test_people_interaction.py (AddInteractionButtonTests,
// FetchAvailableInteractionTypesTests, IsValidInteractionTypeTests,
// FetchAvailableTracksTests, IsValidTrackTests,
// HandleAddInteractionSubmissionTests), followed by TS-only tests that pin
// TECH-DEBT TD1, TD3 and TD7 and give security-invariant evidence (S3, S4,
// S11).
//
// Conventions as in tasks-list.test.ts and people-due.test.ts: each test title
// starts with the Python method name; Mock objects become recording functions
// whose `calls` list holds each call's arguments, and Python's keyword
// arguments are the TS options object (`call.kwargs["json"]` is
// `calls[i][1].json`). Fake Notion responses are real http.ts HttpResponse
// objects. `Mock().raise_for_status.side_effect = Exception("boom")` is an
// HttpResponse whose raise_for_status() throws that plain Error.
// `post_slack_message.assert_called_once_with(msg, thread_ts=None)` is `calls`
// deep-equal to `[[msg, { threadTs: undefined }]]`: the options object always
// has the `threadTs` key, as Python always passes the keyword.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ConnectionError, HttpResponse, ReadTimeout, type GetOptions, type PostOptions } from "../src/http.ts";
import { PeopleDueCommandError } from "../src/people-due.ts";
import {
  ADD_INTERACTION_ACTION_ID,
  ADD_INTERACTION_CALLBACK_ID,
  AddInteractionCommandError,
  INTERACTION_ADDED_MESSAGE_TEMPLATE,
  INTERACTION_FAILURE_MESSAGE,
  INTERACTION_INVALID_MESSAGE,
  MAX_TRACK_OPTIONS,
  addInteractionButton,
  createInteractionPage,
  fetchAvailableInteractionTypes,
  fetchAvailableTracks,
  fetchInteractionsTitleProperty,
  handleAddInteractionSubmission,
  isValidInteractionType,
  isValidTrack,
  type BuildFollowupButtons,
} from "../src/people-interaction.ts";
import { makeDate, type PlainDate } from "../src/plain-date.ts";
import { KeyError, getPyCause } from "../src/python-compat.ts";
import { NotionAuthenticationError, TaskListCommandError, type NotionResponse } from "../src/tasks-list.ts";

const FIXED_TODAY: PlainDate = makeDate(2026, 9, 22);
const PAGES_URL = "https://api.notion.com/v1/pages";
const SCHEMA_URL = "https://api.notion.com/v1/data_sources/interactions-id";
const TRACKS_QUERY_URL = "https://api.notion.com/v1/data_sources/tracks-id/query";
const ADDED_JANE = INTERACTION_ADDED_MESSAGE_TEMPLATE.replace("{name}", "Jane Doe");

// The live Interactions "Type" select property, as it would come back from
// Notion's "retrieve a data source" endpoint. Deliberately includes a value
// ("Video call") absent from every hardcoded list this feature used to
// carry, so tests built on this fixture demonstrate a schema-driven Type
// becoming available without any code change.
const TYPE_SELECT_OPTIONS = [{ name: "Coffee" }, { name: "Walk" }, { name: "Video call" }];

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
type NotionGetMock = Mock<[string, GetOptions], Promise<NotionResponse>>;
type SleepMock = Mock<[number], void>;

/** Mock(return_value=response) */
function notionPostReturning(response: NotionResponse): NotionPostMock {
  return mock(async (_url: string, _options: PostOptions) => response);
}

/** Mock(side_effect=[...]) */
function notionPostMock(values: readonly (NotionResponse | Error)[]): NotionPostMock {
  const next = sideEffects(values);
  return mock(async (_url: string, _options: PostOptions) => next());
}

function notionGetReturning(response: NotionResponse): NotionGetMock {
  return mock(async (_url: string, _options: GetOptions) => response);
}

/**
 * A bare `Mock()` the test expects not to be called. Calling it rejects, so an
 * unexpected call fails the test (stricter than Python's Mock, which would
 * return another Mock).
 */
function unusedNotionPost(): NotionPostMock {
  return mock(async (_url: string, _options: PostOptions): Promise<NotionResponse> => {
    throw new Error("unexpected notion_post call");
  });
}

function unusedNotionGet(): NotionGetMock {
  return mock(async (_url: string, _options: GetOptions): Promise<NotionResponse> => {
    throw new Error("unexpected notion_get call");
  });
}

function slackMock(): SlackMock {
  return mock(async (_message: string, _options?: SlackOptions) => ({}));
}

function sleepMock(): SleepMock {
  return mock((_seconds: number) => undefined);
}

/** `call_args.kwargs["json"]` of the given call (default: the last one). */
function postedJson(notionPost: NotionPostMock, index = -1): Record<string, any> {
  const call = notionPost.calls.at(index);
  assert.ok(call, "notion_post was not called");
  return call[1].json as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, statusCode = 200): HttpResponse {
  return new HttpResponse(statusCode, new Headers(), JSON.stringify(body));
}

function errorResponse(statusCode: number): HttpResponse {
  return new HttpResponse(statusCode, new Headers(), "");
}

/** `Mock().raise_for_status.side_effect = error`. */
class RaisingResponse extends HttpResponse {
  readonly error: Error;

  constructor(error: Error) {
    super(200, new Headers(), "{}");
    this.error = error;
  }

  override raise_for_status(): void {
    throw this.error;
  }
}

function schemaResponse(
  titlePropertyName = "Title of interaction",
  typeOptions: unknown[] | null = null,
): HttpResponse {
  return jsonResponse({
    properties: {
      People: { type: "relation" },
      Type: {
        type: "select",
        select: { options: typeOptions && typeOptions.length > 0 ? typeOptions : TYPE_SELECT_OPTIONS },
      },
      Date: { type: "date" },
      Notes: { type: "rich_text" },
      [titlePropertyName]: { type: "title" },
    },
  });
}

function okResponse(): HttpResponse {
  return jsonResponse({ id: "new-interaction-id" });
}

function schemaResponseMissingTitle(): HttpResponse {
  // No property has type "title": the schema fetch cannot resolve where to
  // write a required title, and must not crash the caller. The Type
  // property is otherwise valid, so this isolates the title-resolution
  // failure from Type validation.
  return jsonResponse({
    properties: {
      People: { type: "relation" },
      Type: { type: "select", select: { options: TYPE_SELECT_OPTIONS } },
    },
  });
}

function trackPage(trackId: string, name: string | null, priority: string | null = null): Record<string, unknown> {
  return {
    id: trackId,
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

function tracksResponse(pages: unknown[], hasMore = false, nextCursor: string | null = null): HttpResponse {
  return jsonResponse({ results: pages, has_more: hasMore, next_cursor: nextCursor });
}

/** HandleAddInteractionSubmissionTests.environment */
function environment(tracksDataSourceId: string | null = null): Record<string, string> {
  const env: Record<string, string> = {
    NOTION_API_KEY: "secret-token",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };
  if (tracksDataSourceId) {
    env["NOTION_TRACKS_DATA_SOURCE_ID"] = tracksDataSourceId;
  }
  return env;
}

// ---------------------------------------------------------------------------
// AddInteractionButtonTests
// ---------------------------------------------------------------------------

test("test_value_carries_the_stable_page_id_and_name", () => {
  const button = addInteractionButton("person-page-id", "Jane Doe");

  assert.equal(button.action_id, ADD_INTERACTION_ACTION_ID);
  assert.deepEqual(JSON.parse(button.value), { page_id: "person-page-id", name: "Jane Doe" });
});

test("test_no_tracks_omits_track_fields_entirely", () => {
  const button = addInteractionButton("person-page-id", "Jane Doe", { tracks: [], defaultTrackId: null });

  assert.ok(!Object.hasOwn(JSON.parse(button.value), "tracks"));
  assert.ok(!Object.hasOwn(JSON.parse(button.value), "default_track_id"));
});

test("test_tracks_and_default_are_carried_in_the_value", () => {
  const tracks = [{ id: "t1", name: "AI Network" }, { id: "t2", name: "Investors" }];

  const button = addInteractionButton("person-page-id", "Jane Doe", { tracks, defaultTrackId: "t1" });

  const value = JSON.parse(button.value);
  assert.deepEqual(value.tracks, tracks);
  assert.equal(value.default_track_id, "t1");
});

test("test_tracks_without_a_default_omit_default_track_id", () => {
  const tracks = [{ id: "t1", name: "AI Network" }];

  const button = addInteractionButton("person-page-id", "Jane Doe", { tracks, defaultTrackId: null });

  assert.ok(!Object.hasOwn(JSON.parse(button.value), "default_track_id"));
});

test("test_no_interaction_types_omits_types_field", () => {
  const button = addInteractionButton("person-page-id", "Jane Doe", { interactionTypes: [] });

  assert.ok(!Object.hasOwn(JSON.parse(button.value), "types"));
});

test("test_interaction_types_are_carried_in_the_value", () => {
  const button = addInteractionButton("person-page-id", "Jane Doe", { interactionTypes: ["Coffee", "Walk"] });

  assert.deepEqual(JSON.parse(button.value).types, ["Coffee", "Walk"]);
});

// ---------------------------------------------------------------------------
// FetchAvailableInteractionTypesTests
// ---------------------------------------------------------------------------

test("test_resolves_option_names_from_the_live_schema", async () => {
  const notionGet = notionGetReturning(schemaResponse());

  const types = await fetchAvailableInteractionTypes(notionGet, "secret", "interactions-id", sleepMock());

  assert.deepEqual(types, ["Coffee", "Walk", "Video call"]);
});

test("test_a_type_added_in_notion_is_available_without_any_code_change", async () => {
  // A value never present in any hardcoded list this feature used to carry
  // becomes available purely because the mocked schema response says so.
  const notionGet = notionGetReturning(schemaResponse(undefined, [{ name: "Brand New Type From Notion" }]));

  const types = await fetchAvailableInteractionTypes(notionGet, "secret", "interactions-id", sleepMock());

  assert.deepEqual(types, ["Brand New Type From Notion"]);
});

test("test_missing_type_property_is_a_failure", async () => {
  const notionGet = notionGetReturning(jsonResponse({ properties: { People: { type: "relation" } } }));

  await assert.rejects(
    fetchAvailableInteractionTypes(notionGet, "secret", "interactions-id", sleepMock()),
    AddInteractionCommandError,
  );
});

test("test_type_property_not_a_select_is_a_failure", async () => {
  const notionGet = notionGetReturning(jsonResponse({ properties: { Type: { type: "rich_text" } } }));

  await assert.rejects(
    fetchAvailableInteractionTypes(notionGet, "secret", "interactions-id", sleepMock()),
    AddInteractionCommandError,
  );
});

test("test_select_property_without_options_is_a_failure", async () => {
  const notionGet = notionGetReturning(jsonResponse({ properties: { Type: { type: "select" } } }));

  await assert.rejects(
    fetchAvailableInteractionTypes(notionGet, "secret", "interactions-id", sleepMock()),
    AddInteractionCommandError,
  );
});

test("test_malformed_option_entries_are_skipped", async () => {
  const notionGet = notionGetReturning(
    jsonResponse({
      properties: {
        Type: {
          type: "select",
          select: { options: [{ name: "Coffee" }, {}, "not-a-dict"] },
        },
      },
    }),
  );

  const types = await fetchAvailableInteractionTypes(notionGet, "secret", "interactions-id", sleepMock());

  assert.deepEqual(types, ["Coffee"]);
});

// ---------------------------------------------------------------------------
// IsValidInteractionTypeTests
// ---------------------------------------------------------------------------

test("test_type_present_among_live_options_is_valid", async () => {
  const notionGet = notionGetReturning(schemaResponse());

  assert.equal(await isValidInteractionType("Coffee", notionGet, "secret", "interactions-id", sleepMock()), true);
});

test("test_type_not_among_live_options_is_invalid", async () => {
  const notionGet = notionGetReturning(schemaResponse());

  assert.equal(await isValidInteractionType("Linkedon", notionGet, "secret", "interactions-id", sleepMock()), false);
});

// ---------------------------------------------------------------------------
// FetchAvailableTracksTests
// ---------------------------------------------------------------------------

test("test_resolves_id_and_name_sorted_alphabetically", async () => {
  const notionPost = notionPostReturning(
    tracksResponse([trackPage("t2", "Investors"), trackPage("t1", "AI Network")]),
  );

  const tracks = await fetchAvailableTracks(notionPost, "secret", "tracks-id", sleepMock());

  assert.deepEqual(tracks, [{ id: "t1", name: "AI Network" }, { id: "t2", name: "Investors" }]);
});

test("test_malformed_track_page_is_skipped", async () => {
  const notionPost = notionPostReturning(
    tracksResponse([{ id: "t1", properties: {} }, trackPage("t2", "Investors")]),
  );

  const tracks = await fetchAvailableTracks(notionPost, "secret", "tracks-id", sleepMock());

  assert.deepEqual(tracks, [{ id: "t2", name: "Investors" }]);
});

test("test_no_tracks_returns_empty_list", async () => {
  const notionPost = notionPostReturning(tracksResponse([]));

  const tracks = await fetchAvailableTracks(notionPost, "secret", "tracks-id", sleepMock());

  assert.deepEqual(tracks, []);
});

// ---------------------------------------------------------------------------
// IsValidTrackTests
// ---------------------------------------------------------------------------

test("test_id_present_among_live_tracks_is_valid", async () => {
  const notionPost = notionPostReturning(tracksResponse([trackPage("t1", "AI Network")]));

  assert.equal(await isValidTrack("t1", notionPost, "secret", "tracks-id", sleepMock()), true);
});

test("test_id_not_among_live_tracks_is_invalid", async () => {
  const notionPost = notionPostReturning(tracksResponse([trackPage("t1", "AI Network")]));

  assert.equal(await isValidTrack("forged-id", notionPost, "secret", "tracks-id", sleepMock()), false);
});

test("test_unconfigured_tracks_data_source_fails_closed (S4)", async () => {
  const notionPost = unusedNotionPost();

  assert.equal(await isValidTrack("t1", notionPost, "secret", "", sleepMock()), false);
  assert.equal(notionPost.calls.length, 0);
});

// ---------------------------------------------------------------------------
// HandleAddInteractionSubmissionTests
// ---------------------------------------------------------------------------

test("test_valid_type_is_accepted_and_written_with_the_correct_person_relation", async () => {
  const notionPost = notionPostReturning(okResponse());
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Talked about the new role.", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 1);
  const request = notionPost.calls.at(-1) as [string, PostOptions];
  assert.equal(request[0], "https://api.notion.com/v1/pages");
  const properties = (request[1].json as Record<string, any>)["properties"];
  assert.deepEqual(properties["People"], { relation: [{ id: "person-page-id" }] });
  assert.deepEqual(properties["Type"], { select: { name: "Coffee" } });
  assert.deepEqual(properties["Date"], { date: { start: "2026-09-22" } });
  assert.deepEqual(postSlackMessage.calls, [[ADDED_JANE, { threadTs: undefined }]]);
});

test("test_notes_are_preserved_exactly", async () => {
  const notionPost = notionPostReturning(okResponse());
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();
  const notes = "  Exact notes,\nnot summarized or rewritten.  ";

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", notes, "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  const properties = postedJson(notionPost)["properties"];
  assert.equal(properties["Notes"]["rich_text"][0]["text"]["content"], notes);
});

test("test_write_payload_contains_only_intended_fields", async () => {
  const notionPost = notionPostReturning(okResponse());
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  const properties = postedJson(notionPost)["properties"];
  assert.deepEqual(
    new Set(Object.keys(properties)),
    new Set(["People", "Type", "Date", "Notes", "Track", "Title of interaction"]),
  );
  const requestJson = postedJson(notionPost);
  assert.deepEqual(requestJson["parent"], { data_source_id: "interactions-id" });
});

test("test_date_defaults_to_today_when_missing", async () => {
  const notionPost = notionPostReturning(okResponse());
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "", "",
    postSlackMessage, notionPost, notionGet, environment(), { today: FIXED_TODAY, sleep: sleepMock() },
  );

  const properties = postedJson(notionPost)["properties"];
  assert.deepEqual(properties["Date"], { date: { start: "2026-09-22" } });
});

test("test_unknown_type_is_rejected_before_any_notion_write (S4)", async () => {
  const notionPost = unusedNotionPost();
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Linkedon", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  // The live schema is read to check the submitted Type, but the
  // Interaction is never written.
  assert.equal(notionGet.calls.length, 1);
  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: undefined }]]);
});

test("test_empty_type_is_rejected", async () => {
  const notionPost = unusedNotionPost();
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: undefined }]]);
});

test("test_type_validation_failure_produces_a_safe_message_without_a_write", async () => {
  // The Type schema fetch itself can fail (a Notion outage, a malformed
  // response); this must be caught exactly like any other Notion failure,
  // and must never fall back to accepting or guessing a Type.
  const notionGet = notionGetReturning(new RaisingResponse(new Error("boom")));
  const notionPost = unusedNotionPost();
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

test("test_malformed_date_is_rejected_before_any_notion_write", async () => {
  const notionPost = unusedNotionPost();
  const notionGet = unusedNotionGet();
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "not-a-date", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.equal(notionGet.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: undefined }]]);
});

test("test_missing_person_identity_is_ignored_rather_than_guessed (S3)", async () => {
  const notionPost = unusedNotionPost();
  const notionGet = unusedNotionGet();
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "", "", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.equal(postSlackMessage.calls.length, 0);
});

test("test_notion_failure_produces_a_safe_message_without_a_partial_write", async () => {
  const notionGet = notionGetReturning(schemaResponse());
  const notionPost = notionPostReturning(new RaisingResponse(new Error("boom")));
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

test("test_unresolvable_title_property_produces_a_safe_message_without_a_partial_write", async () => {
  // The schema fetch itself can fail to find a title property (or fail
  // outright); that must be caught exactly like a Notion write failure, not
  // crash the Action.
  const notionGet = notionGetReturning(schemaResponseMissingTitle());
  const notionPost = unusedNotionPost();
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

test("test_notion_authentication_failure_produces_a_safe_message_without_a_partial_write (S11, TD7)", async () => {
  // A 401/403 from Notion raises NotionAuthenticationError, a distinct
  // exception type from a generic TaskListCommandError; it must be caught
  // the same way rather than crashing the Action uncaught.
  const notionGet = notionGetReturning(errorResponse(401));
  const notionPost = unusedNotionPost();
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

test("test_confirmation_and_failure_replies_stay_in_the_suggestion_thread", async () => {
  const notionPost = notionPostReturning(okResponse());
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { threadTs: "100.001", sleep: sleepMock() },
  );

  assert.deepEqual(postSlackMessage.calls, [[ADDED_JANE, { threadTs: "100.001" }]]);
});

test("test_invalid_type_reply_stays_in_the_suggestion_thread", async () => {
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Linkedon", "Notes", "2026-09-22", "",
    postSlackMessage, unusedNotionPost(), notionGetReturning(schemaResponse()), environment(),
    { threadTs: "100.001", sleep: sleepMock() },
  );

  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: "100.001" }]]);
});

test("test_no_track_selected_writes_an_empty_track_relation", async () => {
  const notionPost = notionPostReturning(okResponse());
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  const properties = postedJson(notionPost)["properties"];
  assert.deepEqual(properties["Track"], { relation: [] });
});

test("test_valid_track_is_written_as_the_track_relation", async () => {
  // notion_post is used for both the live Track validation query and the
  // final Interaction write; the validation query returns the submitted id
  // as a real Track before the write is attempted.
  const notionPost = notionPostMock([tracksResponse([trackPage("track-1", "AI Network")]), okResponse()]);
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "track-1",
    postSlackMessage, notionPost, notionGet, environment("tracks-id"), { sleep: sleepMock() },
  );

  const properties = postedJson(notionPost, -1)["properties"];
  assert.deepEqual(properties["Track"], { relation: [{ id: "track-1" }] });
  assert.deepEqual(postSlackMessage.calls, [[ADDED_JANE, { threadTs: undefined }]]);
});

test("test_a_track_id_that_is_not_a_live_track_is_rejected_before_any_write (S4)", async () => {
  const notionPost = notionPostReturning(tracksResponse([trackPage("track-1", "AI Network")]));
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "forged-or-stale-id",
    postSlackMessage, notionPost, notionGet, environment("tracks-id"), { sleep: sleepMock() },
  );

  // Type validation (notion_get) and the Track validation query
  // (notion_post) both ran; the Interaction page was never created, and the
  // title-property schema fetch never ran.
  assert.equal(notionPost.calls.length, 1);
  assert.equal(notionGet.calls.length, 1);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: undefined }]]);
});

test("test_a_track_id_with_no_tracks_data_source_configured_is_rejected (S4)", async () => {
  const notionPost = unusedNotionPost();
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "track-1",
    postSlackMessage, notionPost, notionGet, environment(), { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: undefined }]]);
});

test("test_track_validation_failure_produces_a_safe_message_without_a_write", async () => {
  const notionPost = notionPostReturning(new RaisingResponse(new Error("boom")));
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "track-1",
    postSlackMessage, notionPost, notionGet, environment("tracks-id"), { sleep: sleepMock() },
  );

  // Type validation ran (and passed); the title-property schema fetch never
  // ran because Track validation failed first.
  assert.equal(notionGet.calls.length, 1);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

// ---------------------------------------------------------------------------
// TS-only tests
// ---------------------------------------------------------------------------

test("TD1 pin: a 5xx on Interaction create is retried with the default policy (can duplicate)", async () => {
  const notionPost = notionPostMock([errorResponse(503), okResponse()]);
  const notionGet = notionGetReturning(schemaResponse());
  const postSlackMessage = slackMock();
  const sleep = sleepMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGet, environment(), { sleep },
  );

  assert.deepEqual(notionPost.calls.map(([url]) => url), [PAGES_URL, PAGES_URL]);
  assert.deepEqual(postedJson(notionPost, 0), postedJson(notionPost, 1));
  assert.deepEqual(sleep.calls, [[1]]);
  assert.deepEqual(postSlackMessage.calls, [[ADDED_JANE, { threadTs: undefined }]]);
});

test("TD1 pin: a ReadTimeout or ConnectionError on Interaction create is retried", async (t) => {
  for (const error of [new ReadTimeout(), new ConnectionError()]) {
    await t.test(error.name, async () => {
      const notionPost = notionPostMock([error, okResponse()]);
      const postSlackMessage = slackMock();
      const sleep = sleepMock();

      await handleAddInteractionSubmission(
        "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
        postSlackMessage, notionPost, notionGetReturning(schemaResponse()), environment(), { sleep },
      );

      assert.deepEqual(notionPost.calls.map(([url]) => url), [PAGES_URL, PAGES_URL]);
      assert.deepEqual(sleep.calls, [[1]]);
      assert.deepEqual(postSlackMessage.calls, [[ADDED_JANE, { threadTs: undefined }]]);
    });
  }
});

test("TD1 pin: three 5xx on Interaction create give three creates, sleeps 1 and 2, and the generic failure", async () => {
  const notionPost = notionPostMock([errorResponse(500), errorResponse(502), errorResponse(503)]);
  const postSlackMessage = slackMock();
  const sleep = sleepMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGetReturning(schemaResponse()), environment(), { sleep },
  );

  assert.equal(notionPost.calls.length, 3);
  assert.deepEqual(sleep.calls, [[1], [2]]);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

test("TD7 pin: a 401 on Interaction create posts the generic failure and does not throw", async () => {
  const notionPost = notionPostMock([errorResponse(401)]);
  const postSlackMessage = slackMock();
  const sleep = sleepMock();
  const buildFollowupButtons = mock(async () => [] as unknown[]);

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGetReturning(schemaResponse()), environment(),
    { sleep, threadTs: "100.001", buildFollowupButtons },
  );

  assert.equal(notionPost.calls.length, 1);
  assert.equal(sleep.calls.length, 0);
  assert.equal(buildFollowupButtons.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: "100.001" }]]);
});

test("TD7 pin: a 403 on Interaction create is a credential failure too (not retried, caught)", async () => {
  const notionPost = notionPostMock([errorResponse(403)]);
  const postSlackMessage = slackMock();
  const sleep = sleepMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPost, notionGetReturning(schemaResponse()), environment(), { sleep },
  );

  assert.equal(notionPost.calls.length, 1);
  assert.equal(sleep.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_FAILURE_MESSAGE, { threadTs: undefined }]]);
});

test("createInteractionPage: 401 and 403 throw NotionAuthenticationError (default credential codes)", async (t) => {
  for (const statusCode of [401, 403]) {
    await t.test(String(statusCode), async () => {
      await assert.rejects(
        createInteractionPage(
          notionPostMock([errorResponse(statusCode)]), "secret", "interactions-id", "p", "Jane", "Coffee", "",
          FIXED_TODAY, null, "Title", sleepMock(),
        ),
        (error: unknown) =>
          error instanceof NotionAuthenticationError &&
          error.message === `Notion authentication failed (HTTP ${statusCode}).`,
      );
    });
  }
});

test("write payload: the full create request equals Python's (URL, headers, timeout, properties, en dash)", async () => {
  const notionPost = notionPostMock([tracksResponse([trackPage("track-1", "AI Network")]), okResponse()]);
  const notionGet = notionGetReturning(schemaResponse("Navn"));
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Søren Ærø", "Video call", "Mødtes på café", "2026-09-22", "track-1",
    postSlackMessage, notionPost, notionGet, environment("tracks-id"), { sleep: sleepMock() },
  );

  const headers = {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
    "Notion-Version": "2025-09-03",
  };
  assert.deepEqual(notionPost.calls, [
    [TRACKS_QUERY_URL, { headers, json: { page_size: MAX_TRACK_OPTIONS }, timeout: 10 }],
    [
      PAGES_URL,
      {
        headers,
        json: {
          parent: { data_source_id: "interactions-id" },
          properties: {
            People: { relation: [{ id: "person-page-id" }] },
            Type: { select: { name: "Video call" } },
            Date: { date: { start: "2026-09-22" } },
            Notes: { rich_text: [{ type: "text", text: { content: "Mødtes på café" } }] },
            Track: { relation: [{ id: "track-1" }] },
            Navn: { title: [{ type: "text", text: { content: "Søren Ærø – Video call" } }] },
          },
        },
        timeout: 10,
      },
    ],
  ]);
  assert.deepEqual(notionGet.calls, [
    [SCHEMA_URL, { headers, timeout: 10 }],
    [SCHEMA_URL, { headers, timeout: 10 }],
  ]);
  assert.deepEqual(postSlackMessage.calls, [["Interaction added for Søren Ærø.", { threadTs: undefined }]]);
});

test("write payload: empty notes write an empty rich_text, and the property key order matches Python's dict", async () => {
  const notionPost = notionPostReturning(okResponse());

  await createInteractionPage(
    notionPost, "secret", "interactions-id", "p", "Jane", "Coffee", "", FIXED_TODAY, "", "Title of interaction",
    sleepMock(),
  );

  const properties = postedJson(notionPost)["properties"];
  assert.deepEqual(Object.keys(properties), ["People", "Type", "Date", "Notes", "Track", "Title of interaction"]);
  assert.deepEqual(properties["Notes"], { rich_text: [] });
  assert.deepEqual(properties["Track"], { relation: [] });
});

test("validation order: date, then Type, then Track, then title property, then exactly one create", async () => {
  const log: string[] = [];
  const notionGet = mock(async (url: string, _options: GetOptions) => {
    log.push(`GET ${url}`);
    return schemaResponse();
  });
  const notionPost = mock(async (url: string, _options: PostOptions) => {
    log.push(`POST ${url}`);
    return url === PAGES_URL ? okResponse() : tracksResponse([trackPage("track-1", "AI Network")]);
  });

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "track-1",
    slackMock(), notionPost, notionGet, environment("tracks-id"), { sleep: sleepMock() },
  );

  assert.deepEqual(log, [`GET ${SCHEMA_URL}`, `POST ${TRACKS_QUERY_URL}`, `GET ${SCHEMA_URL}`, `POST ${PAGES_URL}`]);
});

test("S4: an invalid Type is rejected before the Track is validated", async () => {
  const notionPost = unusedNotionPost();

  const postSlackMessage = slackMock();
  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Linkedon", "Notes", "2026-09-22", "track-1",
    postSlackMessage, notionPost, notionGetReturning(schemaResponse()), environment("tracks-id"),
    { sleep: sleepMock() },
  );

  assert.equal(notionPost.calls.length, 0);
  assert.deepEqual(postSlackMessage.calls, [[INTERACTION_INVALID_MESSAGE, { threadTs: undefined }]]);
});

test("S3: a page id without a name, or a name without a page id, is a silent no-op", async (t) => {
  for (const [pageId, name] of [["person-page-id", ""], ["", "Jane Doe"]] as const) {
    await t.test(`${JSON.stringify(pageId)}, ${JSON.stringify(name)}`, async () => {
      const notionPost = unusedNotionPost();
      const notionGet = unusedNotionGet();
      const postSlackMessage = slackMock();
      const buildFollowupButtons = mock(async () => [] as unknown[]);

      await handleAddInteractionSubmission(
        pageId, name, "Coffee", "Notes", "not-a-date", "track-1",
        postSlackMessage, notionPost, notionGet, {}, { buildFollowupButtons },
      );

      assert.equal(notionPost.calls.length, 0);
      assert.equal(notionGet.calls.length, 0);
      assert.equal(postSlackMessage.calls.length, 0);
      assert.equal(buildFollowupButtons.calls.length, 0);
    });
  }
});

test("buildFollowupButtons: called once after a successful write; its buttons are posted in an actions block", async () => {
  const button = { type: "button", text: { type: "plain_text", text: "Add follow-up Task" }, action_id: "x", value: "{}" };
  const buildFollowupButtons = mock<Parameters<BuildFollowupButtons>, Promise<unknown[]>>(async () => [button]);
  const notionPost = notionPostMock([tracksResponse([trackPage("track-1", "AI Network")]), okResponse()]);
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", null, "", "track-1",
    postSlackMessage, notionPost, notionGetReturning(schemaResponse()), environment("tracks-id"),
    { today: FIXED_TODAY, threadTs: "100.001", sleep: sleepMock(), buildFollowupButtons },
  );

  assert.deepEqual(buildFollowupButtons.calls, [
    ["person-page-id", "Jane Doe", "track-1", "Coffee", "", FIXED_TODAY],
  ]);
  assert.deepEqual(postSlackMessage.calls, [
    [
      ADDED_JANE,
      {
        threadTs: "100.001",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: ADDED_JANE } },
          { type: "actions", elements: [button] },
        ],
      },
    ],
  ]);
});

test("buildFollowupButtons: no buttons means a plain confirmation without blocks", async () => {
  const buildFollowupButtons = mock(async () => [] as unknown[]);
  const postSlackMessage = slackMock();

  await handleAddInteractionSubmission(
    "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
    postSlackMessage, notionPostReturning(okResponse()), notionGetReturning(schemaResponse()), environment(),
    { sleep: sleepMock(), buildFollowupButtons },
  );

  assert.equal(buildFollowupButtons.calls.length, 1);
  assert.deepEqual(postSlackMessage.calls, [[ADDED_JANE, { threadTs: undefined }]]);
});

test("buildFollowupButtons: not called when the submission is invalid or the write fails", async (t) => {
  const cases: Array<[string, string, NotionPostMock]> = [
    ["invalid Type", "Linkedon", unusedNotionPost()],
    ["failed write", "Coffee", notionPostReturning(new RaisingResponse(new Error("boom")))],
  ];
  for (const [label, interactionType, notionPost] of cases) {
    await t.test(label, async () => {
      const buildFollowupButtons = mock(async () => [] as unknown[]);
      await handleAddInteractionSubmission(
        "person-page-id", "Jane Doe", interactionType, "Notes", "2026-09-22", "",
        slackMock(), notionPost, notionGetReturning(schemaResponse()), environment(),
        { sleep: sleepMock(), buildFollowupButtons },
      );
      assert.equal(buildFollowupButtons.calls.length, 0);
    });
  }
});

test("buildFollowupButtons: an error it throws propagates (it runs outside the write's except)", async () => {
  const failure = new Error("unexpected");
  await assert.rejects(
    handleAddInteractionSubmission(
      "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
      slackMock(), notionPostReturning(okResponse()), notionGetReturning(schemaResponse()), environment(),
      { sleep: sleepMock(), buildFollowupButtons: async () => { throw failure; } },
    ),
    (error: unknown) => error === failure,
  );
});

test("TD3 pin: the modal date is parsed with date.fromisoformat, so 20260922 and 2026-W39-2 are accepted", async (t) => {
  for (const dateValue of ["20260922", "2026-W39-2"]) {
    await t.test(dateValue, async () => {
      const notionPost = notionPostReturning(okResponse());
      await handleAddInteractionSubmission(
        "person-page-id", "Jane Doe", "Coffee", "Notes", dateValue, "",
        slackMock(), notionPost, notionGetReturning(schemaResponse()), environment(), { sleep: sleepMock() },
      );
      assert.deepEqual(postedJson(notionPost)["properties"]["Date"], { date: { start: "2026-09-22" } });
    });
  }
});

test("a missing NOTION_API_KEY raises KeyError, as environment[...] does (not caught)", async () => {
  await assert.rejects(
    handleAddInteractionSubmission(
      "person-page-id", "Jane Doe", "Coffee", "Notes", "2026-09-22", "",
      slackMock(), unusedNotionPost(), unusedNotionGet(), { NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id" },
      { sleep: sleepMock() },
    ),
    (error: unknown) => error instanceof KeyError && error.key === "NOTION_API_KEY",
  );
});

test("fetchAvailableInteractionTypes: 401 is a credential failure, 403 is not (credential codes are (401,))", async () => {
  await assert.rejects(
    fetchAvailableInteractionTypes(notionGetReturning(errorResponse(401)), "secret", "interactions-id", sleepMock()),
    NotionAuthenticationError,
  );
  const sleep = sleepMock();
  await assert.rejects(
    fetchAvailableInteractionTypes(notionGetReturning(errorResponse(403)), "secret", "interactions-id", sleep),
    (error: unknown) => error instanceof TaskListCommandError,
  );
  assert.equal(sleep.calls.length, 0);
});

test("fetchAvailableInteractionTypes: a malformed schema is an AddInteractionCommandError caused by the parse error", async (t) => {
  const bodies: Array<[string, HttpResponse]> = [
    ["not JSON", new HttpResponse(200, new Headers(), "not json")],
    ["properties is a list", jsonResponse({ properties: [] })],
    ["options is a number", jsonResponse({ properties: { Type: { type: "select", select: { options: 3 } } } })],
    ["Type is a list", jsonResponse({ properties: { Type: [] } })],
  ];
  for (const [label, response] of bodies) {
    await t.test(label, async () => {
      let caught: unknown;
      await assert.rejects(
        fetchAvailableInteractionTypes(notionGetReturning(response), "secret", "interactions-id", sleepMock()),
        (error: unknown) => {
          caught = error;
          return error instanceof AddInteractionCommandError;
        },
      );
      assert.notEqual(getPyCause(caught), null);
    });
  }
  await t.test("options is a str or a dict: no options, not a failure", async () => {
    for (const options of ["Coffee", { name: "Coffee" }]) {
      const response = jsonResponse({ properties: { Type: { type: "select", select: { options } } } });
      assert.deepEqual(
        await fetchAvailableInteractionTypes(notionGetReturning(response), "secret", "interactions-id", sleepMock()),
        [],
      );
    }
  });
});

test("fetchInteractionsTitleProperty: resolves the title by type; a malformed schema is an AddInteractionCommandError", async () => {
  assert.equal(
    await fetchInteractionsTitleProperty(
      notionGetReturning(schemaResponse("Titel")), "secret", "interactions-id", sleepMock(),
    ),
    "Titel",
  );
  for (const body of [{}, { properties: [] }, { properties: "x" }, { properties: { A: "title" } }]) {
    await assert.rejects(
      fetchInteractionsTitleProperty(notionGetReturning(jsonResponse(body)), "secret", "interactions-id", sleepMock()),
      AddInteractionCommandError,
    );
  }
});

test("fetchAvailableTracks: one bounded query of page_size 25; at most 25 options; a malformed response is an AddInteractionCommandError", async () => {
  const pages = Array.from({ length: 30 }, (_, index) => trackPage(`t${index}`, `Track ${String(index).padStart(2, "0")}`));
  const notionPost = notionPostReturning(tracksResponse(pages, true, "cursor-2"));

  const tracks = await fetchAvailableTracks(notionPost, "secret", "tracks-id", sleepMock());

  assert.equal(notionPost.calls.length, 1);
  assert.deepEqual(postedJson(notionPost), { page_size: 25 });
  assert.equal(tracks.length, MAX_TRACK_OPTIONS);
  assert.deepEqual(tracks.at(-1), { id: "t24", name: "Track 24" });

  let caught: unknown;
  await assert.rejects(
    fetchAvailableTracks(notionPostReturning(jsonResponse({ results: "nope" })), "secret", "tracks-id", sleepMock()),
    (error: unknown) => {
      caught = error;
      return error instanceof AddInteractionCommandError;
    },
  );
  assert.ok(getPyCause(caught) instanceof PeopleDueCommandError);
});

test("fetchAvailableTracks: sorts by casefolded name in code-point order; skips non-dict pages and empty ids", async () => {
  const notionPost = notionPostReturning(
    tracksResponse([
      trackPage("t1", "Østjylland"),
      trackPage("t2", "ærø"),
      trackPage("t3", "Zebra"),
      trackPage("t4", "STRASSE"),
      trackPage("t5", "straße"),
      "not-a-page",
      null,
      trackPage("", "No id"),
    ]),
  );

  const tracks = await fetchAvailableTracks(notionPost, "secret", "tracks-id", sleepMock());

  assert.deepEqual(tracks, [
    { id: "t4", name: "STRASSE" },
    { id: "t5", name: "straße" },
    { id: "t3", name: "Zebra" },
    { id: "t2", name: "ærø" },
    { id: "t1", name: "Østjylland" },
  ]);
});

test("addInteractionButton: values are byte-identical to Python's json.dumps", () => {
  // Expected strings printed by `py -3.12` from people_interaction.add_interaction_button.
  const cases: Array<[ReturnType<typeof addInteractionButton>, string]> = [
    [addInteractionButton("p-1", "Jane Doe"), String.raw`{"page_id": "p-1", "name": "Jane Doe"}`],
    [
      addInteractionButton("p-1", "Søren Æbelø", {
        tracks: [{ id: "t1", name: "Ærø Netværk" }, { id: "t2", name: "Østjylland" }],
        defaultTrackId: "t2",
        interactionTypes: ["Kaffe", "Gåtur", "Video call"],
      }),
      String.raw`{"page_id": "p-1", "name": "S\u00f8ren \u00c6bel\u00f8", "types": ["Kaffe", "G\u00e5tur", "Video call"], "tracks": [{"id": "t1", "name": "\u00c6r\u00f8 Netv\u00e6rk"}, {"id": "t2", "name": "\u00d8stjylland"}], "default_track_id": "t2"}`,
    ],
    [
      addInteractionButton("p-1", 'Åse "Q" \\ Ølund', {
        tracks: [{ id: "t1", name: "AI Network" }],
        defaultTrackId: null,
        interactionTypes: ["Coffee"],
      }),
      String.raw`{"page_id": "p-1", "name": "\u00c5se \"Q\" \\ \u00d8lund", "types": ["Coffee"], "tracks": [{"id": "t1", "name": "AI Network"}]}`,
    ],
    [
      addInteractionButton("p-1", "Jane \u{1F600} Doe\n", { tracks: [], defaultTrackId: "t1", interactionTypes: ["Coffee"] }),
      String.raw`{"page_id": "p-1", "name": "Jane \ud83d\ude00 Doe\n", "types": ["Coffee"]}`,
    ],
    [
      addInteractionButton("p-1", "Jane", { tracks: [{ id: "t1", name: "A" }], defaultTrackId: "", interactionTypes: [] }),
      String.raw`{"page_id": "p-1", "name": "Jane", "tracks": [{"id": "t1", "name": "A"}]}`,
    ],
  ];
  for (const [button, expected] of cases) {
    assert.equal(button.value, expected);
    assert.deepEqual(button.text, { type: "plain_text", text: "Add interaction" });
    assert.equal(button.type, "button");
  }
});

test("action and callback ids equal the constants in api/slack-request.js", () => {
  const source = readFileSync(new URL("../api/slack-request.js", import.meta.url), "utf8");
  assert.match(source, new RegExp(`const ADD_INTERACTION_ACTION_ID = "${ADD_INTERACTION_ACTION_ID}";`));
  assert.match(source, new RegExp(`const ADD_INTERACTION_CALLBACK_ID = "${ADD_INTERACTION_CALLBACK_ID}";`));
});
