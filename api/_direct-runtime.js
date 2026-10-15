// Runs src/main.ts directly inside the Vercel Function for the request shapes
// migrated off GitHub Actions (docs/experiments/vercel-runtime-migration,
// PLAN.md §3). Today that is only the /tasks command family (#36).
//
// This module is transport and runtime adaptation only: it turns the dispatch
// payload that api/slack-request.js already builds into main's environment,
// exactly as .github/workflows/slack-message.yml does, and calls
// runEntryPoint. Routing, authorization and every Notion/Slack call stay in
// src/. It logs only constant text: never the payload, the environment, Slack
// text, Notion data, URLs or tokens.

// slack-message.yml's `env:` mapping from client_payload fields. A missing
// field is "" there, so it is "" here.
const PAYLOAD_ENVIRONMENT = [
  ["SLACK_COMMAND", "command"],
  ["SLACK_TEXT", "text"],
  ["SLACK_CHANNEL_ID", "channel_id"],
  ["SLACK_USER_ID", "user_id"],
  ["SLACK_EVENT_TS", "event_ts"],
  ["SLACK_THREAD_TS", "thread_ts"],
  ["SLACK_CHANNEL_TYPE", "channel_type"],
  ["SLACK_EVENT_TYPE", "slack_event_type"],
  ["SLACK_PERSON", "person"],
  ["SLACK_INTERACTION_TYPE", "interaction_type"],
  ["SLACK_INTERACTION_NOTES", "notes"],
  ["SLACK_INTERACTION_DATE", "date"],
  ["SLACK_INTERACTION_TRACK_ID", "track_id"],
  ["SLACK_VIEW_CALLBACK_ID", "callback_id"],
  ["SLACK_TASK", "task"],
];

// The application secrets slack-message.yml passes, and nothing else: the
// signing secret, GITHUB_* and every other Vercel variable never reach main.
// An unset secret is "", as GitHub's expression gives.
export const APPLICATION_SECRET_NAMES = [
  "SLACK_BOT_TOKEN",
  "AUTHORIZED_SLACK_USER_ID",
  "GEMINI_API_KEY",
  "NOTION_API_KEY",
  "NOTION_PEOPLE_DATA_SOURCE_ID",
  "NOTION_INTERACTIONS_DATA_SOURCE_ID",
  "NOTION_TASKS_DATA_SOURCE_ID",
  "NOTION_TRACKS_DATA_SOURCE_ID",
  "TASKS_SLACK_CHANNEL_ID",
];

/** main's environment for `payload`, as slack-message.yml builds it. */
export function directEnvironment(payload, sourceEnvironment) {
  const environment = {};
  for (const [name, field] of PAYLOAD_ENVIRONMENT) {
    const value = payload[field];
    environment[name] = value === undefined || value === null ? "" : String(value);
  }
  for (const name of APPLICATION_SECRET_NAMES) {
    const value = sourceEnvironment[name];
    environment[name] = typeof value === "string" ? value : "";
  }
  // The workflow's masking step exports this only when it is non-empty.
  const responseUrl = payload.response_url;
  if (typeof responseUrl === "string" && responseUrl) {
    environment.SLACK_RESPONSE_URL = responseUrl;
  }
  return environment;
}

/**
 * Run main for one dispatch payload. `label` is a fixed string chosen by the
 * caller (never request data) and appears in the log lines. Never rejects.
 *
 * Imported lazily, so the synchronous paths (acks, views.open) never load
 * src/main.ts or @google/genai. Uses runEntryPoint, not runProcess: no
 * process-wide listener and no process.exitCode in a shared instance.
 */
export async function runDirect(
  payload,
  label,
  {
    sourceEnvironment = process.env,
    loadApplication = () => import("../src/main.ts"),
    entryPointDeps = {},
    log = console.log,
    logError = console.error,
  } = {}
) {
  // Logging must not reject the waitUntil promise either.
  const write = (logLine, line) => {
    try {
      logLine(line);
    } catch {
      // Nothing more to report it to.
    }
  };

  write(log, `Direct runtime: executing ${label}`);
  let exitCode = 1;
  let application = null;
  try {
    application = await loadApplication();
  } catch {
    // The error could carry a path or source excerpt; report it constantly.
    write(logError, "Direct runtime: failed to load the application");
  }
  if (application) {
    try {
      exitCode = await application.runEntryPoint(
        directEnvironment(payload, sourceEnvironment),
        entryPointDeps
      );
    } catch {
      // runEntryPoint already catches main's errors; this is a last resort.
      write(logError, "Direct runtime: unexpected failure");
      exitCode = 1;
    }
  }
  write(log, `Direct runtime: finished ${label} with exit code ${exitCode}`);
}
