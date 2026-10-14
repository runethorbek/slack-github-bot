// Port of followup_task.py: the "Add follow-up task" buttons (one plain, and
// one prefilled from a Gemini suggestion), the live Tasks schema read, and the
// Task write path (exactly one Notion page create per valid submission).
//
// Notion data is untrusted JSON, read with the python-compat accessors as in
// people-interaction.ts. Gemini output is untrusted too: parseSuggestedTask
// reads it with Python semantics (pyStrip, a translation of the fence regex
// and pyJsonLoads, which accepts NaN/Infinity as json.loads does), and only a
// validated, bounded SuggestedTask ever prefills a button (security invariant
// S5). Gemini never causes a write.
//
// Security invariant S9: the Task create retries only on HTTP 429. A 5xx, a
// timeout or a connection error may arrive after Notion has created the page,
// so it gets FOLLOWUP_TASK_UNCERTAIN_MESSAGE instead of a retry.
//
// TECH-DEBT TD3 is preserved: the modal follow-up date is parsed with
// dateFromIsoformat (`date.fromisoformat`), which also accepts 20261013 and
// 2026-W42-2.

import type { ButtonElement } from "./people-due.ts";
import {
  AddInteractionCommandError,
  fetchAvailableTracks,
  isValidTrack,
  type TrackOption,
} from "./people-interaction.ts";
import { addDays, dateFromIsoformat, isoformat, type PlainDate } from "./plain-date.ts";
import {
  PY_RE_SPACE_CLASS,
  ValueError,
  dictGet,
  getPyCause,
  isDict,
  isParseError,
  iterate,
  pyJsonDumps,
  pyJsonLoads,
  pyLen,
  pyStrip,
  pyTruncate,
  subscript,
  truthy,
  withPyCause,
  type Dict,
  type JsonValue,
} from "./python-compat.ts";
import type { GenerateText } from "./people-suggest.ts";
import {
  NotionAuthenticationError,
  TaskListCommandError,
  callNotionWithRetries,
  copenhagenToday,
  environmentValue,
  externalErrorStatusCode,
  notionHeaders,
  sleepSeconds,
  type Environment,
  type NotionGet,
  type NotionPost,
  type PostSlackMessage,
  type Sleep,
} from "./tasks-list.ts";

// Matches ADD_FOLLOWUP_TASK_ACTION_ID in api/slack-request.js.
export const ADD_FOLLOWUP_TASK_ACTION_ID = "add_followup_task";

// Matches ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID in api/slack-request.js,
// which opens the same Task modal (same callback_id) with the suggestion
// prefilled. Slack requires unique action_ids within one actions block.
export const ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID = "add_suggested_followup_task";

// Matches ADD_FOLLOWUP_TASK_CALLBACK_ID in api/slack-request.js, which
// forwards it as SLACK_VIEW_CALLBACK_ID so the entry point can tell this
// submission apart from an Add Interaction one.
export const ADD_FOLLOWUP_TASK_CALLBACK_ID = "add_followup_task_modal";

// Notion Tasks property names, exactly as named in the live schema
// (docs/notion-tasks-schema.md). The title property is resolved by type at
// request time instead, as for Interactions.
export const TASK_PEOPLE_PROPERTY = "People";
export const TASK_TRACK_PROPERTY = "Track";
export const TASK_PRIORITY_PROPERTY = "Priority";
export const TASK_STATUS_PROPERTY = "Status";
export const TASK_FOLLOW_UP_PROPERTY = "Follow-up";
export const TASK_CREATED_PROPERTY = "Created";
export const TASK_DESCRIPTION_PROPERTY = "Description";

// Every follow-up Task starts in this exact existing Status, matching the
// Danish Status names tasks-list.ts already relies on. It is checked against
// the live schema before each write and never created.
export const TASK_STATUS_NOT_STARTED = "Ikke startet";

// Slack's maximum length for a Block Kit button value.
export const SLACK_BUTTON_VALUE_LIMIT = 2000;

// Slack's maximum length for a Block Kit button's text.
export const SLACK_BUTTON_TEXT_LIMIT = 75;

// Bounds on a Gemini-suggested Task, enforced whatever Gemini returns. An
// invalid name discards the whole suggestion; an invalid description or
// follow-up date is dropped on its own. Lengths are in code points.
export const MAX_SUGGESTED_TASK_NAME_CHARS = 150;
export const MAX_SUGGESTED_TASK_DESCRIPTION_CHARS = 500;
export const MAX_SUGGESTED_FOLLOW_UP_DAYS = 365;

// Python: re.compile(r"^\d{4}-\d{2}-\d{2}$"), used with .match(). Python's
// `\d` is any Unicode decimal digit (\p{Nd}), and its `$` also matches before
// a final "\n", hence `\n?$` (JS `$` without the m flag is the end of input).
// dateFromIsoformat then rejects everything but ASCII digits with no "\n", as
// date.fromisoformat does, so only the outcome None/date matters.
export const ISO_DATE_PATTERN = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}\n?$/u;

// Python: re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL).
// `\s` is PY_RE_SPACE_CLASS (Python's Unicode whitespace), DOTALL `.` is
// `[^]` (any code point), and fullmatch is `^...$` (JS `$` without the m flag
// is the end of input). The lazy group and greedy `\s*` backtrack the same
// way in both engines.
const MARKDOWN_FENCE_PATTERN = new RegExp(
  `^\`\`\`(?:json)?[${PY_RE_SPACE_CLASS}]*([^]*?)[${PY_RE_SPACE_CLASS}]*\`\`\`$`,
  "u",
);

export const FOLLOWUP_SUGGESTION_SYSTEM_INSTRUCTION = `
You are reading the notes the user just saved about an Interaction with a
Person, to decide whether they contain a concrete commitment the user
should track as a follow-up Task. The user reviews and edits any
suggestion before anything is saved.

Rules:
- Use only the Interaction supplied below.
- Suggest a Task only when the notes contain a concrete commitment or
  agreed next action (for example "agreed to send the AI article").
  Otherwise, suggest nothing. Do not invent commitments.
- Suggest at most one Task.
- "name" is a short imperative Task name, at most 150 characters.
- "description" is optional: at most 500 characters of useful detail from
  the notes. Omit it when there is nothing to add beyond the name.
- "follow_up" is optional: an absolute date in the form YYYY-MM-DD, only
  when the notes state or clearly imply when to follow up. Resolve
  relative dates ("next week", "Friday") using TODAY below. Omit it
  otherwise.
- Respond with only a JSON object and no other text or formatting:
  {"task": null} when there is no follow-up, or
  {"task": {"name": "...", "description": "...", "follow_up": "YYYY-MM-DD"}}.
`;

export const FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE = "Follow-up task added for {name}: {task}";
export const FOLLOWUP_TASK_INVALID_MESSAGE = "Unable to add that follow-up task. Please try again.";
export const FOLLOWUP_TASK_FAILURE_MESSAGE = "Unable to add the follow-up task right now. Please try again later.";
export const FOLLOWUP_TASK_UNCERTAIN_MESSAGE =
  "The follow-up task may not have been added. Check Notion before trying again.";
export const FOLLOWUP_TASK_STATUS_MISSING_MESSAGE =
  `Unable to add the follow-up task: Notion Tasks has no "${TASK_STATUS_NOT_STARTED}" Status.`;

/** A Task write failure that is safe to expose generically. */
export class FollowupTaskCommandError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "FollowupTaskCommandError";
  }
}

/** Python's StopIteration from `next(...)` on an exhausted generator. */
class StopIteration extends Error {
  constructor() {
    super("StopIteration");
    this.name = "StopIteration";
  }
}

/** A Gemini-suggested Task that has passed validation. */
export type SuggestedTask = {
  readonly name: string;
  readonly description: string | null;
  readonly followUp: PlainDate | null;
};

/**
 * The parts of the live Tasks schema this write path depends on. As with
 * TrackOption.id, each option name is the truthy JSON value Notion returned
 * (a string with the documented schema).
 */
export type TasksSchema = {
  readonly titlePropertyName: string;
  readonly priorities: readonly string[];
  readonly statuses: readonly string[];
  readonly hasDescription: boolean;
};

/** `FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE.format(name=name, task=task)`. */
export function followupTaskAddedMessage(name: string, task: string): string {
  // One pass with a replacer function, as str.format substitutes both fields
  // at once: a "{task}" inside the name is not substituted again, and `$`
  // sequences in the values are not interpreted.
  return FOLLOWUP_TASK_ADDED_MESSAGE_TEMPLATE.replace(/\{(name|task)\}/g, (_field, key: string) =>
    key === "name" ? name : task,
  );
}

export type FollowupTaskButtonOptions = {
  tracks?: readonly TrackOption[] | undefined;
  defaultTrackId?: string | null | undefined;
  priorities?: readonly string[] | undefined;
  suggestedTask?: SuggestedTask | null | undefined;
};

/**
 * A Block Kit button carrying everything the Task modal needs.
 *
 * Mirrors addInteractionButton: Person identity, Track options, the default
 * Track and the live Priority options are all resolved ahead of time and
 * carried opaquely in the value, so the Vercel webhook that opens the modal
 * never needs Notion access of its own. With a validated `suggestedTask` the
 * button instead opens the same modal with its Name, Description and
 * Follow-up prefilled.
 *
 * The value is serialized with pyJsonDumps, byte-identical to Python's
 * `json.dumps(value)`, keys in the same insertion order.
 */
export function followupTaskButton(
  personPageId: string,
  personName: string,
  { tracks = [], defaultTrackId = null, priorities = [], suggestedTask = null }: FollowupTaskButtonOptions = {},
): ButtonElement {
  const value: { [key: string]: JsonValue } = { page_id: personPageId, name: personName };
  if (priorities.length > 0) {
    value["priorities"] = [...priorities];
  }
  if (tracks.length > 0) {
    value["tracks"] = [...tracks] as unknown as JsonValue[];
    if (truthy(defaultTrackId)) {
      value["default_track_id"] = defaultTrackId as string;
    }
  }
  let text: string;
  let actionId: string;
  if (suggestedTask === null) {
    text = "Add follow-up task";
    actionId = ADD_FOLLOWUP_TASK_ACTION_ID;
  } else {
    value["task_name"] = suggestedTask.name;
    if (truthy(suggestedTask.description)) {
      value["task_description"] = suggestedTask.description as string;
    }
    if (suggestedTask.followUp) {
      value["task_follow_up"] = isoformat(suggestedTask.followUp);
    }
    text = truncateButtonText(`Add task: ${suggestedTask.name}`);
    actionId = ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID;
  }
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value: pyJsonDumps(value),
  };
}

/** At most SLACK_BUTTON_TEXT_LIMIT code points: 74 and "…" when longer. */
export function truncateButtonText(text: string): string {
  return pyTruncate(text, SLACK_BUTTON_TEXT_LIMIT, "…");
}

export type BuildFollowupTaskButtonsOptions = {
  generateText?: GenerateText | null | undefined;
  today?: PlainDate | null | undefined;
  sleep?: Sleep | undefined;
};

/**
 * Resolve the Task modal buttons, or an empty list if none can be.
 *
 * Called only after an Interaction was saved. Any Notion failure here means
 * the Interaction confirmation is posted without the buttons rather than
 * failing the (already successful) Interaction write. An unconfigured Tracks
 * data source simply yields no Track options, as elsewhere.
 *
 * Besides the plain "Add follow-up task" button, non-blank Interaction notes
 * lead to one Gemini call (`generateText`) that may suggest a prefilled Task;
 * any Gemini failure or invalid output just means that second button is
 * omitted. A button whose value is longer than SLACK_BUTTON_VALUE_LIMIT (in
 * Python json.dumps units) is omitted on its own.
 */
export async function buildFollowupTaskButtons(
  personPageId: string,
  personName: string,
  trackId: string | null | undefined,
  interactionType: string,
  notes: string | null | undefined,
  interactionDate: PlainDate,
  notionPost: NotionPost,
  notionGet: NotionGet,
  environment: Environment,
  { generateText = null, today = null, sleep = sleepSeconds }: BuildFollowupTaskButtonsOptions = {},
): Promise<ButtonElement[]> {
  const tasksDataSourceId = environment["NOTION_TASKS_DATA_SOURCE_ID"] ?? "";
  if (!tasksDataSourceId) {
    return [];
  }
  const apiKey = environmentValue(environment, "NOTION_API_KEY");
  const tracksDataSourceId = environment["NOTION_TRACKS_DATA_SOURCE_ID"] ?? "";
  let schema: TasksSchema;
  let tracks: TrackOption[];
  try {
    schema = await fetchTasksSchema(notionGet, apiKey, tasksDataSourceId, sleep);
    tracks = tracksDataSourceId
      ? await fetchAvailableTracks(notionPost, apiKey, tracksDataSourceId, sleep)
      : [];
  } catch (error) {
    if (
      error instanceof TaskListCommandError ||
      error instanceof AddInteractionCommandError ||
      error instanceof FollowupTaskCommandError ||
      error instanceof NotionAuthenticationError
    ) {
      return [];
    }
    throw error;
  }
  const defaultTrackId = tracks.some((track) => track.id === trackId) ? (trackId as string) : null;
  const buttons = [
    followupTaskButton(personPageId, personName, { tracks, defaultTrackId, priorities: schema.priorities }),
  ];
  const suggestedTask =
    generateText && pyStrip(notes || "")
      ? await suggestFollowupTask(
          generateText,
          personName,
          interactionType,
          notes as string,
          interactionDate,
          today ?? copenhagenToday(),
        )
      : null;
  if (suggestedTask !== null) {
    buttons.push(
      followupTaskButton(personPageId, personName, {
        tracks,
        defaultTrackId,
        priorities: schema.priorities,
        suggestedTask,
      }),
    );
  }
  // Slack rejects the whole message if a button value is too long, which
  // would also lose the Interaction confirmation; omit that button instead.
  return buttons.filter((button) => pyLen(button.value) <= SLACK_BUTTON_VALUE_LIMIT);
}

/**
 * Ask Gemini for at most one follow-up Task, or null.
 *
 * Gemini only sees the just-saved Interaction and today's date. Any error
 * from `generateText` is treated as "no suggestion" (no retries), and
 * neither the prompt nor the response is ever logged.
 */
export async function suggestFollowupTask(
  generateText: GenerateText,
  personName: string,
  interactionType: string,
  notes: string,
  interactionDate: PlainDate,
  today: PlainDate,
): Promise<SuggestedTask | null> {
  const prompt = buildFollowupSuggestionPrompt(personName, interactionType, notes, interactionDate, today);
  let response: unknown;
  try {
    response = await generateText(prompt);
  } catch {
    return null;
  }
  return parseSuggestedTask(response, today);
}

export function buildFollowupSuggestionPrompt(
  personName: string,
  interactionType: string,
  notes: string,
  interactionDate: PlainDate,
  today: PlainDate,
): string {
  return (
    `${FOLLOWUP_SUGGESTION_SYSTEM_INSTRUCTION}\n` +
    `TODAY: ${isoformat(today)}\n\n` +
    "INTERACTION:\n" +
    `Person: ${personName}\n` +
    `Date: ${isoformat(interactionDate)}\n` +
    `Type: ${interactionType}\n` +
    `Notes: ${pyStrip(notes)}\n`
  );
}

/**
 * Validate Gemini's response into a SuggestedTask, or null.
 *
 * Anything but the expected JSON structure, or a missing, blank or over-long
 * name, means no suggestion. An over-long description and an invalid, past
 * or too-distant follow-up date are dropped on their own. A single
 * surrounding Markdown code fence is tolerated.
 *
 * As in Python, invalid JSON (a ValueError) means no suggestion, while a
 * RecursionError from absurdly deep nesting propagates.
 */
export function parseSuggestedTask(response: unknown, today: PlainDate): SuggestedTask | null {
  if (typeof response !== "string") {
    return null;
  }
  let text = pyStrip(response);
  const fence = MARKDOWN_FENCE_PATTERN.exec(text);
  if (fence) {
    text = fence[1] as string;
  }
  let parsed: JsonValue;
  try {
    parsed = pyJsonLoads(text);
  } catch (error) {
    if (error instanceof ValueError) return null;
    throw error;
  }
  if (!isDict(parsed)) {
    return null;
  }
  const task = dictGet(parsed, "task");
  if (!isDict(task)) {
    return null;
  }

  let name = dictGet(task, "name");
  if (typeof name !== "string") {
    return null;
  }
  name = pyStrip(name);
  if (!name || pyLen(name as string) > MAX_SUGGESTED_TASK_NAME_CHARS) {
    return null;
  }

  const rawDescription = dictGet(task, "description");
  let description = typeof rawDescription === "string" ? pyStrip(rawDescription) : "";
  if (pyLen(description) > MAX_SUGGESTED_TASK_DESCRIPTION_CHARS) {
    description = "";
  }

  return {
    name: name as string,
    description: description || null,
    followUp: parseSuggestedFollowUp(dictGet(task, "follow_up"), today),
  };
}

export function parseSuggestedFollowUp(value: unknown, today: PlainDate): PlainDate | null {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    return null;
  }
  let followUp: PlainDate;
  try {
    followUp = dateFromIsoformat(value);
  } catch (error) {
    if (error instanceof ValueError) return null;
    throw error;
  }
  // `today <= follow_up <= today + timedelta(days=365)`: the addition (which
  // can raise OverflowError) only runs when the first comparison holds.
  if (!(today <= followUp && followUp <= addDays(today, MAX_SUGGESTED_FOLLOW_UP_DAYS))) {
    return null;
  }
  return followUp;
}

/**
 * Read the title property, Priority/Status options and Description.
 *
 * Notion is the only source of truth for Priority and Status values. A
 * malformed schema response is a failure (FollowupTaskCommandError), not an
 * empty allowlist - except that a missing Priority property just means no
 * Priority options, and a missing or non-rich_text Description just means no
 * Description is written, since both are optional on a Task.
 */
export async function fetchTasksSchema(
  notionGet: NotionGet,
  apiKey: string,
  tasksDataSourceId: string,
  sleep: Sleep,
): Promise<TasksSchema> {
  const response = await callNotionWithRetries(
    () =>
      notionGet(`https://api.notion.com/v1/data_sources/${tasksDataSourceId}`, {
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
    // next(display_name for ... if isinstance(definition, dict) and
    // definition.get("type") == "title")
    const titleEntry = Object.entries(properties).find(
      ([, definition]) => isDict(definition) && dictGet(definition, "type") === "title",
    );
    if (titleEntry === undefined) {
      throw new StopIteration();
    }
    const titlePropertyName = titleEntry[0];
    const priorityProperty = dictGet(properties, TASK_PRIORITY_PROPERTY);
    const statusProperty = subscript(properties, TASK_STATUS_PROPERTY);
    const descriptionProperty = dictGet(properties, TASK_DESCRIPTION_PROPERTY);
    if (
      (priorityProperty !== null && dictGet(priorityProperty, "type") !== "select") ||
      dictGet(statusProperty, "type") !== "status"
    ) {
      throw new FollowupTaskCommandError();
    }
    return {
      titlePropertyName,
      priorities:
        priorityProperty !== null ? optionNames(subscript(subscript(priorityProperty, "select"), "options")) : [],
      statuses: optionNames(subscript(subscript(statusProperty, "status"), "options")),
      hasDescription: isDict(descriptionProperty) && dictGet(descriptionProperty, "type") === "rich_text",
    };
  } catch (error) {
    // except (AttributeError, KeyError, StopIteration, TypeError, ValueError)
    if (isParseError(error) || error instanceof StopIteration) {
      throw withPyCause(new FollowupTaskCommandError(), error);
    }
    throw error;
  }
}

/** The truthy `name` of each dict option; other entries are skipped. */
export function optionNames(options: unknown): string[] {
  const names: string[] = [];
  for (const option of iterate(options)) {
    if (isDict(option) && truthy(dictGet(option, "name"))) {
      names.push(subscript(option, "name") as string);
    }
  }
  return names;
}

/** The bundled Task fields of a follow-up Task submission. */
export type TaskPayload = {
  readonly name: string;
  readonly description: string;
  readonly follow_up: string;
  readonly priority: string;
  readonly track_id: string;
};

const TASK_PAYLOAD_FIELDS = ["name", "description", "follow_up", "priority", "track_id"] as const;

/**
 * Decode the bundled Task fields from a follow-up Task submission.
 *
 * Matches api/slack-request.js: the fields travel together as one JSON field
 * (SLACK_TASK) to stay within GitHub's 10-property client_payload limit.
 * Malformed JSON yields empty fields, which validation rejects. The keys keep
 * Python's snake_case, as they are the payload's field names.
 */
export function parseTaskPayload(value: string | null | undefined): TaskPayload {
  let parsed: unknown;
  try {
    parsed = value ? pyJsonLoads(value) : {};
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    parsed = {};
  }
  const fields: Dict = isDict(parsed) ? parsed : {};
  const payload: Record<string, string> = {};
  for (const field of TASK_PAYLOAD_FIELDS) {
    const fieldValue = dictGet(fields, field);
    payload[field] = typeof fieldValue === "string" ? fieldValue : "";
  }
  return payload as TaskPayload;
}

export type HandleAddFollowupTaskSubmissionOptions = {
  threadTs?: string | null | undefined;
  today?: PlainDate | null | undefined;
  sleep?: Sleep | undefined;
};

/**
 * Validate and perform exactly one Task write.
 *
 * Gemini is never involved. Person identity comes from the modal's structured
 * state; Priority and Track are re-validated against live Notion data rather
 * than trusted from the submission. `description` is the user's own typed
 * text (Interaction notes are never copied); blank means Description is left
 * unset.
 *
 * The validation order is: Person identity (silent no-op when missing), the
 * name, the follow-up date, then (reading Notion) the Tasks data source, the
 * schema, the Priority, the Track, the "Ikke startet" Status, and the create.
 */
export async function handleAddFollowupTaskSubmission(
  personPageId: string | null | undefined,
  personName: string | null | undefined,
  taskName: string | null | undefined,
  description: string | null | undefined,
  followUpValue: string | null | undefined,
  priority: string | null | undefined,
  trackId: string | null | undefined,
  postSlackMessage: PostSlackMessage,
  notionPost: NotionPost,
  notionGet: NotionGet,
  environment: Environment,
  { threadTs = null, today = null, sleep = sleepSeconds }: HandleAddFollowupTaskSubmissionOptions = {},
): Promise<void> {
  // Python passes thread_ts=thread_ts on every post, None included.
  const slackOptions = { threadTs: threadTs ?? undefined };

  if (!personPageId || !personName) {
    // No Person to link the Task to; nothing safe to report.
    return;
  }

  const name = pyStrip(taskName || "");
  if (!name) {
    await postSlackMessage(FOLLOWUP_TASK_INVALID_MESSAGE, slackOptions);
    return;
  }
  const trimmedDescription = pyStrip(description || "");

  let followUp: PlainDate | null;
  try {
    // TECH-DEBT TD3: date.fromisoformat's leniency is kept.
    followUp = followUpValue ? dateFromIsoformat(followUpValue) : null;
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    await postSlackMessage(FOLLOWUP_TASK_INVALID_MESSAGE, slackOptions);
    return;
  }

  const apiKey = environmentValue(environment, "NOTION_API_KEY");
  const tasksDataSourceId = environment["NOTION_TASKS_DATA_SOURCE_ID"] ?? "";
  try {
    if (!tasksDataSourceId) {
      throw new FollowupTaskCommandError();
    }
    const schema = await fetchTasksSchema(notionGet, apiKey, tasksDataSourceId, sleep);

    if (priority && !schema.priorities.includes(priority)) {
      await postSlackMessage(FOLLOWUP_TASK_INVALID_MESSAGE, slackOptions);
      return;
    }

    if (
      trackId &&
      !(await isValidTrack(
        trackId,
        notionPost,
        apiKey,
        environment["NOTION_TRACKS_DATA_SOURCE_ID"] ?? "",
        sleep,
      ))
    ) {
      await postSlackMessage(FOLLOWUP_TASK_INVALID_MESSAGE, slackOptions);
      return;
    }

    if (!schema.statuses.includes(TASK_STATUS_NOT_STARTED)) {
      await postSlackMessage(FOLLOWUP_TASK_STATUS_MISSING_MESSAGE, slackOptions);
      return;
    }

    try {
      await createTaskPage(
        notionPost,
        apiKey,
        tasksDataSourceId,
        schema.titlePropertyName,
        name,
        schema.hasDescription ? trimmedDescription : "",
        personPageId,
        trackId,
        priority,
        followUp,
        today ?? copenhagenToday(),
        sleep,
      );
    } catch (error) {
      if (!(error instanceof TaskListCommandError)) throw error;
      // A timeout, connection error or 5xx may arrive after Notion already
      // created the page; a blind retry could duplicate it (S9). The request
      // error is the cause (`error.__cause__`) of the TaskListCommandError.
      const statusCode = externalErrorStatusCode(getPyCause(error));
      if (statusCode === null || statusCode >= 500) {
        await postSlackMessage(FOLLOWUP_TASK_UNCERTAIN_MESSAGE, slackOptions);
        return;
      }
      throw error;
    }
  } catch (error) {
    if (
      !(
        error instanceof TaskListCommandError ||
        error instanceof AddInteractionCommandError ||
        error instanceof FollowupTaskCommandError ||
        error instanceof NotionAuthenticationError
      )
    ) {
      throw error;
    }
    await postSlackMessage(FOLLOWUP_TASK_FAILURE_MESSAGE, slackOptions);
    return;
  }

  await postSlackMessage(followupTaskAddedMessage(personName, name), slackOptions);
}

/**
 * Create the Task page: one POST to /v1/pages that retries only a 429
 * (isRejectedBeforeProcessing); 401 and 403 are credential failures. Status
 * is always "Ikke startet" and Created is `created` (today).
 */
export async function createTaskPage(
  notionPost: NotionPost,
  apiKey: string,
  tasksDataSourceId: string,
  titlePropertyName: string,
  taskName: string,
  description: string,
  personPageId: string,
  trackId: string | null | undefined,
  priority: string | null | undefined,
  followUp: PlainDate | null,
  created: PlainDate,
  sleep: Sleep,
): Promise<void> {
  // A computed key in a literal is an own property even for "__proto__".
  const properties: Dict = {
    [titlePropertyName]: {
      title: [{ type: "text", text: { content: taskName } }],
    },
    [TASK_PEOPLE_PROPERTY]: { relation: [{ id: personPageId }] },
    [TASK_STATUS_PROPERTY]: { status: { name: TASK_STATUS_NOT_STARTED } },
    [TASK_CREATED_PROPERTY]: { date: { start: isoformat(created) } },
  };
  if (trackId) {
    properties[TASK_TRACK_PROPERTY] = { relation: [{ id: trackId }] };
  }
  if (priority) {
    properties[TASK_PRIORITY_PROPERTY] = { select: { name: priority } };
  }
  if (description) {
    properties[TASK_DESCRIPTION_PROPERTY] = {
      rich_text: [{ type: "text", text: { content: description } }],
    };
  }
  if (followUp) {
    properties[TASK_FOLLOW_UP_PROPERTY] = { date: { start: isoformat(followUp) } };
  }
  await callNotionWithRetries(
    () =>
      notionPost("https://api.notion.com/v1/pages", {
        headers: notionHeaders(apiKey),
        json: {
          parent: { data_source_id: tasksDataSourceId },
          properties,
        },
        timeout: 10,
      }),
    sleep,
    { isRetryable: isRejectedBeforeProcessing },
  );
}

/**
 * Only a 429 is safe to retry for a Task create.
 *
 * A timeout, connection error or 5xx may arrive after Notion already created
 * the page, so retrying those could duplicate the Task.
 */
export function isRejectedBeforeProcessing(error: unknown): boolean {
  return externalErrorStatusCode(error) === 429;
}
