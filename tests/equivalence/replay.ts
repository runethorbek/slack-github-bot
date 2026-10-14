// Golden replay harness: runs a recorded scenario (tests/equivalence/scenarios)
// against the TypeScript entry point and compares its observables with the
// Python golden (tests/equivalence/golden), following the "Replay
// normalisation rules" in tests/equivalence/README.md.
//
// Each scenario runs in its own child process (this file, run as the main
// module), so that the child's real stdout and stderr are exactly what the
// entry point writes, including the top-level error handler's output, and the
// real exit status is what it sets. Only the boundaries are faked, as the
// Python recorder fakes them:
//
// - HTTP: an injected `http` ({post, get}, the http.ts shape) serves the
//   scripted entries in order. A scripted response is a real HttpResponse, and
//   a scripted error is the real http.ts error class. An unscripted call, a call
//   that does not match its entry's `expect`, an unexpected option, or an
//   unused entry is a harness failure (never a pass), recorded even when the
//   application catches the thrown ScriptViolation. `fetch` and
//   `net.Socket.connect` are blocked, so nothing reaches the network.
// - Time: `sleep` records its durations and returns at once; `today` is the
//   scenario's frozen date.
// - Gemini: `gemini.create({model, input})` serves the Gemini script in order.
//   Scripted Gemini errors need src/gemini.ts's error class (S8).
//
// The parent (replayScenario) sends the scenario to the child over IPC and
// receives the recorded calls back; compareWithGolden then applies the rules.
//
// S8 extends this by adding a `main` runner to ENTRY_POINTS (and the Gemini
// error construction), then listing "main" in tests/equivalence.test.ts.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConnectionError,
  HttpResponse,
  ReadTimeout,
  encodeParams,
  type GetOptions,
  type Http,
  type PostOptions,
} from "../../src/http.ts";
import { dateFromIsoformat, type PlainDate } from "../../src/plain-date.ts";

export const EQUIVALENCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(EQUIVALENCE_DIR, "scenarios");
const GOLDEN_DIR = path.join(EQUIVALENCE_DIR, "golden");

/** The canary values every scenario uses for secrets and private data (record_python.py CANARIES). */
export const CANARIES = [
  "xoxb-CANARY-SLACK-TOKEN",
  "secret_CANARY_NOTION_KEY",
  "CANARY-GEMINI-KEY",
  "CANARY-RESPONSE-URL",
  "CANARY-PRIVATE",
] as const;

/**
 * Exception types whose golden `message` is Python's own formatting of the
 * exception (`str(KeyError("X"))` is `'X'`), which the replay does not require
 * in the error output (README "Replay normalisation rules", `exit`; S1 review
 * R6). Every other uncaught message is an application-defined string and must
 * appear.
 */
const PYTHON_FORMATTED_MESSAGE_TYPES: ReadonlySet<string> = new Set(["KeyError"]);

// ---------------------------------------------------------------------------
// Scenario and golden files
// ---------------------------------------------------------------------------

export type HttpScriptEntry = {
  expect: { method: string; url: string };
  response?: { status: number; headers?: Record<string, string>; json?: unknown; text?: string };
  error?: string;
};

export type GeminiScriptEntry = { output_text: string } | { error: { status: number } };

export type Scenario = {
  name: string;
  description: string;
  entrypoint: string;
  today: string;
  env: Record<string, string>;
  http: HttpScriptEntry[];
  gemini: GeminiScriptEntry[];
  known_leak?: string;
};

export type GoldenHttpCall = {
  method: string;
  url: string;
  params: Record<string, string> | null;
  headers: Record<string, string> | null;
  json: unknown;
  timeout: number | null;
};

export type Golden = {
  http_calls: GoldenHttpCall[];
  gemini_calls: Array<{ model: string; input: string }>;
  sleeps: number[];
  stdout: string[];
  exit: { code: number; uncaught?: { type: string; message: string } };
};

/** Every scenario whose entry point is in `entrypoints`, sorted by name. */
export function loadScenarios(entrypoints: readonly string[]): Scenario[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const scenario = JSON.parse(readFileSync(path.join(SCENARIOS_DIR, file), "utf8")) as Scenario;
      assert.equal(scenario.name, file.slice(0, -".json".length), `${file}: name must equal the file name`);
      return scenario;
    })
    .filter((scenario) => entrypoints.includes(scenario.entrypoint));
}

export function loadGolden(name: string): Golden {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), "utf8")) as Golden;
}

// ---------------------------------------------------------------------------
// Child side: run one scenario with faked boundaries
// ---------------------------------------------------------------------------

/** What an entry-point runner is given; the faked boundaries. */
export type ReplayDeps = {
  http: Http;
  sleep: (seconds: number) => void;
  today: PlainDate;
  gemini: { create(request: { model: string; input: string }): Promise<{ output_text: string }> };
};

/** Runs the entry point as the process does: it writes to stdout/stderr and sets process.exitCode. */
type EntryPointRunner = (environment: Record<string, string>, deps: ReplayDeps) => Promise<void>;

const ENTRY_POINTS: Readonly<Record<string, EntryPointRunner>> = {
  // `runProcess` is what `node src/attention-summary.ts` runs, with the
  // environment and the boundaries injected.
  async attention_summary(environment, deps) {
    const { runProcess } = await import("../../src/attention-summary.ts");
    await runProcess(environment, { http: deps.http, sleep: deps.sleep, today: deps.today });
  },
};

/** The application made a call the scenario script does not allow. */
class ScriptViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptViolation";
  }
}

/** What the child reports back over IPC. */
export type ChildReport = {
  http_calls: GoldenHttpCall[];
  gemini_calls: Array<{ model: string; input: string }>;
  sleeps: number[];
  violations: string[];
  unusedHttp: number;
  unusedGemini: number;
};

// The options each http.ts method reads; it ignores any other key, so passing
// one (`params` to post, `json` to get) is a violation.
const HTTP_OPTION_KEYS: Readonly<Record<"GET" | "POST", ReadonlySet<string>>> = {
  POST: new Set(["headers", "json", "timeout"]),
  GET: new Set(["headers", "params", "timeout"]),
};

/** The URL without its query string, and the query (with `params` applied) as a map, or null. */
function splitUrl(url: string, params: Record<string, string> | undefined): [string, Record<string, string> | null, string | null] {
  const full = encodeParams(url, params);
  const queryStart = full.indexOf("?");
  const fragmentStart = full.indexOf("#");
  const baseEnd = queryStart >= 0 ? queryStart : fragmentStart >= 0 ? fragmentStart : full.length;
  const base = full.slice(0, baseEnd);
  if (queryStart < 0) return [base, null, null];
  const query = full.slice(queryStart + 1, fragmentStart > queryStart ? fragmentStart : undefined);
  const map: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (Object.hasOwn(map, key)) return [base, map, `repeated query parameter ${JSON.stringify(key)}`];
    map[key] = value;
  }
  return [base, Object.keys(map).length > 0 ? map : null, null];
}

function buildResponse(spec: NonNullable<HttpScriptEntry["response"]>): HttpResponse {
  let body = "";
  if (Object.hasOwn(spec, "json")) body = JSON.stringify(spec.json);
  else if (spec.text !== undefined) body = spec.text;
  return new HttpResponse(spec.status, new Headers(spec.headers ?? {}), body);
}

/**
 * The scripted `http` ({post, get}): consumes `httpScript` in order, records
 * each call in `report.http_calls` and each violation in `report.violations`
 * (and throws a ScriptViolation for it).
 */
export function createScriptedHttp(
  httpScript: HttpScriptEntry[],
  report: Pick<ChildReport, "http_calls" | "violations">,
): Http {
  const violate = (message: string): never => {
    report.violations.push(message);
    throw new ScriptViolation(message);
  };

  async function call(method: "GET" | "POST", url: string, options: PostOptions & GetOptions = {}): Promise<HttpResponse> {
    const unexpected = Object.keys(options).filter((key) => !HTTP_OPTION_KEYS[method].has(key));
    // Only what the http.ts method sends is recorded: post ignores params, get ignores json.
    const [base, params, paramsProblem] = splitUrl(url, method === "GET" ? options.params : undefined);
    const callNumber = report.http_calls.length + 1;
    report.http_calls.push({
      method,
      url: base,
      params,
      headers: options.headers === undefined ? null : structuredClone(options.headers),
      // What goes on the wire: http.ts serializes `json` with JSON.stringify.
      json: method === "GET" || options.json === undefined ? null : JSON.parse(JSON.stringify(options.json)),
      timeout: options.timeout === undefined ? null : options.timeout,
    });
    if (unexpected.length > 0) violate(`${method} ${base}: unexpected option(s) ${unexpected.join(", ")}`);
    // http.ts sends the literal body `null` for `json: null`, while requests
    // sends no body for `json=None`: the two cannot be compared.
    if (options.json === null) violate(`${method} ${base}: json is null`);
    if (paramsProblem !== null) violate(`${method} ${base}: ${paramsProblem}`);
    const entry = httpScript.shift();
    if (entry === undefined) return violate(`HTTP call ${callNumber} (${method} ${base}) is not in the script`);
    if (entry.expect.method !== method || entry.expect.url !== base) {
      violate(
        `HTTP call ${callNumber} was ${method} ${base}, script expects ${entry.expect.method} ${entry.expect.url}`,
      );
    }
    if (entry.error !== undefined) {
      if (entry.error === "ReadTimeout") throw new ReadTimeout();
      if (entry.error === "ConnectionError") throw new ConnectionError();
      // ConnectTimeout has no http.ts equivalent: fetch reports every timeout as ReadTimeout.
      return violate(`Scripted HTTP error ${JSON.stringify(entry.error)} has no http.ts equivalent`);
    }
    if (entry.response === undefined) return violate(`HTTP script entry ${callNumber} has no response`);
    return buildResponse(entry.response);
  }

  return {
    post: (url, options) => call("POST", url, options),
    get: (url, options) => call("GET", url, options),
  };
}

async function runChild(scenario: Scenario): Promise<ChildReport> {
  const httpScript = [...scenario.http];
  const geminiScript = [...scenario.gemini];
  const report: ChildReport = {
    http_calls: [],
    gemini_calls: [],
    sleeps: [],
    violations: [],
    unusedHttp: 0,
    unusedGemini: 0,
  };
  const violate = (message: string): never => {
    report.violations.push(message);
    throw new ScriptViolation(message);
  };

  // Nothing may reach the network outside the scripted http.
  globalThis.fetch = async () => violate("Network access outside the scripted http (fetch)");
  net.Socket.prototype.connect = function blockedConnect(): never {
    return violate("Network access outside the scripted http (net.Socket.connect)");
  };


  const deps: ReplayDeps = {
    http: createScriptedHttp(httpScript, report),
    sleep: (seconds) => {
      report.sleeps.push(seconds);
    },
    today: dateFromIsoformat(scenario.today),
    gemini: {
      async create({ model, input }) {
        const callNumber = report.gemini_calls.length + 1;
        report.gemini_calls.push({ model, input });
        const entry = geminiScript.shift();
        if (entry === undefined) return violate(`Gemini call ${callNumber} is not in the script`);
        if ("error" in entry) return violate("Scripted Gemini errors need src/gemini.ts (S8)");
        return { output_text: entry.output_text };
      },
    },
  };

  const runner = ENTRY_POINTS[scenario.entrypoint];
  if (runner === undefined) {
    report.violations.push(`No TypeScript entry point for ${JSON.stringify(scenario.entrypoint)}`);
  } else {
    await runner(scenario.env, deps);
  }
  report.unusedHttp = httpScript.length;
  report.unusedGemini = geminiScript.length;
  return report;
}

if (import.meta.main) {
  process.once("message", (scenario) => {
    void runChild(scenario as Scenario).then(
      (report) => process.send?.(report, () => process.disconnect()),
      () => {
        // A harness failure: report nothing, so the parent fails. The error is
        // not printed (the entry point's stderr is under test).
        process.exitCode = 99;
        process.disconnect();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Parent side
// ---------------------------------------------------------------------------

export type Observed = ChildReport & {
  /** Everything the child wrote to stdout. */
  stdout: string;
  /** Everything the child wrote to stderr. */
  stderr: string;
  /** The child's exit status. */
  exitCode: number | null;
};

const REPLAY_TIMEOUT_MS = 30_000;

/** Run `scenario` in a child process and collect its observables. */
export function replayScenario(scenario: Scenario): Promise<Observed> {
  return new Promise((resolve, reject) => {
    // The child gets no environment beyond what Node needs: the entry point
    // reads only the scenario's `env`, passed explicitly.
    const childEnv: Record<string, string> = {};
    for (const name of ["PATH", "SYSTEMROOT", "SystemRoot"]) {
      const value = process.env[name];
      if (value !== undefined) childEnv[name] = value;
    }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: childEnv,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let report: ChildReport | null = null;
    const timer = setTimeout(() => child.kill(), REPLAY_TIMEOUT_MS);
    assert.ok(child.stdout && child.stderr, "the replay child has piped stdout and stderr");
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("message", (message) => {
      report = message as ChildReport;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (report === null) {
        reject(new Error(`${scenario.name}: the replay child reported nothing (exit ${code})`));
        return;
      }
      resolve({
        ...(report as ChildReport),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
      });
    });
    child.send(scenario);
  });
}

/**
 * Compare the observables with the golden, per the README's normalisation
 * rules. Throws an AssertionError on the first difference.
 */
export function compareWithGolden(scenario: Scenario, golden: Golden, observed: Observed): void {
  const name = scenario.name;
  // The script was followed exactly.
  assert.deepEqual(observed.violations, [], `${name}: script violations`);
  assert.equal(observed.unusedHttp, 0, `${name}: scripted HTTP entries unused`);
  assert.equal(observed.unusedGemini, 0, `${name}: scripted Gemini entries unused`);

  // HTTP calls: exact order; method, URL, params, headers and timeout exactly;
  // JSON bodies structurally (key order ignored, every value exact).
  assert.equal(
    observed.http_calls.length,
    golden.http_calls.length,
    `${name}: number of HTTP calls (${observed.http_calls.map((c) => `${c.method} ${c.url}`).join(", ")})`,
  );
  golden.http_calls.forEach((expected, index) => {
    const actual = observed.http_calls[index] as GoldenHttpCall;
    const label = `${name}: HTTP call ${index + 1}`;
    assert.equal(actual.method, expected.method, `${label} method`);
    assert.equal(actual.url, expected.url, `${label} url`);
    assert.deepStrictEqual(actual.params, expected.params, `${label} params`);
    assert.deepStrictEqual(actual.headers, expected.headers, `${label} headers`);
    assert.deepStrictEqual(actual.json, expected.json, `${label} json`);
    assert.strictEqual(actual.timeout, expected.timeout, `${label} timeout`);
  });

  // Gemini calls: model and input exactly.
  assert.deepStrictEqual(observed.gemini_calls, golden.gemini_calls, `${name}: Gemini calls`);

  // Sleeps: numerically, in order.
  assert.equal(observed.sleeps.length, golden.sleeps.length, `${name}: number of sleeps`);
  golden.sleeps.forEach((expected, index) => {
    assert.ok(Number(observed.sleeps[index]) === Number(expected), `${name}: sleep ${index + 1} is ${observed.sleeps[index]}, golden ${expected}`);
  });

  // stdout: exactly the golden lines, each ended by "\n" as print ends them.
  assert.equal(
    observed.stdout,
    golden.stdout.map((line) => `${line}\n`).join(""),
    `${name}: stdout`,
  );

  // Exit outcome.
  assert.equal(observed.exitCode, golden.exit.code, `${name}: exit code`);
  const uncaught = golden.exit.uncaught;
  if (uncaught === undefined) {
    // The recorder fails on any stderr output, so the golden implies none.
    assert.equal(observed.stderr, "", `${name}: stderr`);
  } else {
    // The top-level handler prints exactly one line.
    assert.match(observed.stderr, /^[^\n]+\n$/, `${name}: the uncaught error is reported as exactly one line`);
    if (!PYTHON_FORMATTED_MESSAGE_TYPES.has(uncaught.type)) {
      assert.ok(
        observed.stderr.includes(uncaught.message),
        `${name}: stderr ${JSON.stringify(observed.stderr)} lacks the message ${JSON.stringify(uncaught.message)}`,
      );
    }
  }

  // Security invariant S7: no canary in anything the entry point printed.
  if (scenario.known_leak === undefined) {
    for (const [stream, text] of [
      ["stdout", observed.stdout],
      ["stderr", observed.stderr],
    ] as const) {
      for (const canary of CANARIES) {
        assert.ok(!text.includes(canary), `${name}: secret canary ${canary} leaked to ${stream}`);
      }
    }
  }
}
