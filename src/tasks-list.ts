// Port of tasks_list.py: the /tasks list command and the shared Notion helpers
// (retry policy, headers, Track parsing) that the other modules import.
//
// Notion data is untrusted JSON, so the parsers below read it with the
// Python-semantics accessors from python-compat.ts (`subscript`, `dictGet`,
// `iterate`, `truthy`). They throw where the Python expression would raise:
// KeyError for a missing `x["key"]`, TypeError where Python raises TypeError
// or AttributeError (for example `.get` on a list). Each parser catches exactly
// what its Python counterpart catches.

import { ConnectionError, Timeout, type GetOptions, type HttpHeaders, type PostOptions } from "./http.ts";
import {
  DATE_MAX,
  addDays,
  compareDates,
  copenhagenToday,
  dateFromIsoformat,
  isoformat,
  parseHttpDate,
  type PlainDate,
} from "./plain-date.ts";
import {
  KeyError,
  OverflowError,
  ValueError,
  assertHashable,
  casefold,
  comparePy,
  dictContains,
  dictGet,
  isDict,
  isParseError,
  iterate,
  pyFloat,
  pyStrip,
  subscript,
  truthy,
  withPyCause,
  type Dict,
} from "./python-compat.ts";

export { copenhagenToday };

export const NOTION_API_VERSION = "2025-09-03";
export const TASKS_USAGE = "Usage: /tasks list";
export const TASKS_CHANNEL_REFUSAL = "The /tasks command is not available in this channel.";
export const NO_TASKS_MESSAGE = "No tasks need attention right now.";
export const MORE_TASKS_MESSAGE = "More tasks may need attention.";
export const TASKS_FAILURE_MESSAGE = "Unable to retrieve tasks right now. Please try again later.";
export const MAX_SCANNED_TASKS = 500;
export const MAX_DISPLAYED_TASKS = 20;
export const MAX_DISPLAYED_TRACKS = 3;
export const NOTION_PAGE_SIZE = 100;
export const MAX_NOTION_PAGES = Math.floor(MAX_SCANNED_TASKS / NOTION_PAGE_SIZE);
export const PRIORITY_ORDER: Readonly<Record<string, number>> = { High: 0, Medium: 1, Low: 2 };
export const STATUS_DONE = "Færdig";

// The field types follow the Python dataclass annotations. As in Python they
// are not enforced: `status` and `priority` hold whatever JSON value Notion
// returned for the option name (a string with the documented Notion schema).
export type Task = {
  readonly name: string;
  readonly url: string;
  readonly status: string | null;
  readonly followUp: PlainDate | null;
  readonly priority: string | null;
  readonly trackIds: readonly string[];
};

export type Track = {
  readonly name: string;
  readonly priority: string | null;
};

/** Track id → resolved Track, or null when the Track is unavailable. */
export type ResolvedTracks = ReadonlyMap<string, Track | null>;

/** A Notion task-list failure that is safe to expose generically. */
export class TaskListCommandError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "TaskListCommandError";
  }
}

/** A Notion credential failure that must fail the workflow clearly. (RuntimeError in Python.) */
export class NotionAuthenticationError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "NotionAuthenticationError";
  }
}

/** A single task record cannot be interpreted using the expected schema. */
export class MalformedTaskPageError extends ValueError {
  constructor(message = "") {
    super(message);
    this.name = "MalformedTaskPageError";
  }
}

/** A Track record cannot be interpreted using the expected schema. */
export class MalformedTrackPageError extends ValueError {
  constructor(message = "") {
    super(message);
    this.name = "MalformedTrackPageError";
  }
}

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** What the code uses of a `requests` response; HttpResponse satisfies it. */
export type NotionResponse = {
  json(): unknown;
  raise_for_status(): void;
};

/** `requests.post`'s call shape, as `Http.post` in http.ts. */
export type NotionPost = (url: string, options: PostOptions) => Promise<NotionResponse>;

/** `requests.get`'s call shape, as `Http.get` in http.ts. */
export type NotionGet = (url: string, options: GetOptions) => Promise<NotionResponse>;

/** `time.sleep`: seconds. A fake may return synchronously. */
export type Sleep = (seconds: number) => unknown;

/** `post_slack_message(message, thread_ts=None, blocks=None)`; returns Slack's JSON body. */
export type PostSlackMessage = (
  message: string,
  options?: { threadTs?: string; blocks?: unknown },
) => Promise<Record<string, unknown>>;

export type PostEphemeralResponse = (message: string) => Promise<unknown>;

/** `os.environ` or a dict: a missing key raises KeyError when read. */
export type Environment = Readonly<Record<string, string | undefined>>;

// setTimeout fires at once for a delay above 2**31 - 1 ms, so a longer sleep
// is taken in steps (a large Retry-After makes time.sleep wait that long).
const MAX_TIMEOUT_MS = 2_147_483_647;

const TWO_POW_63 = 2 ** 63;

/**
 * The default `sleep`, like `time.sleep`, including what it raises before
 * sleeping. CPython 3.12 converts the seconds to a signed 64-bit count of
 * nanoseconds, `seconds * 1e9` rounded away from zero (pytime.c,
 * `_PyTime_FromDouble` with `_PyTime_ROUND_TIMEOUT`), then checks the sign.
 * Verified against `py -3.12`:
 *
 * - NaN: ValueError("Invalid value NaN (not a number)").
 * - Rounded nanoseconds outside [-2**63, 2**63), which includes ±inf:
 *   OverflowError("timestamp out of range for platform time_t"). The largest
 *   value that sleeps is 9223372036.854774 (0x1.12e0be826d694p+33); the next
 *   double, 9223372036.854776, overflows.
 * - Any other negative value, even -1e-10 (rounded to -1 ns): ValueError("sleep
 *   length must be non-negative"). -0.0 sleeps for 0 seconds.
 *
 * (For an int argument Python's OverflowError message differs, but the same
 * values overflow.)
 */
export async function sleepSeconds(seconds: number): Promise<void> {
  if (Number.isNaN(seconds)) throw new ValueError("Invalid value NaN (not a number)");
  const scaled = seconds * 1e9;
  const nanoseconds = scaled >= 0 ? Math.ceil(scaled) : Math.floor(scaled);
  if (!(-TWO_POW_63 <= nanoseconds && nanoseconds < TWO_POW_63)) {
    throw new OverflowError("timestamp out of range for platform time_t");
  }
  if (nanoseconds < 0) throw new ValueError("sleep length must be non-negative");

  let remaining = seconds * 1000;
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_TIMEOUT_MS);
    await new Promise((resolve) => setTimeout(resolve, step));
    remaining -= step;
  }
}

/** `environment[name]`: throws KeyError when the variable is missing. */
export function environmentValue(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined) throw new KeyError(name);
  return value;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** `"".join(part.get("plain_text", "") for part in parts)`. */
function joinPlainText(parts: unknown): string {
  let joined = "";
  for (const part of iterate(parts)) {
    const text = dictGet(part, "plain_text", "");
    if (typeof text !== "string") throw new TypeError("sequence item: expected str instance");
    joined += text;
  }
  return joined;
}

/** `PRIORITY_ORDER.get(priority, len(PRIORITY_ORDER))`. */
function priorityRank(priority: unknown): number {
  assertHashable(priority);
  if (typeof priority === "string" && Object.hasOwn(PRIORITY_ORDER, priority)) {
    return PRIORITY_ORDER[priority] as number;
  }
  return Object.keys(PRIORITY_ORDER).length;
}

/** `sorted(items, key=key)`: every key is computed first, then a stable sort. */
function sortedByKey<T, K>(items: readonly T[], key: (item: T) => K, compare: (a: K, b: K) => number): T[] {
  const keyed = items.map((item) => ({ item, sortKey: key(item) }));
  keyed.sort((a, b) => compare(a.sortKey, b.sortKey));
  return keyed.map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// The /tasks command
// ---------------------------------------------------------------------------

export type HandleTasksCommandOptions = {
  today?: PlainDate | undefined;
  postEphemeralResponse?: PostEphemeralResponse | undefined;
  notionGet?: NotionGet | undefined;
  sleep?: Sleep | undefined;
};

/**
 * Handle the owned /tasks command family without using Gemini.
 *
 * Resolving to true means the command was fully handled and must not continue
 * into the Gemini conversation path. False is reserved for other command
 * families. `today` is injectable so date-based command behavior can be
 * verified without relying on the runner clock.
 */
export async function handleTasksCommand(
  command: string,
  text: string,
  _channelId: string,
  postSlackMessage: PostSlackMessage,
  notionPost: NotionPost,
  environment: Environment,
  { today, postEphemeralResponse, notionGet, sleep = sleepSeconds }: HandleTasksCommandOptions = {},
): Promise<boolean> {
  if (command !== "/tasks") {
    return false;
  }

  if (casefold(pyStrip(text)) !== "list") {
    await postTaskValidationResponse(TASKS_USAGE, postSlackMessage, postEphemeralResponse);
    return true;
  }

  const rootMessage = await postSlackMessage("/tasks list");
  let commandToday: PlainDate;
  let hasUnexaminedTasks: boolean;
  let eligibleTasks: Task[];
  let skippedTaskCount: number;
  let resolvedTracks: ResolvedTracks;
  try {
    commandToday = today ?? copenhagenToday();
    let pages: unknown[];
    [pages, hasUnexaminedTasks] = await fetchTasks(
      notionPost,
      environmentValue(environment, "NOTION_API_KEY"),
      environmentValue(environment, "NOTION_TASKS_DATA_SOURCE_ID"),
      { sleep },
    );
    [eligibleTasks, skippedTaskCount] = selectTasksNeedingAttention(pages, commandToday);
    resolvedTracks = await resolveTracks(
      eligibleTasks,
      notionGet ?? null,
      environmentValue(environment, "NOTION_API_KEY"),
      { sleep },
    );
  } catch (error) {
    if (!(error instanceof TaskListCommandError)) throw error;
    await postSlackMessage(TASKS_FAILURE_MESSAGE, { threadTs: rootTs(rootMessage) });
    return true;
  }

  let message: string;
  if (eligibleTasks.length > 0) {
    message = formatTaskList(eligibleTasks, commandToday, { resolvedTracks });
    if (hasUnexaminedTasks) {
      message = `${message}\n\n${MORE_TASKS_MESSAGE}`;
    }
  } else if (hasUnexaminedTasks) {
    // The bounded result is not complete, so the normal empty-state claim
    // would be misleading.
    message = MORE_TASKS_MESSAGE;
  } else {
    message = NO_TASKS_MESSAGE;
  }

  if (skippedTaskCount) {
    const noun = skippedTaskCount === 1 ? "task" : "tasks";
    message = `${message}\n\nSkipped ${skippedTaskCount} malformed ${noun}.`;
  }

  await postSlackMessage(message, { threadTs: rootTs(rootMessage) });
  return true;
}

/** `root_message["ts"]`: KeyError when Slack's response has no `ts`. */
function rootTs(rootMessage: Record<string, unknown>): string {
  return subscript(rootMessage, "ts") as string;
}

export async function postTaskValidationResponse(
  message: string,
  postSlackMessage: PostSlackMessage,
  postEphemeralResponse: PostEphemeralResponse | null | undefined,
): Promise<void> {
  if (postEphemeralResponse) {
    await postEphemeralResponse(message);
  } else {
    await postSlackMessage(message);
  }
}

/**
 * Fetch at most 500 non-finished task records from Notion.
 *
 * A true second result means Notion had another page after the examined set;
 * that page is deliberately not fetched.
 */
export async function fetchTasks(
  notionPost: NotionPost,
  apiKey: string,
  dataSourceId: string,
  { sleep = sleepSeconds }: { sleep?: Sleep | undefined } = {},
): Promise<[unknown[], boolean]> {
  const results: unknown[] = [];
  let cursor: unknown = null;
  let hasUnexaminedTasks = false;

  let pagesFetched = 0;
  while (results.length < MAX_SCANNED_TASKS && pagesFetched < MAX_NOTION_PAGES) {
    const requestJson: Dict = {
      page_size: Math.min(NOTION_PAGE_SIZE, MAX_SCANNED_TASKS - results.length),
      filter: {
        property: "Status",
        status: { does_not_equal: STATUS_DONE },
      },
    };
    if (truthy(cursor)) {
      requestJson["start_cursor"] = cursor;
    }

    const response = await callNotionWithRetries(
      () =>
        notionPost(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
          headers: notionHeaders(apiKey),
          json: requestJson,
          timeout: 10,
        }),
      sleep,
    );
    pagesFetched += 1;
    let responseBody: unknown;
    try {
      responseBody = response.json();
    } catch (error) {
      if (error instanceof TypeError || error instanceof ValueError) {
        throw withPyCause(new TaskListCommandError(), error);
      }
      throw error;
    }
    if (!isDict(responseBody)) {
      throw new TaskListCommandError();
    }
    const pageResults = dictGet(responseBody, "results", []);
    if (!Array.isArray(pageResults)) {
      throw new TaskListCommandError();
    }
    const remaining = MAX_SCANNED_TASKS - results.length;
    results.push(...pageResults.slice(0, remaining));

    if (pageResults.length > remaining) {
      hasUnexaminedTasks = true;
      break;
    }
    if (!truthy(dictGet(responseBody, "has_more"))) {
      break;
    }

    cursor = dictGet(responseBody, "next_cursor");
    if (!truthy(cursor)) {
      // Do not issue an unsafe repeated request on a malformed pagination
      // response. It cannot be claimed complete.
      hasUnexaminedTasks = true;
      break;
    }
    if (results.length === MAX_SCANNED_TASKS || pagesFetched === MAX_NOTION_PAGES) {
      hasUnexaminedTasks = true;
      break;
    }
  }

  return [results, hasUnexaminedTasks];
}

export function selectTasksNeedingAttention(
  pages: readonly unknown[],
  today: PlainDate,
): [Task[], number] {
  const [eligibleTasks, skippedTaskCount] = selectAllTasksNeedingAttention(pages, today);
  return [eligibleTasks.slice(0, MAX_DISPLAYED_TASKS), skippedTaskCount];
}

/** Every eligible task in display order, without the /tasks list cap. */
export function selectAllTasksNeedingAttention(
  pages: readonly unknown[],
  today: PlainDate,
): [Task[], number] {
  const tasks: Task[] = [];
  let skippedTaskCount = 0;
  for (const page of pages) {
    try {
      tasks.push(taskFromNotionPage(page));
    } catch (error) {
      if (!(error instanceof MalformedTaskPageError)) throw error;
      skippedTaskCount += 1;
    }
  }
  const eligibleTasks = tasks.filter((task) => needsAttention(task, today));
  return [sortedByKey(eligibleTasks, taskSortKey, compareTaskSortKeys), skippedTaskCount];
}

export function taskFromNotionPage(page: unknown): Task {
  try {
    const properties = subscript(page, "properties");
    const titleProperty = findProperty(properties, "Name", "title") as Dict;
    const name = pyStrip(joinPlainText(dictGet(titleProperty, "title", [])));
    const url = subscript(page, "url");
    if (!name || !truthy(url)) {
      throw new MalformedTaskPageError("A task is missing its Name or URL");
    }

    const statusProperty = findProperty(properties, "Status", "status") as Dict;
    const statusValue = dictGet(statusProperty, "status");
    const status = dictGet(truthy(statusValue) ? statusValue : {}, "name");
    const priorityProperty = findProperty(properties, "Priority", "select", { required: false });
    let priority: unknown = null;
    if (truthy(priorityProperty)) {
      const selectValue = dictGet(priorityProperty, "select");
      priority = dictGet(truthy(selectValue) ? selectValue : {}, "name");
    }
    const followUpProperty = findProperty(properties, "Follow-up", "date", { required: false });
    let followUpStart: unknown = null;
    if (truthy(followUpProperty)) {
      const dateValue = dictGet(followUpProperty, "date");
      followUpStart = dictGet(truthy(dateValue) ? dateValue : {}, "start");
    }
    let trackProperty = dictGet(properties, "Track");
    if (truthy(trackProperty) && dictGet(trackProperty, "type") !== "relation") {
      trackProperty = null;
    }
    const trackIds: unknown[] = [];
    for (const relation of iterate(truthy(trackProperty) ? dictGet(trackProperty, "relation", []) : [])) {
      if (truthy(dictGet(relation, "id"))) {
        trackIds.push(subscript(relation, "id"));
      }
    }
    let followUp: PlainDate | null = null;
    if (truthy(followUpStart)) {
      if (typeof followUpStart !== "string") {
        throw new TypeError("fromisoformat: argument must be str");
      }
      // TECH-DEBT TD2: date.fromisoformat, so a datetime value is malformed.
      followUp = dateFromIsoformat(followUpStart);
    }
    return {
      name,
      url: url as string,
      status: status as string | null,
      followUp,
      priority: priority as string | null,
      trackIds: trackIds as string[],
    };
  } catch (error) {
    if (isParseError(error)) throw withPyCause(new MalformedTaskPageError(), error);
    throw error;
  }
}

/** Resolve each distinct Track at most once for this command. */
export async function resolveTracks(
  tasks: readonly Task[],
  notionGet: NotionGet | null,
  apiKey: string,
  { sleep = sleepSeconds }: { sleep?: Sleep | undefined } = {},
): Promise<Map<string, Track | null>> {
  const resolved = new Map<string, Track | null>();
  for (const task of tasks) {
    for (const trackId of task.trackIds) {
      assertHashable(trackId);
      if (resolved.has(trackId)) {
        continue;
      }

      if (notionGet === null) {
        resolved.set(trackId, null);
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
        resolved.set(trackId, trackFromNotionPage(trackPage));
      } catch (error) {
        if (!(error instanceof TaskListCommandError || error instanceof MalformedTrackPageError)) {
          throw error;
        }
        // Track failures are intentionally isolated to the relation;
        // the task remains visible with a safe fallback.
        resolved.set(trackId, null);
      }
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Notion retry policy (shared)
// ---------------------------------------------------------------------------

export type CallNotionWithRetriesOptions = {
  credentialFailureStatusCodes?: readonly number[] | undefined;
  isRetryable?: ((error: unknown) => boolean) | null | undefined;
};

/**
 * Make one Notion request, retrying only bounded transient failures.
 *
 * `isRetryable` narrows which failures are retried (default:
 * isRetryableNotionError), e.g. for a non-idempotent write.
 *
 * A credential failure throws NotionAuthenticationError with no cause
 * (`from None`). Any other final failure throws TaskListCommandError whose
 * cause (getPyCause) is the request's error.
 */
export async function callNotionWithRetries<R extends NotionResponse>(
  request: () => R | Promise<R>,
  sleep: Sleep,
  { credentialFailureStatusCodes = [401, 403], isRetryable }: CallNotionWithRetriesOptions = {},
): Promise<R> {
  const retryable = isRetryable || isRetryableNotionError;
  for (let retryNumber = 0; retryNumber < 3; retryNumber += 1) {
    try {
      const response = await request();
      response.raise_for_status();
      return response;
    } catch (error) {
      const statusCode = externalErrorStatusCode(error);
      if (statusCode !== null && credentialFailureStatusCodes.includes(statusCode)) {
        throw new NotionAuthenticationError(`Notion authentication failed (HTTP ${statusCode}).`);
      }
      if (!retryable(error) || retryNumber === 2) {
        throw withPyCause(new TaskListCommandError(), error);
      }
      await sleep(retryDelay(error, retryNumber));
    }
  }
  // Unreachable: the third failure always throws above.
  throw new TaskListCommandError();
}

function attribute(value: unknown, name: string): unknown {
  // getattr(value, name, None)
  if (value === null || value === undefined) return null;
  const found = (value as Record<string, unknown>)[name];
  return found === undefined ? null : found;
}

/**
 * `getattr(getattr(error, "response", None), "status_code", None)` when it is
 * an int, else null. Reads the http.ts error shape (`error.response.status_code`).
 */
export function externalErrorStatusCode(error: unknown): number | null {
  const statusCode = attribute(attribute(error, "response"), "status_code");
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : null;
}

export function isRetryableNotionError(error: unknown): boolean {
  const statusCode = attribute(attribute(error, "response"), "status_code");
  if (
    statusCode === 429 ||
    (typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 500 && statusCode < 600)
  ) {
    return true;
  }
  return error instanceof Timeout || error instanceof ConnectionError;
}

/**
 * `(headers or {}).get(name)` for a `Headers` object (case-insensitive, like
 * requests' CaseInsensitiveDict) or a plain dict (the Python tests' fakes).
 */
function headerValue(headers: unknown, name: string): unknown {
  if (headers instanceof Headers) return headers.get(name);
  if (!truthy(headers)) return null;
  return dictGet(headers, name);
}

/** `float(value)`, or null where it raises TypeError or ValueError. */
function floatOrNone(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return null;
  try {
    return pyFloat(value);
  } catch (error) {
    if (error instanceof ValueError) return null;
    throw error;
  }
}

/**
 * The seconds to wait before retry number `retryNumber` (0 or 1): a valid
 * Retry-After (seconds or an HTTP-date relative to now), else 1 + retryNumber.
 */
export function retryDelay(error: unknown, retryNumber: number): number {
  const response = attribute(error, "response");
  const retryAfter = headerValue(attribute(response, "headers"), "Retry-After");
  const delay = floatOrNone(retryAfter);
  if (delay !== null && Number.isFinite(delay) && delay >= 0) {
    return delay;
  }
  if (typeof retryAfter === "string") {
    try {
      const retryAt = parseHttpDate(retryAfter);
      return Math.max(0, (retryAt - Date.now()) / 1000);
    } catch (parseError) {
      if (!(parseError instanceof ValueError)) throw parseError;
    }
  }
  return 1 + retryNumber;
}

// ---------------------------------------------------------------------------
// Track pages, headers, properties
// ---------------------------------------------------------------------------

export function trackFromNotionPage(page: unknown): Track {
  try {
    const properties = subscript(page, "properties");
    const nameProperty = dictGet(properties, "Navn");
    if (!truthy(nameProperty) || dictGet(nameProperty, "type") !== "title") {
      throw new MalformedTrackPageError("A Track is missing its Navn");
    }
    const name = pyStrip(joinPlainText(dictGet(nameProperty, "title", [])));
    if (!name) {
      throw new MalformedTrackPageError("A Track is missing its Navn");
    }

    let priorityProperty = dictGet(properties, "Priority");
    if (truthy(priorityProperty) && dictGet(priorityProperty, "type") !== "select") {
      priorityProperty = null;
    }
    let priority: unknown = null;
    if (truthy(priorityProperty)) {
      const selectValue = dictGet(priorityProperty, "select");
      priority = dictGet(truthy(selectValue) ? selectValue : {}, "name");
    }
    return { name, priority: priority as string | null };
  } catch (error) {
    if (isParseError(error)) throw withPyCause(new MalformedTrackPageError(), error);
    throw error;
  }
}

export function notionHeaders(apiKey: string): HttpHeaders {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_API_VERSION,
  };
}

/**
 * Find a property by display name, else the first property of the type.
 * Returns null (None) when it is optional and missing; throws
 * MalformedTaskPageError when it is required and missing.
 */
export function findProperty(
  properties: unknown,
  displayName: string,
  propertyType: string,
  { required = true }: { required?: boolean } = {},
): unknown {
  const propertyValue = dictGet(properties, displayName);
  if (
    truthy(propertyValue) &&
    (dictGet(propertyValue, "type") === propertyType || dictContains(propertyValue as Dict, propertyType))
  ) {
    return propertyValue;
  }

  for (const candidate of Object.values(properties as Dict)) {
    if (dictGet(candidate, "type") === propertyType || dictContains(candidate as Dict, propertyType)) {
      return candidate;
    }
    if (propertyType === "title" && dictGet(candidate, "id") === "title") {
      return candidate;
    }
  }

  if (required) {
    throw new MalformedTaskPageError(`A task is missing its ${displayName} property`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selection and formatting
// ---------------------------------------------------------------------------

export function needsAttention(task: Task, today: PlainDate): boolean {
  return (
    task.status !== STATUS_DONE &&
    (task.followUp === null || compareDates(task.followUp, addDays(today, 7)) <= 0)
  );
}

type TaskSortKey = [number, PlainDate, number, string];

export function taskSortKey(task: Task): TaskSortKey {
  const rank = priorityRank(task.priority);
  const nameKey = casefold(task.name);
  if (task.followUp === null) {
    return [1, DATE_MAX, rank, nameKey];
  }
  return [0, task.followUp, rank, nameKey];
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Python tuple comparison of two task sort keys. */
export function compareTaskSortKeys(a: TaskSortKey, b: TaskSortKey): number {
  return (
    compareNumbers(a[0], b[0]) ||
    compareDates(a[1], b[1]) ||
    compareNumbers(a[2], b[2]) ||
    comparePy(a[3], b[3])
  );
}

export function formatTaskList(
  tasks: readonly Task[],
  today: PlainDate,
  { resolvedTracks }: { resolvedTracks?: ResolvedTracks | null | undefined } = {},
): string {
  return tasks.map((task) => formatTask(task, today, { resolvedTracks: resolvedTracks ?? new Map() })).join("\n");
}

export function formatTask(
  task: Task,
  today: PlainDate,
  { resolvedTracks }: { resolvedTracks?: ResolvedTracks | null | undefined } = {},
): string {
  const priority = truthy(task.priority) ? task.priority : "No priority";
  const followUp = formatFollowUp(task, today);
  const trackText = formatTracks(task, resolvedTracks ?? new Map());
  return `• <${task.url}|${task.name}> — Priority: ${priority} — Track: ${trackText} — ${followUp}`;
}

export function formatFollowUp(task: Task, today: PlainDate): string {
  if (task.followUp === null) {
    return "No follow-up";
  }
  if (compareDates(task.followUp, today) < 0) {
    return `Overdue: ${isoformat(task.followUp)}`;
  }
  if (compareDates(task.followUp, today) === 0) {
    return "Follow-up: today";
  }
  return `Follow-up: ${isoformat(task.followUp)}`;
}

export function formatTracks(task: Task, resolvedTracks: ResolvedTracks): string {
  if (task.trackIds.length === 0) {
    return "No track";
  }

  const lookup = (trackId: string): Track | null => resolvedTracks.get(trackId) ?? null;
  const available = task.trackIds
    .filter((trackId) => lookup(trackId) !== null)
    .map((trackId) => lookup(trackId) as Track);
  const sortedAvailable = sortedByKey(
    available,
    (track): [number, string] => [priorityRank(track.priority), casefold(track.name)],
    (a, b) => compareNumbers(a[0], b[0]) || comparePy(a[1], b[1]),
  );
  const unavailableCount = task.trackIds.filter((trackId) => lookup(trackId) === null).length;
  const names = sortedAvailable.map((track) => track.name);
  for (let index = 0; index < unavailableCount; index += 1) {
    names.push("Track unavailable");
  }
  const displayedNames = names.slice(0, MAX_DISPLAYED_TRACKS);
  if (task.trackIds.length > MAX_DISPLAYED_TRACKS) {
    displayedNames.push(`+${task.trackIds.length - MAX_DISPLAYED_TRACKS} more`);
  }
  return displayedNames.join(", ");
}
