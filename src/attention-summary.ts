// Port of attention_summary.py: the scheduled attention summary sent as a
// private Slack DM, and its entry point (`node src/attention-summary.ts`).
//
// Reuses the exact /tasks list eligibility and /people due cadence logic so the
// summary matches those commands on the same day. Fully deterministic: no
// Gemini call is involved. Only counts and safe error descriptions are logged;
// Task and People content goes to Slack only.
//
// Entry point (PLAN.md §2 design rule 4): `main(environment, deps)` is the
// Python `main()` with its collaborators injected and resolves to the exit
// code. `runEntryPoint` adds the top-level error handler: an error that escapes
// `main` is reported as exactly one secret-free line on stderr (security
// invariant S7) and gives exit code 1, as an uncaught Python exception does.
// The `import.meta.main` guard at the bottom runs it for the real process.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { RequestException, createHttp, type Http, type PostOptions } from "./http.ts";
import {
  INCOMPLETE_SCAN_MESSAGE,
  PeopleDueCommandError,
  findDuePeople,
  formatPersonName,
  type DuePerson,
} from "./people-due.ts";
import { isoformat, type PlainDate } from "./plain-date.ts";
import { KeyError, dictGet, getPyCause, isDict, truthy, type Dict } from "./python-compat.ts";
import {
  MORE_TASKS_MESSAGE,
  NotionAuthenticationError,
  TaskListCommandError,
  copenhagenToday,
  environmentValue,
  externalErrorStatusCode,
  fetchTasks,
  formatFollowUp,
  selectAllTasksNeedingAttention,
  sleepSeconds,
  type Environment,
  type NotionPost,
  type Sleep,
  type Task,
} from "./tasks-list.ts";

export const SUMMARY_HEADER = "*Attention summary*";
export const TASKS_UNAVAILABLE_MESSAGE = "Tasks unavailable right now.";
export const PEOPLE_UNAVAILABLE_MESSAGE = "People unavailable right now.";
export const MAX_SUMMARY_ITEMS = 5;
export const CONFIG_NAMES: ReadonlySet<string> = new Set([
  "NOTION_API_KEY",
  "NOTION_TASKS_DATA_SOURCE_ID",
  "NOTION_PEOPLE_DATA_SOURCE_ID",
  "NOTION_INTERACTIONS_DATA_SOURCE_ID",
]);

export type TasksAttention = {
  readonly datedTasks: readonly Task[];
  readonly undatedTaskCount: number;
  readonly isIncomplete: boolean;
  readonly skippedTaskCount: number;
};

export type PeopleAttention = {
  readonly duePeople: readonly DuePerson[];
  readonly isIncomplete: boolean;
  readonly skippedPersonCount: number;
};

/** A source failed, so the run must fail; the message is secret-free. (RuntimeError in Python.) */
export class AttentionSummaryError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "AttentionSummaryError";
  }
}

/** The summary DM could not be posted; the message is secret-free. (RuntimeError in Python.) */
export class SlackDmDeliveryError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "SlackDmDeliveryError";
  }
}

/** Python's `print`: one line per call. */
export type Log = (line: string) => void;

/** `post_direct_message(message)`; resolves to Slack's JSON body. */
export type PostDirectMessage = (message: string) => Promise<unknown>;

/** `requests.post`'s call shape for the Slack DM, as `Http.post` in http.ts. */
export type SlackPost = Http["post"];

function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function fetchTasksAttention(
  notionPost: NotionPost,
  environment: Environment,
  today: PlainDate,
  sleep: Sleep = sleepSeconds,
): Promise<TasksAttention> {
  const [pages, hasUnexaminedTasks] = await fetchTasks(
    notionPost,
    environmentValue(environment, "NOTION_API_KEY"),
    environmentValue(environment, "NOTION_TASKS_DATA_SOURCE_ID"),
    { sleep },
  );
  const [eligibleTasks, skippedTaskCount] = selectAllTasksNeedingAttention(pages, today);
  const datedTasks = eligibleTasks.filter((task) => task.followUp !== null);
  return {
    datedTasks,
    undatedTaskCount: eligibleTasks.length - datedTasks.length,
    isIncomplete: hasUnexaminedTasks,
    skippedTaskCount,
  };
}

export async function fetchPeopleAttention(
  notionPost: NotionPost,
  environment: Environment,
  today: PlainDate,
  sleep: Sleep = sleepSeconds,
): Promise<PeopleAttention> {
  const [duePeople, isIncomplete, skippedPersonCount] = await findDuePeople(
    notionPost,
    environmentValue(environment, "NOTION_API_KEY"),
    environmentValue(environment, "NOTION_PEOPLE_DATA_SOURCE_ID"),
    environmentValue(environment, "NOTION_INTERACTIONS_DATA_SOURCE_ID"),
    today,
    sleep,
  );
  return { duePeople, isIncomplete, skippedPersonCount };
}

export function hasTasksNeedingAttention(tasks: TasksAttention | null): boolean {
  // An incomplete scan is reported like /tasks list does: more tasks may
  // need attention even when none were found. Skipped rows alone are not.
  return (
    tasks !== null &&
    (tasks.datedTasks.length > 0 || tasks.undatedTaskCount !== 0 || tasks.isIncomplete)
  );
}

export function hasPeopleNeedingAttention(people: PeopleAttention | null): boolean {
  return people !== null && (people.duePeople.length > 0 || people.isIncomplete);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Build the DM text, or null when nothing needs attention.
 *
 * `tasks`/`people` are null when that source failed; a failed source is shown
 * as an "unavailable" line only alongside a section that has items.
 */
export function composeSummary(
  tasks: TasksAttention | null,
  people: PeopleAttention | null,
  today: PlainDate,
): string | null {
  const hasTasks = hasTasksNeedingAttention(tasks);
  const hasPeople = hasPeopleNeedingAttention(people);
  if (!hasTasks && !hasPeople) {
    return null;
  }

  const sections = [SUMMARY_HEADER];
  if (tasks === null) {
    sections.push(TASKS_UNAVAILABLE_MESSAGE);
  } else if (hasTasks) {
    sections.push(formatTasksSection(tasks, today));
  }

  if (people === null) {
    sections.push(PEOPLE_UNAVAILABLE_MESSAGE);
  } else if (hasPeople) {
    sections.push(formatPeopleSection(people));
  }

  return sections.join("\n\n");
}

export function formatTasksSection(tasks: TasksAttention, today: PlainDate): string {
  const lines = ["*Tasks*"];
  const displayed = tasks.datedTasks.slice(0, MAX_SUMMARY_ITEMS);
  for (const task of displayed) {
    const priority = truthy(task.priority) ? task.priority : "No priority";
    lines.push(`• <${task.url}|${task.name}> — Priority: ${priority} — ${formatFollowUp(task, today)}`);
  }
  const remainder = tasks.datedTasks.length - displayed.length;
  if (remainder > 0) {
    lines.push(`+${remainder} more — run /tasks list`);
  }
  if (tasks.undatedTaskCount) {
    const noun = tasks.undatedTaskCount === 1 ? "task" : "tasks";
    lines.push(`${tasks.undatedTaskCount} open ${noun} without follow-up date`);
  }
  if (tasks.isIncomplete) {
    lines.push(MORE_TASKS_MESSAGE);
  }
  if (tasks.skippedTaskCount) {
    const noun = tasks.skippedTaskCount === 1 ? "task" : "tasks";
    lines.push(`Skipped ${tasks.skippedTaskCount} malformed ${noun}.`);
  }
  return lines.join("\n");
}

export function formatPeopleSection(people: PeopleAttention): string {
  const lines = ["*People due*"];
  const displayed = people.duePeople.slice(0, MAX_SUMMARY_ITEMS);
  for (const duePerson of displayed) {
    const dueText =
      duePerson.nextContactDue === null
        ? "No previous interaction"
        : `Next contact due: ${isoformat(duePerson.nextContactDue)}`;
    lines.push(`• ${formatPersonName(duePerson.person)} — ${dueText}`);
  }
  const remainder = people.duePeople.length - displayed.length;
  if (remainder > 0) {
    lines.push(`+${remainder} more — run /people due`);
  }
  if (people.isIncomplete) {
    lines.push(INCOMPLETE_SCAN_MESSAGE);
  }
  if (people.skippedPersonCount) {
    const noun = people.skippedPersonCount === 1 ? "person" : "people";
    lines.push(`Skipped ${people.skippedPersonCount} malformed ${noun}.`);
  }
  return lines.join("\n");
}

/**
 * `type(error).__name__`. Every error class in src/ sets `name` to its Python
 * class name, as do the JS built-ins that stand for Python's (TypeError).
 */
function typeName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

/** A secret-free, diagnosable description of a source failure. */
export function describeSourceError(error: unknown): string {
  if (error instanceof NotionAuthenticationError) {
    return error.message;
  }
  if (error instanceof KeyError && CONFIG_NAMES.has(error.key)) {
    return `missing configuration ${error.key}`;
  }
  let description = typeName(error);
  if (error instanceof TaskListCommandError || error instanceof PeopleDueCommandError) {
    // Only the type name and status code; never the cause's message,
    // URL, headers or body.
    const statusCode = externalErrorStatusCode(getPyCause(error));
    if (statusCode !== null) {
      description = `${description} (HTTP ${statusCode})`;
    }
  }
  return description;
}

export type SendAttentionSummaryOptions = {
  today?: PlainDate | null | undefined;
  sleep?: Sleep | undefined;
  log?: Log | undefined;
};

/**
 * Send one summary DM when anything needs attention.
 *
 * Resolves to true when a DM was posted. Throws AttentionSummaryError when any
 * source failed, after posting whatever the other source could provide, so an
 * unwatched scheduled run still fails visibly.
 */
export async function sendAttentionSummary(
  postDirectMessage: PostDirectMessage,
  notionPost: NotionPost,
  environment: Environment,
  { today = null, sleep = sleepSeconds, log = printLine }: SendAttentionSummaryOptions = {},
): Promise<boolean> {
  const summaryToday = today || copenhagenToday();
  const failures: string[] = [];

  let tasks: TasksAttention | null;
  try {
    tasks = await fetchTasksAttention(notionPost, environment, summaryToday, sleep);
  } catch (error) {
    tasks = null;
    failures.push(`Tasks unavailable: ${describeSourceError(error)}`);
  }

  let people: PeopleAttention | null;
  try {
    people = await fetchPeopleAttention(notionPost, environment, summaryToday, sleep);
  } catch (error) {
    people = null;
    failures.push(`People unavailable: ${describeSourceError(error)}`);
  }

  for (const failure of failures) {
    log(`::error::${failure}`);
  }

  if (tasks === null && people === null) {
    throw new AttentionSummaryError("Tasks and People are both unavailable; no summary sent.");
  }

  const message = composeSummary(tasks, people, summaryToday);
  if (message === null) {
    log("Nothing needs attention; no DM sent");
  } else {
    await postDirectMessage(message);
    log("Attention summary DM sent");
  }

  if (failures.length > 0) {
    const failedSource = tasks === null ? "Tasks" : "People";
    const outcome = message ? "partial summary sent" : "no summary sent";
    throw new AttentionSummaryError(`${failedSource} unavailable; ${outcome}.`);
  }
  return message !== null;
}

// ---------------------------------------------------------------------------
// Slack transport
// ---------------------------------------------------------------------------

/**
 * `f"{error_code}"` for the Slack `error` field. Slack sends a string; a
 * number or boolean is formatted as Python's str() does for them.
 */
function formatErrorCode(errorCode: unknown): string {
  if (typeof errorCode === "boolean") return errorCode ? "True" : "False";
  return String(errorCode);
}

/** Post to the app's DM with `userId` (chat.postMessage to a user ID). */
export function buildSlackDmPoster(
  slackToken: string,
  userId: string,
  slackPost: SlackPost = createHttp().post,
): (message: string) => Promise<Dict> {
  return async function postDirectMessage(message: string): Promise<Dict> {
    let result: unknown;
    try {
      const options: PostOptions = {
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
        },
        json: { channel: userId, text: message, mrkdwn: true },
        timeout: 10,
      };
      const response = await slackPost("https://slack.com/api/chat.postMessage", options);
      response.raise_for_status();
      result = response.json();
    } catch (error) {
      // `raise ... from None`: no cause is attached.
      const statusCode = externalErrorStatusCode(error);
      if (statusCode !== null) {
        throw new SlackDmDeliveryError(`Slack DM delivery failed (HTTP ${statusCode}).`);
      }
      throw new SlackDmDeliveryError(`Slack DM delivery failed (${typeName(error)}).`);
    }

    if (!isDict(result) || !truthy(dictGet(result, "ok"))) {
      const errorCode = isDict(result) ? dictGet(result, "error") : null;
      throw new SlackDmDeliveryError(
        `Slack DM delivery failed (${truthy(errorCode) ? formatErrorCode(errorCode) : "unknown"}).`,
      );
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type MainDeps = {
  /** `requests`: only `post` is used. Default: the real http.ts adapter. */
  http?: Http | undefined;
  /** `time.sleep`. Default: sleepSeconds. */
  sleep?: Sleep | undefined;
  /** The Copenhagen date. Default: copenhagenToday(). */
  today?: PlainDate | undefined;
  /** Python's `print`. Default: the line plus "\n" on stdout. */
  log?: Log | undefined;
};

/** `main()`: resolves to the process exit code. */
export async function main(environment: Environment, deps: MainDeps = {}): Promise<number> {
  const http = deps.http ?? createHttp();
  const log = deps.log ?? printLine;
  const slackToken = environment["SLACK_BOT_TOKEN"] ?? "";
  const userId = environment["AUTHORIZED_SLACK_USER_ID"] ?? "";
  if (!slackToken || !userId) {
    log("::error::SLACK_BOT_TOKEN and AUTHORIZED_SLACK_USER_ID are required");
    return 1;
  }

  try {
    await sendAttentionSummary(buildSlackDmPoster(slackToken, userId, http.post), http.post, environment, {
      today: deps.today,
      sleep: deps.sleep,
      log,
    });
  } catch (error) {
    if (error instanceof AttentionSummaryError || error instanceof SlackDmDeliveryError) {
      log(`::error::${error.message}`);
      return 1;
    }
    throw error;
  }
  return 0;
}

// Error classes whose messages the application builds from constants, status
// codes and config names only, so the top-level handler may print them. Any
// other error (a JS built-in, KeyError, whose message can quote a Notion key)
// is reported by its name alone.
const SECRET_FREE_MESSAGE_ERRORS: ReadonlyArray<abstract new (...args: never[]) => Error> = [
  AttentionSummaryError,
  SlackDmDeliveryError,
  NotionAuthenticationError,
  TaskListCommandError,
  PeopleDueCommandError,
  RequestException,
];

/**
 * The one line the top-level handler prints for an uncaught error: the error's
 * name, plus its message for an application-defined error class. Never a
 * stack, a cause chain, a URL or a body (security invariant S7).
 */
export function uncaughtErrorLine(error: unknown): string {
  let name = "Error";
  let message: string | null = null;
  try {
    if (error instanceof Error) {
      if (typeof error.name === "string" && /^[A-Za-z_$][\w$]*$/.test(error.name)) {
        name = error.name;
      }
      if (SECRET_FREE_MESSAGE_ERRORS.some((errorClass) => error instanceof errorClass)) {
        message = String(error.message).replace(/[\r\n\u2028\u2029]+/g, " ");
      }
    }
  } catch {
    // A hostile getter must not stop the report.
  }
  return message ? `${name}: ${message}` : name;
}

export type EntryPointDeps = MainDeps & {
  /** Where the top-level handler writes. Default: process.stderr. */
  writeStderr?: ((text: string) => void) | undefined;
};

function writeToStderr(text: string): void {
  process.stderr.write(text);
}

/**
 * `sys.exit(main())` with the top-level error handler: an error escaping main
 * is reported as one secret-free line on stderr and resolves to exit code 1.
 */
export async function runEntryPoint(environment: Environment, deps: EntryPointDeps = {}): Promise<number> {
  try {
    return await main(environment, deps);
  } catch (error) {
    (deps.writeStderr ?? writeToStderr)(`${uncaughtErrorLine(error)}\n`);
    return 1;
  }
}

/**
 * Run as the process: runEntryPoint, then `process.exitCode`. Anything that
 * escapes the awaited chain (an unhandled rejection becomes an uncaught
 * exception) gets the same one-line report instead of Node's default output,
 * which prints the stack and any cause chain. Once that has happened the exit
 * code stays 1, whatever main resolves to.
 */
export async function runProcess(environment: Environment, deps: EntryPointDeps = {}): Promise<void> {
  const writeStderr = deps.writeStderr ?? writeToStderr;
  let uncaught = false;
  process.on("uncaughtException", (error) => {
    uncaught = true;
    writeStderr(`${uncaughtErrorLine(error)}\n`);
    process.exitCode = 1;
  });
  const exitCode = await runEntryPoint(environment, deps);
  process.exitCode = uncaught ? 1 : exitCode;
}

/** The one stderr line when Node cannot tell whether this module is the entry point. */
export const UNSUPPORTED_NODE_MESSAGE = "This entry point requires Node.js >= 24.2 (import.meta.main).";

/**
 * Whether a module is being run as the program ("run"), imported ("imported"),
 * or run on a Node without `import.meta.main` (before 24.2, "unsupported").
 * There `import.meta.main` is undefined, so a plain guard would silently do
 * nothing and exit 0; when the module is the script Node was started with
 * (`argvScript`, process.argv[1]), that must fail loudly instead.
 */
export function entryPointMode(
  importMetaMain: unknown,
  argvScript: string | undefined,
  moduleUrl: string,
): "run" | "imported" | "unsupported" {
  if (importMetaMain === true) return "run";
  if (importMetaMain !== undefined || argvScript === undefined) return "imported";
  return path.resolve(argvScript) === fileURLToPath(moduleUrl) ? "unsupported" : "imported";
}

const mode = entryPointMode(import.meta.main, process.argv[1], import.meta.url);
if (mode === "run") {
  await runProcess(process.env);
} else if (mode === "unsupported") {
  writeToStderr(`${UNSUPPORTED_NODE_MESSAGE}\n`);
  process.exitCode = 1;
}
