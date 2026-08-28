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
      thread_ts: "",
      slack_event_type: "slash_command",
    },
  ]);
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
        thread_ts: "123.456",
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
        thread_ts: "123.456",
        slack_event_type: "message",
      },
    ]);
  });
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
