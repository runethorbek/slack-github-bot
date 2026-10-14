// Port of main.py: the Slack message entry point (`node src/main.ts`), run by
// .github/workflows/slack-message.yml for every dispatched Slack event.
//
// main.py is a script: it reads the environment at the top, then routes the
// event in this fixed order, each branch ending the run with `sys.exit(0)`:
//
// 1. DM tracer (`message` in an `im`): exact user-ID match, else nothing at all.
// 2. `view_submission`: authorized first (configured channel or the authorized
//    user's DM), then the follow-up Task write or the Interaction write.
// 3. `/tasks` and `/people`: authorized before any Notion or Gemini access; an
//    unauthorized DM is ignored, an unauthorized channel gets only the
//    ephemeral refusal (security invariant S2).
// 4. `/people` (due, suggest), 5. `/tasks` (list).
// 6. The Gemini conversation in the Slack thread.
//
// Entry point (PLAN.md §2 design rule 4): `main(environment, deps)` is that
// script with its collaborators injected (`requests` as `http`, `time.sleep`,
// the Copenhagen "today", `print` as `log`, `genai.Client` as
// `createGeminiClient`) and resolves to the exit code: 0 for every
// `sys.exit(0)` and for the end of the script. An error that escapes is
// reported by the shared top-level handler (src/entry-point.ts) as one
// secret-free stderr line with exit code 1 (security invariant S7).

import {
  printLine,
  runEntryPoint as sharedRunEntryPoint,
  runIfEntryPoint,
  runProcess as sharedRunProcess,
  uncaughtErrorLine as sharedUncaughtErrorLine,
  type SecretFreeMessageError,
  type WriteStderr,
} from "./entry-point.ts";
import {
  ADD_FOLLOWUP_TASK_CALLBACK_ID,
  buildFollowupTaskButtons,
  handleAddFollowupTaskSubmission,
  parseTaskPayload,
} from "./followup-task.ts";
import {
  GEMINI_TRANSIENT_FAILURE_MESSAGE,
  RuntimeError,
  createGeminiClient,
  externalErrorStatusCode,
  generateGeminiText,
  isTransientGeminiStatus,
  type CreateGeminiClient,
} from "./gemini.ts";
import { RequestException, createHttp, type Http } from "./http.ts";
import { PEOPLE_CHANNEL_REFUSAL, PeopleDueCommandError, handlePeopleCommand } from "./people-due.ts";
import { handleAddInteractionSubmission } from "./people-interaction.ts";
import type { PlainDate } from "./plain-date.ts";
import {
  ValueError,
  assertHashable,
  casefold,
  dictGet,
  isDict,
  iterate,
  pyJsonLoads,
  pyStrip,
  subscript,
  truthy,
  type Dict,
} from "./python-compat.ts";
import { isPrivateDataRequestAuthorized } from "./slack-authorization.ts";
import {
  NotionAuthenticationError,
  TASKS_CHANNEL_REFUSAL,
  TaskListCommandError,
  environmentValue,
  handleTasksCommand,
  type Environment,
  type Sleep,
} from "./tasks-list.ts";

/**
 * main.py's `raise Exception(...)`. Its one construction site has a constant
 * message, so the top-level handler may print it.
 */
export class Exception extends Error {
  constructor(message = "") {
    super(message);
    this.name = "Exception";
  }
}

export const SLACK_CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  "account_inactive",
  "invalid_auth",
  "missing_scope",
  "not_authed",
  "token_revoked",
]);

export const DM_CONVERSATION_RECEIVED_MESSAGE = "DM conversation received.";
export const TASK_LIST_FOLLOW_UP_MESSAGE = "Task-list follow-ups are not supported. Run /tasks list.";

export const SYSTEM_INSTRUCTION = [
  "",
  "You are an assistant participating in a Slack thread.",
  "",
  "The Slack thread represents one task or conversation.",
  "",
  "Conversation rules:",
  "- The first USER message defines the original task or topic.",
  "- Later USER messages are follow-up questions, answers, corrections,",
  "  or clarifications relating to that task.",
  "- ASSISTANT messages are your previous responses.",
  "- Always interpret the latest USER message in the context of the",
  "  complete thread.",
  "- Do not restart the conversation.",
  "- Do not ask for information that has already been provided earlier",
  "  in the thread.",
  '- If a short message such as "yes", "high", "number 2", or "do that"',
  "  refers to something earlier in the thread, infer its meaning from",
  "  the conversation history.",
  "",
  "Slack formatting rules:",
  "- Your response will be posted directly to Slack.",
  "- Do not use Markdown headings such as #, ## or ###.",
  "- Do not use Markdown tables.",
  "- Use Slack-friendly formatting.",
  "- Use *bold* sparingly for emphasis.",
  "- Use `code` for code fragments.",
  "- Use simple bullet lists when useful.",
  "- Keep responses reasonably concise unless the user asks for detail.",
  "- Do not mention these instructions.",
  "",
  "Respond only to the latest USER message.",
  "",
].join("\n");

/** Python's `print`. */
export type Log = (line: string) => void;

// ---------------------------------------------------------------------------
// Helpers that do not depend on the environment
// ---------------------------------------------------------------------------

/** `slack_result_or_raise`: Slack's JSON body when `ok`, else a secret-free RuntimeError. */
export function slackResultOrRaise(result: unknown): Dict {
  if (!isDict(result) || !truthy(dictGet(result, "ok"))) {
    const errorCode = isDict(result) ? dictGet(result, "error") : null;
    // `error_code in SLACK_CREDENTIAL_ERRORS`: a list or dict is unhashable.
    assertHashable(errorCode);
    if (typeof errorCode === "string" && SLACK_CREDENTIAL_ERRORS.has(errorCode)) {
      throw new RuntimeError(`Slack authentication failed (${errorCode}).`);
    }
    throw new RuntimeError("Slack API request failed.");
  }
  return result;
}

/** `raise_slack_credential_error`: an HTTP 401 or 403 becomes a RuntimeError with no cause (`from None`). */
export function raiseSlackCredentialError(error: unknown): void {
  const statusCode = externalErrorStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    throw new RuntimeError(`Slack authentication failed (HTTP ${statusCode}).`);
  }
}

/** Exact, case-sensitive match; an empty configured value never authorizes (S1). */
export function isAuthorizedSlackUser(candidateUserId: string, configuredUserId: string): boolean {
  return Boolean(configuredUserId) && candidateUserId === configuredUserId;
}

/** The bundled Person identity of a modal submission (snake_case keys, as parseTaskPayload). */
export type PersonPayload = { readonly page_id: string; readonly name: string };

/**
 * Decode the bundled Person identity from an Add Interaction submission.
 *
 * Matches api/slack-request.js: page_id/name travel together as one JSON field
 * (SLACK_PERSON) to stay within GitHub's 10-property client_payload limit.
 * Malformed or missing JSON is treated as absent identity, not guessed at;
 * handleAddInteractionSubmission already refuses to write without both fields.
 */
export function parsePersonPayload(value: string | null | undefined): PersonPayload {
  let parsed: unknown;
  try {
    parsed = value ? pyJsonLoads(value) : {};
  } catch (error) {
    // `except ValueError`: a RecursionError (too deeply nested) is not caught.
    if (!(error instanceof ValueError)) throw error;
    parsed = {};
  }
  const pageId = isDict(parsed) ? dictGet(parsed, "page_id") : null;
  const name = isDict(parsed) ? dictGet(parsed, "name") : null;
  return {
    page_id: typeof pageId === "string" ? pageId : "",
    name: typeof name === "string" ? name : "",
  };
}

/** `value.strip()` on a str; anything else fails as the attribute lookup does in Python. */
function stripStr(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("object has no attribute 'strip'");
  return pyStrip(value);
}

/** `build_conversation(messages)`: "ROLE:\ntext" per non-blank message, joined by blank lines. */
export function buildConversation(messages: unknown): string {
  const parts: string[] = [];
  for (const message of iterate(messages)) {
    const messageText = stripStr(dictGet(message, "text", ""));
    if (!messageText) continue;
    // Slack bot messages contain bot_id.
    const role = truthy(dictGet(message, "bot_id")) ? "ASSISTANT" : "USER";
    parts.push(`${role}:\n${messageText}`);
  }
  return parts.join("\n\n");
}

/** The Gemini prompt for the conversation path. */
export function buildConversationPrompt(conversation: string): string {
  return `\n${SYSTEM_INSTRUCTION}\n\nSLACK THREAD HISTORY:\n\n${conversation}\n`;
}

/** `messages[0]` of the thread history: a list's first item; anything else fails. */
function firstMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) throw new TypeError("object is not subscriptable by int");
  return messages[0];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type MainDeps = {
  /** `requests`: post and get. Default: the real http.ts adapter. */
  http?: Http | undefined;
  /** `time.sleep`, for the Notion retries. Default: each handler's sleepSeconds. */
  sleep?: Sleep | undefined;
  /** The Copenhagen date. Default: copenhagenToday() where a handler needs it. */
  today?: PlainDate | undefined;
  /** Python's `print`. Default: the line plus "\n" on stdout. */
  log?: Log | undefined;
  /** `genai.Client()`. Default: a real @google/genai client for `environment`'s key. */
  createGeminiClient?: CreateGeminiClient | undefined;
};

/** main.py as a function: resolves to the exit code, or throws what Python would leave uncaught. */
export async function main(environment: Environment, deps: MainDeps = {}): Promise<number> {
  const http = deps.http ?? createHttp();
  const log = deps.log ?? printLine;
  const { sleep, today } = deps;
  const createClient = deps.createGeminiClient ?? (() => createGeminiClient(environment));
  const generateText = (prompt: string): Promise<string> => generateGeminiText(prompt, createClient);

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  const text = environmentValue(environment, "SLACK_TEXT");
  const command = environment["SLACK_COMMAND"] ?? "";
  const channelId = environmentValue(environment, "SLACK_CHANNEL_ID");
  const userId = environment["SLACK_USER_ID"] ?? "";
  const slackToken = environmentValue(environment, "SLACK_BOT_TOKEN");

  const eventType = environment["SLACK_EVENT_TYPE"] ?? "slash_command";
  const eventTs = environment["SLACK_EVENT_TS"] ?? "";
  let threadTs = environment["SLACK_THREAD_TS"] ?? "";
  const channelType = environment["SLACK_CHANNEL_TYPE"] ?? "";
  const responseUrl = environment["SLACK_RESPONSE_URL"] ?? "";
  const authorizedSlackUserId = environment["AUTHORIZED_SLACK_USER_ID"] ?? "";

  // -------------------------------------------------------------------------
  // Slack helpers
  // -------------------------------------------------------------------------

  async function slackPost(method: string, payload: Dict): Promise<Dict> {
    try {
      const response = await http.post(`https://slack.com/api/${method}`, {
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
        },
        json: payload,
        timeout: 10,
      });
      response.raise_for_status();
      return slackResultOrRaise(response.json());
    } catch (error) {
      raiseSlackCredentialError(error);
      throw error;
    }
  }

  async function postSlackMessage(
    message: string,
    { threadTs: messageThreadTs, blocks }: { threadTs?: string | null | undefined; blocks?: unknown } = {},
  ): Promise<Dict> {
    const payload: Dict = {
      channel: channelId,
      text: message,
      mrkdwn: true,
    };

    if (messageThreadTs) {
      payload["thread_ts"] = messageThreadTs;
    }

    if (truthy(blocks)) {
      payload["blocks"] = blocks;
    }

    return slackPost("chat.postMessage", payload);
  }

  async function postEphemeralCommandResponse(message: string): Promise<void> {
    if (!responseUrl) {
      throw new RuntimeError("SLACK_RESPONSE_URL is required for a slash command response");
    }

    try {
      const response = await http.post(responseUrl, {
        json: {
          response_type: "ephemeral",
          text: message,
        },
        timeout: 10,
      });
      response.raise_for_status();
    } catch (error) {
      raiseSlackCredentialError(error);
      // `from None`: the response URL in the request error is not chained.
      throw new RuntimeError("Slack response delivery failed.");
    }
  }

  async function getThreadMessages(rootTs: string): Promise<unknown> {
    try {
      const response = await http.get("https://slack.com/api/conversations.replies", {
        headers: {
          Authorization: `Bearer ${slackToken}`,
        },
        params: {
          channel: channelId,
          ts: rootTs,
        },
        timeout: 10,
      });
      response.raise_for_status();
      return subscript(slackResultOrRaise(response.json()), "messages");
    } catch (error) {
      raiseSlackCredentialError(error);
      throw error;
    }
  }

  const authorizedChannelId = (): string => environment["TASKS_SLACK_CHANNEL_ID"] ?? "";

  // -------------------------------------------------------------------------
  // Private DM tracer
  // -------------------------------------------------------------------------

  if (eventType === "message" && channelType === "im") {
    if (!isAuthorizedSlackUser(userId, authorizedSlackUserId)) {
      log("Unauthorized Slack DM ignored");
      return 0;
    }

    const conversationRootTs = threadTs || eventTs;

    if (!conversationRootTs) {
      throw new RuntimeError("Received Slack DM event without a conversation root timestamp");
    }

    await postSlackMessage(DM_CONVERSATION_RECEIVED_MESSAGE, { threadTs: conversationRootTs });
    log("Authorized Slack DM response posted");
    return 0;
  }

  // -------------------------------------------------------------------------
  // Add Interaction modal submission
  // -------------------------------------------------------------------------

  if (eventType === "view_submission") {
    if (
      !isPrivateDataRequestAuthorized({
        channelId,
        channelType,
        userId,
        authorizedUserId: authorizedSlackUserId,
        authorizedChannelId: authorizedChannelId(),
      })
    ) {
      log("Unauthorized modal submission ignored");
      return 0;
    }

    const person = parsePersonPayload(environment["SLACK_PERSON"] ?? "");

    if ((environment["SLACK_VIEW_CALLBACK_ID"] ?? "") === ADD_FOLLOWUP_TASK_CALLBACK_ID) {
      const task = parseTaskPayload(environment["SLACK_TASK"] ?? "");
      await handleAddFollowupTaskSubmission(
        person.page_id,
        person.name,
        task.name,
        task.description,
        task.follow_up,
        task.priority,
        task.track_id,
        postSlackMessage,
        http.post,
        http.get,
        environment,
        { threadTs: threadTs || null, today, sleep },
      );
      log("Add follow-up Task submission handled");
      return 0;
    }

    await handleAddInteractionSubmission(
      person.page_id,
      person.name,
      environment["SLACK_INTERACTION_TYPE"] ?? "",
      environment["SLACK_INTERACTION_NOTES"] ?? "",
      environment["SLACK_INTERACTION_DATE"] ?? "",
      environment["SLACK_INTERACTION_TRACK_ID"] ?? "",
      postSlackMessage,
      http.post,
      http.get,
      environment,
      {
        threadTs: threadTs || null,
        today,
        sleep,
        buildFollowupButtons: (...interaction) =>
          buildFollowupTaskButtons(...interaction, http.post, http.get, environment, { generateText, today, sleep }),
      },
    );
    log("Add Interaction submission handled");
    return 0;
  }

  // -------------------------------------------------------------------------
  // Deterministic command families
  // -------------------------------------------------------------------------

  if (
    (command === "/tasks" || command === "/people") &&
    !isPrivateDataRequestAuthorized({
      channelId,
      channelType,
      userId,
      authorizedUserId: authorizedSlackUserId,
      authorizedChannelId: authorizedChannelId(),
    })
  ) {
    if (channelType === "im") {
      log("Unauthorized Slack DM command ignored");
    } else {
      const refusal = command === "/tasks" ? TASKS_CHANNEL_REFUSAL : PEOPLE_CHANNEL_REFUSAL;
      await postEphemeralCommandResponse(refusal);
      log("Unauthorized private-data command rejected");
    }
    return 0;
  }

  if (
    await handlePeopleCommand(command, text, postSlackMessage, http.post, environment, {
      generateText,
      postEphemeralResponse: postEphemeralCommandResponse,
      notionGet: http.get,
      today,
      sleep,
    })
  ) {
    log("People command handled");
    return 0;
  }

  if (
    await handleTasksCommand(command, text, channelId, postSlackMessage, http.post, environment, {
      postEphemeralResponse: postEphemeralCommandResponse,
      notionGet: http.get,
      today,
      sleep,
    })
  ) {
    log("Task command handled");
    return 0;
  }

  // -------------------------------------------------------------------------
  // Determine current Slack thread
  // -------------------------------------------------------------------------

  if (eventType === "slash_command") {
    // Slash commands are not real channel messages themselves,
    // so create a root message representing the user's task.
    const rootMessage = await postSlackMessage(`\u{1F4AC} ${text}`);

    // `root_message["ts"]`: whatever Slack returned for it.
    threadTs = subscript(rootMessage, "ts") as string;
  } else {
    // A normal Slack message event should already belong
    // to an existing thread.
    if (!threadTs) {
      throw new Exception("Received Slack message event without SLACK_THREAD_TS");
    }
  }

  // -------------------------------------------------------------------------
  // Read complete thread
  // -------------------------------------------------------------------------

  const messages = await getThreadMessages(threadTs);

  if (
    eventType === "message" &&
    truthy(messages) &&
    casefold(stripStr(dictGet(firstMessage(messages), "text", ""))) === "/tasks list"
  ) {
    await postSlackMessage(TASK_LIST_FOLLOW_UP_MESSAGE, { threadTs });
    return 0;
  }

  const conversation = buildConversation(messages);

  // -------------------------------------------------------------------------
  // Gemini
  // -------------------------------------------------------------------------

  const prompt = buildConversationPrompt(conversation);

  let answer: string;
  try {
    answer = await generateText(prompt);
  } catch (error) {
    if (!isTransientGeminiStatus(externalErrorStatusCode(error))) {
      throw error;
    }
    await postSlackMessage(GEMINI_TRANSIENT_FAILURE_MESSAGE, { threadTs });
    log("Gemini transient failure; safe Slack reply posted");
    return 0;
  }

  // -------------------------------------------------------------------------
  // Reply in the same Slack thread
  // -------------------------------------------------------------------------

  await postSlackMessage(answer, { threadTs });

  log("Gemini response posted to Slack thread");
  return 0;
}

// Error classes whose messages the application builds from constants, HTTP
// status codes and fixed Slack error codes only, so the top-level handler may
// print them:
//
// - RuntimeError (gemini.ts): every construction site in main.ts and gemini.ts
//   has a constant message, or interpolates only an HTTP status code (401/403)
//   or an error code that is a member of the constant SLACK_CREDENTIAL_ERRORS.
// - Exception: one site, a constant message.
// - NotionAuthenticationError ("Notion authentication failed (HTTP N)."),
//   TaskListCommandError and PeopleDueCommandError (empty messages), and the
//   http.ts errors (RequestException: fixed text, at most a status code), as
//   in the attention summary.
//
// Any other error (a JS built-in, KeyError, ValueError, an SDK error whose
// message quotes the API's response) is reported by its name alone.
const SECRET_FREE_MESSAGE_ERRORS: readonly SecretFreeMessageError[] = [
  RuntimeError,
  Exception,
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
  return sharedUncaughtErrorLine(error, SECRET_FREE_MESSAGE_ERRORS);
}

export type EntryPointDeps = MainDeps & {
  /** Where the top-level handler writes. Default: process.stderr. */
  writeStderr?: WriteStderr | undefined;
};

/**
 * main.py run by Python: an error escaping main is reported as one
 * secret-free line on stderr and resolves to exit code 1.
 */
export async function runEntryPoint(environment: Environment, deps: EntryPointDeps = {}): Promise<number> {
  return sharedRunEntryPoint(() => main(environment, deps), SECRET_FREE_MESSAGE_ERRORS, deps.writeStderr);
}

/** Run as the process: runEntryPoint, then `process.exitCode` (see src/entry-point.ts). */
export async function runProcess(environment: Environment, deps: EntryPointDeps = {}): Promise<void> {
  await sharedRunProcess(() => main(environment, deps), SECRET_FREE_MESSAGE_ERRORS, deps.writeStderr);
}

await runIfEntryPoint(import.meta, () => runProcess(process.env));
