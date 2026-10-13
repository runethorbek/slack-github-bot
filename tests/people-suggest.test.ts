// Port of tests/test_people_suggest.py (ResolvePersonTests,
// PersonProfileContextTests, PersonProfileTrackTests, ExtractPropertyTextTests,
// ExtractRelationIdsTests, FetchRecentInteractionsTests, CollectTrackIdsTests,
// ResolveTracksTests, ExtractTrackPurposeTests, GroupRelevantTracksTests,
// BuildSuggestionPromptTests, BuildRecapPromptTests, AllowedNextStepKindsTests,
// SplitRecapAndNextStepsTests, NextStepFormattingTests, HandlePeopleSuggestTests,
// AddInteractionTrackSelectorTests, NextStepSuggestionTests), followed by
// TS-only tests: byte-identity with Python-printed prompts and text
// (tests/equivalence/people-suggest-prompts.json), the marker regex
// against Python's `re` (tests/equivalence/golden/python-compat.json), and
// security-invariant evidence (S5, S6, S10, S11).
//
// Conventions as in people-interaction.test.ts: each test title starts with
// the Python method name; Mock objects become recording functions whose
// `calls` list holds each call's arguments, and Python's keyword arguments are
// the TS options object (`call.kwargs["json"]` is `calls[i][1].json`,
// `call_args_list[-1].kwargs["blocks"]` is `calls.at(-1)[1].blocks`). Fake
// Notion responses are real http.ts HttpResponse objects. Python dataclasses
// are plain objects: `TrackContext("AI Network")` is `{ name: "AI Network",
// purpose: null }`. A dict result (resolve_tracks) is a Map.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HttpResponse, type GetOptions, type PostOptions } from "../src/http.ts";
import { PeopleDueCommandError } from "../src/people-due.ts";
import { ADD_INTERACTION_ACTION_ID } from "../src/people-interaction.ts";
import {
  GEMINI_TRANSIENT_FAILURE_MESSAGE,
  INTERACTION_TYPE_UNAVAILABLE_NOTE,
  MAX_NEXT_STEP_SUGGESTIONS,
  MAX_SUGGESTION_INTERACTIONS,
  MAX_SUGGESTION_TRACKS,
  MAX_TRACK_PURPOSE_CHARS,
  NEXT_STEP_MARKER_PATTERN,
  PEOPLE_SUGGEST_FAILURE_MESSAGE,
  RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION,
  SLACK_SECTION_TEXT_LIMIT,
  SUGGESTION_SYSTEM_INSTRUCTION,
  allowedNextStepKinds,
  ambiguousPersonMessage,
  buildContextBlock,
  buildRecapPrompt,
  buildSuggestionBlocks,
  buildSuggestionPrompt,
  collectTrackIds,
  externalErrorStatusCode,
  extractPropertyText,
  extractRelationIds,
  extractTrackPurpose,
  fetchRecentInteractions,
  formatFullReply,
  formatNextSteps,
  formatSuggestionMessage,
  groupRelevantTracks,
  handlePeopleSuggest,
  interactionSummaryFromNotionPage,
  isTransientGeminiStatus,
  parseNextStep,
  personNotFoundMessage,
  personProfileFromNotionPage,
  resolvePerson,
  resolveTracks,
  splitRecapAndNextSteps,
  truncateForSlackSection,
  type GenerateText,
  type InteractionSummary,
  type NextStep,
  type PersonProfile,
  type TrackContext,
} from "../src/people-suggest.ts";
import * as peopleSuggest from "../src/people-suggest.ts";
import { makeDate, type PlainDate } from "../src/plain-date.ts";
import { pyJsonDumps, pyLen, type JsonValue } from "../src/python-compat.ts";
import { NotionAuthenticationError, TaskListCommandError, type NotionResponse } from "../src/tasks-list.ts";

const FIXED_TODAY: PlainDate = makeDate(2026, 9, 20);
const PEOPLE_URL = "https://api.notion.com/v1/data_sources/people-id/query";
const INTERACTIONS_URL = "https://api.notion.com/v1/data_sources/interactions-id/query";
const INTERACTIONS_TYPE_SCHEMA_URL = "https://api.notion.com/v1/data_sources/interactions-id";

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
type GenerateMock = Mock<[string], Promise<string>>;
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

function notionGetMock(values: readonly (NotionResponse | Error)[]): NotionGetMock {
  const next = sideEffects(values);
  return mock(async (_url: string, _options: GetOptions) => next());
}

/** Mock(side_effect=lambda url, **kwargs: ...) */
function notionGetRouted(route: (url: string) => NotionResponse): NotionGetMock {
  return mock(async (url: string, _options: GetOptions) => route(url));
}

/** A bare `Mock()` that must not be called: calling it rejects. */
function unusedNotionGet(): NotionGetMock {
  return mock(async (_url: string, _options: GetOptions): Promise<NotionResponse> => {
    throw new Error("unexpected notion_get call");
  });
}

function slackMock(): SlackMock {
  // Mock(side_effect=lambda message, thread_ts=None, blocks=None: {"ts": "123.456"})
  return mock(async (_message: string, _options?: SlackOptions) => ({ ts: "123.456" }));
}

/** Mock(side_effect=[...]) for generate_text. */
function generateMock(values: readonly (string | Error)[]): GenerateMock {
  const next = sideEffects(values);
  return mock(async (_prompt: string) => next());
}

/** Mock(return_value=value) for generate_text. */
function generateReturning(value: string): GenerateMock {
  return mock(async (_prompt: string) => value);
}

/** Mock(side_effect=error): every call raises it. */
function generateRaising(error: unknown): GenerateMock {
  return mock(async (_prompt: string): Promise<string> => {
    throw error;
  });
}

/** A bare `Mock()` generate_text the test expects not to be called. */
function unusedGenerate(): GenerateMock {
  return mock(async (_prompt: string): Promise<string> => {
    throw new Error("unexpected generate_text call");
  });
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

type Block = { type: string; text?: { type: string; text: string }; elements?: Array<Record<string, any>> };

/** `call_args_list[-1].kwargs["blocks"]`. */
function lastBlocks(postSlackMessage: SlackMock): Block[] {
  const options = lastCall(postSlackMessage)[1];
  assert.ok(options && Object.hasOwn(options, "blocks"), "no blocks keyword");
  return options.blocks as Block[];
}

/** `call.args[0]` of every generate_text call. */
function prompts(generateText: GenerateMock): string[] {
  return generateText.calls.map((call) => call[0]);
}

function assertIn(needle: string, haystack: string): void {
  assert.ok(haystack.includes(needle), `expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
}

function assertNotIn(needle: string, haystack: string): void {
  assert.ok(!haystack.includes(needle), `expected ${JSON.stringify(needle)} not in ${JSON.stringify(haystack)}`);
}

/** `haystack.count(needle)` for a non-empty needle. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

function richText(value: string): Record<string, unknown> {
  return { type: "rich_text", rich_text: [{ plain_text: value }] };
}

function select(value: string): Record<string, unknown> {
  return { type: "select", select: { name: value } };
}

function multiSelect(values: readonly string[]): Record<string, unknown> {
  return { type: "multi_select", multi_select: values.map((v) => ({ name: v })) };
}

function relation(trackIds: readonly string[]): Record<string, unknown> {
  return {
    type: "relation",
    relation: trackIds.map((trackId) => ({ id: trackId })),
  };
}

type Page = { id?: string; properties: Record<string, any> };

function personPage(
  pageId: string,
  name: string,
  trackIds: readonly string[] = [],
  extraProperties: Record<string, unknown> = {},
): Page {
  const properties: Record<string, unknown> = { Name: { type: "title", title: [{ plain_text: name }] } };
  if (trackIds.length > 0) {
    properties["Track Goal"] = relation(trackIds);
  }
  Object.assign(properties, extraProperties);
  return { id: pageId, properties };
}

type InteractionPageOptions = {
  type?: string | null;
  title?: string | null;
  notes?: string | null;
  personIds?: readonly string[];
  trackIds?: readonly string[];
};

/** interaction_page(interaction_date=None, type_=None, title=None, notes=None, person_ids=("p1",), track_ids=()) */
function interactionPage(
  interactionDate: string | null = null,
  { type = null, title = null, notes = null, personIds = ["p1"], trackIds = [] }: InteractionPageOptions = {},
): Page {
  const properties: Record<string, unknown> = {
    People: {
      type: "relation",
      relation: personIds.map((personId) => ({ id: personId })),
    },
  };
  if (interactionDate !== null) {
    properties["Date"] = { type: "date", date: { start: interactionDate } };
  }
  if (type !== null) {
    properties["Type"] = select(type);
  }
  if (title !== null) {
    properties["Name"] = { type: "title", title: [{ plain_text: title }] };
  }
  if (notes !== null) {
    properties["Notes"] = richText(notes);
  }
  if (trackIds.length > 0) {
    properties["Track"] = relation(trackIds);
  }
  return { properties };
}

function trackPage(name: string, priority: string | null = null, purpose: string | null = null): Page {
  const page: Page = {
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
  if (purpose !== null) {
    page.properties["Purpose"] = richText(purpose);
  }
  return page;
}

function notionResponse(results: unknown): HttpResponse {
  return jsonResponse({ results });
}

function notionGetResponse(jsonBody: unknown): HttpResponse {
  return jsonResponse(jsonBody);
}

function interactionTypeSchemaResponse(options: readonly string[] = ["Coffee"]): HttpResponse {
  return notionGetResponse({
    properties: {
      Type: {
        type: "select",
        select: { options: options.map((option) => ({ name: option })) },
      },
    },
  });
}

/**
 * A notion_get that answers both Track-page GETs and the Add Interaction
 * button's Type-schema GET from a single mock, routed by URL.
 */
function notionGetWithTypeSchema(trackPageResponse: NotionResponse, typeOptions: readonly string[] = ["Coffee"]) {
  const typeResponse = interactionTypeSchemaResponse(typeOptions);
  return notionGetRouted((url) => (url === INTERACTIONS_TYPE_SCHEMA_URL ? typeResponse : trackPageResponse));
}

function profileOf(
  pageId: string,
  name: string,
  { contextFields = [], trackIds = [] }: { contextFields?: [string, string][]; trackIds?: string[] } = {},
): PersonProfile {
  return { pageId, name, contextFields, trackIds };
}

function interactionOf({
  date = null,
  type = null,
  title = null,
  notes = null,
  trackIds = [],
}: Partial<{ date: string | null; type: string | null; title: string | null; notes: string | null; trackIds: string[] }>): InteractionSummary {
  return { date, type, title, notes, trackIds };
}

/** TrackContext(name, purpose=None) */
function trackContext(name: string, purpose: string | null = null): TrackContext {
  return { name, purpose };
}

function environment(): Record<string, string> {
  return {
    NOTION_API_KEY: "secret-token",
    NOTION_PEOPLE_DATA_SOURCE_ID: "people-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };
}

function trackSelectorEnvironment(): Record<string, string> {
  return { ...environment(), NOTION_TRACKS_DATA_SOURCE_ID: "tracks-id" };
}

/** handle_people_suggest(name, post, notion_post, generate_text, env, today=FIXED_TODAY, sleep=Mock(), notion_get=...) */
async function runSuggest(
  personName: string,
  postSlackMessage: SlackMock,
  notionPost: NotionPostMock,
  generateText: GenerateText,
  env: Record<string, string>,
  notionGet: NotionGetMock | null = null,
): Promise<void> {
  await handlePeopleSuggest(personName, postSlackMessage, notionPost, generateText, env, {
    today: FIXED_TODAY,
    sleep: sleepMock(),
    notionGet,
  });
}

function janeAndNoInteractions(): NotionPostMock {
  return notionPostMock([notionResponse([personPage("p1", "Jane Doe")]), notionResponse([])]);
}

// ---------------------------------------------------------------------------
// ResolvePersonTests
// ---------------------------------------------------------------------------

test("test_exact_match_resolves", async () => {
  const notionPost = notionPostReturning(notionResponse([personPage("p1", "Jane Doe")]));

  const [profile, isAmbiguous] = await resolvePerson(notionPost, "secret", "people-id", "Jane Doe", sleepMock());

  assert.equal(profile?.name, "Jane Doe");
  assert.equal(profile?.pageId, "p1");
  assert.equal(isAmbiguous, false);
});

test("test_case_insensitive_match_resolves", async () => {
  const notionPost = notionPostReturning(notionResponse([personPage("p1", "Jane Doe")]));

  const [profile, isAmbiguous] = await resolvePerson(notionPost, "secret", "people-id", "jane doe", sleepMock());

  assert.equal(profile?.name, "Jane Doe");
  assert.equal(isAmbiguous, false);
});

test("test_no_match_returns_none", async () => {
  const notionPost = notionPostReturning(notionResponse([personPage("p1", "Jane Doe")]));

  const [profile, isAmbiguous] = await resolvePerson(notionPost, "secret", "people-id", "Someone Else", sleepMock());

  assert.equal(profile, null);
  assert.equal(isAmbiguous, false);
});

test("test_multiple_exact_matches_are_reported_as_ambiguous_without_guessing", async () => {
  const notionPost = notionPostReturning(
    notionResponse([personPage("p1", "Jane Doe"), personPage("p2", "Jane Doe")]),
  );

  const [profile, isAmbiguous] = await resolvePerson(notionPost, "secret", "people-id", "Jane Doe", sleepMock());

  assert.equal(profile, null);
  assert.equal(isAmbiguous, true);
});

test("test_malformed_person_pages_do_not_block_resolution", async () => {
  const notionPost = notionPostReturning(notionResponse([{ id: "p1", properties: {} }, personPage("p2", "Jane Doe")]));

  const [profile, isAmbiguous] = await resolvePerson(notionPost, "secret", "people-id", "Jane Doe", sleepMock());

  assert.equal(profile?.name, "Jane Doe");
  assert.equal(isAmbiguous, false);
});

// ---------------------------------------------------------------------------
// PersonProfileContextTests
// ---------------------------------------------------------------------------

test("test_only_existing_recognized_fields_are_included", () => {
  const page = personPage("p1", "Jane Doe", [], {
    "Why this person": richText("Former colleague"),
    "Relationship intent": select("Mentor"),
    Interests: multiSelect(["Climbing", "Chess"]),
    // "Relationship status", "Relationship strength", "Expertise",
    // and "Notes" are intentionally absent.
    "Contact cadence": select("3 months"),
    LinkedIn: { type: "url", url: "https://linkedin.example/jane" },
  });

  const profile = personProfileFromNotionPage(page);

  const fieldLabels = (profile as PersonProfile).contextFields.map(([label]) => label);
  assert.ok(fieldLabels.includes("Why this person"));
  assert.ok(fieldLabels.includes("Relationship intent"));
  assert.ok(fieldLabels.includes("Interests"));
  assert.ok(!fieldLabels.includes("Relationship status"));
  assert.ok(!fieldLabels.includes("Notes"));
  // Fields outside the suggested-context list must never leak through.
  assert.ok(!fieldLabels.includes("Contact cadence"));
  assert.ok(!fieldLabels.includes("LinkedIn"));
});

test("test_empty_text_field_is_treated_as_absent", () => {
  const page = personPage("p1", "Jane Doe", [], { Notes: richText("   ") });

  const profile = personProfileFromNotionPage(page);

  assert.deepEqual((profile as PersonProfile).contextFields, []);
});

test("test_unrecognized_property_type_is_safely_omitted", () => {
  const page = personPage("p1", "Jane Doe", [], { Notes: { type: "checkbox", checkbox: true } });

  const profile = personProfileFromNotionPage(page);

  assert.deepEqual((profile as PersonProfile).contextFields, []);
});

test("test_missing_name_returns_none", () => {
  const page = { id: "p1", properties: {} };

  assert.equal(personProfileFromNotionPage(page), null);
});

// ---------------------------------------------------------------------------
// PersonProfileTrackTests
// ---------------------------------------------------------------------------

test("test_track_goal_relation_is_captured", () => {
  const page = personPage("p1", "Jane Doe", ["track-1", "track-2"]);

  const profile = personProfileFromNotionPage(page);

  assert.deepEqual((profile as PersonProfile).trackIds, ["track-1", "track-2"]);
});

test("test_missing_track_goal_is_empty", () => {
  const page = personPage("p1", "Jane Doe");

  const profile = personProfileFromNotionPage(page);

  assert.deepEqual((profile as PersonProfile).trackIds, []);
});

test("test_malformed_track_goal_relation_is_safely_ignored", () => {
  const page = personPage("p1", "Jane Doe");
  page.properties["Track Goal"] = { type: "rich_text", rich_text: [] };

  const profile = personProfileFromNotionPage(page);

  assert.deepEqual((profile as PersonProfile).trackIds, []);
});

// ---------------------------------------------------------------------------
// ExtractPropertyTextTests
// ---------------------------------------------------------------------------

test("test_multi_select_joins_names", () => {
  const properties = { Interests: multiSelect(["Climbing", "Chess"]) };

  assert.equal(extractPropertyText(properties, "Interests"), "Climbing, Chess");
});

test("test_missing_property_returns_none", () => {
  assert.equal(extractPropertyText({}, "Notes"), null);
});

// ---------------------------------------------------------------------------
// ExtractRelationIdsTests
// ---------------------------------------------------------------------------

test("test_reads_relation_ids", () => {
  const properties = { Tracks: relation(["t1", "t2"]) };

  assert.deepEqual(extractRelationIds(properties, "Tracks"), ["t1", "t2"]);
});

test("test_missing_property_returns_empty", () => {
  assert.deepEqual(extractRelationIds({}, "Tracks"), []);
});

test("test_non_relation_property_returns_empty", () => {
  const properties = { Tracks: select("Not a relation") };

  assert.deepEqual(extractRelationIds(properties, "Tracks"), []);
});

test("test_relation_entries_missing_id_are_skipped", () => {
  const properties = { Tracks: { type: "relation", relation: [{}, { id: "t1" }] } };

  assert.deepEqual(extractRelationIds(properties, "Tracks"), ["t1"]);
});

// ---------------------------------------------------------------------------
// FetchRecentInteractionsTests
// ---------------------------------------------------------------------------

test("test_bounded_to_five_and_sorted_query", async () => {
  const pages = [1, 2, 3].map((i) =>
    interactionPage(`2026-0${i}-01`, { type: "Call", title: `Chat ${i}`, notes: "n" }),
  );
  const notionPost = notionPostReturning(notionResponse(pages));

  const summaries = await fetchRecentInteractions(notionPost, "secret", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.equal(summaries.length, 3);
  const requestJson = notionPost.calls.at(-1)?.[1].json as Record<string, any>;
  assert.equal(requestJson["page_size"], MAX_SUGGESTION_INTERACTIONS);
  assert.deepEqual(requestJson["sorts"], [{ property: "Date", direction: "descending" }]);
  assert.equal(requestJson["filter"]["and"][0]["relation"]["contains"], "p1");
});

test("test_more_than_five_results_are_still_bounded_defensively", async () => {
  const pages = [1, 2, 3, 4, 5, 6, 7].map((i) => interactionPage(`2026-01-0${i}`, { title: `Chat ${i}` }));
  const notionPost = notionPostReturning(notionResponse(pages));

  const summaries = await fetchRecentInteractions(notionPost, "secret", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.equal(summaries.length, MAX_SUGGESTION_INTERACTIONS);
});

test("test_malformed_interaction_is_skipped", async () => {
  const pages = [{}, interactionPage("2026-01-01", { title: "Chat" })];
  const notionPost = notionPostReturning(notionResponse(pages));

  const summaries = await fetchRecentInteractions(notionPost, "secret", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.title, "Chat");
});

test("test_no_interactions_returns_empty_list", async () => {
  const notionPost = notionPostReturning(notionResponse([]));

  const summaries = await fetchRecentInteractions(notionPost, "secret", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.deepEqual(summaries, []);
});

test("test_tracks_relation_is_captured", async () => {
  const pages = [interactionPage("2026-01-01", { title: "Chat", trackIds: ["t1", "t2"] })];
  const notionPost = notionPostReturning(notionResponse(pages));

  const summaries = await fetchRecentInteractions(notionPost, "secret", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.deepEqual(summaries[0]?.trackIds, ["t1", "t2"]);
});

test("test_missing_tracks_relation_is_empty", async () => {
  const pages = [interactionPage("2026-01-01", { title: "Chat" })];
  const notionPost = notionPostReturning(notionResponse(pages));

  const summaries = await fetchRecentInteractions(notionPost, "secret", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.deepEqual(summaries[0]?.trackIds, []);
});

// ---------------------------------------------------------------------------
// CollectTrackIdsTests
// ---------------------------------------------------------------------------

test("test_dedupes_across_person_and_interactions_preserving_order", () => {
  const profile = profileOf("p1", "Jane", { trackIds: ["t1", "t2"] });
  const interactions = [interactionOf({ trackIds: ["t2", "t3"] }), interactionOf({ trackIds: ["t3"] })];

  assert.deepEqual(collectTrackIds(profile, interactions), ["t1", "t2", "t3"]);
});

test("test_no_tracks_returns_empty", () => {
  const profile = profileOf("p1", "Jane");

  assert.deepEqual(collectTrackIds(profile, []), []);
});

// ---------------------------------------------------------------------------
// ResolveTracksTests
// ---------------------------------------------------------------------------

test("test_resolves_each_distinct_id_once", async () => {
  const notionGet = notionGetReturning(notionGetResponse(trackPage("AI Network")));

  const resolved = await resolveTracks(["t1", "t1"], notionGet, "secret", sleepMock());

  assert.deepEqual(resolved, new Map([["t1", trackContext("AI Network")]]));
  assert.equal(notionGet.calls.length, 1);
});

test("test_multiple_distinct_tracks_each_resolved", async () => {
  const notionGet = notionGetMock([
    notionGetResponse(trackPage("AI Network")),
    notionGetResponse(trackPage("Investors")),
  ]);

  const resolved = await resolveTracks(["t1", "t2"], notionGet, "secret", sleepMock());

  assert.deepEqual(
    resolved,
    new Map([
      ["t1", trackContext("AI Network")],
      ["t2", trackContext("Investors")],
    ]),
  );
});

test("test_purpose_is_read_from_the_same_page_without_extra_requests", async () => {
  const notionGet = notionGetReturning(notionGetResponse(trackPage("AI Network", null, "Learn about AI")));

  const resolved = await resolveTracks(["t1"], notionGet, "secret", sleepMock());

  assert.deepEqual(resolved, new Map([["t1", trackContext("AI Network", "Learn about AI")]]));
  assert.equal(notionGet.calls.length, 1);
});

test("test_notion_get_none_resolves_nothing", async () => {
  const resolved = await resolveTracks(["t1"], null, "secret", sleepMock());

  assert.deepEqual(resolved, new Map());
});

test("test_malformed_track_page_is_omitted_not_raised", async () => {
  const notionGet = notionGetReturning(notionGetResponse({ properties: {} }));

  const resolved = await resolveTracks(["t1"], notionGet, "secret", sleepMock());

  assert.deepEqual(resolved, new Map([["t1", null]]));
});

test("test_no_track_ids_makes_no_requests", async () => {
  const notionGet = unusedNotionGet();

  const resolved = await resolveTracks([], notionGet, "secret", sleepMock());

  assert.deepEqual(resolved, new Map());
  assert.equal(notionGet.calls.length, 0);
});

// ---------------------------------------------------------------------------
// ExtractTrackPurposeTests
// ---------------------------------------------------------------------------

test("test_present_purpose_is_returned", () => {
  const page = trackPage("AI Network", null, "Learn about AI");

  assert.equal(extractTrackPurpose(page), "Learn about AI");
});

test("test_multi_part_and_multi_line_purpose_is_joined_on_one_line", () => {
  const page = trackPage("AI Network");
  page.properties["Purpose"] = {
    type: "rich_text",
    rich_text: [{ plain_text: "Learn about\n" }, { plain_text: " AI  agents" }],
  };

  assert.equal(extractTrackPurpose(page), "Learn about AI agents");
});

test("test_empty_purpose_is_none", () => {
  assert.equal(extractTrackPurpose(trackPage("AI Network", null, "  ")), null);
});

test("test_missing_purpose_is_none", () => {
  assert.equal(extractTrackPurpose(trackPage("AI Network")), null);
});

test("test_non_text_purpose_is_none", () => {
  const page = trackPage("AI Network");
  page.properties["Purpose"] = select("Learn about AI");

  assert.equal(extractTrackPurpose(page), null);
});

test("test_malformed_rich_text_is_none", () => {
  const page = trackPage("AI Network");
  page.properties["Purpose"] = { type: "rich_text", rich_text: null };

  assert.equal(extractTrackPurpose(page), null);
});

test("test_long_purpose_is_truncated_to_the_limit (S10: 500-char Purpose)", () => {
  const page = trackPage("AI Network", null, "x".repeat(MAX_TRACK_PURPOSE_CHARS + 50));

  const purpose = extractTrackPurpose(page) as string;

  assert.equal(pyLen(purpose), MAX_TRACK_PURPOSE_CHARS);
  assert.ok(purpose.endsWith("…"));
});

test("test_purpose_exactly_at_the_limit_is_kept_whole", () => {
  const text = "x".repeat(MAX_TRACK_PURPOSE_CHARS);

  assert.equal(extractTrackPurpose(trackPage("AI", null, text)), text);
});

// ---------------------------------------------------------------------------
// GroupRelevantTracksTests
// ---------------------------------------------------------------------------

function groupProfile(trackIds: string[] = []): PersonProfile {
  return profileOf("p1", "Jane", { trackIds });
}

test("test_person_tracks_come_first_and_interaction_only_tracks_second", () => {
  const [personTracks, otherTracks] = groupRelevantTracks(
    groupProfile(["t1"]),
    ["t1", "t2"],
    new Map([
      ["t1", trackContext("AI Network", "Learn")],
      ["t2", trackContext("Investors")],
    ]),
  );

  assert.deepEqual(personTracks, [trackContext("AI Network", "Learn")]);
  assert.deepEqual(otherTracks, [trackContext("Investors")]);
});

test("test_track_linked_from_person_and_interaction_is_a_person_track_once", () => {
  const profile = groupProfile(["t1"]);
  const interactions = [interactionOf({ trackIds: ["t1", "t2"] })];
  const trackIds = collectTrackIds(profile, interactions);

  const [personTracks, otherTracks] = groupRelevantTracks(
    profile,
    trackIds,
    new Map([
      ["t1", trackContext("AI Network")],
      ["t2", trackContext("Investors")],
    ]),
  );

  assert.deepEqual(personTracks, [trackContext("AI Network")]);
  assert.deepEqual(otherTracks, [trackContext("Investors")]);
});

test("test_filters_unresolved_and_dedupes_names", () => {
  const [personTracks, otherTracks] = groupRelevantTracks(
    groupProfile(),
    ["t1", "t2", "t3"],
    new Map<string, TrackContext | null>([
      ["t1", trackContext("AI Network")],
      ["t2", null],
      ["t3", trackContext("AI Network")],
    ]),
  );

  assert.deepEqual(personTracks, []);
  assert.deepEqual(otherTracks, [trackContext("AI Network")]);
});

test("test_empty_when_nothing_resolved", () => {
  assert.deepEqual(groupRelevantTracks(groupProfile(), ["t1"], new Map()), [[], []]);
});

// ---------------------------------------------------------------------------
// BuildSuggestionPromptTests
// ---------------------------------------------------------------------------

test("test_no_interactions_says_so_explicitly (BuildSuggestionPromptTests)", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildSuggestionPrompt(profile, []);

  assertIn("No previous Interactions are recorded.", prompt);
});

test("test_interaction_fields_are_included_when_present", () => {
  const profile = profileOf("p1", "Jane Doe");
  const interactions = [interactionOf({ date: "2026-08-01", type: "Call", title: "Catch-up", notes: "Talked shop" })];

  const prompt = buildSuggestionPrompt(profile, interactions);

  assertIn("Date: 2026-08-01", prompt);
  assertIn("Type: Call", prompt);
  assertIn("Title: Catch-up", prompt);
  assertIn("Notes: Talked shop", prompt);
});

test("test_track_names_never_appear_in_the_message_prompt", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildSuggestionPrompt(profile, []);

  assertNotIn("RELEVANT TRACKS", prompt);
  assertNotIn("Track", prompt);
});

test("test_grouped_track_context_and_privacy_rule_are_included", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildSuggestionPrompt(profile, [], {
    personTracks: [trackContext("AI Network", "Learn about AI")],
    otherTracks: [trackContext("Investors", "Raise a seed round")],
  });

  assertIn(
    "RELEVANT TRACKS:\n" +
      "Person's Tracks (primary focus):\n" +
      "- AI Network\n" +
      "  Purpose: Learn about AI\n" +
      "Other Tracks from recent Interactions (secondary):\n" +
      "- Investors\n" +
      "  Purpose: Raise a seed round\n",
    prompt,
  );
  assertIn("Never name a Track, quote a Purpose, or present a Purpose as the user's\n  goal in the draft.", prompt);
  assertIn("may bring up the underlying topic", prompt);
  assertIn("The Person's Tracks are the main focus", prompt);
});

// ---------------------------------------------------------------------------
// BuildRecapPromptTests
// ---------------------------------------------------------------------------

test("test_no_tracks_omits_track_section", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], { personTracks: [] });

  assertNotIn("RELEVANT TRACKS", prompt);
  assertNotIn("Rules for Track context", prompt);
});

test("test_track_names_are_included_verbatim", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], {
    personTracks: [trackContext("AI Network"), trackContext("Investors")],
  });

  assertIn("RELEVANT TRACKS:", prompt);
  assertIn("- AI Network", prompt);
  assertIn("- Investors", prompt);
});

test("test_person_tracks_are_listed_before_interaction_only_tracks", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], {
    personTracks: [trackContext("AI Network", "Learn about AI")],
    otherTracks: [trackContext("Investors")],
    nextStepKinds: ["Coffee", "Wait"],
  });

  const personIndex = prompt.indexOf("Person's Tracks (primary focus):");
  const otherIndex = prompt.indexOf("Other Tracks from recent Interactions (secondary):");
  assert.ok(personIndex >= 0 && otherIndex >= 0);
  assert.ok(personIndex < otherIndex);
  assertIn("- AI Network\n  Purpose: Learn about AI\n", prompt);
  // A Track without a Purpose is still listed by name alone.
  assertIn("- Investors\n", prompt);
  assertNotIn("- Investors\n  Purpose:", prompt);
  assertIn("Treat those Purposes as the main focus", prompt);
});

test("test_group_heading_is_omitted_when_that_group_is_empty", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], { personTracks: [], otherTracks: [trackContext("Investors")] });

  assertNotIn("Person's Tracks (primary focus):", prompt);
  assertIn("Other Tracks from recent Interactions (secondary):\n- Investors", prompt);
});

test("test_no_interactions_says_so_explicitly (BuildRecapPromptTests)", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], { personTracks: [] });

  assertIn("No previous Interactions are recorded.", prompt);
});

test("test_no_next_step_kinds_does_not_request_a_next_step", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], { nextStepKinds: [] });

  assertNotIn("NEXT STEP", prompt);
});

test("test_next_step_kinds_are_supplied_verbatim_with_the_request", () => {
  const profile = profileOf("p1", "Jane Doe");

  const prompt = buildRecapPrompt(profile, [], {
    personTracks: [trackContext("AI Network")],
    nextStepKinds: ["Coffee", "Intro", "Wait"],
  });

  assertIn("ALLOWED NEXT STEP KINDS:\n- Coffee\n- Intro\n- Wait", prompt);
  assertIn('"NEXT STEP:"', prompt);
  assertIn("- AI Network", prompt);
});

test("test_next_step_request_replaces_the_bullet_list_only_rule", () => {
  // The recap-only "Respond with only the bullet list ... no heading"
  // rule would contradict the NEXT STEP: heading the model is asked for.
  const profile = profileOf("p1", "Jane Doe");

  const withNextStep = buildRecapPrompt(profile, [], { nextStepKinds: ["Coffee", "Wait"] });
  const recapOnly = buildRecapPrompt(profile, [], { nextStepKinds: [] });

  assertNotIn("with\n  no heading, preamble, or explanation", withNextStep);
  assertIn("followed by the next-step part described below", withNextStep);
  assertIn("with\n  no heading, preamble, or explanation", recapOnly);
  assertNotIn("next-step part", recapOnly);
});

// ---------------------------------------------------------------------------
// AllowedNextStepKindsTests
// ---------------------------------------------------------------------------

test("test_live_types_plus_wait", () => {
  assert.deepEqual(allowedNextStepKinds(["Coffee", "Call"]), ["Coffee", "Call", "Wait"]);
});

test("test_no_live_types_offers_nothing_not_even_wait", () => {
  assert.deepEqual(allowedNextStepKinds([]), []);
});

test("test_wait_already_a_live_type_is_not_duplicated", () => {
  assert.deepEqual(allowedNextStepKinds(["Wait", "Coffee"]), ["Wait", "Coffee"]);
});

// ---------------------------------------------------------------------------
// SplitRecapAndNextStepsTests
// ---------------------------------------------------------------------------

const KINDS = ["Coffee", "Intro", "Wait"];

test("test_valid_kinds_and_wait_are_kept", () => {
  const [recap, nextSteps] = splitRecapAndNextSteps(
    "- Recap one.\n- Recap two.\nNEXT STEP:\n" + "- Coffee: Catch up on the new role.\n- Wait: Just met last week.",
    KINDS,
  );

  assert.equal(recap, "- Recap one.\n- Recap two.");
  assert.deepEqual(nextSteps, [
    ["Coffee", "Catch up on the new role."],
    ["Wait", "Just met last week."],
  ]);
});

test("test_unknown_or_inexact_kind_is_dropped (S5: kinds validated)", () => {
  const [, nextSteps] = splitRecapAndNextSteps(
    "- Recap.\nNEXT STEP:\n- Lunch: Invent a lunch.\n" +
      "- coffee: Wrong case.\n- **Coffee**: Bold.\n- Intro: Introduce to Bob.",
    KINDS,
  );

  assert.deepEqual(nextSteps, [["Intro", "Introduce to Bob."]]);
});

test("test_more_than_two_suggestions_are_truncated (S5: at most 2)", () => {
  const [, nextSteps] = splitRecapAndNextSteps(
    "- Recap.\nNEXT STEP:\n- Coffee: One.\n- Intro: Two.\n- Wait: Three.",
    KINDS,
  );

  assert.deepEqual(nextSteps, [
    ["Coffee", "One."],
    ["Intro", "Two."],
  ]);
});

test("test_missing_next_step_part_keeps_the_whole_recap", () => {
  const [recap, nextSteps] = splitRecapAndNextSteps("- Recap.", KINDS);

  assert.equal(recap, "- Recap.");
  assert.deepEqual(nextSteps, []);
});

test("test_malformed_next_step_lines_yield_no_suggestions", () => {
  const [recap, nextSteps] = splitRecapAndNextSteps(
    "- Recap.\nNEXT STEP:\nMaybe grab a coffee sometime.\n- Coffee:\n- Coffee",
    KINDS,
  );

  assert.equal(recap, "- Recap.");
  assert.deepEqual(nextSteps, []);
});

test("test_off_format_marker_lines_still_split_off_the_next_step", async (t) => {
  for (const marker of ["**NEXT STEP:**", "Next step:", "### Next steps:", "**Suggested next step**:"]) {
    await t.test(`marker=${marker}`, () => {
      const [recap, nextSteps] = splitRecapAndNextSteps(`- Recap.\n${marker}\n- Lunch: Not allowed.\n- Coffee: Idea.`, KINDS);

      assert.equal(recap, "- Recap.");
      assert.deepEqual(nextSteps, [["Coffee", "Idea."]]);
    });
  }
});

test("test_suggestion_on_the_marker_line_is_validated_not_leaked", () => {
  let [recap, nextSteps] = splitRecapAndNextSteps("- Recap.\nNEXT STEP: - Lunch: Not allowed.\n", KINDS);

  assert.equal(recap, "- Recap.");
  assert.deepEqual(nextSteps, []);

  [, nextSteps] = splitRecapAndNextSteps("- Recap.\nNext step: Coffee: Idea.", KINDS);
  assert.deepEqual(nextSteps, [["Coffee", "Idea."]]);
});

test("test_recap_bullet_mentioning_next_step_is_not_a_marker", () => {
  const response = "- Next step: they promised to send the deck.";

  assert.deepEqual(splitRecapAndNextSteps(response, KINDS), [response, []]);
});

test("test_kind_containing_a_colon_is_matched_exactly", () => {
  const [, nextSteps] = splitRecapAndNextSteps(
    "- Recap.\nNEXT STEP:\n- Call: video: Quick face-to-face check-in.",
    ["Call", "Call: video", "Wait"],
  );

  assert.deepEqual(nextSteps, [["Call: video", "Quick face-to-face check-in."]]);
});

test("test_star_bullets_are_accepted", () => {
  const [, nextSteps] = splitRecapAndNextSteps("- Recap.\nNEXT STEP:\n* Coffee: Idea.", KINDS);

  assert.deepEqual(nextSteps, [["Coffee", "Idea."]]);
});

test("test_no_allowed_kinds_returns_response_untouched", () => {
  const response = "- Recap.\nNEXT STEP:\n- Coffee: Idea.";

  assert.deepEqual(splitRecapAndNextSteps(response, []), [response, []]);
});

// ---------------------------------------------------------------------------
// NextStepFormattingTests
// ---------------------------------------------------------------------------

test("test_no_next_steps_formats_to_nothing", () => {
  assert.equal(formatNextSteps([]), "");
});

test("test_text_fallback_places_next_step_between_recap_and_message", () => {
  const nextStepText = formatNextSteps([["Coffee", "Catch up."]]);

  assert.equal(
    formatFullReply("- Recap.", "Suggested message for Jane:\n\nHi", { nextStepText }),
    "Context:\n- Recap.\n\nSuggested next step:\n- Coffee: Catch up.\n\n" + "Suggested message for Jane:\n\nHi",
  );
});

test("test_text_fallback_without_next_step_is_unchanged", () => {
  assert.equal(formatFullReply("- Recap.", "Message"), "Context:\n- Recap.\n\nMessage");
});

test("test_oversized_next_step_block_is_truncated (S10: 3000-char section)", () => {
  const profile = profileOf("p1", "Jane Doe");
  const nextStepText = formatNextSteps([["Coffee", "x".repeat(4000)]]);

  const blocks = buildSuggestionBlocks(profile, "- Recap.", "Message", { nextStepText }) as Block[];

  const sections = blocks.map((block) => (block.text as { text: string }).text);
  assert.equal(sections.length, 3);
  assert.ok((sections[1] as string).startsWith("Suggested next step:\n- Coffee: "));
  assert.ok(pyLen(sections[1] as string) <= SLACK_SECTION_TEXT_LIMIT);
});

// ---------------------------------------------------------------------------
// HandlePeopleSuggestTests
// ---------------------------------------------------------------------------

test("test_valid_exact_match_returns_gemini_draft_to_slack", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap bullet.", "Hey Jane, been a while!"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  assert.equal(generateText.calls.length, 2);
  const output = lastMessage(postSlackMessage);
  assert.equal(output, "Context:\n- Recap bullet.\n\n" + "Suggested message for Jane Doe:\n\nHey Jane, been a while!");
  assert.deepEqual(
    notionPost.calls.map((call) => call[0]),
    [PEOPLE_URL, INTERACTIONS_URL],
  );
});

test("test_reply_includes_an_add_interaction_button_carrying_the_person_page_id", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap bullet.", "Hey Jane, been a while!"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  const blocks = lastBlocks(postSlackMessage);
  const actionsBlock = blocks.find((block) => block.type === "actions") as Block;
  const button = (actionsBlock.elements as Array<Record<string, any>>)[0] as Record<string, any>;
  assert.equal(button["action_id"], ADD_INTERACTION_ACTION_ID);
  assert.deepEqual(JSON.parse(button["value"]), { page_id: "p1", name: "Jane Doe", types: ["Coffee"] });
});

test("test_reply_includes_a_context_recap_block_before_the_message_block", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap bullet.", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  const blocks = lastBlocks(postSlackMessage);
  const sectionBlocks = blocks.filter((block) => block.type === "section");
  assert.equal(sectionBlocks.length, 2);
  assertIn("Context:\n- Recap bullet.", (sectionBlocks[0] as Block).text?.text as string);
  assertIn("Suggested message for Jane Doe:", (sectionBlocks[1] as Block).text?.text as string);
});

test("test_an_oversized_gemini_draft_is_truncated_to_slacks_block_text_limit (S10: 3000-char section)", async () => {
  // Gemini's output has no length cap of its own; a draft over Slack's
  // ~3000-char section-block limit must not break the reply.
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const oversizedDraft = "x".repeat(4000);
  const generateText = generateMock(["- Recap bullet.", oversizedDraft]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  // The plain-text fallback (a much higher Slack limit) keeps the full
  // draft; only the rendered section block is truncated.
  const output = lastMessage(postSlackMessage);
  assertIn(oversizedDraft, output);

  const blocks = lastBlocks(postSlackMessage);
  const messageBlock = blocks.find(
    (block) => block.type === "section" && (block.text?.text as string).includes("Suggested message"),
  ) as Block;
  assert.ok(pyLen(messageBlock.text?.text as string) <= SLACK_SECTION_TEXT_LIMIT);
});

test("test_case_insensitive_input_still_resolves", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("jane doe", postSlackMessage, notionPost, generateText, environment());

  const output = lastMessage(postSlackMessage);
  assertIn("Suggested message for Jane Doe:", output);
});

test("test_person_not_found_produces_a_clear_message_without_calling_gemini", async () => {
  const notionPost = notionPostReturning(notionResponse([]));
  const postSlackMessage = slackMock();
  const generateText = unusedGenerate();

  await runSuggest("Nobody Here", postSlackMessage, notionPost, generateText, environment());

  assert.equal(generateText.calls.length, 0);
  const output = lastMessage(postSlackMessage);
  assert.equal(output, personNotFoundMessage("Nobody Here"));
  // Only the Person search happened; Interactions were never queried.
  assert.equal(notionPost.calls.length, 1);
});

test("test_ambiguous_match_fails_safely_without_guessing", async () => {
  const notionPost = notionPostReturning(
    notionResponse([personPage("p1", "Jane Doe"), personPage("p2", "Jane Doe")]),
  );
  const postSlackMessage = slackMock();
  const generateText = unusedGenerate();

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  assert.equal(generateText.calls.length, 0);
  const output = lastMessage(postSlackMessage);
  assert.equal(output, ambiguousPersonMessage("Jane Doe"));
});

test("test_transient_gemini_failure_replies_safely_without_crashing", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const transientError = Object.assign(new Error("payload leak marker XYZ123"), { response: { status_code: 503 } });
  const generateText = generateRaising(transientError);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  const output = lastMessage(postSlackMessage);
  assert.equal(output, "Gemini is currently experiencing high demand. Please try again shortly.");
  assertNotIn("XYZ123", output);
  assert.equal(lastCall(postSlackMessage)[1]?.threadTs, "123.456");
});

test("test_gemini_credential_failure_still_propagates_uncaught", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  // Mirrors main.raise_gemini_credential_error's output: a plain
  // RuntimeError with no status-code attributes, matching issue #3.
  const credentialError = new Error("Gemini authentication failed (HTTP 401).");
  const generateText = generateRaising(credentialError);

  await assert.rejects(
    runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment()),
    (error: unknown) => error === credentialError,
  );
});

test("test_unrelated_gemini_failure_still_propagates_uncaught", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const unrelatedError = Object.assign(new Error("unexpected malformed response"), { response: { status_code: 400 } });
  const generateText = generateRaising(unrelatedError);

  await assert.rejects(
    runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment()),
    (error: unknown) => error === unrelatedError,
  );
});

test("test_person_with_no_interactions_still_produces_a_draft", async () => {
  const notionPost = janeAndNoInteractions();
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Generic honest draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  const messagePrompt = prompts(generateText)[1] as string;
  assertIn("No previous Interactions are recorded.", messagePrompt);
});

test("test_gemini_receives_only_intended_person_and_interaction_context (S6)", async () => {
  const notionPost = notionPostMock([
    notionResponse([
      personPage("p1", "Jane Doe", [], {
        "Why this person": richText("Former colleague"),
        "Contact cadence": select("3 months"),
        LinkedIn: {
          type: "url",
          url: "https://linkedin.example/jane",
        },
      }),
    ]),
    notionResponse([interactionPage("2026-08-01", { type: "Call", title: "Catch-up", notes: "Talked shop" })]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  for (const prompt of prompts(generateText)) {
    assertIn("Name: Jane Doe", prompt);
    assertIn("Why this person: Former colleague", prompt);
    assertIn("Date: 2026-08-01", prompt);
    assertIn("Title: Catch-up", prompt);
    // Fields outside the suggested-context list must not reach Gemini.
    assertNotIn("3 months", prompt);
    assertNotIn("linkedin.example", prompt);
  }
});

test("test_notion_failure_produces_a_safe_message_without_calling_gemini", async () => {
  const failing = jsonResponse({ results: "not-a-list" });
  const notionPost = notionPostReturning(failing);
  const postSlackMessage = slackMock();
  const generateText = unusedGenerate();

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  assert.equal(generateText.calls.length, 0);
  const output = lastMessage(postSlackMessage);
  assert.equal(output, PEOPLE_SUGGEST_FAILURE_MESSAGE);
});

test("test_notion_failure_error_type_is_the_shared_people_error", () => {
  // Guards the cross-module contract: people-suggest relies on people-due's
  // fetch/query helpers raising PeopleDueCommandError.
  assert.ok(PeopleDueCommandError.prototype instanceof Error);
});

test("test_person_with_one_track_includes_it_in_the_recap_context", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([interactionPage("2026-08-01", { type: "Coffee", title: "Coffee chat", trackIds: ["track-1"] })]),
  ]);
  const notionGet = notionGetWithTypeSchema(notionGetResponse(trackPage("AI Network")));
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Relevant Track: AI Network", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const recapPrompt = prompts(generateText)[0] as string;
  assertIn("RELEVANT TRACKS:", recapPrompt);
  assertIn("- AI Network", recapPrompt);
  // Bounded to one GET per distinct Track id (a second notion_get call
  // is the unrelated Add Interaction Type-schema fetch).
  const trackCalls = notionGet.calls.filter((call) => call[0] === "https://api.notion.com/v1/pages/track-1");
  assert.equal(trackCalls.length, 1);
});

test("test_multiple_interactions_referencing_the_same_track_resolve_it_once", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([
      interactionPage("2026-08-01", { title: "Coffee", trackIds: ["track-1"] }),
      interactionPage("2026-07-01", { title: "Call", trackIds: ["track-1"] }),
    ]),
  ]);
  const notionGet = notionGetWithTypeSchema(notionGetResponse(trackPage("AI Network")));
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  // Bounded to one GET per distinct Track id, never per Interaction (a
  // second notion_get call is the unrelated Add Interaction Type-schema
  // fetch).
  const trackCalls = notionGet.calls.filter((call) => call[0] === "https://api.notion.com/v1/pages/track-1");
  assert.equal(trackCalls.length, 1);
});

test("test_multiple_relevant_tracks_are_all_included", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["track-1"])]),
    notionResponse([interactionPage("2026-08-01", { title: "Coffee", trackIds: ["track-2"] })]),
  ]);
  // As in Python, the third GET (the Type schema) finds the side effects
  // exhausted; the request error becomes a TaskListCommandError, so the
  // best-effort Type fetch yields no options.
  const notionGet = notionGetMock([
    notionGetResponse(trackPage("AI Network")),
    notionGetResponse(trackPage("Investors")),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const recapPrompt = prompts(generateText)[0] as string;
  assertIn("- AI Network", recapPrompt);
  assertIn("- Investors", recapPrompt);
});

test("test_no_track_omits_track_context_and_makes_no_track_requests", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([interactionPage("2026-08-01", { title: "Coffee" })]),
  ]);
  const notionGet = notionGetReturning(interactionTypeSchemaResponse());
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const recapPrompt = prompts(generateText)[0] as string;
  assertNotIn("RELEVANT TRACKS", recapPrompt);
  // The only notion_get call is the unrelated Add Interaction
  // Type-schema fetch, not a Track request.
  assert.equal(notionGet.calls.length, 1);
  assert.equal(notionGet.calls.at(-1)?.[0], INTERACTIONS_TYPE_SCHEMA_URL);
});

test("test_malformed_track_relation_is_treated_as_no_track", async () => {
  const person = personPage("p1", "Jane Doe");
  person.properties["Track Goal"] = { type: "rich_text", rich_text: [] };
  const notionPost = notionPostMock([notionResponse([person]), notionResponse([])]);
  const notionGet = notionGetReturning(interactionTypeSchemaResponse());
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const recapPrompt = prompts(generateText)[0] as string;
  assertNotIn("RELEVANT TRACKS", recapPrompt);
  // The only notion_get call is the unrelated Add Interaction
  // Type-schema fetch, not a Track request.
  assert.equal(notionGet.calls.length, 1);
  assert.equal(notionGet.calls.at(-1)?.[0], INTERACTIONS_TYPE_SCHEMA_URL);
});

test("test_unresolvable_track_is_omitted_without_inventing_a_name", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["track-1"])]),
    notionResponse([]),
  ]);
  const notionGet = notionGetReturning(notionGetResponse({ properties: {} }));
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const recapPrompt = prompts(generateText)[0] as string;
  assertNotIn("RELEVANT TRACKS", recapPrompt);
});

test("test_both_prompts_receive_grouped_tracks_with_purposes_as_private_context", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["track-1"])]),
    notionResponse([interactionPage("2026-08-01", { title: "Coffee", trackIds: ["track-2", "track-1"] })]),
  ]);
  const trackPages: Record<string, Page> = {
    "https://api.notion.com/v1/pages/track-1": trackPage("AI Network", null, "Learn about AI"),
    "https://api.notion.com/v1/pages/track-2": trackPage("Investors", null, "Raise a seed round"),
  };
  const typeResponse = interactionTypeSchemaResponse();
  const notionGet = notionGetRouted((url) => {
    if (url === INTERACTIONS_TYPE_SCHEMA_URL) return typeResponse;
    const page = trackPages[url];
    if (page === undefined) throw new Error(`KeyError: ${url}`);
    return notionGetResponse(page);
  });
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const expectedTracks =
    "Person's Tracks (primary focus):\n" +
    "- AI Network\n" +
    "  Purpose: Learn about AI\n" +
    "Other Tracks from recent Interactions (secondary):\n" +
    "- Investors\n" +
    "  Purpose: Raise a seed round\n";
  const [recapPrompt, messagePrompt] = prompts(generateText) as [string, string];
  assertIn(expectedTracks, recapPrompt);
  assertIn(expectedTracks, messagePrompt);
  // A Track linked from both the Person and an Interaction appears once.
  assert.equal(countOf(messagePrompt, "- AI Network"), 1);
  assertIn("Never name a Track, quote a Purpose", messagePrompt);
  // Still one GET per distinct Track id; Purpose needs no extra request.
  const trackCalls = notionGet.calls.filter((call) => call[0] !== INTERACTIONS_TYPE_SCHEMA_URL);
  assert.equal(trackCalls.length, 2);
});

test("test_person_tracks_take_precedence_within_the_track_cap (S10: 5 Tracks)", async () => {
  const personTrackIds = Array.from({ length: MAX_SUGGESTION_TRACKS - 1 }, (_, i) => `person-${i}`);
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", personTrackIds)]),
    notionResponse([interactionPage("2026-08-01", { title: "Coffee", trackIds: ["other-1", "other-2"] })]),
  ]);
  const typeResponse = interactionTypeSchemaResponse();
  const notionGet = notionGetRouted((url) =>
    url === INTERACTIONS_TYPE_SCHEMA_URL
      ? typeResponse
      : notionGetResponse(trackPage(url.slice(url.lastIndexOf("/") + 1))),
  );
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const recapPrompt = prompts(generateText)[0] as string;
  for (const trackId of personTrackIds) {
    assertIn(`- ${trackId}\n`, recapPrompt);
  }
  assertIn("- other-1\n", recapPrompt);
  assertNotIn("other-2", recapPrompt);
  const trackCalls = notionGet.calls.filter((call) => call[0] !== INTERACTIONS_TYPE_SCHEMA_URL);
  assert.equal(trackCalls.length, MAX_SUGGESTION_TRACKS);
});

test("test_person_with_no_tracks_gets_the_unchanged_prompts (S6: exact prompts)", async () => {
  const person = personPage("p1", "Jane Doe");
  const notionPost = notionPostMock([notionResponse([person]), notionResponse([])]);
  const notionGet = notionGetReturning(interactionTypeSchemaResponse());
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);

  const contextBlock = buildContextBlock(personProfileFromNotionPage(person) as PersonProfile, []);
  assert.equal(
    prompts(generateText)[0],
    `${RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION}\n\n${contextBlock}` + "\nALLOWED NEXT STEP KINDS:\n- Coffee\n- Wait\n",
  );
  assert.equal(prompts(generateText)[1], `${SUGGESTION_SYSTEM_INSTRUCTION}\n\n${contextBlock}`);
});

test("test_purpose_text_is_never_written_to_logs", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["track-1"])]),
    notionResponse([]),
  ]);
  const notionGet = notionGetWithTypeSchema(
    notionGetResponse(trackPage("AI Network", null, "Secret purpose text")),
  );
  const postSlackMessage = slackMock();
  const generateText = generateMock(["- Recap", "Draft"]);

  // redirect_stdout / redirect_stderr / assertNoLogs: record everything the
  // process writes (passing it through, so the test runner is unaffected) and
  // every console call.
  const written: string[] = [];
  const consoleCalls: unknown[][] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originalConsole = consoleMethods.map((name) => console[name]);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (originalStdout as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (originalStderr as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  for (const name of consoleMethods) {
    console[name] = (...args: unknown[]) => {
      consoleCalls.push(args);
    };
  }
  try {
    await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    consoleMethods.forEach((name, index) => {
      console[name] = originalConsole[index] as (typeof console)[typeof name];
    });
  }

  assert.deepEqual(consoleCalls, []);
  assertNotIn("Secret purpose text", written.join(""));
});

test("test_no_notion_get_supplied_skips_track_resolution", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["track-1"])]),
    notionResponse([]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment());

  const recapPrompt = prompts(generateText)[0] as string;
  assertNotIn("RELEVANT TRACKS", recapPrompt);
});

// ---------------------------------------------------------------------------
// AddInteractionTrackSelectorTests
// ---------------------------------------------------------------------------

function selectableTrackPage(trackId: string, name: string): Page {
  return {
    id: trackId,
    properties: { Navn: { type: "title", title: [{ plain_text: name }] } },
  };
}

/** add_interaction_button(post_slack_message): the first element of the actions block. */
function addInteractionButtonOf(postSlackMessage: SlackMock): Record<string, any> {
  const blocks = lastBlocks(postSlackMessage);
  const actionsBlock = blocks.find((block) => block.type === "actions") as Block;
  return (actionsBlock.elements as Array<Record<string, any>>)[0] as Record<string, any>;
}

test("test_person_with_no_track_has_no_default_but_still_offers_all_tracks", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([]),
    notionResponse([selectableTrackPage("t1", "AI Network")]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  const button = addInteractionButtonOf(postSlackMessage);
  const value = JSON.parse(button["value"]);
  assert.deepEqual(value["tracks"], [{ id: "t1", name: "AI Network" }]);
  assert.ok(!Object.hasOwn(value, "default_track_id"));
});

test("test_person_with_exactly_one_track_preselects_it", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["t1"])]),
    notionResponse([]),
    notionResponse([selectableTrackPage("t1", "AI Network"), selectableTrackPage("t2", "Investors")]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  const button = addInteractionButtonOf(postSlackMessage);
  const value = JSON.parse(button["value"]);
  assert.equal(value["default_track_id"], "t1");
});

test("test_person_with_multiple_tracks_has_no_default_but_can_still_choose", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["t1", "t2"])]),
    notionResponse([]),
    notionResponse([selectableTrackPage("t1", "AI Network"), selectableTrackPage("t2", "Investors")]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  const button = addInteractionButtonOf(postSlackMessage);
  const value = JSON.parse(button["value"]);
  assert.ok(!Object.hasOwn(value, "default_track_id"));
  assert.deepEqual(new Set(value["tracks"].map((track: { id: string }) => track.id)), new Set(["t1", "t2"]));
});

test("test_no_tracks_data_source_configured_omits_the_track_selector", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["t1"])]),
    notionResponse([]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  const env = {
    NOTION_API_KEY: "secret-token",
    NOTION_PEOPLE_DATA_SOURCE_ID: "people-id",
    NOTION_INTERACTIONS_DATA_SOURCE_ID: "interactions-id",
  };

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, env,
    notionGetReturning(interactionTypeSchemaResponse()));

  const button = addInteractionButtonOf(postSlackMessage);
  assert.deepEqual(JSON.parse(button["value"]), { page_id: "p1", name: "Jane Doe", types: ["Coffee"] });
  // No extra Notion call was made to list Tracks.
  assert.equal(notionPost.calls.length, 2);
});

test("test_a_track_listing_failure_does_not_break_the_rest_of_the_reply", async () => {
  const failing = new RaisingResponse(new Error("boom"));
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([]),
    failing,
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  // The reply still goes out; Track selection is simply unavailable.
  const button = addInteractionButtonOf(postSlackMessage);
  assert.deepEqual(JSON.parse(button["value"]), { page_id: "p1", name: "Jane Doe", types: ["Coffee"] });
});

test("test_a_track_listing_credential_failure_does_not_break_the_rest_of_the_reply (S11: degrades)", async () => {
  // A 401/403 from Notion raises NotionAuthenticationError, a distinct
  // exception type from a generic TaskListCommandError. Track selection is
  // still only an optional add-on to the reply, so this must degrade the
  // same way a generic listing failure does.
  const error = Object.assign(new Error("unauthorized"), { response: { status_code: 401 } });
  const failing = new RaisingResponse(error);
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([]),
    failing,
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock(["Recap", "Draft"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(),
    notionGetReturning(interactionTypeSchemaResponse()));

  const button = addInteractionButtonOf(postSlackMessage);
  assert.deepEqual(JSON.parse(button["value"]), { page_id: "p1", name: "Jane Doe", types: ["Coffee"] });
  const output = lastMessage(postSlackMessage);
  assertIn("Suggested message for Jane Doe:", output);
});

// ---------------------------------------------------------------------------
// NextStepSuggestionTests
// ---------------------------------------------------------------------------

async function runNextStepSuggest(
  recapResponse: string,
  notionGet: NotionGetMock,
): Promise<[SlackMock, GenerateMock]> {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe")]),
    notionResponse([]),
    notionResponse([]),
  ]);
  const postSlackMessage = slackMock();
  const generateText = generateMock([recapResponse, "Hey Jane!"]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet);
  return [postSlackMessage, generateText];
}

test("test_valid_next_steps_are_shown_alongside_recap_message_and_button (S5)", async () => {
  const [postSlackMessage, generateText] = await runNextStepSuggest(
    "- Recap bullet.\nNEXT STEP:\n- Coffee: Catch up in person.\n" + "- Lunch: Not a live Type.\n- Wait: Recently in touch.\n",
    notionGetReturning(interactionTypeSchemaResponse(["Coffee", "Call"])),
  );

  assert.equal(generateText.calls.length, 2);
  const [recapPrompt, messagePrompt] = prompts(generateText) as [string, string];
  assertIn("ALLOWED NEXT STEP KINDS:\n- Coffee\n- Call\n- Wait", recapPrompt);
  // The message call is unchanged: no next-step request or kinds leak in.
  assert.ok(messagePrompt.startsWith(SUGGESTION_SYSTEM_INSTRUCTION));
  assertNotIn("NEXT STEP", messagePrompt);

  const output = lastMessage(postSlackMessage);
  assert.equal(
    output,
    "Context:\n- Recap bullet.\n\n" +
      "Suggested next step:\n- Coffee: Catch up in person.\n" +
      "- Wait: Recently in touch.\n\n" +
      "Suggested message for Jane Doe:\n\nHey Jane!",
  );
  const blocks = lastBlocks(postSlackMessage);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["section", "section", "section", "actions"],
  );
  assert.equal(blocks[0]?.text?.text, "Context:\n- Recap bullet.");
  assertIn("Suggested next step:", blocks[1]?.text?.text as string);
  assertNotIn("Lunch", blocks[1]?.text?.text as string);
  assertIn("Suggested message for Jane Doe:", blocks[2]?.text?.text as string);
});

test("test_unparseable_next_step_part_omits_the_section_without_error", async () => {
  const [postSlackMessage] = await runNextStepSuggest(
    "- Recap bullet.\n**Next step:**\nPerhaps grab a coffee?",
    notionGetReturning(interactionTypeSchemaResponse()),
  );

  const output = lastMessage(postSlackMessage);
  assert.equal(output, "Context:\n- Recap bullet.\n\nSuggested message for Jane Doe:\n\nHey Jane!");
});

test("test_missing_next_step_part_still_shows_the_recap", async () => {
  const [postSlackMessage] = await runNextStepSuggest(
    "- Recap bullet.",
    notionGetReturning(interactionTypeSchemaResponse()),
  );

  const output = lastMessage(postSlackMessage);
  assert.equal(output, "Context:\n- Recap bullet.\n\nSuggested message for Jane Doe:\n\nHey Jane!");
});

test("test_no_valid_suggestions_omits_the_section", async () => {
  const [postSlackMessage] = await runNextStepSuggest(
    "- Recap bullet.\nNEXT STEP:\n- Lunch: Not allowed.",
    notionGetReturning(interactionTypeSchemaResponse()),
  );

  const output = lastMessage(postSlackMessage);
  assert.equal(output, "Context:\n- Recap bullet.\n\nSuggested message for Jane Doe:\n\nHey Jane!");
});

test("test_type_options_unavailable_means_no_next_step_requested_or_shown", async () => {
  const failing = jsonResponse({ properties: {} });
  const [postSlackMessage, generateText] = await runNextStepSuggest("- Recap bullet.", notionGetReturning(failing));

  assert.equal(generateText.calls.length, 2);
  for (const prompt of prompts(generateText)) {
    assertNotIn("NEXT STEP", prompt);
  }
  const output = lastMessage(postSlackMessage);
  assertNotIn("Suggested next step", output);
  assertIn("Suggested message for Jane Doe:", output);
});

// ---------------------------------------------------------------------------
// TS-only: byte identity with Python (prompts, text, blocks)
// ---------------------------------------------------------------------------

// Generated by tests/equivalence/generate_people_suggest_prompts.py under Python 3.12.
const fixture = JSON.parse(
  readFileSync(new URL("./equivalence/people-suggest-prompts.json", import.meta.url), "utf8"),
);

// Generated by tests/equivalence/generate_python_compat_golden.py under Python 3.12.
const compatGolden = JSON.parse(
  readFileSync(new URL("./equivalence/golden/python-compat.json", import.meta.url), "utf8"),
);

type ProfileSpec = { page_id: string; name: string; context_fields: [string, string][]; track_ids: string[] };
type InteractionSpec = { date: string | null; type: string | null; title: string | null; notes: string | null; track_ids: string[] };

function profileFromSpec(spec: ProfileSpec): PersonProfile {
  return { pageId: spec.page_id, name: spec.name, contextFields: spec.context_fields, trackIds: spec.track_ids };
}

function interactionFromSpec(spec: InteractionSpec): InteractionSummary {
  return { date: spec.date, type: spec.type, title: spec.title, notes: spec.notes, trackIds: spec.track_ids };
}

test("prompt fixture: every prompt constant, message and bound equals Python's, byte for byte (S6, S10)", async (t) => {
  assert.equal(fixture.meta.python, "3.12");
  const constants = fixture.constants as Record<string, unknown>;
  assert.equal(Object.keys(constants).length, 19);
  for (const [name, expected] of Object.entries(constants)) {
    await t.test(name, () => {
      const actual = (peopleSuggest as Record<string, unknown>)[name];
      assert.deepStrictEqual(Array.isArray(actual) ? [...actual] : actual, expected);
    });
  }
  for (const row of fixture.messages as Array<{ input: string; person_not_found: string; ambiguous: string }>) {
    assert.equal(personNotFoundMessage(row.input), row.person_not_found);
    assert.equal(ambiguousPersonMessage(row.input), row.ambiguous);
  }
});

test("prompt fixture: built recap and draft prompts equal Python's, byte for byte (S6)", async (t) => {
  assert.ok(fixture.prompts.length >= 6);
  for (const row of fixture.prompts) {
    await t.test(row.name, () => {
      const profile = profileFromSpec(row.profile);
      const interactions = (row.interactions as InteractionSpec[]).map(interactionFromSpec);
      const personTracks = row.person_tracks as TrackContext[];
      const otherTracks = row.other_tracks as TrackContext[];
      assert.equal(
        buildRecapPrompt(profile, interactions, { personTracks, otherTracks, nextStepKinds: row.next_step_kinds }),
        row.recap_prompt,
      );
      assert.equal(buildSuggestionPrompt(profile, interactions, { personTracks, otherTracks }), row.suggestion_prompt);
    });
  }
});

test("next-step fixture: splitRecapAndNextSteps equals Python on line boundaries, Unicode, bullets and markers (S5)", async (t) => {
  assert.ok(fixture.splits.length >= 10);
  for (const [index, row] of (fixture.splits as Array<Record<string, any>>).entries()) {
    await t.test(`case ${index}: ${JSON.stringify(row["response"])}`, () => {
      assert.deepEqual(splitRecapAndNextSteps(row["response"], row["allowed_kinds"]), [row["recap"], row["next_steps"]]);
    });
  }
});

test("blocks fixture: reply text and Block Kit blocks, including the button value string, equal Python's", async (t) => {
  for (const row of fixture.blocks as Array<Record<string, any>>) {
    await t.test(row["name"], () => {
      const profile = profileFromSpec(row["profile"]);
      const nextStepText = formatNextSteps(row["next_steps"] as NextStep[]);
      const message = formatSuggestionMessage(profile.name, row["answer"]);
      assert.equal(formatFullReply(row["recap"], message, { nextStepText }), row["reply_text"]);
      // Exact structure, and the button `value` is the same string
      // (pyJsonDumps), not merely equal after parsing.
      assert.deepStrictEqual(
        buildSuggestionBlocks(profile, row["recap"], message, {
          tracks: row["tracks"],
          defaultTrackId: row["default_track_id"],
          interactionTypes: row["interaction_types"],
          nextStepText,
        }),
        row["blocks"],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// TS-only: NEXT_STEP_MARKER_PATTERN against Python's `re`
// ---------------------------------------------------------------------------

/** `NEXT_STEP_MARKER_PATTERN.match(line)`: group(1), or null. */
function markerGroup(line: string): string | null {
  const match = NEXT_STEP_MARKER_PATTERN.exec(line);
  return match ? (match[1] as string) : null;
}

test("NEXT_STEP_MARKER_PATTERN: group 1 equals Python's re.match on tricky marker lines", () => {
  const rows = compatGolden.next_step_marker as Array<{ input: string; output: string | null }>;
  assert.ok(rows.length >= 40);
  const failures = rows.filter((row) => markerGroup(row.input) !== row.output);
  assert.deepEqual(failures, []);
});

test("NEXT_STEP_MARKER_PATTERN: every letter, whitespace and `.` position matches exactly Python's code points (exhaustive)", () => {
  const letters = new Map<string, number[]>(
    (compatGolden.regex_ignorecase_letters as Array<{ input: string; output: number[] }>).map((row) => [
      row.input,
      row.output,
    ]),
  );
  const space: number[] = compatGolden.regex_space;
  assert.deepEqual(compatGolden.regex_dot_excluded, [0x0a]);
  const asterisk = 0x2a;
  const underscore = 0x5f;
  const hash = 0x23;
  const colon = 0x3a;

  // [template, index, expected code points]: the template matches with the
  // character at `index`, and a probe replaces that character with each code
  // point in turn. The expected sets are composed from Python's per-element
  // sets; e.g. the optional "s" of "steps?" may also be skipped, so any
  // character of the following [\s*_]* or the colon itself fits there too.
  const template = "suggested next steps:";
  const letterAt = (index: number) => letters.get(template[index] as string) as number[];
  const probes: Array<[string, number, number[]]> = [
    ...[0, 1, 2, 4, 6, 8, 10, 12, 18].map((index): [string, number, number[]] => [template, index, letterAt(index)]),
    [template, 9, space],
    [template, 14, space],
    [template, 19, [...letterAt(19), ...space, asterisk, underscore, colon]],
    [template, 20, [colon]],
    [" next step:", 0, [...space, hash, asterisk, underscore]],
    // "next stepX:" also matches with X = the optional "s", or X = ":".
    ["next step :", 9, [...space, asterisk, underscore, ...(letters.get("s") as number[]), colon]],
  ];
  assert.deepEqual(
    [...new Set([0, 1, 2, 4, 6, 8, 10, 12, 18].map((index) => template[index]))].sort(),
    [...letters.keys()].sort(),
  );

  for (const [probeTemplate, index, expected] of probes) {
    const before = probeTemplate.slice(0, index);
    const after = probeTemplate.slice(index + 1);
    const matched: number[] = [];
    for (let cp = 0; cp < 0x110000; cp += 1) {
      if (NEXT_STEP_MARKER_PATTERN.test(before + String.fromCodePoint(cp) + after)) matched.push(cp);
    }
    assert.deepEqual(matched, [...new Set(expected)].sort((a, b) => a - b), `${probeTemplate} @ ${index}`);
  }

  // `(.*)$`: after "next step:" every code point but \n is captured, unless
  // [\s*_]* consumed it first; a trailing \n is allowed by Python's `$`.
  const consumed = new Set([...space, asterisk, underscore]);
  const wrong: number[] = [];
  for (let cp = 0; cp < 0x110000; cp += 1) {
    const ch = String.fromCodePoint(cp);
    const expectedGroup = consumed.has(cp) || cp === 0x0a ? "" : ch;
    if (markerGroup(`next step:${ch}`) !== expectedGroup) wrong.push(cp);
  }
  assert.deepEqual(wrong, []);
});

// ---------------------------------------------------------------------------
// TS-only: security invariants and Python-semantics details
// ---------------------------------------------------------------------------

test("S10: the people-suggest bounds are Python's values", () => {
  assert.equal(MAX_SUGGESTION_INTERACTIONS, 5);
  assert.equal(MAX_SUGGESTION_TRACKS, 5);
  assert.equal(MAX_TRACK_PURPOSE_CHARS, 500);
  assert.equal(MAX_NEXT_STEP_SUGGESTIONS, 2);
  assert.equal(SLACK_SECTION_TEXT_LIMIT, 3000);
});

test("S10: truncateForSlackSection keeps 3000 code points and cuts longer text to 2999 + … (astral characters count once)", () => {
  const exact = "x".repeat(2997) + "😀😀😀";
  assert.equal(truncateForSlackSection(exact), exact);

  const over = "x".repeat(2997) + "😀😀😀😀";
  const cut = truncateForSlackSection(over);
  assert.equal(pyLen(cut), 3000);
  assert.equal(cut, "x".repeat(2997) + "😀😀…");
});

test("S10: extractTrackPurpose truncates by code points to 499 + … and keeps exactly 500", () => {
  const exact = "😀".repeat(500);
  assert.equal(extractTrackPurpose(trackPage("AI", null, exact)), exact);

  const purpose = extractTrackPurpose(trackPage("AI", null, "😀".repeat(501))) as string;
  assert.equal(purpose, "😀".repeat(499) + "…");
});

test("S10: the Interactions query asks for 5 and at most 5 summaries are used, even from a longer response", async () => {
  const pages = Array.from({ length: 9 }, (_, i) => interactionPage(`2026-01-0${i + 1}`, { title: `Chat ${i}` }));
  const notionPost = notionPostReturning(notionResponse(pages));

  const summaries = await fetchRecentInteractions(notionPost, "k", "interactions-id", "p1", FIXED_TODAY, sleepMock());

  assert.deepEqual(
    summaries.map((summary) => summary.title),
    ["Chat 0", "Chat 1", "Chat 2", "Chat 3", "Chat 4"],
  );
  assert.equal(notionPost.calls.length, 1);
  assert.deepEqual(notionPost.calls[0]?.[1].json, {
    page_size: 5,
    filter: {
      and: [
        { property: "People", relation: { contains: "p1" } },
        { property: "Date", date: { is_not_empty: true } },
        { property: "Date", date: { on_or_before: "2026-09-20" } },
      ],
    },
    sorts: [{ property: "Date", direction: "descending" }],
  });
});

test("S5: Gemini output triggers no side effect: Notion is only read, and the only post after Gemini is the reply", async () => {
  const notionPost = notionPostMock([
    notionResponse([personPage("p1", "Jane Doe", ["t1"])]),
    notionResponse([]),
    notionResponse([selectableTrackPage("t1", "AI Network")]),
  ]);
  const notionGet = notionGetWithTypeSchema(notionGetResponse(trackPage("AI Network")));
  const postSlackMessage = slackMock();
  // Model output that looks like instructions or extra kinds.
  const generateText = generateMock([
    "- Recap.\nNEXT STEP:\n- Coffee: Book it now.\n- Create Task: Add a Notion task.\n- Wait: Later.\n- Coffee: Third.",
    "Draft. NEXT STEP:\n- Coffee: in the draft",
  ]);

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(), notionGet);

  assert.deepEqual(
    notionPost.calls.map((call) => call[0]),
    [PEOPLE_URL, INTERACTIONS_URL, "https://api.notion.com/v1/data_sources/tracks-id/query"],
  );
  assert.deepEqual(
    notionGet.calls.map((call) => call[0]),
    ["https://api.notion.com/v1/pages/t1", INTERACTIONS_TYPE_SCHEMA_URL],
  );
  assert.equal(postSlackMessage.calls.length, 2);
  const output = lastMessage(postSlackMessage);
  // Only validated kinds, at most 2, are shown; the draft is shown as text.
  assertIn("Suggested next step:\n- Coffee: Book it now.\n- Wait: Later.\n\n", output);
  assertNotIn("Create Task", output);
  assertNotIn("Third", output);
});

test("transient Gemini failures: 429 and 5xx from response.status_code, status_code or code post the fixed reply; others are re-thrown", async (t) => {
  const transient: Array<[string, Record<string, unknown>]> = [
    ["429 via response.status_code", { response: { status_code: 429 } }],
    ["500 via status_code", { status_code: 500 }],
    ["599 via code", { code: 599 }],
  ];
  for (const [label, attributes] of transient) {
    for (const failingCall of [0, 1]) {
      await t.test(`${label}, failing call ${failingCall}`, async () => {
        const error = Object.assign(new Error("leak"), attributes);
        const values: (string | Error)[] = failingCall === 0 ? [error] : ["- Recap", error];
        const postSlackMessage = slackMock();

        await runSuggest("Jane Doe", postSlackMessage, janeAndNoInteractions(), generateMock(values), environment());

        assert.deepEqual(postSlackMessage.calls.at(-1), [GEMINI_TRANSIENT_FAILURE_MESSAGE, { threadTs: "123.456" }]);
        assert.equal(postSlackMessage.calls.length, 2);
      });
    }
  }
  const permanent: Array<[string, Record<string, unknown>]> = [
    ["428", { response: { status_code: 428 } }],
    ["600", { status_code: 600 }],
    ["499 via code", { code: 499 }],
    ['"503" as a string', { status_code: "503" }],
    ["no status", {}],
  ];
  for (const [label, attributes] of permanent) {
    await t.test(`${label} is re-thrown`, async () => {
      const error = Object.assign(new Error("other"), attributes);
      const postSlackMessage = slackMock();

      await assert.rejects(
        runSuggest("Jane Doe", postSlackMessage, janeAndNoInteractions(), generateRaising(error), environment()),
        (thrown: unknown) => thrown === error,
      );
      assert.equal(postSlackMessage.calls.length, 1);
    });
  }
});

test("externalErrorStatusCode: response.status_code first, then status_code, then code; only ints count", () => {
  assert.equal(externalErrorStatusCode({ response: { status_code: 503 }, status_code: 429, code: 500 }), 503);
  assert.equal(externalErrorStatusCode({ response: { status_code: "503" }, status_code: 429 }), 429);
  assert.equal(externalErrorStatusCode({ response: null, status_code: 503.5, code: 500 }), 500);
  assert.equal(externalErrorStatusCode({ code: "ECONNRESET" }), null);
  assert.equal(externalErrorStatusCode(new Error("plain")), null);
  assert.equal(externalErrorStatusCode(null), null);
  // bool is an int in Python: True stops the search (and is not transient).
  assert.equal(externalErrorStatusCode({ status_code: true, code: 503 }), 1);
  assert.equal(isTransientGeminiStatus(externalErrorStatusCode({ status_code: true, code: 503 })), false);
  assert.deepEqual(
    [428, 429, 430, 499, 500, 503, 599, 600, null].map((status) => isTransientGeminiStatus(status)),
    [false, true, false, false, true, true, true, false, false],
  );
});

test("S11: a 401 on a Track page fails the command before Gemini; a 403 only omits that Track", async (t) => {
  await t.test("401 propagates NotionAuthenticationError", async () => {
    const notionPost = notionPostMock([notionResponse([personPage("p1", "Jane Doe", ["t1"])]), notionResponse([])]);
    const notionGet = notionGetReturning(errorResponse(401));
    const generateText = unusedGenerate();
    const postSlackMessage = slackMock();

    await assert.rejects(
      runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, environment(), notionGet),
      NotionAuthenticationError,
    );
    assert.equal(notionGet.calls.length, 1);
    assert.equal(generateText.calls.length, 0);
    assert.equal(postSlackMessage.calls.length, 1);
  });
  await t.test("403 is not a credential failure here; the Track is left out", async () => {
    const notionPost = notionPostMock([notionResponse([personPage("p1", "Jane Doe", ["t1"])]), notionResponse([])]);
    const notionGet = notionGetRouted((url) =>
      url === INTERACTIONS_TYPE_SCHEMA_URL ? interactionTypeSchemaResponse() : errorResponse(403),
    );
    const generateText = generateMock(["- Recap", "Draft"]);

    await runSuggest("Jane Doe", slackMock(), notionPost, generateText, environment(), notionGet);

    assertNotIn("RELEVANT TRACKS", prompts(generateText)[0] as string);
    // Not retried: one Track GET, then the Type schema.
    assert.equal(notionGet.calls.length, 2);
  });
});

test("S11: a 401 on the Type schema degrades: no button, no next step, and the unavailable note", async () => {
  const notionGet = notionGetReturning(errorResponse(401));
  const [postSlackMessage, generateText] = await runNextStepSuggest("- Recap bullet.\nNEXT STEP:\n- Coffee: X.", notionGet);

  for (const prompt of prompts(generateText)) {
    assertNotIn("NEXT STEP", prompt);
  }
  assert.equal(
    lastMessage(postSlackMessage),
    "Context:\n- Recap bullet.\nNEXT STEP:\n- Coffee: X.\n\nSuggested message for Jane Doe:\n\nHey Jane!\n\n" +
      INTERACTION_TYPE_UNAVAILABLE_NOTE,
  );
  assert.ok(lastBlocks(postSlackMessage).every((block) => block.type === "section"));
});

test("handlePeopleSuggest: only a PeopleDueCommandError gets the failure message; a TaskListCommandError propagates", async () => {
  const notionPost = notionPostReturning(errorResponse(503));
  const postSlackMessage = slackMock();
  const sleep = sleepMock();

  await assert.rejects(
    handlePeopleSuggest("Jane Doe", postSlackMessage, notionPost, unusedGenerate(), environment(), {
      today: FIXED_TODAY,
      sleep,
    }),
    TaskListCommandError,
  );
  assert.equal(notionPost.calls.length, 3);
  assert.deepEqual(sleep.calls, [[1], [2]]);
  assert.deepEqual(postSlackMessage.calls, [["/people suggest Jane Doe"]]);
});

test("handlePeopleSuggest: the call order is Person, Interactions, Track GETs, Track listing, Type schema, recap, draft", async () => {
  const log: string[] = [];
  const notionPost = mock(async (url: string, _options: PostOptions): Promise<NotionResponse> => {
    log.push(`post ${url}`);
    if (url === PEOPLE_URL) return notionResponse([personPage("p1", "Jane Doe", ["t1"])]);
    if (url === INTERACTIONS_URL) return notionResponse([interactionPage("2026-08-01", { title: "C", trackIds: ["t2"] })]);
    return notionResponse([selectableTrackPage("t1", "AI Network")]);
  });
  const notionGet = notionGetRouted((url) => {
    log.push(`get ${url}`);
    return url === INTERACTIONS_TYPE_SCHEMA_URL ? interactionTypeSchemaResponse() : notionGetResponse(trackPage("T"));
  });
  const generateText = mock(async (prompt: string) => {
    log.push(prompt.startsWith(SUGGESTION_SYSTEM_INSTRUCTION) ? "draft" : "recap");
    return "text";
  });
  const postSlackMessage = mock(async (message: string, _options?: SlackOptions) => {
    log.push(`slack ${message.split("\n")[0]}`);
    return { ts: "1.2" };
  });

  await runSuggest("Jane Doe", postSlackMessage, notionPost, generateText, trackSelectorEnvironment(), notionGet);

  assert.deepEqual(log, [
    "slack /people suggest Jane Doe",
    `post ${PEOPLE_URL}`,
    `post ${INTERACTIONS_URL}`,
    "get https://api.notion.com/v1/pages/t1",
    "get https://api.notion.com/v1/pages/t2",
    "post https://api.notion.com/v1/data_sources/tracks-id/query",
    `get ${INTERACTIONS_TYPE_SCHEMA_URL}`,
    "recap",
    "draft",
    "slack Context:",
  ]);
  assert.equal(postSlackMessage.calls.at(-1)?.[1]?.threadTs, "1.2");
});

test("handlePeopleSuggest: a missing generateText throws a TypeError after the Notion reads, as calling None does", async () => {
  const postSlackMessage = slackMock();

  await assert.rejects(
    handlePeopleSuggest("Jane Doe", postSlackMessage, janeAndNoInteractions(), null, environment(), {
      today: FIXED_TODAY,
      sleep: sleepMock(),
    }),
    TypeError,
  );
  assert.equal(postSlackMessage.calls.length, 1);
});

test("resolvePerson: casefold matching (ß and SS) against whitespace-collapsed Notion names, one query of page_size 100", async () => {
  const notionPost = notionPostReturning(
    notionResponse([
      personPage("p1", "  Jürgen   Straße "),
      personPage("p2", "Ærø"),
      { id: "", properties: { Name: { type: "title", title: [{ plain_text: "Jürgen Strasse" }] } } },
    ]),
  );

  const [profile, isAmbiguous] = await resolvePerson(notionPost, "k", "people-id", "JÜRGEN STRASSE", sleepMock());

  assert.equal(profile?.pageId, "p1");
  assert.equal(profile?.name, "Jürgen Straße");
  assert.equal(isAmbiguous, false);
  assert.deepEqual(notionPost.calls[0]?.[1].json, { page_size: 100 });
  // An inner double space in the typed name is not collapsed (exact match).
  const [none] = await resolvePerson(notionPost, "k", "people-id", "Jürgen  Straße", sleepMock());
  assert.equal(none, null);
});

test("Notion parsing: Python's exceptions are kept (caught for the Name, raised for context fields)", () => {
  // A non-str plain_text in the Name is a TypeError inside the try: no profile.
  assert.equal(
    personProfileFromNotionPage({ id: "p1", properties: { Name: { type: "title", title: [{ plain_text: 5 }] } } }),
    null,
  );
  // ...but in a context field it is outside the try and propagates.
  assert.throws(
    () => personProfileFromNotionPage(personPage("p1", "Jane", [], { Notes: { type: "rich_text", rich_text: [{ plain_text: 5 }] } })),
    TypeError,
  );
  // A multi_select name that is not a str: ", ".join raises TypeError.
  assert.throws(
    () => extractPropertyText({ Interests: { type: "multi_select", multi_select: [{ name: "a" }, { name: 7 }] } }, "Interests"),
    TypeError,
  );
  // Interaction pages: no usable field, or no dict properties, is skipped.
  assert.equal(interactionSummaryFromNotionPage({ properties: [] }), null);
  assert.equal(interactionSummaryFromNotionPage("not a page"), null);
  assert.equal(interactionSummaryFromNotionPage({ properties: { People: relation(["p1"]) } }), null);
  assert.deepEqual(
    interactionSummaryFromNotionPage({
      properties: {
        Date: { type: "date", date: { start: "2026-08-01T09:00:00.000+02:00" } },
        Kind: { type: "title", title: [{ plain_text: "  " }] },
        Titel: { type: "title", title: [{ plain_text: " Second title " }] },
        Type: { type: "multi_select", multi_select: [{ name: "Call" }, {}, { name: "Video" }] },
      },
    }),
    { date: "2026-08-01T09:00:00.000+02:00", type: "Call, Video", title: "Second title", notes: null, trackIds: [] },
  );
});

test("parseNextStep: bullets, the longest kind first, and code-point slicing after an astral kind", () => {
  assert.deepEqual(parseNextStep("  • Call: video: X ", ["Call", "Call: video"]), ["Call: video", "X"]);
  assert.deepEqual(parseNextStep("- 😀 Chat:  🎉 ", ["😀 Chat"]), ["😀 Chat", "🎉"]);
  assert.equal(parseNextStep("- Coffee:   ", ["Coffee"]), null);
  assert.equal(parseNextStep("-Coffee: x", ["Coffee"]), null);
  // Only one bullet is removed.
  assert.equal(parseNextStep("- - Coffee: x", ["Coffee"]), null);
});

test("buildSuggestionBlocks: the button value is Python's json.dumps output (ensure_ascii, separators)", () => {
  const profile = profileOf("p-1", "Jørgen");
  const blocks = buildSuggestionBlocks(profile, "", "Msg", {
    tracks: [{ id: "t1", name: "Århus" }],
    defaultTrackId: "t1",
    interactionTypes: ["Møde"],
  }) as Block[];

  const button = blocks.at(-1)?.elements?.[0] as Record<string, any>;
  const expected: JsonValue = {
    page_id: "p-1",
    name: "Jørgen",
    types: ["Møde"],
    tracks: [{ id: "t1", name: "Århus" }],
    default_track_id: "t1",
  };
  assert.equal(button["value"], pyJsonDumps(expected));
  assert.ok((button["value"] as string).includes(String.raw`"J\u00f8rgen"`));
});
