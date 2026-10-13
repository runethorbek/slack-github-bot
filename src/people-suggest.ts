// Port of people_suggest.py: `/people suggest <person>`. Notion access, Person
// resolution and Track resolution are deterministic; Gemini (the injected
// `generateText`) only summarizes and drafts text from the bounded context
// built here, and its output never triggers a side effect.
//
// Notion data is untrusted JSON. As in the other ported modules, it is read
// with the python-compat accessors, and each parser catches exactly what its
// Python counterpart catches: `except (AttributeError, KeyError, TypeError)`
// is isAccessError.
//
// The prompt constants and builders reproduce Python's text byte for byte
// (tests/equivalence/people-suggest-prompts.json, printed by Python).

import {
  MAX_SCANNED_PEOPLE,
  PEOPLE_PAGE_SIZE,
  PeopleDueCommandError,
  fetchNotionPages,
  queryDataSource,
  type ButtonElement,
  type SectionBlock,
} from "./people-due.ts";
import {
  AddInteractionCommandError,
  INTERACTION_TRACK_PROPERTY,
  addInteractionButton,
  fetchAvailableInteractionTypes,
  fetchAvailableTracks,
  type TrackOption,
} from "./people-interaction.ts";
import { isoformat, type PlainDate } from "./plain-date.ts";
import {
  ValueError,
  assertHashable,
  casefold,
  dictGet,
  isAccessError,
  isDict,
  iterate,
  pyLen,
  pySlice,
  pySplitWhitespace,
  pySplitlines,
  pyStrip,
  pyTruncate,
  subscript,
  truthy,
  withPyCause,
  type Dict,
} from "./python-compat.ts";
import {
  MalformedTrackPageError,
  NotionAuthenticationError,
  TaskListCommandError,
  callNotionWithRetries,
  copenhagenToday,
  environmentValue,
  notionHeaders,
  sleepSeconds,
  trackFromNotionPage,
  type Environment,
  type NotionGet,
  type NotionPost,
  type PostSlackMessage,
  type Sleep,
} from "./tasks-list.ts";

export const PEOPLE_SUGGEST_FAILURE_MESSAGE = "Unable to prepare a suggested message right now. Please try again later.";
export const GEMINI_TRANSIENT_FAILURE_MESSAGE = "Gemini is currently experiencing high demand. Please try again shortly.";
export const INTERACTION_TYPE_UNAVAILABLE_NOTE =
  "Add interaction is unavailable right now (couldn't load Notion Type options).";
export const MAX_SUGGESTION_INTERACTIONS = 5;

// Bounds the number of distinct Track ids resolved per command, so a Person
// or their recent Interactions cannot drive an unbounded number of Notion
// reads (one GET per distinct Track id, never per Interaction).
export const MAX_SUGGESTION_TRACKS = 5;

// Notion property name for the People -> Tracks relation, exactly as named
// in the live schema. The Interactions -> Tracks relation's equivalent,
// INTERACTION_TRACK_PROPERTY, is defined once in people-interaction.ts
// (which also writes it) and imported above, rather than duplicated here.
export const PERSON_TRACK_PROPERTY = "Track Goal";

// Notion Tracks property holding the Track's free-text purpose, exactly as
// named in the live schema. It is sent to Gemini (bounded by
// MAX_TRACK_PURPOSE_CHARS) and must never be logged.
export const TRACK_PURPOSE_PROPERTY = "Purpose";
export const MAX_TRACK_PURPOSE_CHARS = 500;

// Suggestions beyond this are dropped, whatever Gemini returns.
export const MAX_NEXT_STEP_SUGGESTIONS = 2;

// The one next-step kind that is not a live Interaction Type option.
export const WAIT_NEXT_STEP_KIND = "Wait";

// Delimits the recap from the next-step part in the recap call's response.
export const NEXT_STEP_MARKER = "NEXT STEP:";

// Python's `re` `\s` on str: exactly the code points for which str.isspace()
// is true (checked against Python in tests/python-compat.test.ts, golden
// "regex_space"). JS `\s` differs: it adds U+FEFF and lacks \x1c-\x1f, \x85.
const PY_RE_SPACE_CLASS = [
  [0x09, 0x0d],
  [0x1c, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
]
  .map(([first, last]) => `\\u{${(first as number).toString(16)}}-\\u{${(last as number).toString(16)}}`)
  .join("");

// Recognizes the marker line leniently - any case, wrapped in Markdown
// emphasis or a heading, or followed by a suggestion on the same line - so
// a slightly off-format next-step part is still split off and validated
// rather than leaking unvalidated into the recap. A recap bullet ("- ...")
// never matches. Group 1 is any text after the colon.
//
// Python: re.compile(r"^[\s#*_]*(?:suggested\s+)?next\s+steps?[\s*_]*:[\s*_]*(.*)$",
// re.IGNORECASE), used with .match(). The translation keeps Python's `re`
// semantics: `\s` is PY_RE_SPACE_CLASS; the `u` flag makes `i` use Unicode
// simple case folding, which (like Python's IGNORECASE) matches U+017F (long
// s) for `s` - without `u`, JS would not; `.` is `[^\n]`, since Python's `.`
// excludes only \n (JS's also excludes \r, U+2028, U+2029); and Python's `$`
// (end of string, or before a final \n) is `(?=\n?$)`.
export const NEXT_STEP_MARKER_PATTERN = new RegExp(
  `^[${PY_RE_SPACE_CLASS}#*_]*(?:suggested[${PY_RE_SPACE_CLASS}]+)?next[${PY_RE_SPACE_CLASS}]+steps?` +
    `[${PY_RE_SPACE_CLASS}*_]*:[${PY_RE_SPACE_CLASS}*_]*([^\\n]*)(?=\\n?$)`,
  "iu",
);

// Slack rejects a section block whose mrkdwn text exceeds this length. Gemini's
// draft has no length cap of its own, so the block (not the plain-text
// fallback, which has a much higher limit) must be defensively truncated.
export const SLACK_SECTION_TEXT_LIMIT = 3000;

// Notion People property display names, exactly as named in the schema.
export const PERSON_CONTEXT_PROPERTIES = [
  "Why this person",
  "Relationship intent",
  "Relationship status",
  "Relationship strength",
  "Interests",
  "Expertise",
  "Notes",
] as const;

// The multi-line prompt constants below are Python's triple-quoted strings,
// including their leading and trailing newlines. (A template literal keeps
// its line breaks as \n even if the file is checked out with CRLF.)

export const SUGGESTION_SYSTEM_INSTRUCTION = `
You are drafting a short reconnect message on behalf of the user. The user
will review the draft before deciding whether to send anything themselves.

Rules:
- Use only the context supplied below.
- Do not invent facts, relationship history, interests, commitments, or
  meetings that are not present in the supplied context.
- Do not decide who to contact; a person to contact has already been chosen.
- Draft a short, natural reconnect message.
- Keep it concise.
- Avoid sounding sales-oriented.
- Do not mention Notion, CRM fields, cadence, or internal metadata.
- If there is not enough context for a specific message, produce a generic
  but honest draft rather than inventing details.
- Respond with only the drafted message text, with no preamble or
  explanation.
`;

// The recap rules shared by both recap prompt variants; each variant adds
// its own final "Respond with" rule so the two never contradict each other.
export const RECAP_RULES = `
You are preparing a short private recap for the user about a Person, so
they can quickly recall relevant context before reaching out. This recap
is for the user only; it is never sent to the Person.

Rules:
- Use only the context supplied below.
- Do not invent facts, relationship history, interests, commitments,
  meetings, or Track membership that are not present in the supplied
  context.
- Summarize the most relevant recent Interactions in roughly 2 to 4 short
  bullet points. Do not mechanically restate every Interaction line by
  line; synthesize what matters.
- If Relevant Tracks are supplied below, add one final bullet naming them
  exactly as given, for example "Relevant Track: <name>". Never rename,
  invent, or omit a supplied Track name.
- If no Relevant Tracks are supplied, do not mention Track at all.
- If there are no previous Interactions, write one honest bullet saying
  so rather than inventing history.
`;

// Appended to either recap instruction only when Tracks are supplied, so a
// Person with no Tracks gets exactly the same prompt as before Purposes
// were introduced.
export const RECAP_TRACK_FOCUS_RULES = `
Rules for Track context:
- The Person's Tracks (primary focus) and their Purposes say what this
  relationship is for. Treat those Purposes as the main focus when
  choosing what to emphasize and, if requested, the next step.
- Other Tracks from recent Interactions are secondary context only.
- Do not invent a Purpose that is not supplied.
`;

// Appended to the draft instruction only when Tracks are supplied, for the
// same reason as RECAP_TRACK_FOCUS_RULES.
export const SUGGESTION_TRACK_RULES = `
Rules for Track context:
- The RELEVANT TRACKS below are the user's private context about why this
  relationship matters. The Person's Tracks are the main focus; other
  Tracks are secondary.
- The draft may bring up the underlying topic of a Track's Purpose (for
  example, a Purpose of "learn about AI" may lead the draft to mention AI).
- Never name a Track, quote a Purpose, or present a Purpose as the user's
  goal in the draft.
`;

export const RECAP_SYSTEM_INSTRUCTION = `${RECAP_RULES}- Respond with only the bullet list (each line starting with "- "), with
  no heading, preamble, or explanation.
`;

export const RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION = `${RECAP_RULES}- Respond with only the bullet list (each line starting with "- "),
  followed by the next-step part described below, with no other heading,
  preamble, or explanation.

After the recap bullet list, also suggest the user's next relationship
action with this Person. This part is also private to the user.

Rules for the next step:
- Use only the context supplied below. Do not invent history, meetings,
  commitments, interests, or Track membership.
- Each suggestion's kind must be exactly one of the ALLOWED NEXT STEP
  KINDS listed below, spelled exactly as given.
- "${WAIT_NEXT_STEP_KIND}" means reaching out now seems premature given the
  context.
- Give 1 suggestion when there is little context. Give at most
  ${MAX_NEXT_STEP_SUGGESTIONS}, and a second only when the context supports a
  distinct alternative.
- Keep each reason or idea to one short sentence.
- Format: after the recap bullets, write one line containing exactly
  "${NEXT_STEP_MARKER}", then one line per suggestion in the form
  "- <Kind>: <short reason or idea>". Use no bold or other formatting.
`;

// As with Person.pageId in people-due.ts, `pageId` and the ids hold whatever
// truthy JSON value Notion returned (a string with the documented schema).
export type PersonProfile = {
  readonly pageId: string;
  readonly name: string;
  readonly contextFields: readonly (readonly [string, string])[];
  readonly trackIds: readonly string[];
};

export type TrackContext = {
  readonly name: string;
  readonly purpose: string | null;
};

export type InteractionSummary = {
  readonly date: string | null;
  readonly type: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly trackIds: readonly string[];
};

/** A validated next-step suggestion: `(kind, idea)`. */
export type NextStep = readonly [string, string];

export type ActionsBlock = {
  type: "actions";
  elements: ButtonElement[];
};

export type SuggestionBlock = SectionBlock | ActionsBlock;

/** The injected Gemini call, `generate_text(prompt) -> str` (asynchronous in TS). */
export type GenerateText = (prompt: string) => Promise<string>;

export function personNotFoundMessage(personName: string): string {
  return `No Person found matching "${personName}".`;
}

export function ambiguousPersonMessage(personName: string): string {
  return `Multiple People match "${personName}" exactly; cannot determine which one was meant.`;
}

function attribute(value: unknown, name: string): unknown {
  // getattr(value, name, None)
  if (value === null || value === undefined) return null;
  const found = (value as Record<string, unknown>)[name];
  return found === undefined ? null : found;
}

/** `isinstance(value, int)`: an integral number, or a bool (an int subclass in Python). */
function pyIntOrNull(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * This module's own copy of the status extraction for the injected Gemini
 * `generateText` call, which throws whatever the SDK threw rather than a
 * shared error type: `error.response.status_code`, then `error.status_code`,
 * then `error.code`, the first one that is an int; otherwise null.
 */
export function externalErrorStatusCode(error: unknown): number | null {
  const responseStatus = pyIntOrNull(attribute(attribute(error, "response"), "status_code"));
  if (responseStatus !== null) return responseStatus;
  for (const name of ["status_code", "code"]) {
    const statusCode = pyIntOrNull(attribute(error, name));
    if (statusCode !== null) return statusCode;
  }
  return null;
}

/** A 429 (rate limit) or 5xx Gemini response is transient/high-demand. */
export function isTransientGeminiStatus(statusCode: number | null): boolean {
  return statusCode === 429 || (statusCode !== null && statusCode >= 500 && statusCode < 600);
}

export type HandlePeopleSuggestOptions = {
  today?: PlainDate | null | undefined;
  sleep?: Sleep | undefined;
  notionGet?: NotionGet | null | undefined;
};

/** `root_message["ts"]`: KeyError when Slack's response has no `ts`. */
function rootTs(rootMessage: Record<string, unknown>): string {
  return subscript(rootMessage, "ts") as string;
}

/**
 * Handle `/people suggest <person>`.
 *
 * Notion access, Person resolution, and Track resolution stay entirely
 * deterministic; Gemini (via the injected `generateText`) only ever sees the
 * bounded context built here and is only ever asked to summarize or draft
 * text, never to choose a Person, infer a Track, or perform a side effect.
 * `notionGet` is optional so Track relations can be resolved without
 * requiring every caller to supply it; when omitted, Track context is simply
 * left out of the recap.
 *
 * The order is Python's: resolve the Person, read the Interactions, resolve
 * the Tracks, list the selectable Tracks, read the Type options, then the
 * Gemini recap and the Gemini draft. A transient Gemini failure (429/5xx)
 * posts GEMINI_TRANSIENT_FAILURE_MESSAGE; any other Gemini failure throws.
 */
export async function handlePeopleSuggest(
  personName: string,
  postSlackMessage: PostSlackMessage,
  notionPost: NotionPost,
  generateText: GenerateText | null | undefined,
  environment: Environment,
  { today = null, sleep = sleepSeconds, notionGet = null }: HandlePeopleSuggestOptions = {},
): Promise<void> {
  const rootMessage = await postSlackMessage(`/people suggest ${personName}`);

  let profile: PersonProfile | null;
  let isAmbiguous: boolean;
  let interactions: InteractionSummary[];
  try {
    const commandToday = today ?? copenhagenToday();
    [profile, isAmbiguous] = await resolvePerson(
      notionPost,
      environmentValue(environment, "NOTION_API_KEY"),
      environmentValue(environment, "NOTION_PEOPLE_DATA_SOURCE_ID"),
      personName,
      sleep,
    );
    interactions =
      profile !== null
        ? await fetchRecentInteractions(
            notionPost,
            environmentValue(environment, "NOTION_API_KEY"),
            environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
            profile.pageId,
            commandToday,
            sleep,
          )
        : [];
  } catch (error) {
    if (!(error instanceof PeopleDueCommandError)) throw error;
    await postSlackMessage(PEOPLE_SUGGEST_FAILURE_MESSAGE, { threadTs: rootTs(rootMessage) });
    return;
  }

  if (isAmbiguous) {
    await postSlackMessage(ambiguousPersonMessage(personName), { threadTs: rootTs(rootMessage) });
    return;
  }
  if (profile === null) {
    await postSlackMessage(personNotFoundMessage(personName), { threadTs: rootTs(rootMessage) });
    return;
  }

  const trackIds = collectTrackIds(profile, interactions).slice(0, MAX_SUGGESTION_TRACKS);
  const resolvedTracks = await resolveTracks(
    trackIds,
    notionGet,
    environmentValue(environment, "NOTION_API_KEY"),
    sleep,
  );
  const [personTracks, otherTracks] = groupRelevantTracks(profile, trackIds, resolvedTracks);

  const selectableTracks = await fetchSelectableTracks(notionPost, environment, sleep);
  const defaultTrackId = profile.trackIds.length === 1 ? (profile.trackIds[0] as string) : null;
  const selectableInteractionTypes = await fetchSelectableInteractionTypes(notionGet, environment, sleep);
  const nextStepKinds = allowedNextStepKinds(selectableInteractionTypes);

  let recapResponse: string;
  let answer: string;
  try {
    // A missing generateText fails here as calling None does in Python: a
    // TypeError with no status code, so it is re-thrown below.
    const generate = generateText as GenerateText;
    recapResponse = pyStrip(
      await generate(buildRecapPrompt(profile, interactions, { personTracks, otherTracks, nextStepKinds })),
    );
    answer = pyStrip(await generate(buildSuggestionPrompt(profile, interactions, { personTracks, otherTracks })));
  } catch (error) {
    if (!isTransientGeminiStatus(externalErrorStatusCode(error))) {
      throw error;
    }
    await postSlackMessage(GEMINI_TRANSIENT_FAILURE_MESSAGE, { threadTs: rootTs(rootMessage) });
    return;
  }
  const [recap, nextSteps] = splitRecapAndNextSteps(recapResponse, nextStepKinds);
  const nextStepText = formatNextSteps(nextSteps);
  const message = formatSuggestionMessage(profile.name, answer);
  let replyText = formatFullReply(recap, message, { nextStepText });
  if (selectableInteractionTypes.length === 0) {
    replyText = `${replyText}\n\n${INTERACTION_TYPE_UNAVAILABLE_NOTE}`;
  }
  await postSlackMessage(replyText, {
    threadTs: rootTs(rootMessage),
    blocks: buildSuggestionBlocks(profile, recap, message, {
      tracks: selectableTracks,
      defaultTrackId,
      interactionTypes: selectableInteractionTypes,
      nextStepText,
    }),
  });
}

/**
 * The live Interaction Type options plus Wait, or nothing at all.
 *
 * Without live Type options no next step is requested or shown - not even
 * Wait alone - so no Type list is ever hardcoded here.
 */
export function allowedNextStepKinds(interactionTypes: readonly string[]): string[] {
  if (interactionTypes.length === 0) {
    return [];
  }
  const kinds = [...interactionTypes];
  if (!kinds.includes(WAIT_NEXT_STEP_KIND)) {
    kinds.push(WAIT_NEXT_STEP_KIND);
  }
  return kinds;
}

/**
 * Split the recap call's response into [recap, next steps].
 *
 * Gemini's next-step part is advisory text only and is validated here: a
 * suggestion whose kind is not exactly an allowed kind is dropped, at most
 * MAX_NEXT_STEP_SUGGESTIONS are kept, and a missing or unparseable next-step
 * part yields no suggestions rather than an error. Without allowed kinds no
 * next step was requested, so the response is the recap.
 */
export function splitRecapAndNextSteps(
  response: string,
  allowedKinds: readonly string[],
): [string, NextStep[]] {
  if (allowedKinds.length === 0) {
    return [response, []];
  }

  const lines = pySplitlines(response);
  let markerIndex = -1;
  let markerGroup = "";
  for (const [index, line] of lines.entries()) {
    const markerMatch = NEXT_STEP_MARKER_PATTERN.exec(line);
    if (markerMatch) {
      markerIndex = index;
      markerGroup = markerMatch[1] as string;
      break;
    }
  }
  if (markerIndex === -1) {
    return [response, []];
  }

  const recap = pyStrip(lines.slice(0, markerIndex).join("\n"));
  // A suggestion written on the marker line itself is still validated.
  const suggestionLines = [markerGroup, ...lines.slice(markerIndex + 1)];
  const nextSteps: NextStep[] = [];
  for (const line of suggestionLines) {
    const nextStep = parseNextStep(line, allowedKinds);
    if (nextStep !== null) {
      nextSteps.push(nextStep);
    }
  }
  return [recap, nextSteps.slice(0, MAX_NEXT_STEP_SUGGESTIONS)];
}

/**
 * Parse one "- <Kind>: <idea>" line, or null if it is not valid.
 *
 * The kind must be exactly an allowed kind. Matching by prefix rather than
 * splitting at the first colon keeps a live Type option whose name itself
 * contains a colon matchable; the longest kind (in code points) wins, and
 * kinds of equal length keep their order (Python's stable reverse sort).
 */
export function parseNextStep(line: string, allowedKinds: readonly string[]): NextStep | null {
  let suggestion = pyStrip(line);
  for (const bullet of ["- ", "* ", "• "]) {
    if (suggestion.startsWith(bullet)) {
      suggestion = pyStrip(pySlice(suggestion, pyLen(bullet)));
      break;
    }
  }
  // sorted(allowed_kinds, key=len, reverse=True): every key is computed first.
  const keyed = allowedKinds.map((kind) => ({ kind, length: pyLen(kind) }));
  keyed.sort((a, b) => b.length - a.length);
  for (const { kind, length } of keyed) {
    if (suggestion.startsWith(`${kind}:`)) {
      const idea = pyStrip(pySlice(suggestion, length + 1));
      return idea ? [kind, idea] : null;
    }
  }
  return null;
}

/**
 * Fetch the live Interaction Type options for the Add Interaction button.
 *
 * Unlike Track (optional), a Type is required for every Interaction write,
 * so a fetch failure here must not silently offer a button that could open a
 * modal with no valid Type field. An empty result - whether from a Notion
 * failure (including a credential failure) or a misconfigured schema - means
 * the caller must omit the Add Interaction button entirely (see
 * buildSuggestionBlocks).
 */
export async function fetchSelectableInteractionTypes(
  notionGet: NotionGet | null | undefined,
  environment: Environment,
  sleep: Sleep,
): Promise<string[]> {
  if (notionGet === null || notionGet === undefined) {
    return [];
  }
  try {
    return await fetchAvailableInteractionTypes(
      notionGet,
      environmentValue(environment, "NOTION_API_KEY"),
      environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
      sleep,
    );
  } catch (error) {
    if (isSelectableFetchFailure(error)) return [];
    throw error;
  }
}

/**
 * Fetch every Track offerable in the Add Interaction modal's selector.
 *
 * Best-effort: a listing failure - including a Notion credential failure -
 * must not break the rest of the reply, since Track selection is optional.
 * An unconfigured Tracks data source (NOTION_TRACKS_DATA_SOURCE_ID) simply
 * yields no Track options rather than an error.
 */
export async function fetchSelectableTracks(
  notionPost: NotionPost,
  environment: Environment,
  sleep: Sleep,
): Promise<TrackOption[]> {
  // environment.get("NOTION_TRACKS_DATA_SOURCE_ID", "")
  const tracksDataSourceId = environment["NOTION_TRACKS_DATA_SOURCE_ID"] ?? "";
  if (!tracksDataSourceId) {
    return [];
  }
  try {
    return await fetchAvailableTracks(
      notionPost,
      environmentValue(environment, "NOTION_API_KEY"),
      tracksDataSourceId,
      sleep,
    );
  } catch (error) {
    if (isSelectableFetchFailure(error)) return [];
    throw error;
  }
}

/** `except (TaskListCommandError, AddInteractionCommandError, NotionAuthenticationError)`. */
function isSelectableFetchFailure(error: unknown): boolean {
  return (
    error instanceof TaskListCommandError ||
    error instanceof AddInteractionCommandError ||
    error instanceof NotionAuthenticationError
  );
}

/**
 * Find the Person whose Name matches exactly, ignoring case (casefold).
 *
 * Resolves to [profile, isAmbiguous]. profile is null when there is no exact
 * match; isAmbiguous is true when more than one Person matches, in which case
 * the caller must not guess which one was meant.
 */
export async function resolvePerson(
  notionPost: NotionPost,
  apiKey: string,
  peopleDataSourceId: string,
  personName: string,
  sleep: Sleep,
): Promise<[PersonProfile | null, boolean]> {
  const buildRequestJson = (cursor: unknown): Dict => {
    const requestJson: Dict = { page_size: PEOPLE_PAGE_SIZE };
    if (truthy(cursor)) {
      requestJson["start_cursor"] = cursor;
    }
    return requestJson;
  };

  const [pages] = await fetchNotionPages(
    notionPost,
    apiKey,
    peopleDataSourceId,
    buildRequestJson,
    MAX_SCANNED_PEOPLE,
    PEOPLE_PAGE_SIZE,
    sleep,
  );

  const target = casefold(personName);
  const matches: PersonProfile[] = [];
  for (const page of pages) {
    const profile = personProfileFromNotionPage(page);
    if (profile !== null && casefold(profile.name) === target) {
      matches.push(profile);
    }
  }
  if (matches.length !== 1) {
    return [null, matches.length > 1];
  }
  return [matches[0] as PersonProfile, false];
}

/** A PersonProfile from a People page, or null (None) when the Name or id is unusable. */
export function personProfileFromNotionPage(page: unknown): PersonProfile | null {
  let properties: unknown;
  let name: string;
  let pageId: unknown;
  try {
    properties = subscript(page, "properties");
    const nameProperty = subscript(properties, "Name");
    if (dictGet(nameProperty, "type") !== "title") {
      return null;
    }
    name = pySplitWhitespace(joinPlainText(dictGet(nameProperty, "title", []))).join(" ");
    pageId = subscript(page, "id");
    if (!name || !truthy(pageId)) {
      return null;
    }
  } catch (error) {
    if (isAccessError(error)) return null;
    throw error;
  }

  const contextFields: [string, string][] = [];
  for (const propertyName of PERSON_CONTEXT_PROPERTIES) {
    const value = extractPropertyText(properties, propertyName);
    if (value !== null) {
      contextFields.push([propertyName, value]);
    }
  }
  const trackIds = extractRelationIds(properties, PERSON_TRACK_PROPERTY);
  return { pageId: pageId as string, name, contextFields, trackIds };
}

/**
 * The Person's newest Interactions dated on or before `today`: one query of
 * page_size MAX_SUGGESTION_INTERACTIONS, newest first, with no pagination.
 * Interaction pages with nothing usable are skipped.
 */
export async function fetchRecentInteractions(
  notionPost: NotionPost,
  apiKey: string,
  interactionsDataSourceId: string,
  personPageId: string,
  today: PlainDate,
  sleep: Sleep,
): Promise<InteractionSummary[]> {
  const requestJson: Dict = {
    page_size: MAX_SUGGESTION_INTERACTIONS,
    filter: {
      and: [
        { property: "People", relation: { contains: personPageId } },
        { property: "Date", date: { is_not_empty: true } },
        {
          property: "Date",
          date: { on_or_before: isoformat(today) },
        },
      ],
    },
    sorts: [{ property: "Date", direction: "descending" }],
  };
  const pages = await queryDataSource(notionPost, apiKey, interactionsDataSourceId, requestJson, sleep);

  const summaries: InteractionSummary[] = [];
  for (const page of pages.slice(0, MAX_SUGGESTION_INTERACTIONS)) {
    const summary = interactionSummaryFromNotionPage(page);
    if (summary !== null) {
      summaries.push(summary);
    }
  }
  return summaries;
}

export function interactionSummaryFromNotionPage(page: unknown): InteractionSummary | null {
  let properties: unknown;
  try {
    properties = subscript(page, "properties");
  } catch (error) {
    if (isAccessError(error)) return null;
    throw error;
  }
  if (!isDict(properties)) {
    return null;
  }

  const dateValue = extractInteractionDate(properties);
  const typeValue = extractPropertyText(properties, "Type");
  const titleValue = extractTitleText(properties);
  const notesValue = extractPropertyText(properties, "Notes");

  if (!dateValue && !typeValue && !titleValue && !notesValue) {
    return null;
  }

  const trackIds = extractRelationIds(properties, INTERACTION_TRACK_PROPERTY);
  return { date: dateValue, type: typeValue, title: titleValue, notes: notesValue, trackIds };
}

export function extractInteractionDate(properties: Dict): string | null {
  const dateProperty = dictGet(properties, "Date");
  if (!isDict(dateProperty) || dictGet(dateProperty, "type") !== "date") {
    return null;
  }
  const dateObject = dictGet(dateProperty, "date");
  const start = dictGet(truthy(dateObject) ? dateObject : {}, "start");
  return typeof start === "string" && start ? start : null;
}

/** The first non-empty title-typed property, in the page's property order. */
export function extractTitleText(properties: Dict): string | null {
  for (const propertyValue of Object.values(properties)) {
    if (isDict(propertyValue) && dictGet(propertyValue, "type") === "title") {
      const text = pyStrip(joinPlainText(dictGet(propertyValue, "title", [])));
      if (text) {
        return text;
      }
    }
  }
  return null;
}

/**
 * Read a People/Interaction property as plain text, if it exists.
 *
 * Only the text-shaped Notion property types actually used by this schema
 * (rich_text, select, multi_select) are recognized. A missing property, or
 * one of a type not recognized here, is safely omitted (null) rather than
 * guessed at.
 */
export function extractPropertyText(properties: unknown, displayName: string): string | null {
  const propertyValue = dictGet(properties, displayName);
  if (!isDict(propertyValue)) {
    return null;
  }

  const propertyType = dictGet(propertyValue, "type");
  if (propertyType === "rich_text") {
    const text = pyStrip(joinPlainText(dictGet(propertyValue, "rich_text", [])));
    return text || null;
  }
  if (propertyType === "select") {
    const selectValue = dictGet(propertyValue, "select");
    const name = dictGet(truthy(selectValue) ? selectValue : {}, "name");
    return typeof name === "string" && name ? name : null;
  }
  if (propertyType === "multi_select") {
    const names: unknown[] = [];
    for (const option of iterate(dictGet(propertyValue, "multi_select", []))) {
      if (isDict(option) && truthy(dictGet(option, "name"))) {
        names.push(dictGet(option, "name"));
      }
    }
    return names.length > 0 ? joinStrings(", ", names) : null;
  }
  return null;
}

/**
 * Read a relation property's related page ids, if present. A missing
 * property, or one not shaped as a relation, is treated as no relation.
 */
export function extractRelationIds(properties: unknown, displayName: string): string[] {
  const propertyValue = dictGet(properties, displayName);
  if (!isDict(propertyValue) || dictGet(propertyValue, "type") !== "relation") {
    return [];
  }
  const ids: string[] = [];
  for (const relation of iterate(dictGet(propertyValue, "relation", []))) {
    if (isDict(relation) && truthy(dictGet(relation, "id"))) {
      ids.push(subscript(relation, "id") as string);
    }
  }
  return ids;
}

/**
 * Distinct Track ids from the Person and their recent Interactions.
 *
 * Order is preserved (Person first, then each Interaction in the order given)
 * and duplicates are dropped, so a Track referenced by several Interactions is
 * still resolved at most once.
 */
export function collectTrackIds(
  profile: PersonProfile,
  interactions: readonly InteractionSummary[],
): string[] {
  const seen: string[] = [];
  for (const trackId of profile.trackIds) {
    if (!seen.includes(trackId)) {
      seen.push(trackId);
    }
  }
  for (const interaction of interactions) {
    for (const trackId of interaction.trackIds) {
      if (!seen.includes(trackId)) {
        seen.push(trackId);
      }
    }
  }
  return seen;
}

/**
 * Resolve each distinct Track id to a TrackContext, at most once per id.
 *
 * One GET per distinct Track id, never per Interaction; the Purpose is read
 * from the same page. A Track that fails to resolve (TaskListCommandError,
 * including a 403) or is malformed maps to null. A 401 is a credential
 * failure (credential codes [401]) and propagates as
 * NotionAuthenticationError, as on the Tasks Track path. Without
 * `notionGet` nothing is resolved.
 */
export async function resolveTracks(
  trackIds: readonly string[],
  notionGet: NotionGet | null | undefined,
  apiKey: string,
  sleep: Sleep,
): Promise<Map<string, TrackContext | null>> {
  const resolved = new Map<string, TrackContext | null>();
  if (notionGet === null || notionGet === undefined) {
    return resolved;
  }

  for (const trackId of trackIds) {
    assertHashable(trackId);
    if (resolved.has(trackId)) {
      continue;
    }
    try {
      const response = await callNotionWithRetries(
        () =>
          notionGet(`https://api.notion.com/v1/pages/${trackId}`, {
            headers: notionHeaders(apiKey),
            timeout: 10,
          }),
        sleep,
        { credentialFailureStatusCodes: [401] },
      );
      let trackPage: unknown;
      try {
        trackPage = response.json();
      } catch (error) {
        if (error instanceof TypeError || error instanceof ValueError) {
          throw withPyCause(new MalformedTrackPageError(), error);
        }
        throw error;
      }
      const name = trackFromNotionPage(trackPage).name;
      resolved.set(trackId, { name, purpose: extractTrackPurpose(trackPage) });
    } catch (error) {
      if (!(error instanceof TaskListCommandError || error instanceof MalformedTrackPageError)) {
        throw error;
      }
      resolved.set(trackId, null);
    }
  }
  return resolved;
}

/**
 * Read a Track page's Purpose as bounded single-line text, if present: the
 * rich_text parts joined, whitespace collapsed, and truncated to
 * MAX_TRACK_PURPOSE_CHARS code points (ending in "…"). A missing, empty, or
 * non-rich-text Purpose yields null, so the Track is used by name alone.
 */
export function extractTrackPurpose(trackPage: unknown): string | null {
  let propertyValue: unknown;
  try {
    propertyValue = dictGet(subscript(trackPage, "properties"), TRACK_PURPOSE_PROPERTY);
  } catch (error) {
    if (isAccessError(error)) return null;
    throw error;
  }
  if (!isDict(propertyValue) || dictGet(propertyValue, "type") !== "rich_text") {
    return null;
  }
  const parts = dictGet(propertyValue, "rich_text");
  if (!Array.isArray(parts)) {
    return null;
  }
  const text = pySplitWhitespace(joinPlainText(parts.filter((part) => isDict(part)))).join(" ");
  if (!text) {
    return null;
  }
  return pyTruncate(text, MAX_TRACK_PURPOSE_CHARS, "…");
}

/**
 * Split resolved Tracks into [Person's Tracks, Interaction-only Tracks].
 *
 * Order follows trackIds (Person first, see collectTrackIds). A Track linked
 * from both the Person and an Interaction is a Person Track. Unresolved
 * Tracks are dropped, and a name already listed is not repeated, so the
 * Person group wins for duplicate names too.
 */
export function groupRelevantTracks(
  profile: PersonProfile,
  trackIds: readonly string[],
  resolvedTracks: ReadonlyMap<string, TrackContext | null>,
): [TrackContext[], TrackContext[]] {
  const personTracks: TrackContext[] = [];
  const otherTracks: TrackContext[] = [];
  const seenNames = new Set<string>();
  for (const trackId of trackIds) {
    assertHashable(trackId);
    const track = resolvedTracks.get(trackId) ?? null;
    if (track === null || seenNames.has(track.name)) {
      continue;
    }
    seenNames.add(track.name);
    if (profile.trackIds.includes(trackId)) {
      personTracks.push(track);
    } else {
      otherTracks.push(track);
    }
  }
  return [personTracks, otherTracks];
}

export function buildTracksBlock(
  personTracks: readonly TrackContext[],
  otherTracks: readonly TrackContext[],
): string {
  if (personTracks.length === 0 && otherTracks.length === 0) {
    return "";
  }
  const lines = ["RELEVANT TRACKS:"];
  const groups: [string, readonly TrackContext[]][] = [
    ["Person's Tracks (primary focus):", personTracks],
    ["Other Tracks from recent Interactions (secondary):", otherTracks],
  ];
  for (const [heading, tracks] of groups) {
    if (tracks.length === 0) {
      continue;
    }
    lines.push(heading);
    for (const track of tracks) {
      lines.push(`- ${track.name}`);
      if (track.purpose) {
        lines.push(`  Purpose: ${track.purpose}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function buildContextBlock(profile: PersonProfile, interactions: readonly InteractionSummary[]): string {
  const contextLines = [`Name: ${profile.name}`];
  for (const [label, value] of profile.contextFields) {
    contextLines.push(`${label}: ${value}`);
  }

  let interactionsBlock: string;
  if (interactions.length > 0) {
    interactionsBlock = interactions
      .map((interaction) => `- ${formattedInteractionFields(interaction).join("; ")}`)
      .join("\n");
  } else {
    interactionsBlock = "No previous Interactions are recorded.";
  }

  const personContext = contextLines.join("\n");
  return `PERSON CONTEXT:\n${personContext}\n\nRECENT INTERACTIONS:\n${interactionsBlock}\n`;
}

export type BuildPromptOptions = {
  personTracks?: readonly TrackContext[] | undefined;
  otherTracks?: readonly TrackContext[] | undefined;
};

export function buildSuggestionPrompt(
  profile: PersonProfile,
  interactions: readonly InteractionSummary[],
  { personTracks = [], otherTracks = [] }: BuildPromptOptions = {},
): string {
  const contextBlock = buildContextBlock(profile, interactions);
  const tracksBlock = buildTracksBlock(personTracks, otherTracks);
  if (!tracksBlock) {
    return `${SUGGESTION_SYSTEM_INSTRUCTION}\n\n${contextBlock}`;
  }
  return `${SUGGESTION_SYSTEM_INSTRUCTION}${SUGGESTION_TRACK_RULES}\n\n${contextBlock}\n${tracksBlock}`;
}

export type BuildRecapPromptOptions = BuildPromptOptions & {
  nextStepKinds?: readonly string[] | undefined;
};

export function buildRecapPrompt(
  profile: PersonProfile,
  interactions: readonly InteractionSummary[],
  { personTracks = [], otherTracks = [], nextStepKinds = [] }: BuildRecapPromptOptions = {},
): string {
  let contextBlock = buildContextBlock(profile, interactions);
  const tracksBlock = buildTracksBlock(personTracks, otherTracks);
  if (tracksBlock) {
    contextBlock = `${contextBlock}\n${tracksBlock}`;
  }
  const trackRules = tracksBlock ? RECAP_TRACK_FOCUS_RULES : "";
  if (nextStepKinds.length === 0) {
    return `${RECAP_SYSTEM_INSTRUCTION}${trackRules}\n\n${contextBlock}`;
  }
  const kindsBlock = nextStepKinds.map((kind) => `- ${kind}`).join("\n");
  contextBlock = `${contextBlock}\nALLOWED NEXT STEP KINDS:\n${kindsBlock}\n`;
  return `${RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION}${trackRules}\n\n${contextBlock}`;
}

export function formattedInteractionFields(interaction: InteractionSummary): string[] {
  const fields: string[] = [];
  if (interaction.date) {
    fields.push(`Date: ${interaction.date}`);
  }
  if (interaction.type) {
    fields.push(`Type: ${interaction.type}`);
  }
  if (interaction.title) {
    fields.push(`Title: ${interaction.title}`);
  }
  if (interaction.notes) {
    fields.push(`Notes: ${interaction.notes}`);
  }
  return fields;
}

export function formatSuggestionMessage(personName: string, answer: string): string {
  return `Suggested message for ${personName}:\n\n${answer}`;
}

export function formatNextSteps(nextSteps: readonly NextStep[]): string {
  if (nextSteps.length === 0) {
    return "";
  }
  const lines = nextSteps.map(([kind, idea]) => `- ${kind}: ${idea}`).join("\n");
  return `Suggested next step:\n${lines}`;
}

export function formatFullReply(
  recap: string,
  message: string,
  { nextStepText = "" }: { nextStepText?: string | undefined } = {},
): string {
  const parts: string[] = [];
  if (recap) {
    parts.push(`Context:\n${recap}`);
  }
  if (nextStepText) {
    parts.push(nextStepText);
  }
  parts.push(message);
  return parts.join("\n\n");
}

export type BuildSuggestionBlocksOptions = {
  tracks?: readonly TrackOption[] | undefined;
  defaultTrackId?: string | null | undefined;
  interactionTypes?: readonly string[] | undefined;
  nextStepText?: string | undefined;
};

export function buildSuggestionBlocks(
  profile: PersonProfile,
  recap: string,
  messageText: string,
  { tracks = [], defaultTrackId = null, interactionTypes = [], nextStepText = "" }: BuildSuggestionBlocksOptions = {},
): SuggestionBlock[] {
  const blocks: SuggestionBlock[] = [];
  if (recap) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateForSlackSection(`Context:\n${recap}`),
      },
    });
  }
  if (nextStepText) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateForSlackSection(nextStepText),
      },
    });
  }
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateForSlackSection(messageText),
    },
  });
  // A Type dropdown is required for a usable Add Interaction modal, so the
  // button itself is only offered when there is at least one live Type
  // option to populate it with - see fetchSelectableInteractionTypes.
  if (interactionTypes.length > 0) {
    blocks.push({
      type: "actions",
      elements: [
        addInteractionButton(profile.pageId, profile.name, {
          tracks,
          defaultTrackId,
          interactionTypes,
        }),
      ],
    });
  }
  return blocks;
}

/** At most SLACK_SECTION_TEXT_LIMIT code points, ending in "…" when cut. */
export function truncateForSlackSection(text: string): string {
  return pyTruncate(text, SLACK_SECTION_TEXT_LIMIT, "…");
}

// ---------------------------------------------------------------------------
// Joining untrusted text
// ---------------------------------------------------------------------------

/** `sep.join(values)`: TypeError when a value is not a str, as in Python. */
function joinStrings(separator: string, values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") throw new TypeError("sequence item: expected str instance");
  }
  return values.join(separator);
}

/** `"".join(part.get("plain_text", "") for part in parts)`. */
function joinPlainText(parts: unknown): string {
  return joinStrings(
    "",
    iterate(parts).map((part) => dictGet(part, "plain_text", "")),
  );
}
