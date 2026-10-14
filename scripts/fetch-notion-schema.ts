// One-off dev utility: dump live Notion data source schemas to local files.
// Port of scripts/fetch_notion_schema.py (removed in S9).
//
// Read-only. Calls Notion's "retrieve a data source" endpoint for whichever of
// People / Interactions / Tasks / Tracks have a data source id configured, and
// writes each response's `properties` to schema-dump/<name>.json so the repo's
// docs/notion-*-schema.md files can be written or corrected against the real
// schema instead of guessed from code.
//
// Usage (PowerShell):
//     $env:NOTION_API_KEY = "..."
//     $env:NOTION_PEOPLE_DATA_SOURCE_ID = "..."
//     $env:NOTION_INTERACTIONS_DATA_SOURCE_ID = "..."
//     $env:NOTION_TASKS_DATA_SOURCE_ID = "..."
//     $env:NOTION_TRACKS_DATA_SOURCE_ID = "..."   # find it via the Tracks
//                                                   # database's Notion URL/share
//                                                   # link if not already set
//     node scripts/fetch-notion-schema.ts
//
// Only data sources whose env var is set are fetched; the rest are skipped.
// Nothing is printed except progress lines naming which sources were fetched
// or skipped -- the API key is never logged, and the dumped files contain
// schema (property names/types/options) only, never row data.
//
// The files are written with JSON.stringify(properties, null, 2), which
// matches Python's json.dumps(indent=2, ensure_ascii=False) for this data
// except that a float like 1.0 is written as 1.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  printLine,
  runIfEntryPoint,
  runProcess,
  writeToStderr,
  type SecretFreeMessageError,
  type WriteStderr,
} from "../src/entry-point.ts";
import { JSONDecodeError, RequestException, createHttp, type Http } from "../src/http.ts";
import { dictGet, isDict, pyLen } from "../src/python-compat.ts";
import { NOTION_API_VERSION, type Environment } from "../src/tasks-list.ts";

export const DATA_SOURCES: readonly (readonly [string, string])[] = [
  ["people", "NOTION_PEOPLE_DATA_SOURCE_ID"],
  ["interactions", "NOTION_INTERACTIONS_DATA_SOURCE_ID"],
  ["tasks", "NOTION_TASKS_DATA_SOURCE_ID"],
  ["tracks", "NOTION_TRACKS_DATA_SOURCE_ID"],
];

export const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schema-dump");

export type FetchSchemaDeps = {
  http?: Pick<Http, "get"> | undefined;
  /** Where the files are written. Default: OUTPUT_DIR. */
  outputDir?: string | undefined;
  /** `print`. Default: stdout. */
  log?: ((line: string) => void) | undefined;
  /** `print(..., file=sys.stderr)`. Default: process.stderr. */
  writeStderr?: WriteStderr | undefined;
};

/** `len(properties)`. */
function length(value: unknown): number {
  if (isDict(value)) return Object.keys(value).length;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return pyLen(value);
  throw new TypeError("object has no len()");
}

export async function main(environment: Environment, deps: FetchSchemaDeps = {}): Promise<number> {
  const http = deps.http ?? createHttp();
  const outputDir = deps.outputDir ?? OUTPUT_DIR;
  const log = deps.log ?? printLine;
  const writeStderr = deps.writeStderr ?? writeToStderr;

  const apiKey = environment["NOTION_API_KEY"];
  if (!apiKey) {
    writeStderr("NOTION_API_KEY is not set; nothing to do.\n");
    return 1;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_API_VERSION,
  };

  mkdirSync(outputDir, { recursive: true });

  let fetchedAny = false;
  for (const [name, envVar] of DATA_SOURCES) {
    const dataSourceId = environment[envVar];
    if (!dataSourceId) {
      log(`Skipping ${name}: ${envVar} is not set.`);
      continue;
    }

    const response = await http.get(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
      headers,
      timeout: 10,
    });
    response.raise_for_status();
    const properties = dictGet(response.json(), "properties", {});

    const outputPath = path.join(outputDir, `${name}.json`);
    writeFileSync(outputPath, JSON.stringify(properties, null, 2), "utf8");
    log(`Wrote ${outputPath} (${length(properties)} properties)`);
    fetchedAny = true;
  }

  if (!fetchedAny) {
    writeStderr("No data source ids were set; nothing fetched.\n");
    return 1;
  }
  return 0;
}

// http.ts errors carry fixed text (at most a status code); anything else is
// reported by its name alone (src/entry-point.ts).
const SECRET_FREE_MESSAGE_ERRORS: readonly SecretFreeMessageError[] = [RequestException, JSONDecodeError];

await runIfEntryPoint(import.meta, () => runProcess(() => main(process.env), SECRET_FREE_MESSAGE_ERRORS));
