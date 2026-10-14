// One-off dev utility: print the exact Gemini prompts `/people suggest` builds.
// Port of scripts/preview_people_suggest_prompts.py (removed in S9).
//
// Runs the real `handlePeopleSuggest` code path against live Notion data, but
// with Gemini and Slack replaced by local stubs: nothing is sent to Gemini and
// nothing is posted to Slack. Notion is only read (the same queries and page
// fetches the command makes). The captured prompts -- the recap/next-step
// prompt and the draft-message prompt -- are printed to this terminal only.
//
// Use it to check what Track context (names and Purposes) actually reaches
// Gemini for a given Person.
//
// Usage (PowerShell):
//     $env:NOTION_API_KEY = "..."
//     $env:NOTION_PEOPLE_DATA_SOURCE_ID = "..."
//     $env:NOTION_INTERACTIONS_DATA_SOURCE_ID = "..."
//     $env:NOTION_TRACKS_DATA_SOURCE_ID = "..."   # optional; only affects the
//                                                   # Track picker, not the prompts
//     node scripts/preview-people-suggest-prompts.ts "Anders Krog-Meyer"
//
// The output contains private Notion data (Person context, Interaction notes,
// Track Purposes). Do not paste it anywhere public or commit it. The API key is
// never printed.
//
// Node writes stdout as UTF-8, so Purposes with characters such as the
// truncation "…" print on any Windows console (the Python version had to
// reconfigure stdout for that).

import {
  printLine,
  runIfEntryPoint,
  runProcess,
  writeToStderr,
  type SecretFreeMessageError,
  type WriteStderr,
} from "../src/entry-point.ts";
import { RequestException, createHttp, type Http } from "../src/http.ts";
import { PeopleDueCommandError } from "../src/people-due.ts";
import { handlePeopleSuggest, type GenerateText } from "../src/people-suggest.ts";
import { pyStrip } from "../src/python-compat.ts";
import {
  NotionAuthenticationError,
  TaskListCommandError,
  type Environment,
  type PostSlackMessage,
} from "../src/tasks-list.ts";

export const REQUIRED_ENV_VARS = [
  "NOTION_API_KEY",
  "NOTION_PEOPLE_DATA_SOURCE_ID",
  "NOTION_INTERACTIONS_DATA_SOURCE_ID",
] as const;

export const PROMPT_LABELS = ["RECAP / NEXT-STEP PROMPT", "DRAFT-MESSAGE PROMPT"] as const;

export const USAGE = 'Usage: node scripts/preview-people-suggest-prompts.ts "<Person name>"';

/** What the Gemini stub returns for every prompt. */
export const DRY_RUN_GEMINI_TEXT = "- (dry run: Gemini not called)";

export type PreviewDeps = {
  /** Notion reads only: `post` for the queries, `get` for page and schema fetches. */
  http?: Http | undefined;
  /** `print`. Default: stdout. */
  log?: ((line: string) => void) | undefined;
  /** `print(..., file=sys.stderr)`. Default: process.stderr. */
  writeStderr?: WriteStderr | undefined;
};

/** `args` is the command line after the script, `sys.argv[1:]`. */
export async function main(
  args: readonly string[],
  environment: Environment,
  deps: PreviewDeps = {},
): Promise<number> {
  const log = deps.log ?? printLine;
  const writeStderr = deps.writeStderr ?? writeToStderr;

  const personName = args.length === 1 ? pyStrip(args[0] as string) : "";
  if (!personName) {
    writeStderr(`${USAGE}\n`);
    return 2;
  }

  const missing = REQUIRED_ENV_VARS.filter((name) => !environment[name]);
  if (missing.length > 0) {
    writeStderr(`Missing environment variables: ${missing.join(", ")}\n`);
    return 1;
  }

  const http = deps.http ?? createHttp();
  const prompts: string[] = [];
  const slackMessages: string[] = [];

  const capturePrompt: GenerateText = async (prompt) => {
    prompts.push(prompt);
    return DRY_RUN_GEMINI_TEXT;
  };

  const captureSlackMessage: PostSlackMessage = async (message) => {
    slackMessages.push(message);
    return { ts: "dry-run" };
  };

  await handlePeopleSuggest(personName, captureSlackMessage, http.post, capturePrompt, environment, {
    notionGet: http.get,
  });

  if (prompts.length === 0) {
    // The command stopped before calling Gemini (Person not found,
    // ambiguous, or a Notion failure); show what it would have posted.
    log("No Gemini prompts were built. The command would have replied:\n");
    for (const message of slackMessages.slice(1)) {
      log(message);
    }
    return 1;
  }

  PROMPT_LABELS.forEach((label, index) => {
    const prompt = prompts[index];
    if (prompt === undefined) return;
    log(`${"=".repeat(20)} ${label} ${"=".repeat(20)}`);
    log(prompt);
    log("");
  });
  return 0;
}

// The application errors handlePeopleSuggest can let escape carry fixed,
// secret-free messages; anything else is reported by its name alone
// (src/entry-point.ts).
const SECRET_FREE_MESSAGE_ERRORS: readonly SecretFreeMessageError[] = [
  NotionAuthenticationError,
  TaskListCommandError,
  PeopleDueCommandError,
  RequestException,
];

await runIfEntryPoint(import.meta, () =>
  runProcess(() => main(process.argv.slice(2), process.env), SECRET_FREE_MESSAGE_ERRORS),
);
