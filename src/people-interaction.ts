// Port of people_interaction.py: the "Add interaction" button, the live Track
// and Type allowlists, and the Interaction write path (exactly one Notion
// page create per valid submission).
//
// Notion data is untrusted JSON. As in tasks-list.ts and people-due.ts, it is
// read with the python-compat accessors, and each parser catches exactly what
// its Python counterpart catches: `except (AttributeError, KeyError,
// TypeError, ValueError)` is isParseError.
//
// TECH-DEBT TD1 and TD7 are preserved: createInteractionPage uses the default
// retry policy (5xx, timeouts and connection errors are retried), and
// handleAddInteractionSubmission catches NotionAuthenticationError and posts
// the generic failure message. TD3: the modal date is parsed with
// dateFromIsoformat (`date.fromisoformat`).

import { PeopleDueCommandError, fetchNotionPages, type ButtonElement } from "./people-due.ts";
import { dateFromIsoformat, isoformat, type PlainDate } from "./plain-date.ts";
import {
  KeyError,
  ValueError,
  casefold,
  comparePy,
  dictGet,
  isDict,
  isParseError,
  iterate,
  pyJsonDumps,
  subscript,
  truthy,
  withPyCause,
  type Dict,
  type JsonValue,
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

// Matches ADD_INTERACTION_ACTION_ID in api/slack-request.js.
export const ADD_INTERACTION_ACTION_ID = "people_add_interaction";

// Matches ADD_INTERACTION_CALLBACK_ID in api/slack-request.js.
export const ADD_INTERACTION_CALLBACK_ID = "add_interaction_modal";

// Notion property name for the Interactions Track relation, exactly as
// named in the live schema (docs/notion-interactions-schema.md).
export const INTERACTION_TRACK_PROPERTY = "Track";

// Bounds both the Track selector's option list and the validation query
// below to a single Notion request, well above the small number of Tracks
// this workspace actually has, and under Slack's 100-option static_select
// cap.
export const MAX_TRACK_OPTIONS = 25;

// Notion property name for the Interactions Type select, exactly as named
// in the live schema (docs/notion-interactions-schema.md). Notion is the
// only source of truth for the allowed values - see
// fetchAvailableInteractionTypes / isValidInteractionType below - rather
// than a duplicated hardcoded list here.
export const INTERACTION_TYPE_PROPERTY = "Type";

export const INTERACTION_ADDED_MESSAGE_TEMPLATE = "Interaction added for {name}.";
export const INTERACTION_INVALID_MESSAGE = "Unable to add that interaction. Please try again.";
export const INTERACTION_FAILURE_MESSAGE = "Unable to add the interaction right now. Please try again later.";

/** An Interaction write failure that is safe to expose generically. */
export class AddInteractionCommandError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "AddInteractionCommandError";
  }
}

/**
 * A Track selector option, `{"id": ..., "name": ...}` in that key order.
 * As with Person.pageId, `id` holds whatever truthy JSON value Notion returned
 * for the page id (a string with the documented Notion schema).
 */
export type TrackOption = {
  readonly id: string;
  readonly name: string;
};

/** `INTERACTION_ADDED_MESSAGE_TEMPLATE.format(name=name)`. */
function interactionAddedMessage(name: string): string {
  // A replacer function, so `$` sequences in the name are not interpreted.
  return INTERACTION_ADDED_MESSAGE_TEMPLATE.replace("{name}", () => name);
}

export type AddInteractionButtonOptions = {
  tracks?: readonly TrackOption[] | undefined;
  defaultTrackId?: string | null | undefined;
  interactionTypes?: readonly string[] | undefined;
};

/**
 * A Block Kit button carrying the stable Person page id forward.
 *
 * The value is opaque structured JSON (not free text), so the Slack
 * interaction payload - not a re-typed or re-resolved name - is the only
 * source of Person identity used later by the write path. `tracks` (options
 * already resolved from Notion), `defaultTrackId`, and `interactionTypes`
 * (Type names already resolved from the live Notion schema) are carried the
 * same way, so the Vercel webhook that opens the modal never needs Notion
 * access of its own. When there are no tracks (or Type options) to offer,
 * the corresponding fields are omitted rather than sent as empty
 * placeholders; a caller must not offer this button at all when
 * `interactionTypes` is empty, since the Type dropdown is required for a
 * usable modal.
 *
 * The value is serialized with pyJsonDumps, byte-identical to Python's
 * `json.dumps(value)`, keys in the same insertion order.
 */
export function addInteractionButton(
  personPageId: string,
  personName: string,
  { tracks = [], defaultTrackId = null, interactionTypes = [] }: AddInteractionButtonOptions = {},
): ButtonElement {
  const value: { [key: string]: JsonValue } = { page_id: personPageId, name: personName };
  if (interactionTypes.length > 0) {
    value["types"] = [...interactionTypes];
  }
  if (tracks.length > 0) {
    value["tracks"] = [...tracks] as unknown as JsonValue[];
    if (truthy(defaultTrackId)) {
      value["default_track_id"] = defaultTrackId as string;
    }
  }
  return {
    type: "button",
    text: { type: "plain_text", text: "Add interaction" },
    action_id: ADD_INTERACTION_ACTION_ID,
    value: pyJsonDumps(value),
  };
}

/**
 * Fetch up to MAX_TRACK_OPTIONS Tracks as `{"id", "name"}` options, sorted by
 * casefolded name.
 *
 * Used both to populate the Track selector and, independently, to validate a
 * submitted Track id against the live Tracks data source before any write.
 * A malformed individual Track page is skipped rather than failing the whole
 * listing. A malformed query response throws AddInteractionCommandError
 * (caused by the PeopleDueCommandError); a Notion request failure
 * (TaskListCommandError, NotionAuthenticationError) propagates as it is.
 */
export async function fetchAvailableTracks(
  notionPost: NotionPost,
  apiKey: string,
  tracksDataSourceId: string,
  sleep: Sleep,
): Promise<TrackOption[]> {
  const buildRequestJson = (cursor: unknown): Dict => {
    const requestJson: Dict = { page_size: MAX_TRACK_OPTIONS };
    if (truthy(cursor)) {
      requestJson["start_cursor"] = cursor;
    }
    return requestJson;
  };

  let pages: unknown[];
  try {
    [pages] = await fetchNotionPages(
      notionPost,
      apiKey,
      tracksDataSourceId,
      buildRequestJson,
      MAX_TRACK_OPTIONS,
      MAX_TRACK_OPTIONS,
      sleep,
    );
  } catch (error) {
    if (error instanceof PeopleDueCommandError) {
      throw withPyCause(new AddInteractionCommandError(), error);
    }
    throw error;
  }

  const options: TrackOption[] = [];
  for (const page of pages.slice(0, MAX_TRACK_OPTIONS)) {
    let pageId: unknown;
    let name: string;
    try {
      pageId = subscript(page, "id");
      name = trackFromNotionPage(page).name;
    } catch (error) {
      // except (MalformedTrackPageError, KeyError, TypeError)
      if (error instanceof MalformedTrackPageError || error instanceof KeyError || error instanceof TypeError) {
        continue;
      }
      throw error;
    }
    if (truthy(pageId)) {
      options.push({ id: pageId as string, name });
    }
  }
  // options.sort(key=lambda option: option["name"].casefold()): every key is
  // computed first, then a stable sort by code point.
  const keyed = options.map((option) => ({ option, sortKey: casefold(option.name) }));
  keyed.sort((a, b) => comparePy(a.sortKey, b.sortKey));
  return keyed.map(({ option }) => option);
}

/**
 * Confirm a submitted Track id names a real, current Track record.
 *
 * A manipulated or stale id must not reach the write path. An unconfigured
 * Tracks data source fails closed (false, with no Notion call) rather than
 * silently accepting an unverifiable id.
 */
export async function isValidTrack(
  trackId: string,
  notionPost: NotionPost,
  apiKey: string,
  tracksDataSourceId: string,
  sleep: Sleep,
): Promise<boolean> {
  if (!tracksDataSourceId) {
    return false;
  }
  const availableTracks = await fetchAvailableTracks(notionPost, apiKey, tracksDataSourceId, sleep);
  return availableTracks.some((option) => option.id === trackId);
}

/**
 * Read the live allowed Interaction Type values from the Notion schema.
 *
 * Notion is the only source of truth for Type values. A malformed schema
 * response (the Type property missing, not a select, or without a readable
 * options list) throws AddInteractionCommandError: it is a failure, not an
 * empty allowlist, so it cannot be mistaken for "no Types configured".
 * Option entries that are not dicts or have no truthy name are skipped. As
 * with TrackOption.id, each name is the JSON value Notion returned.
 */
export async function fetchAvailableInteractionTypes(
  notionGet: NotionGet,
  apiKey: string,
  interactionsDataSourceId: string,
  sleep: Sleep,
): Promise<string[]> {
  const response = await callNotionWithRetries(
    () =>
      notionGet(`https://api.notion.com/v1/data_sources/${interactionsDataSourceId}`, {
        headers: notionHeaders(apiKey),
        timeout: 10,
      }),
    sleep,
    { credentialFailureStatusCodes: [401] },
  );
  try {
    const typeProperty = subscript(subscript(response.json(), "properties"), INTERACTION_TYPE_PROPERTY);
    if (dictGet(typeProperty, "type") !== "select") {
      throw new AddInteractionCommandError();
    }
    const options = subscript(subscript(typeProperty, "select"), "options");
    const names: string[] = [];
    for (const option of iterate(options)) {
      if (isDict(option) && truthy(dictGet(option, "name"))) {
        names.push(subscript(option, "name") as string);
      }
    }
    return names;
  } catch (error) {
    if (isParseError(error)) throw withPyCause(new AddInteractionCommandError(), error);
    throw error;
  }
}

/**
 * Confirm a submitted Type is currently among the live Notion options.
 *
 * The Type dropdown is only a usability guardrail; this re-check against the
 * live schema at write time is the hard guardrail, so a stale dropdown or a
 * manipulated payload can never write an unknown Type or create a new Notion
 * select option.
 */
export async function isValidInteractionType(
  interactionType: string,
  notionGet: NotionGet,
  apiKey: string,
  interactionsDataSourceId: string,
  sleep: Sleep,
): Promise<boolean> {
  const availableTypes = await fetchAvailableInteractionTypes(notionGet, apiKey, interactionsDataSourceId, sleep);
  return availableTypes.includes(interactionType);
}

/**
 * `build_followup_buttons(person_page_id, person_name, track_id,
 * interaction_type, notes, interaction_date)`: followup_task's button builder,
 * injected by the entry point. Resolves to the Block Kit button elements; an
 * empty list means none.
 */
export type BuildFollowupButtons = (
  personPageId: string,
  personName: string,
  trackId: string | null | undefined,
  interactionType: string,
  notes: string,
  interactionDate: PlainDate,
) => Promise<readonly unknown[]> | readonly unknown[];

export type HandleAddInteractionSubmissionOptions = {
  threadTs?: string | null | undefined;
  today?: PlainDate | null | undefined;
  sleep?: Sleep | undefined;
  buildFollowupButtons?: BuildFollowupButtons | null | undefined;
};

/**
 * Validate and perform exactly one Interaction write.
 *
 * Gemini is never involved here: every field either comes from the fixed
 * Person identity carried through the modal's structured state, a controlled
 * dropdown, or free text preserved as-is. The validation order is the date,
 * then the Type (live schema), then the Track (live Tracks, only when one was
 * submitted), then the title property, then the create. `trackId` is optional
 * (Slack sends "" when the Track selector was left empty). `threadTs` keeps
 * the reply in the suggestion's Slack thread. `buildFollowupButtons` is
 * called only after a successful write; when it returns no buttons the
 * confirmation is posted as plain text without them.
 */
export async function handleAddInteractionSubmission(
  personPageId: string,
  personName: string,
  interactionType: string,
  notes: string | null | undefined,
  dateValue: string | null | undefined,
  trackId: string | null | undefined,
  postSlackMessage: PostSlackMessage,
  notionPost: NotionPost,
  notionGet: NotionGet,
  environment: Environment,
  { threadTs = null, today = null, sleep = sleepSeconds, buildFollowupButtons = null }:
    HandleAddInteractionSubmissionOptions = {},
): Promise<void> {
  // Python passes thread_ts=thread_ts on every post, None included.
  const slackOptions = { threadTs: threadTs ?? undefined };

  if (!personPageId || !personName) {
    // A malformed or spoofed submission with no Person identity to attach
    // to. Nothing safe to report; fail silently rather than guessing a
    // Person.
    return;
  }

  let interactionDate: PlainDate;
  try {
    // TECH-DEBT TD3: date.fromisoformat's leniency is kept.
    interactionDate = dateValue ? dateFromIsoformat(dateValue) : (today ?? copenhagenToday());
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    await postSlackMessage(INTERACTION_INVALID_MESSAGE, slackOptions);
    return;
  }

  try {
    if (
      !(await isValidInteractionType(
        interactionType,
        notionGet,
        environmentValue(environment, "NOTION_API_KEY"),
        environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
        sleep,
      ))
    ) {
      await postSlackMessage(INTERACTION_INVALID_MESSAGE, slackOptions);
      return;
    }

    if (
      trackId &&
      !(await isValidTrack(
        trackId,
        notionPost,
        environmentValue(environment, "NOTION_API_KEY"),
        // environment.get("NOTION_TRACKS_DATA_SOURCE_ID", "")
        environment["NOTION_TRACKS_DATA_SOURCE_ID"] ?? "",
        sleep,
      ))
    ) {
      await postSlackMessage(INTERACTION_INVALID_MESSAGE, slackOptions);
      return;
    }

    const titlePropertyName = await fetchInteractionsTitleProperty(
      notionGet,
      environmentValue(environment, "NOTION_API_KEY"),
      environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
      sleep,
    );
    await createInteractionPage(
      notionPost,
      environmentValue(environment, "NOTION_API_KEY"),
      environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
      personPageId,
      personName,
      interactionType,
      notes || "",
      interactionDate,
      trackId,
      titlePropertyName,
      sleep,
    );
  } catch (error) {
    // TECH-DEBT TD7: a credential failure is caught here too, and the run
    // continues (exit 0 at the entry point).
    if (
      !(
        error instanceof TaskListCommandError ||
        error instanceof AddInteractionCommandError ||
        error instanceof NotionAuthenticationError
      )
    ) {
      throw error;
    }
    await postSlackMessage(INTERACTION_FAILURE_MESSAGE, slackOptions);
    return;
  }

  const confirmation = interactionAddedMessage(personName);
  const followupButtons = buildFollowupButtons
    ? await buildFollowupButtons(personPageId, personName, trackId, interactionType, notes || "", interactionDate)
    : [];
  if (!truthy(followupButtons)) {
    await postSlackMessage(confirmation, slackOptions);
    return;
  }
  await postSlackMessage(confirmation, {
    ...slackOptions,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: confirmation } },
      { type: "actions", elements: [...followupButtons] },
    ],
  });
}

/**
 * Resolve the Interactions data source's title property by its type.
 *
 * Every Notion page requires a value for its title property, whatever it is
 * displayed as. Resolving it at request time, rather than hardcoding a
 * guessed display name, keeps the write correct. No title property, or a
 * malformed schema, throws AddInteractionCommandError.
 */
export async function fetchInteractionsTitleProperty(
  notionGet: NotionGet,
  apiKey: string,
  interactionsDataSourceId: string,
  sleep: Sleep,
): Promise<string> {
  const response = await callNotionWithRetries(
    () =>
      notionGet(`https://api.notion.com/v1/data_sources/${interactionsDataSourceId}`, {
        headers: notionHeaders(apiKey),
        timeout: 10,
      }),
    sleep,
    { credentialFailureStatusCodes: [401] },
  );
  try {
    const properties = subscript(response.json(), "properties");
    if (!isDict(properties)) {
      // properties.items() on a non-dict: AttributeError.
      throw new TypeError("object has no attribute 'items'");
    }
    for (const [displayName, definition] of Object.entries(properties)) {
      if (isDict(definition) && dictGet(definition, "type") === "title") {
        return displayName;
      }
    }
  } catch (error) {
    if (isParseError(error)) throw withPyCause(new AddInteractionCommandError(), error);
    throw error;
  }
  throw new AddInteractionCommandError();
}

/**
 * Create the Interaction page: one POST to /v1/pages with the default Notion
 * retry policy (TECH-DEBT TD1: 429, 5xx, timeouts and connection errors are
 * retried; 401 and 403 are credential failures).
 */
export async function createInteractionPage(
  notionPost: NotionPost,
  apiKey: string,
  interactionsDataSourceId: string,
  personPageId: string,
  personName: string,
  interactionType: string,
  notes: string,
  interactionDate: PlainDate,
  trackId: string | null | undefined,
  titlePropertyName: string,
  sleep: Sleep,
): Promise<void> {
  const properties: Dict = {
    People: { relation: [{ id: personPageId }] },
    Type: { select: { name: interactionType } },
    Date: { date: { start: isoformat(interactionDate) } },
    Notes: {
      rich_text: notes ? [{ type: "text", text: { content: notes } }] : [],
    },
    [INTERACTION_TRACK_PROPERTY]: {
      relation: trackId ? [{ id: trackId }] : [],
    },
    [titlePropertyName]: {
      title: [
        {
          type: "text",
          text: { content: `${personName} – ${interactionType}` },
        },
      ],
    },
  };
  await callNotionWithRetries(
    () =>
      notionPost("https://api.notion.com/v1/pages", {
        headers: notionHeaders(apiKey),
        json: {
          parent: { data_source_id: interactionsDataSourceId },
          properties,
        },
        timeout: 10,
      }),
    sleep,
  );
}
