// Golden equivalence (ACCEPTANCE.md G5): every recorded scenario, replayed
// against the TypeScript entry point, must produce the observables Python
// recorded. tests/equivalence/replay.ts runs each scenario in a child process
// and applies the README's normalisation rules.
//
// Entry points: attention_summary (S7) and main (S8): every scenario is replayed.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  EQUIVALENCE_DIR,
  compareWithGolden,
  createScriptedHttp,
  loadGolden,
  loadScenarios,
  replayScenario,
  sdkStatusError,
  type Golden,
  type Observed,
  type Scenario,
} from "./equivalence/replay.ts";

const REPLAYED_ENTRY_POINTS = ["attention_summary", "main"];

const scenarios = loadScenarios(REPLAYED_ENTRY_POINTS);

test("golden scenarios: every scenario is replayed: all 62, 6 attention_summary and 56 main", () => {
  const scenarioFiles = readdirSync(path.join(EQUIVALENCE_DIR, "scenarios")).filter((file) => file.endsWith(".json"));
  assert.equal(scenarioFiles.length, 62);
  assert.equal(scenarios.length, scenarioFiles.length, "a scenario's entry point is not replayed");
  assert.deepEqual(
    scenarios.filter((scenario) => scenario.entrypoint === "attention_summary").map((scenario) => scenario.name),
    [
      "attention_both_fail",
      "attention_both_sections_over_5",
      "attention_missing_slack_token",
      "attention_nothing",
      "attention_slack_dm_not_ok",
      "attention_tasks_fail_people_ok",
    ],
  );
  assert.equal(scenarios.filter((scenario) => scenario.entrypoint === "main").length, 56);
});

for (const scenario of scenarios) {
  test(`golden: ${scenario.name}`, async () => {
    const observed = await replayScenario(scenario);
    compareWithGolden(scenario, loadGolden(scenario.name), observed);
  });
}

// ---------------------------------------------------------------------------
// Harness self-tests: the replay is not lenient
// ---------------------------------------------------------------------------

function scenarioNamed(name: string): Scenario {
  const found = scenarios.find((scenario) => scenario.name === name);
  assert.ok(found, name);
  return structuredClone(found);
}

function mutated<T>(value: T, edit: (copy: T) => void): T {
  const copy = structuredClone(value);
  edit(copy);
  return copy;
}

test("harness self-test: a golden that differs in any compared observable fails the comparison", async (t) => {
  const scenario = scenarioNamed("attention_tasks_fail_people_ok");
  const golden = loadGolden(scenario.name);
  const observed = await replayScenario(scenario);
  compareWithGolden(scenario, golden, observed);

  const overFive = scenarioNamed("attention_both_sections_over_5");
  const overFiveGolden = loadGolden(overFive.name);
  const overFiveObserved = await replayScenario(overFive);
  compareWithGolden(overFive, overFiveGolden, overFiveObserved);

  const dmText = (copy: Golden) => (copy.http_calls.at(-1)?.json as { text: string });

  const goldenMutations: Array<[string, Scenario, Golden, Observed, (copy: Golden) => void]> = [
    ["the '+N more' line in the DM text", overFive, overFiveGolden, overFiveObserved, (copy) => {
      dmText(copy).text = dmText(copy).text.replace("+2 more — run /tasks list", "+3 more — run /tasks list");
    }],
    ["the DM text has one extra character", overFive, overFiveGolden, overFiveObserved, (copy) => {
      dmText(copy).text += " ";
    }],
    ["a JSON body field", overFive, overFiveGolden, overFiveObserved, (copy) => {
      (copy.http_calls[0]?.json as { page_size: number }).page_size = 99;
    }],
    ["an extra JSON body field", overFive, overFiveGolden, overFiveObserved, (copy) => {
      (copy.http_calls[0]?.json as Record<string, unknown>)["extra"] = null;
    }],
    ["a header value", scenario, golden, observed, (copy) => {
      (copy.http_calls.at(-1)?.headers as Record<string, string>)["Authorization"] = "Bearer xoxb-other";
    }],
    ["a header name's case", scenario, golden, observed, (copy) => {
      const headers = copy.http_calls[0]?.headers as Record<string, string>;
      headers["notion-version"] = headers["Notion-Version"] as string;
      delete headers["Notion-Version"];
    }],
    ["the timeout", scenario, golden, observed, (copy) => {
      (copy.http_calls[0] as { timeout: number | null }).timeout = null;
    }],
    ["the params", scenario, golden, observed, (copy) => {
      (copy.http_calls[0] as { params: unknown }).params = {};
    }],
    ["the URL", scenario, golden, observed, (copy) => {
      (copy.http_calls[0] as { url: string }).url += "/";
    }],
    ["the call order", scenario, golden, observed, (copy) => {
      copy.http_calls.reverse();
    }],
    ["one call fewer", scenario, golden, observed, (copy) => {
      copy.http_calls.pop();
    }],
    ["a sleep duration", scenario, golden, observed, (copy) => {
      copy.sleeps[1] = 3;
    }],
    ["one sleep fewer", scenario, golden, observed, (copy) => {
      copy.sleeps.pop();
    }],
    ["a stdout line", scenario, golden, observed, (copy) => {
      copy.stdout[0] = (copy.stdout[0] as string).replace("HTTP 500", "HTTP 503");
    }],
    ["an extra stdout line", scenario, golden, observed, (copy) => {
      copy.stdout.push("");
    }],
    ["the exit code", scenario, golden, observed, (copy) => {
      copy.exit.code = 0;
    }],
    ["an uncaught application error the output lacks", scenario, golden, observed, (copy) => {
      copy.exit.uncaught = { type: "RuntimeError", message: "Slack response delivery failed." };
    }],
    ["a Gemini call", scenario, golden, observed, (copy) => {
      copy.gemini_calls.push({ model: "m", input: "i" });
    }],
  ];

  for (const [what, base, baseGolden, baseObserved, edit] of goldenMutations) {
    await t.test(what, () => {
      assert.throws(() => compareWithGolden(base, mutated(baseGolden, edit), baseObserved), assert.AssertionError);
    });
  }
});

test("harness self-test: observed output the golden does not allow fails the comparison", async (t) => {
  const scenario = scenarioNamed("attention_slack_dm_not_ok");
  const golden = loadGolden(scenario.name);
  const observed = await replayScenario(scenario);
  compareWithGolden(scenario, golden, observed);

  const observedMutations: Array<[string, (copy: Observed) => void]> = [
    ["a canary in stdout", (copy) => {
      copy.stdout = copy.stdout.replace("channel_not_found", "xoxb-CANARY-SLACK-TOKEN");
    }],
    ["stdout without its final newline", (copy) => {
      copy.stdout = copy.stdout.slice(0, -1);
    }],
    ["anything on stderr", (copy) => {
      copy.stderr = "warning\n";
    }],
    ["a script violation", (copy) => {
      copy.violations.push("HTTP call 5 is not in the script");
    }],
    ["an unused HTTP entry", (copy) => {
      copy.unusedHttp = 1;
    }],
    ["a sleep the golden lacks", (copy) => {
      copy.sleeps.push(1);
    }],
  ];
  for (const [what, edit] of observedMutations) {
    await t.test(what, () => {
      assert.throws(() => compareWithGolden(scenario, golden, mutated(observed, edit)), assert.AssertionError);
    });
  }

  await t.test("an uncaught error: a canary on stderr, two lines, or a missing application message", () => {
    const withUncaught = mutated(golden, (copy) => {
      copy.exit.uncaught = { type: "RuntimeError", message: "Slack DM delivery failed (channel_not_found)." };
    });
    const reported = mutated(observed, (copy) => {
      copy.stderr = "SlackDmDeliveryError: Slack DM delivery failed (channel_not_found).\n";
    });
    compareWithGolden(scenario, withUncaught, reported);
    for (const stderr of [
      "SlackDmDeliveryError: Slack DM delivery failed (channel_not_found). xoxb-CANARY-SLACK-TOKEN\n",
      "SlackDmDeliveryError: Slack DM delivery failed (channel_not_found).\n    at stack\n",
      "SlackDmDeliveryError\n",
    ]) {
      assert.throws(
        () => compareWithGolden(scenario, withUncaught, mutated(reported, (copy) => {
          copy.stderr = stderr;
        })),
        assert.AssertionError,
      );
    }
    // A KeyError message is Python's formatting and is not required.
    const keyError = mutated(golden, (copy) => {
      copy.exit.uncaught = { type: "KeyError", message: "'SLACK_TEXT'" };
    });
    compareWithGolden(scenario, keyError, mutated(observed, (copy) => {
      copy.stderr = "KeyError\n";
    }));
  });
});

test("harness self-test: the fake http fails on an unscripted, mismatching or unused call", async (t) => {
  const base = scenarioNamed("attention_nothing");
  const golden = loadGolden(base.name);

  await t.test("a call beyond the script", async () => {
    const scenario = mutated(base, (copy) => {
      copy.http.pop();
    });
    const observed = await replayScenario(scenario);
    assert.equal(observed.violations.length, 1);
    assert.match(observed.violations[0] as string, /HTTP call 3 .* is not in the script/);
    assert.throws(() => compareWithGolden(scenario, golden, observed), assert.AssertionError);
  });

  await t.test("a call that does not match its entry", async () => {
    const scenario = mutated(base, (copy) => {
      (copy.http[1] as { expect: { url: string } }).expect.url = "https://api.notion.com/v1/data_sources/other/query";
    });
    const observed = await replayScenario(scenario);
    assert.match(observed.violations[0] as string, /HTTP call 2 was POST .*ds-people\/query, script expects/);
    assert.throws(() => compareWithGolden(scenario, golden, observed), assert.AssertionError);
  });

  await t.test("an unused script entry", async () => {
    const scenario = mutated(base, (copy) => {
      copy.http.push(structuredClone(copy.http[0] as Scenario["http"][number]));
    });
    const observed = await replayScenario(scenario);
    assert.deepEqual(observed.violations, []);
    assert.equal(observed.unusedHttp, 1);
    assert.throws(() => compareWithGolden(scenario, golden, observed), assert.AssertionError);
  });
});

test("harness self-test: the fake http allows only the options http.ts sends, and no json: null", async (t) => {
  const url = "https://api.notion.com/v1/data_sources/ds/query";
  const script = (method: string) => [{ expect: { method, url }, response: { status: 200, json: {} } }];
  const newReport = () => ({ http_calls: [], violations: [] as string[] });

  await t.test("allowed: POST {headers, json, timeout} and GET {headers, params, timeout}", async () => {
    const report = newReport();
    await createScriptedHttp(script("POST"), report).post(url, { headers: {}, json: { a: 1 }, timeout: 10 });
    await createScriptedHttp(script("GET"), report).get(url, { headers: {}, params: { a: "1" }, timeout: 10 });
    assert.deepEqual(report.violations, []);
  });

  const rejected: Array<[string, (http: ReturnType<typeof createScriptedHttp>) => Promise<unknown>, string, RegExp]> = [
    ["params on a POST (http.ts post ignores it)", (http) => http.post(url, { params: { a: "1" } } as never), "POST", /unexpected option\(s\) params/],
    ["json on a GET (http.ts get ignores it)", (http) => http.get(url, { json: { a: 1 } } as never), "GET", /unexpected option\(s\) json/],
    ["json: null on a POST (http.ts would send the body null)", (http) => http.post(url, { json: null }), "POST", /json is null/],
    ["an unknown option", (http) => http.post(url, { data: "x" } as never), "POST", /unexpected option\(s\) data/],
  ];
  for (const [what, makeCall, method, pattern] of rejected) {
    await t.test(what, async () => {
      const report = newReport();
      await assert.rejects(makeCall(createScriptedHttp(script(method), report)), { name: "ScriptViolation" });
      assert.equal(report.violations.length, 1);
      assert.match(report.violations[0] as string, pattern);
    });
  }
});

test("harness self-test: the scripted Gemini fails on an unscripted or unused call; a scripted error is the real @google/genai error", async (t) => {
  await t.test("a scripted error is the SDK's own HTTP error class for the status", async () => {
    for (const [status, name] of [[401, "AuthenticationError"], [429, "RateLimitError"], [503, "InternalServerError"]] as const) {
      const error = await sdkStatusError(status) as Error & Record<string, unknown>;
      assert.equal(error.name, name);
      assert.equal(error["status"], status);
      assert.equal(error["statusCode"], status);
      // Python's attribute is added by src/gemini.ts's adapter, not by the SDK.
      assert.equal(error["status_code"], undefined);
    }
  });

  const base = scenarioNamed("gemini_new_thread");
  const golden = loadGolden(base.name);

  await t.test("a Gemini call beyond the script", async () => {
    const scenario = mutated(base, (copy) => {
      copy.gemini.pop();
    });
    const observed = await replayScenario(scenario);
    assert.deepEqual(observed.violations, ["Gemini call 1 is not in the script"]);
    assert.throws(() => compareWithGolden(scenario, golden, observed), assert.AssertionError);
  });

  await t.test("an unused Gemini entry", async () => {
    const scenario = mutated(base, (copy) => {
      copy.gemini.push({ output_text: "unused" });
    });
    const observed = await replayScenario(scenario);
    assert.deepEqual(observed.violations, []);
    assert.equal(observed.unusedGemini, 1);
    assert.throws(() => compareWithGolden(scenario, golden, observed), assert.AssertionError);
  });

  await t.test("a different prompt", async () => {
    const observed = await replayScenario(base);
    compareWithGolden(base, golden, observed);
    const edited = mutated(golden, (copy) => {
      const call = copy.gemini_calls[0] as { input: string };
      call.input = call.input.replace("SLACK THREAD HISTORY", "SLACK THREAD  HISTORY");
    });
    assert.throws(() => compareWithGolden(base, edited, observed), assert.AssertionError);
  });
});
