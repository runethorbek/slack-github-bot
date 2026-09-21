import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handleSlackRequest } from "../api/slack-request.js";

const NOW_SECONDS = 1_700_000_000;
const SIGNING_SECRET = "test-signing-secret";

function sign(body, timestamp = NOW_SECONDS) {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

function slackRequest(
  body,
  {
    contentType = "application/x-www-form-urlencoded",
    timestamp = NOW_SECONDS,
    signature = sign(body, timestamp),
  } = {}
) {
  const headers = new Headers({
    "content-type": contentType,
  });

  if (timestamp !== null) {
    headers.set("x-slack-request-timestamp", String(timestamp));
  }

  if (signature !== null) {
    headers.set("x-slack-signature", signature);
  }

  return new Request("https://example.test/api/slack", {
    method: "POST",
    headers,
    body,
  });
}

function testDependencies() {
  const dispatched = [];
  const deferred = [];

  return {
    dispatched,
    deferred,
    options: {
      signingSecret: SIGNING_SECRET,
      now: () => NOW_SECONDS * 1000,
      triggerGitHub: async (payload) => {
        dispatched.push(payload);
      },
      defer: (promise) => {
        deferred.push(promise);
      },
    },
  };
}

test("a valid signed /tasks list request preserves the existing dispatch", async () => {
  const body = new URLSearchParams({
    command: "/tasks",
    text: "list",
    response_url: "https://hooks.slack.test/response",
    channel_id: "C123",
    user_id: "U123",
  }).toString();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, [
    {
      command: "/tasks",
      text: "list",
      response_url: "https://hooks.slack.test/response",
      channel_id: "C123",
      user_id: "U123",
      channel_type: "channel",
      thread_ts: "",
      slack_event_type: "slash_command",
    },
  ]);
});

test("a valid signed /people due request preserves the command dispatch", async () => {
  const body = new URLSearchParams({
    command: "/people",
    text: "due",
    response_url: "https://hooks.slack.test/response",
    channel_id: "C123",
    user_id: "U123",
  }).toString();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.equal(dependencies.dispatched[0].command, "/people");
  assert.equal(dependencies.dispatched[0].text, "due");
  assert.equal(dependencies.dispatched[0].channel_type, "channel");
});

test("a valid people_suggest button click dispatches the same command a typed /people suggest would", async () => {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      actions: [{ action_id: "people_suggest", value: "Jane Doe" }],
      response_url: "https://hooks.slack.test/interaction",
      channel: { id: "C123" },
      user: { id: "U123" },
    }),
  }).toString();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(dependencies.dispatched, [
    {
      command: "/people",
      text: "suggest Jane Doe",
      response_url: "https://hooks.slack.test/interaction",
      channel_id: "C123",
      user_id: "U123",
      channel_type: "channel",
      thread_ts: "",
      slack_event_type: "block_actions",
    },
  ]);
});

test("slash commands and block actions preserve DM identity", async (t) => {
  const cases = [
    {
      name: "slash command",
      body: new URLSearchParams({
        command: "/tasks",
        text: "list",
        response_url: "https://hooks.slack.test/response",
        channel_id: "D123",
        user_id: "U123",
      }).toString(),
    },
    {
      name: "block action",
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          actions: [{ action_id: "people_suggest", value: "Jane Doe" }],
          response_url: "https://hooks.slack.test/interaction",
          channel: { id: "D123" },
          user: { id: "U123" },
        }),
      }).toString(),
    },
  ];

  for (const { name, body } of cases) {
    await t.test(name, async () => {
      const dependencies = testDependencies();
      await handleSlackRequest(slackRequest(body), dependencies.options);
      await Promise.all(dependencies.deferred);

      assert.equal(dependencies.dispatched[0].channel_type, "im");
    });
  }
});

test("block_actions clicks with an unrecognized action or empty value are acknowledged without dispatch", async (t) => {
  const cases = [
    [
      "unrecognized action_id",
      { type: "block_actions", actions: [{ action_id: "some_other_button", value: "Jane Doe" }] },
    ],
    [
      "empty value",
      { type: "block_actions", actions: [{ action_id: "people_suggest", value: "" }] },
    ],
    ["no actions", { type: "block_actions", actions: [] }],
    ["a different interaction type", { type: "view_submission", actions: [] }],
  ];

  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      const dependencies = testDependencies();

      const response = await handleSlackRequest(
        slackRequest(body),
        dependencies.options
      );
      await Promise.all(dependencies.deferred);

      assert.equal(response.status, 200);
      assert.deepEqual(dependencies.dispatched, []);
      assert.deepEqual(dependencies.deferred, []);
    });
  }
});

test("a malformed interaction payload fails without dispatch", async () => {
  const body = new URLSearchParams({ payload: "{not-json" }).toString();
  const dependencies = testDependencies();

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await handleSlackRequest(
      slackRequest(body),
      dependencies.options
    );

    assert.equal(response.status, 500);
    assert.deepEqual(dependencies.dispatched, []);
    assert.deepEqual(dependencies.deferred, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("authenticated slash commands receive an empty acknowledgement", async (t) => {
  const commands = [
    ["/tasks", "list"],
    ["/people", "due"],
    ["/testbot", "hello"],
  ];

  for (const [command, text] of commands) {
    await t.test(command, async () => {
      const body = new URLSearchParams({
        command,
        text,
        response_url: "https://hooks.slack.test/response",
        channel_id: "C123",
        user_id: "U123",
      }).toString();
      const dependencies = testDependencies();

      const response = await handleSlackRequest(
        slackRequest(body),
        dependencies.options
      );
      await Promise.all(dependencies.deferred);

      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
    });
  }
});

test("signature verification uses the exact raw request body", async () => {
  const rawBody =
    "command=%2ftasks&text=list&text=list&response_url=https%3A%2F%2Fhooks.slack.test%2Fresponse&channel_id=C123&user_id=U123";
  const reconstructedBody = new URLSearchParams(rawBody).toString();
  const originalSignature = sign(rawBody);

  assert.equal(
    reconstructedBody,
    rawBody.replace("%2f", "%2F"),
    "the equivalent reconstructed body should differ by exactly one byte"
  );

  const validDependencies = testDependencies();
  const validResponse = await handleSlackRequest(
    slackRequest(rawBody, { signature: originalSignature }),
    validDependencies.options
  );
  await Promise.all(validDependencies.deferred);

  assert.equal(validResponse.status, 200);
  assert.equal(validDependencies.dispatched.length, 1);

  const invalidDependencies = testDependencies();
  const invalidResponse = await handleSlackRequest(
    slackRequest(reconstructedBody, { signature: originalSignature }),
    invalidDependencies.options
  );

  assert.equal(invalidResponse.status, 401);
  assert.deepEqual(invalidDependencies.dispatched, []);
  assert.deepEqual(invalidDependencies.deferred, []);
});

test("valid signed /testbot and thread events preserve their dispatches", async (t) => {
  await t.test("/testbot", async () => {
    const body = new URLSearchParams({
      command: "/testbot",
      text: "hello",
      response_url: "https://hooks.slack.test/response",
      channel_id: "C123",
      user_id: "U123",
    }).toString();
    const dependencies = testDependencies();

    const response = await handleSlackRequest(
      slackRequest(body),
      dependencies.options
    );
    await Promise.all(dependencies.deferred);

    assert.equal(response.status, 200);
    assert.deepEqual(dependencies.dispatched, [
      {
        command: "/testbot",
        text: "hello",
        response_url: "https://hooks.slack.test/response",
        channel_id: "C123",
        user_id: "U123",
        channel_type: "channel",
        thread_ts: "",
        slack_event_type: "slash_command",
      },
    ]);
  });

  await t.test("thread event", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        text: "follow up",
        channel: "C123",
        user: "U123",
        ts: "123.789",
        thread_ts: "123.456",
        channel_type: "channel",
      },
    });
    const dependencies = testDependencies();

    const response = await handleSlackRequest(
      slackRequest(body, { contentType: "application/json" }),
      dependencies.options
    );
    await Promise.all(dependencies.deferred);

    assert.equal(response.status, 200);
    assert.deepEqual(dependencies.dispatched, [
      {
        text: "follow up",
        channel_id: "C123",
        user_id: "U123",
        event_ts: "123.789",
        thread_ts: "123.456",
        channel_type: "channel",
        slack_event_type: "message",
      },
    ]);
  });
});

test("root and follow-up DMs preserve identity and conversation timestamps", async (t) => {
  const cases = [
    {
      name: "root DM",
      event: {
        type: "message",
        text: "private root",
        channel: "D123",
        user: "U123",
        ts: "100.001",
        channel_type: "im",
      },
      expectedThreadTs: "",
    },
    {
      name: "DM follow-up",
      event: {
        type: "message",
        text: "private follow-up",
        channel: "D123",
        user: "U123",
        ts: "100.002",
        thread_ts: "100.001",
        channel_type: "im",
      },
      expectedThreadTs: "100.001",
    },
    {
      name: "second root DM",
      event: {
        type: "message",
        text: "separate private root",
        channel: "D123",
        user: "U123",
        ts: "200.001",
        channel_type: "im",
      },
      expectedThreadTs: "",
    },
  ];

  for (const { name, event, expectedThreadTs } of cases) {
    await t.test(name, async () => {
      const body = JSON.stringify({ type: "event_callback", event });
      const dependencies = testDependencies();

      const response = await handleSlackRequest(
        slackRequest(body, { contentType: "application/json" }),
        dependencies.options
      );
      await Promise.all(dependencies.deferred);

      assert.equal(response.status, 200);
      assert.deepEqual(dependencies.dispatched, [
        {
          text: event.text,
          channel_id: "D123",
          user_id: "U123",
          event_ts: event.ts,
          thread_ts: expectedThreadTs,
          channel_type: "im",
          slack_event_type: "message",
        },
      ]);
    });
  }
});

test("valid URL verification is authenticated and does not dispatch", async () => {
  const body = JSON.stringify({
    type: "url_verification",
    challenge: "challenge-value",
  });
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body, { contentType: "application/json" }),
    dependencies.options
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: "challenge-value" });
  assert.deepEqual(dependencies.dispatched, []);
  assert.deepEqual(dependencies.deferred, []);
});

test("missing, invalid, and out-of-window signatures are rejected before dispatch", async (t) => {
  const cases = [
    ["missing signature", { signature: null }],
    ["missing timestamp", { timestamp: null }],
    ["invalid", { signature: `v0=${"0".repeat(64)}` }],
    [
      "replay-aged",
      {
        timestamp: NOW_SECONDS - 301,
        signature: sign("not-json", NOW_SECONDS - 301),
      },
    ],
    [
      "future timestamp",
      {
        timestamp: NOW_SECONDS + 301,
        signature: sign("not-json", NOW_SECONDS + 301),
      },
    ],
  ];

  for (const [name, requestOptions] of cases) {
    await t.test(name, async () => {
      const dependencies = testDependencies();
      const response = await handleSlackRequest(
        slackRequest("not-json", {
          contentType: "application/json",
          ...requestOptions,
        }),
        dependencies.options
      );

      assert.equal(response.status, 401);
      assert.deepEqual(dependencies.dispatched, []);
      assert.deepEqual(dependencies.deferred, []);
    });
  }
});

test("signatures exactly five minutes old or ahead are accepted", async (t) => {
  for (const offset of [-300, 300]) {
    await t.test(`${offset} seconds`, async () => {
      const body = new URLSearchParams({
        command: "/testbot",
        text: "hello",
      }).toString();
      const timestamp = NOW_SECONDS + offset;
      const dependencies = testDependencies();

      const response = await handleSlackRequest(
        slackRequest(body, {
          timestamp,
          signature: sign(body, timestamp),
        }),
        dependencies.options
      );
      await Promise.all(dependencies.deferred);

      assert.equal(response.status, 200);
      assert.equal(dependencies.dispatched.length, 1);
    });
  }
});

test("a missing signing secret fails closed without dispatch", async () => {
  const body = new URLSearchParams({
    command: "/testbot",
    text: "hello",
  }).toString();
  const dependencies = testDependencies();

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await handleSlackRequest(slackRequest(body), {
      ...dependencies.options,
      signingSecret: "",
    });

    assert.equal(response.status, 500);
    assert.deepEqual(dependencies.dispatched, []);
    assert.deepEqual(dependencies.deferred, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("malformed authenticated JSON fails without dispatch", async () => {
  const body = "{not-json";
  const dependencies = testDependencies();

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await handleSlackRequest(
      slackRequest(body, { contentType: "application/json" }),
      dependencies.options
    );

    assert.equal(response.status, 500);
    assert.deepEqual(dependencies.dispatched, []);
    assert.deepEqual(dependencies.deferred, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("bot messages and top-level messages are acknowledged without dispatch", async (t) => {
  const events = [
    [
      "bot message",
      {
        type: "message",
        text: "bot output",
        channel: "C123",
        bot_id: "B123",
        thread_ts: "123.456",
      },
    ],
    [
      "top-level message",
      {
        type: "message",
        text: "ordinary channel message",
        channel: "C123",
        user: "U123",
        ts: "123.456",
        channel_type: "channel",
      },
    ],
    [
      "channel type takes precedence over an ID prefix",
      {
        type: "message",
        text: "ordinary channel message",
        channel: "D-prefixed-channel",
        user: "U123",
        ts: "123.456",
        channel_type: "channel",
      },
    ],
  ];

  for (const [name, event] of events) {
    await t.test(name, async () => {
      const body = JSON.stringify({ type: "event_callback", event });
      const dependencies = testDependencies();

      const response = await handleSlackRequest(
        slackRequest(body, { contentType: "application/json" }),
        dependencies.options
      );

      assert.equal(response.status, 200);
      assert.deepEqual(dependencies.dispatched, []);
      assert.deepEqual(dependencies.deferred, []);
    });
  }
});
