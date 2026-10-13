// PLACEHOLDER — replaced by the port of people_suggest.py in migration slice S5.
//
// It exists only so that people-due.ts can mirror Python's lazy
// `from people_suggest import handle_people_suggest` with a dynamic
// `import("./people-suggest.ts")` before the real module is ported. The
// signature is the intended one (Python's, in the S2 conventions); the body
// always throws, so nothing can silently depend on it.

import type { PlainDate } from "./plain-date.ts";
import type { Environment, NotionGet, NotionPost, PostSlackMessage, Sleep } from "./tasks-list.ts";

/** `generate_text(prompt) -> str`, the injected Gemini call (asynchronous in TS). */
export type GenerateText = (prompt: string) => Promise<string>;

export type HandlePeopleSuggestOptions = {
  today?: PlainDate | null | undefined;
  sleep?: Sleep | undefined;
  notionGet?: NotionGet | null | undefined;
};

/**
 * `handle_people_suggest(person_name, post_slack_message, notion_post,
 * generate_text, environment, today=None, sleep=time.sleep, notion_get=None)`.
 */
export async function handlePeopleSuggest(
  _personName: string,
  _postSlackMessage: PostSlackMessage,
  _notionPost: NotionPost,
  _generateText: GenerateText | null | undefined,
  _environment: Environment,
  _options: HandlePeopleSuggestOptions = {},
): Promise<void> {
  throw new Error("people-suggest is ported in migration slice S5");
}
