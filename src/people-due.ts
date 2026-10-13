// Port of people_due.py: the /people command family, `/people due`'s cadence
// evaluation, the bounded Notion pagination that the other People modules
// import (`fetchNotionPages`, `queryDataSource`), and the Block Kit builders.
//
// Notion data is untrusted JSON. As in tasks-list.ts, it is read with the
// python-compat accessors, and each parser catches exactly what its Python
// counterpart catches: `except (AttributeError, KeyError, TypeError)` is
// isAccessError, and with ValueError added it is isParseError.

import {
  DATE_MAX,
  addCalendarMonths,
  compareDates,
  dateFromIsoDatetime,
  dateFromIsoformat,
  isoformat,
  type PlainDate,
} from "./plain-date.ts";
import {
  KeyError,
  ValueError,
  assertHashable,
  casefold,
  comparePy,
  dictGet,
  isAccessError,
  isDict,
  isParseError,
  iterate,
  pySlice,
  pyStartsWithSpace,
  pyStrip,
  subscript,
  truthy,
  withPyCause,
  type Dict,
} from "./python-compat.ts";
import {
  TaskListCommandError,
  callNotionWithRetries,
  copenhagenToday,
  environmentValue,
  notionHeaders,
  sleepSeconds,
  type Environment,
  type NotionGet,
  type NotionPost,
  type PostEphemeralResponse,
  type PostSlackMessage,
  type Sleep,
} from "./tasks-list.ts";
// Type-only: erased at runtime, so it adds no import cycle. The module itself
// is imported lazily in handlePeopleCommand, as Python does.
import type { GenerateText } from "./people-suggest.ts";

export { addCalendarMonths };

export const PEOPLE_USAGE = "Usage: /people due | /people suggest <person>";
export const PEOPLE_CHANNEL_REFUSAL = "The /people command is not available in this channel.";
export const NO_DUE_PERSON_MESSAGE = "No people are due for contact.";
export const PEOPLE_FAILURE_MESSAGE = "Unable to retrieve people right now. Please try again later.";
export const INCOMPLETE_SCAN_MESSAGE =
  "Some People or Interactions could not be scanned; results may be incomplete.";
export const CADENCE_MONTHS: Readonly<Record<string, number>> = {
  "1 month": 1,
  "2 months": 2,
  "3 months": 3,
  "6 months": 6,
  "12 months": 12,
};
export const PEOPLE_PAGE_SIZE = 100;
export const INTERACTIONS_PAGE_SIZE = 100;
export const MAX_DISPLAYED_PEOPLE = 20;
export const MAX_SCANNED_PEOPLE = 500;
export const MAX_SCANNED_INTERACTIONS = 500;

/** `class CadenceStatus(str, Enum)`: the values are the enum's string values. */
export const CadenceStatus = {
  DUE_WITH_NO_PREVIOUS_INTERACTION: "due_with_no_previous_interaction",
  NOT_DUE: "not_due",
  DUE_TODAY: "due_today",
  OVERDUE: "overdue",
} as const;
export type CadenceStatus = (typeof CadenceStatus)[keyof typeof CadenceStatus];

// The field types follow the Python dataclass annotations. As in Python they
// are not enforced: `pageId` holds whatever truthy JSON value Notion returned
// for the page id (a string with the documented Notion schema).
export type Person = {
  readonly pageId: string;
  readonly name: string;
  readonly cadence: string;
  readonly linkedinUrl: string | null;
};

export type CadenceEvaluation = {
  readonly status: CadenceStatus;
  readonly latestInteractionDate: PlainDate | null;
  readonly nextDueDate: PlainDate | null;
  readonly isDue: boolean;
};

export type DuePerson = {
  readonly person: Person;
  readonly latestInteraction: PlainDate | null;
  readonly nextContactDue: PlainDate | null;
};

/** A People cadence failure that is safe to expose generically. */
export class PeopleDueCommandError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "PeopleDueCommandError";
  }
}

// ---------------------------------------------------------------------------
// The /people command
// ---------------------------------------------------------------------------

export type HandlePeopleCommandOptions = {
  generateText?: GenerateText | null | undefined;
  today?: PlainDate | null | undefined;
  postEphemeralResponse?: PostEphemeralResponse | null | undefined;
  sleep?: Sleep | undefined;
  notionGet?: NotionGet | null | undefined;
};

/**
 * Handle the /people command family.
 *
 * `due` is fully deterministic. `suggest <person>` also reads Notion
 * deterministically, but drafts its output with Gemini via the injected
 * `generateText` callable, keeping Gemini isolated from Notion access and from
 * arbitrary side effects. `notionGet` is used only to resolve Track relation
 * names for `suggest`'s recap.
 */
export async function handlePeopleCommand(
  command: string,
  text: string,
  postSlackMessage: PostSlackMessage,
  notionPost: NotionPost,
  environment: Environment,
  {
    generateText = null,
    today = null,
    postEphemeralResponse = null,
    sleep = sleepSeconds,
    notionGet = null,
  }: HandlePeopleCommandOptions = {},
): Promise<boolean> {
  if (command !== "/people") {
    return false;
  }

  const normalizedText = pyStrip(text);
  const loweredText = casefold(normalizedText);

  if (loweredText === "due") {
    await handlePeopleDue(postSlackMessage, notionPost, environment, today, sleep);
    return true;
  }

  if (loweredText.startsWith("suggest")) {
    const remainder = pySlice(normalizedText, "suggest".length);
    const personName = pyStrip(remainder);
    if (personName && pyStartsWithSpace(remainder)) {
      // Imported lazily, as Python does to avoid a circular import:
      // people-suggest depends on shared helpers defined in this module.
      const { handlePeopleSuggest } = await import("./people-suggest.ts");

      await handlePeopleSuggest(personName, postSlackMessage, notionPost, generateText, environment, {
        today,
        sleep,
        notionGet,
      });
      return true;
    }
  }

  await postValidationResponse(PEOPLE_USAGE, postSlackMessage, postEphemeralResponse);
  return true;
}

export async function handlePeopleDue(
  postSlackMessage: PostSlackMessage,
  notionPost: NotionPost,
  environment: Environment,
  today: PlainDate | null | undefined,
  sleep: Sleep,
): Promise<void> {
  const rootMessage = await postSlackMessage("/people due");
  let duePeople: DuePerson[];
  let isIncomplete: boolean;
  let skippedPersonCount: number;
  try {
    const commandToday = today ?? copenhagenToday();
    [duePeople, isIncomplete, skippedPersonCount] = await findDuePeople(
      notionPost,
      environmentValue(environment, "NOTION_API_KEY"),
      environmentValue(environment, "NOTION_PEOPLE_DATA_SOURCE_ID"),
      environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
      commandToday,
      sleep,
    );
  } catch (error) {
    if (!(error instanceof PeopleDueCommandError || error instanceof TaskListCommandError)) {
      throw error;
    }
    await postSlackMessage(PEOPLE_FAILURE_MESSAGE, { threadTs: rootTs(rootMessage) });
    return;
  }

  let message: string;
  let blocks: SectionBlock[] | null;
  if (duePeople.length > 0) {
    message = formatDuePeople(duePeople);
    blocks = buildDuePeopleBlocks(duePeople);
    if (isIncomplete) {
      message = `${message}\n\n${INCOMPLETE_SCAN_MESSAGE}`;
      blocks.push(plainSectionBlock(INCOMPLETE_SCAN_MESSAGE));
    }
  } else if (isIncomplete) {
    // The bounded scan is not complete, so the normal empty-state claim
    // would be misleading.
    message = INCOMPLETE_SCAN_MESSAGE;
    blocks = null;
  } else {
    message = NO_DUE_PERSON_MESSAGE;
    blocks = null;
  }

  if (skippedPersonCount) {
    const noun = skippedPersonCount === 1 ? "person" : "people";
    const skippedMessage = `Skipped ${skippedPersonCount} malformed ${noun}.`;
    message = `${message}\n\n${skippedMessage}`;
    if (blocks !== null && blocks.length > 0) {
      blocks.push(plainSectionBlock(skippedMessage));
    }
  }

  await postSlackMessage(message, { threadTs: rootTs(rootMessage), blocks });
}

/** `root_message["ts"]`: KeyError when Slack's response has no `ts`. */
function rootTs(rootMessage: Record<string, unknown>): string {
  return subscript(rootMessage, "ts") as string;
}

export async function postValidationResponse(
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

// ---------------------------------------------------------------------------
// Finding due People
// ---------------------------------------------------------------------------

/**
 * Legacy Slice 1 single-Person finder.
 *
 * Superseded by findDuePeople for the /people due command; kept only because
 * Slice 1/2 tests exercise it directly to pin the original per-Person query
 * behavior. Do not build new behavior on this path (TECH-DEBT TD4).
 */
export async function findOneDuePerson(
  notionPost: NotionPost,
  apiKey: string,
  peopleDataSourceId: string,
  interactionsDataSourceId: string,
  today: PlainDate,
  sleep: Sleep,
): Promise<DuePerson | null> {
  const peoplePages = await queryDataSource(
    notionPost,
    apiKey,
    peopleDataSourceId,
    {
      page_size: PEOPLE_PAGE_SIZE,
      filter: {
        property: "Contact cadence",
        select: { is_not_empty: true },
      },
    },
    sleep,
  );

  for (const page of peoplePages) {
    const person = personFromNotionPage(page);
    if (person === null) {
      continue;
    }

    const interactionPages = await queryDataSource(
      notionPost,
      apiKey,
      interactionsDataSourceId,
      {
        page_size: INTERACTIONS_PAGE_SIZE,
        filter: {
          and: [
            {
              property: "People",
              relation: { contains: person.pageId },
            },
            {
              property: "Date",
              date: { is_not_empty: true },
            },
            {
              property: "Date",
              date: { on_or_before: isoformat(today) },
            },
          ],
        },
        sorts: [{ property: "Date", direction: "descending" }],
      },
      sleep,
    );
    const evaluation = evaluateCadence(person.cadence, interactionDateValues(interactionPages), today);
    if (evaluation.isDue) {
      return {
        person,
        latestInteraction: evaluation.latestInteractionDate,
        nextContactDue: evaluation.nextDueDate,
      };
    }
  }

  return null;
}

/**
 * Evaluate every cadenced Person and return those who are due.
 *
 * Interactions are fetched once and grouped locally by related Person, instead
 * of issuing one Notion query per Person. Resolves to
 * [duePeople, isIncomplete, skippedPersonCount]; isIncomplete is true when the
 * bounded scan of People or Interactions could not read everything, so the
 * result must not be presented as a complete or empty listing.
 * skippedPersonCount counts individually malformed People records that were
 * skipped rather than crashing the command.
 */
export async function findDuePeople(
  notionPost: NotionPost,
  apiKey: string,
  peopleDataSourceId: string,
  interactionsDataSourceId: string,
  today: PlainDate,
  sleep: Sleep,
): Promise<[DuePerson[], boolean, number]> {
  const [peoplePages, hasUnexaminedPeople] = await fetchPeoplePages(
    notionPost,
    apiKey,
    peopleDataSourceId,
    sleep,
  );
  const [interactionDatesByPerson, hasUnexaminedInteractions] = await fetchInteractionDatesByPerson(
    notionPost,
    apiKey,
    interactionsDataSourceId,
    today,
    sleep,
  );

  const duePeople: DuePerson[] = [];
  let skippedPersonCount = 0;
  for (const page of peoplePages) {
    const person = personFromNotionPage(page);
    if (person === null) {
      skippedPersonCount += 1;
      continue;
    }

    const evaluation = evaluateCadence(
      person.cadence,
      interactionDatesByPerson.get(dictKey(person.pageId)) ?? [],
      today,
    );
    if (evaluation.isDue) {
      duePeople.push({
        person,
        latestInteraction: evaluation.latestInteractionDate,
        nextContactDue: evaluation.nextDueDate,
      });
    }
  }

  // due_people.sort(key=due_person_sort_key): every key first, then a stable sort.
  const keyed = duePeople.map((duePerson) => ({ duePerson, sortKey: duePersonSortKey(duePerson) }));
  keyed.sort((a, b) => compareDuePersonSortKeys(a.sortKey, b.sortKey));
  const sortedDuePeople = keyed.map(({ duePerson }) => duePerson);
  const isIncomplete = hasUnexaminedPeople || hasUnexaminedInteractions;
  return [sortedDuePeople, isIncomplete, skippedPersonCount];
}

/**
 * A Python dict key for a JSON value: TypeError when it is unhashable (a list
 * or dict). JS Map compares keys with SameValueZero; Python additionally
 * treats True/False as equal to 1/0, so booleans are mapped to numbers.
 */
function dictKey(value: unknown): unknown {
  assertHashable(value);
  return typeof value === "boolean" ? Number(value) : value;
}

export type DuePersonSortKey = readonly [0 | 1, PlainDate, string];

export function duePersonSortKey(duePerson: DuePerson): DuePersonSortKey {
  const nameKey = casefold(duePerson.person.name);
  if (duePerson.nextContactDue !== null) {
    return [0, duePerson.nextContactDue, nameKey];
  }
  return [1, DATE_MAX, nameKey];
}

/** Python tuple comparison of two due-person sort keys. */
export function compareDuePersonSortKeys(a: DuePersonSortKey, b: DuePersonSortKey): number {
  return a[0] - b[0] || compareDates(a[1], b[1]) || comparePy(a[2], b[2]);
}

/** Fetch every Person with a configured Contact cadence, bounded. */
export async function fetchPeoplePages(
  notionPost: NotionPost,
  apiKey: string,
  peopleDataSourceId: string,
  sleep: Sleep,
): Promise<[unknown[], boolean]> {
  const buildRequestJson = (cursor: unknown): Dict => {
    const requestJson: Dict = {
      page_size: PEOPLE_PAGE_SIZE,
      filter: {
        property: "Contact cadence",
        select: { is_not_empty: true },
      },
    };
    if (truthy(cursor)) {
      requestJson["start_cursor"] = cursor;
    }
    return requestJson;
  };

  return fetchNotionPages(
    notionPost,
    apiKey,
    peopleDataSourceId,
    buildRequestJson,
    MAX_SCANNED_PEOPLE,
    PEOPLE_PAGE_SIZE,
    sleep,
  );
}

/**
 * Fetch Interactions with a valid Date on or before today, once.
 *
 * Results are grouped by related Person page id so cadence can be evaluated
 * for every Person without a per-Person Notion query. The map's keys are
 * Python dict keys (see dictKey); its values are the raw Date start values.
 */
export async function fetchInteractionDatesByPerson(
  notionPost: NotionPost,
  apiKey: string,
  interactionsDataSourceId: string,
  today: PlainDate,
  sleep: Sleep,
): Promise<[Map<unknown, unknown[]>, boolean]> {
  const buildRequestJson = (cursor: unknown): Dict => {
    const requestJson: Dict = {
      page_size: INTERACTIONS_PAGE_SIZE,
      filter: {
        and: [
          { property: "Date", date: { is_not_empty: true } },
          {
            property: "Date",
            date: { on_or_before: isoformat(today) },
          },
        ],
      },
      sorts: [{ property: "Date", direction: "descending" }],
    };
    if (truthy(cursor)) {
      requestJson["start_cursor"] = cursor;
    }
    return requestJson;
  };

  const [pages, hasUnexaminedInteractions] = await fetchNotionPages(
    notionPost,
    apiKey,
    interactionsDataSourceId,
    buildRequestJson,
    MAX_SCANNED_INTERACTIONS,
    INTERACTIONS_PAGE_SIZE,
    sleep,
  );

  const datesByPerson = new Map<unknown, unknown[]>();
  for (const page of pages) {
    for (const [personId, dateValue] of interactionPersonDates(page)) {
      // dates_by_person.setdefault(person_id, []).append(date_value)
      const key = dictKey(personId);
      let dates = datesByPerson.get(key);
      if (dates === undefined) {
        dates = [];
        datesByPerson.set(key, dates);
      }
      dates.push(dateValue);
    }
  }

  return [datesByPerson, hasUnexaminedInteractions];
}

/** `build_request_json(cursor)`: the query body for the next page; `cursor` is None for the first. */
export type BuildRequestJson = (cursor: unknown) => Dict;

/**
 * Query a Notion data source across pages, bounded by maxScanned.
 *
 * Resolves to [pages, isIncomplete]; isIncomplete is true when the bound was
 * reached, or pagination could not safely continue, before every matching page
 * was read. A malformed response throws PeopleDueCommandError whose cause
 * (getPyCause) is the parse error.
 */
export async function fetchNotionPages(
  notionPost: NotionPost,
  apiKey: string,
  dataSourceId: string,
  buildRequestJson: BuildRequestJson,
  maxScanned: number,
  pageSize: number,
  sleep: Sleep,
): Promise<[unknown[], boolean]> {
  const results: unknown[] = [];
  let cursor: unknown = null;
  let pagesFetched = 0;
  const maxPages = Math.floor(maxScanned / pageSize);

  for (;;) {
    const response = await callNotionWithRetries(
      () =>
        notionPost(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
          headers: notionHeaders(apiKey),
          json: buildRequestJson(cursor),
          timeout: 10,
        }),
      sleep,
    );
    pagesFetched += 1;
    let responseBody: unknown;
    let pageResults: unknown;
    try {
      responseBody = response.json();
      pageResults = subscript(responseBody, "results");
      if (!Array.isArray(pageResults)) {
        throw new TypeError("results is not a list");
      }
    } catch (error) {
      if (isParseError(error)) throw withPyCause(new PeopleDueCommandError(), error);
      throw error;
    }

    // results.extend(page_results); a loop, since spreading an untrusted
    // (possibly huge) list into push() can exceed the argument limit.
    for (const pageResult of pageResults as unknown[]) {
      results.push(pageResult);
    }

    if (!truthy(dictGet(responseBody, "has_more"))) {
      return [results, false];
    }

    cursor = dictGet(responseBody, "next_cursor");
    if (!truthy(cursor) || pagesFetched === maxPages) {
      return [results, true];
    }
  }
}

/** `[(person_id, date_value), ...]` for one Interaction page; [] when it is malformed. */
export function interactionPersonDates(page: unknown): Array<[unknown, unknown]> {
  try {
    const properties = subscript(page, "properties");
    const dateProperty = subscript(properties, "Date");
    if (dictGet(dateProperty, "type") !== "date") {
      return [];
    }
    const dateObject = dictGet(dateProperty, "date");
    const dateValue = dictGet(truthy(dateObject) ? dateObject : {}, "start");

    const peopleProperty = dictGet(properties, "People");
    if (!truthy(peopleProperty) || dictGet(peopleProperty, "type") !== "relation") {
      return [];
    }
    const personIds: unknown[] = [];
    for (const relation of iterate(dictGet(peopleProperty, "relation", []))) {
      if (truthy(dictGet(relation, "id"))) {
        personIds.push(subscript(relation, "id"));
      }
    }
    return personIds.map((personId): [unknown, unknown] => [personId, dateValue]);
  } catch (error) {
    if (isAccessError(error)) return [];
    throw error;
  }
}

export function formatDuePeople(duePeople: readonly DuePerson[]): string {
  const displayed = duePeople.slice(0, MAX_DISPLAYED_PEOPLE);
  let message = displayed.map((duePerson) => formatDuePerson(duePerson)).join("\n\n");

  const remainder = duePeople.length - displayed.length;
  if (remainder > 0) {
    message = `${message}\n\n+${remainder} more`;
  }
  return message;
}

/** One unpaginated data-source query; its `results` list. */
export async function queryDataSource(
  notionPost: NotionPost,
  apiKey: string,
  dataSourceId: string,
  requestJson: Dict,
  sleep: Sleep,
): Promise<unknown[]> {
  const response = await callNotionWithRetries(
    () =>
      notionPost(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
        headers: notionHeaders(apiKey),
        json: requestJson,
        timeout: 10,
      }),
    sleep,
  );
  try {
    const responseBody = response.json();
    const results = subscript(responseBody, "results");
    if (!Array.isArray(results)) {
      throw new TypeError("results is not a list");
    }
    return results;
  } catch (error) {
    if (isParseError(error)) throw withPyCause(new PeopleDueCommandError(), error);
    throw error;
  }
}

/** A Person from a People page, or null (None) when the record is malformed. */
export function personFromNotionPage(page: unknown): Person | null {
  try {
    const properties = subscript(page, "properties");
    const nameProperty = subscript(properties, "Name");
    const cadenceProperty = subscript(properties, "Contact cadence");
    if (dictGet(nameProperty, "type") !== "title") {
      return null;
    }
    if (dictGet(cadenceProperty, "type") !== "select") {
      return null;
    }
    // "".join(part.get("plain_text", "") for part in name_property.get("title", [])).strip()
    let joined = "";
    for (const part of iterate(dictGet(nameProperty, "title", []))) {
      const text = dictGet(part, "plain_text", "");
      if (typeof text !== "string") throw new TypeError("sequence item: expected str instance");
      joined += text;
    }
    const name = pyStrip(joined);
    const selectValue = dictGet(cadenceProperty, "select");
    const cadence = dictGet(truthy(selectValue) ? selectValue : {}, "name");
    const pageId = subscript(page, "id");
    if (!name || !truthy(pageId) || !cadenceIsSupported(cadence)) {
      return null;
    }
    const linkedinUrl = extractLinkedinUrl(properties as Dict);
    return { pageId: pageId as string, name, cadence: cadence as string, linkedinUrl };
  } catch (error) {
    if (isAccessError(error)) return null;
    throw error;
  }
}

/** `cadence in CADENCE_MONTHS`: TypeError when the value is unhashable. */
function cadenceIsSupported(cadence: unknown): boolean {
  assertHashable(cadence);
  return typeof cadence === "string" && Object.hasOwn(CADENCE_MONTHS, cadence);
}

/** Read the LinkedIn URL property as-is; never construct or guess one. */
export function extractLinkedinUrl(properties: Dict): string | null {
  const linkedinProperty = dictGet(properties, "LinkedIn");
  if (!isDict(linkedinProperty)) {
    return null;
  }
  if (dictGet(linkedinProperty, "type") !== "url") {
    return null;
  }
  const url = dictGet(linkedinProperty, "url");
  return typeof url === "string" && url ? url : null;
}

/** The raw Date start value of each well-formed Interaction page. */
export function interactionDateValues(pages: readonly unknown[]): unknown[] {
  const values: unknown[] = [];
  for (const page of pages) {
    try {
      const dateProperty = subscript(subscript(page, "properties"), "Date");
      if (dictGet(dateProperty, "type") !== "date") {
        continue;
      }
      const dateObject = dictGet(dateProperty, "date");
      values.push(dictGet(truthy(dateObject) ? dateObject : {}, "start"));
    } catch (error) {
      if (isAccessError(error)) continue;
      throw error;
    }
  }
  return values;
}

export function latestValidInteractionDate(values: readonly unknown[], today: PlainDate): PlainDate | null {
  const validDates: PlainDate[] = [];
  for (const value of values) {
    try {
      const interactionDate = parseNotionDate(value);
      if (compareDates(interactionDate, today) <= 0) {
        validDates.push(interactionDate);
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof ValueError) continue;
      throw error;
    }
  }
  // max(valid_dates, default=None)
  let latest: PlainDate | null = null;
  for (const validDate of validDates) {
    if (latest === null || compareDates(validDate, latest) > 0) {
      latest = validDate;
    }
  }
  return latest;
}

/** Evaluate one person's cadence from raw Interaction date values. */
export function evaluateCadence(
  cadence: string,
  interactionDates: readonly unknown[],
  today: PlainDate,
): CadenceEvaluation {
  // CADENCE_MONTHS[cadence]
  if (!Object.hasOwn(CADENCE_MONTHS, cadence)) throw new KeyError(cadence);
  const months = CADENCE_MONTHS[cadence] as number;
  const latestInteraction = latestValidInteractionDate(interactionDates, today);
  if (latestInteraction === null) {
    return {
      status: CadenceStatus.DUE_WITH_NO_PREVIOUS_INTERACTION,
      latestInteractionDate: null,
      nextDueDate: null,
      isDue: true,
    };
  }

  const nextDueDate = addCalendarMonths(latestInteraction, months);
  let status: CadenceStatus;
  let isDue: boolean;
  if (compareDates(today, nextDueDate) < 0) {
    status = CadenceStatus.NOT_DUE;
    isDue = false;
  } else if (compareDates(today, nextDueDate) === 0) {
    status = CadenceStatus.DUE_TODAY;
    isDue = true;
  } else {
    status = CadenceStatus.OVERDUE;
    isDue = true;
  }
  return { status, latestInteractionDate: latestInteraction, nextDueDate, isDue };
}

/**
 * A Notion date value: `date.fromisoformat(value)`, else
 * `datetime.fromisoformat(value.replace("Z", "+00:00")).date()`. Throws
 * ValueError for a non-str, an empty str or an unparseable value. A datetime
 * gives its date in the string's own offset (BASELINE.md §7 quirk 1).
 */
export function parseNotionDate(value: unknown): PlainDate {
  if (typeof value !== "string" || !value) {
    throw new ValueError();
  }
  try {
    return dateFromIsoformat(value);
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    return dateFromIsoDatetime(value);
  }
}

// ---------------------------------------------------------------------------
// Formatting and Block Kit
// ---------------------------------------------------------------------------

export function formatPersonName(person: Person): string {
  if (person.linkedinUrl) {
    return `<${person.linkedinUrl}|${person.name}>`;
  }
  return person.name;
}

export function formatDuePerson(duePerson: DuePerson): string {
  const lines = [
    `*${formatPersonName(duePerson.person)}*`,
    `Contact cadence: ${duePerson.person.cadence}`,
  ];
  if (duePerson.latestInteraction === null) {
    lines.push("Latest interaction: No previous interaction");
  } else {
    lines.push(
      `Latest interaction: ${isoformat(duePerson.latestInteraction)}`,
      `Next contact due: ${isoformat(duePerson.nextContactDue as PlainDate)}`,
    );
  }
  return lines.join("\n");
}

export const PEOPLE_SUGGEST_ACTION_ID = "people_suggest";

export type ButtonElement = {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
};

export type SectionBlock = {
  type: "section";
  text: { type: "mrkdwn"; text: string };
  accessory?: ButtonElement;
};

/**
 * A Block Kit button that, on click, invokes /people suggest <name>.
 *
 * The button's value is the Person's exact Name, so a click is handled by
 * api/slack-request.js and the entry point exactly like a typed
 * `/people suggest <person>` command - same Person resolution, same Gemini
 * prompting, no duplicated logic.
 */
export function suggestButton(person: Person): ButtonElement {
  return {
    type: "button",
    text: { type: "plain_text", text: "Suggest message" },
    action_id: PEOPLE_SUGGEST_ACTION_ID,
    value: person.name,
  };
}

export function duePersonBlock(duePerson: DuePerson): SectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: formatDuePerson(duePerson) },
    accessory: suggestButton(duePerson.person),
  };
}

export function plainSectionBlock(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function buildDuePeopleBlocks(duePeople: readonly DuePerson[]): SectionBlock[] {
  const displayed = duePeople.slice(0, MAX_DISPLAYED_PEOPLE);
  const blocks = displayed.map((duePerson) => duePersonBlock(duePerson));

  const remainder = duePeople.length - displayed.length;
  if (remainder > 0) {
    blocks.push(plainSectionBlock(`+${remainder} more`));
  }
  return blocks;
}
