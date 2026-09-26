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
  const openedModals = [];

  return {
    dispatched,
    deferred,
    openedModals,
    options: {
      signingSecret: SIGNING_SECRET,
      now: () => NOW_SECONDS * 1000,
      triggerGitHub: async (payload) => {
        dispatched.push(payload);
      },
      defer: (promise) => {
        deferred.push(promise);
      },
      openModal: async (triggerId, view) => {
        openedModals.push({ triggerId, view });
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

function addInteractionButtonClickBody(overrides = {}) {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      trigger_id: "trigger-123",
      actions: [
        {
          action_id: "people_add_interaction",
          value: JSON.stringify({
            page_id: "person-page-id",
            name: "Jane Doe",
            types: ["Coffee", "Walk"],
          }),
        },
      ],
      channel: { id: "C123" },
      user: { id: "U123" },
      message: { ts: "111.111", thread_ts: "100.001" },
      ...overrides,
    }),
  }).toString();
}

test("clicking Add Interaction opens a modal carrying the Person page id and thread, without dispatching to GitHub", async () => {
  const body = addInteractionButtonClickBody();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, []);
  assert.equal(dependencies.openedModals.length, 1);
  const { triggerId, view } = dependencies.openedModals[0];
  assert.equal(triggerId, "trigger-123");
  assert.equal(view.callback_id, "add_interaction_modal");

  const metadata = JSON.parse(view.private_metadata);
  assert.deepEqual(metadata, {
    person_page_id: "person-page-id",
    person_name: "Jane Doe",
    channel_id: "C123",
    user_id: "U123",
    thread_ts: "100.001",
  });

  const typeBlock = view.blocks.find((block) => block.block_id === "type_block");
  assert.equal(typeBlock.element.type, "static_select");
  // Rendered from the button's own "types", resolved from the live Notion
  // schema by people_suggest.py - not a hardcoded list in this file.
  assert.deepEqual(typeBlock.element.options, [
    { text: { type: "plain_text", text: "Coffee" }, value: "Coffee" },
    { text: { type: "plain_text", text: "Walk" }, value: "Walk" },
  ]);

  // The button value carried no "tracks", so the Track field must not be
  // offered at all (Slack rejects a static_select with no options).
  assert.equal(
    view.blocks.find((block) => block.block_id === "track_block"),
    undefined
  );
});

test("a button value carrying Track options renders a Track selector with no default when none is given", async () => {
  const body = addInteractionButtonClickBody({
    actions: [
      {
        action_id: "people_add_interaction",
        value: JSON.stringify({
          page_id: "person-page-id",
          name: "Jane Doe",
          types: ["Coffee"],
          tracks: [
            { id: "track-1", name: "AI Network" },
            { id: "track-2", name: "Investors" },
          ],
        }),
      },
    ],
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);

  const { view } = dependencies.openedModals[0];
  const trackBlock = view.blocks.find((block) => block.block_id === "track_block");
  assert.ok(trackBlock);
  assert.equal(trackBlock.optional, true);
  assert.deepEqual(trackBlock.element.options, [
    { text: { type: "plain_text", text: "AI Network" }, value: "track-1" },
    { text: { type: "plain_text", text: "Investors" }, value: "track-2" },
  ]);
  assert.equal(trackBlock.element.initial_option, undefined);
});

test("a button value carrying a default_track_id preselects that Track option", async () => {
  const body = addInteractionButtonClickBody({
    actions: [
      {
        action_id: "people_add_interaction",
        value: JSON.stringify({
          page_id: "person-page-id",
          name: "Jane Doe",
          types: ["Coffee"],
          tracks: [
            { id: "track-1", name: "AI Network" },
            { id: "track-2", name: "Investors" },
          ],
          default_track_id: "track-2",
        }),
      },
    ],
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);

  const { view } = dependencies.openedModals[0];
  const trackBlock = view.blocks.find((block) => block.block_id === "track_block");
  assert.deepEqual(trackBlock.element.initial_option, {
    text: { type: "plain_text", text: "Investors" },
    value: "track-2",
  });
});

test("a default_track_id that is not among the offered tracks is not preselected", async () => {
  const body = addInteractionButtonClickBody({
    actions: [
      {
        action_id: "people_add_interaction",
        value: JSON.stringify({
          page_id: "person-page-id",
          name: "Jane Doe",
          types: ["Coffee"],
          tracks: [{ id: "track-1", name: "AI Network" }],
          default_track_id: "stale-track-id",
        }),
      },
    ],
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);

  const { view } = dependencies.openedModals[0];
  const trackBlock = view.blocks.find((block) => block.block_id === "track_block");
  assert.equal(trackBlock.element.initial_option, undefined);
});

test("a suggestion message that is itself a thread root falls back to its own ts", async () => {
  const body = addInteractionButtonClickBody({
    message: { ts: "111.111" },
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);

  const metadata = JSON.parse(dependencies.openedModals[0].view.private_metadata);
  assert.equal(metadata.thread_ts, "111.111");
});

test("an Add Interaction click without a trigger_id does not open a modal", async () => {
  const body = addInteractionButtonClickBody({ trigger_id: undefined });
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.openedModals, []);
});

test("an Add Interaction click carrying no Type options does not open a modal", async () => {
  // people_suggest.py never builds this button without Type options (see
  // build_suggestion_blocks), but a stale or tampered payload must still
  // fail closed rather than open a modal Slack would reject anyway (a
  // static_select cannot have zero options).
  const body = addInteractionButtonClickBody({
    actions: [
      {
        action_id: "people_add_interaction",
        value: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
      },
    ],
  });
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.openedModals, []);
});

test("a retried Add Interaction click does not open a second modal", async () => {
  const body = addInteractionButtonClickBody();
  const dependencies = testDependencies();
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(NOW_SECONDS),
    "x-slack-signature": sign(body),
    "x-slack-retry-num": "1",
  });
  const request = new Request("https://example.test/api/slack", {
    method: "POST",
    headers,
    body,
  });

  const response = await handleSlackRequest(request, dependencies.options);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.openedModals, []);
});

test("a malformed Add Interaction button value does not open a modal", async () => {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      trigger_id: "trigger-123",
      actions: [{ action_id: "people_add_interaction", value: "not-json" }],
      channel: { id: "C123" },
      user: { id: "U123" },
    }),
  }).toString();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.openedModals, []);
});

function addInteractionSubmissionBody() {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "view_submission",
      view: {
        callback_id: "add_interaction_modal",
        private_metadata: JSON.stringify({
          person_page_id: "person-page-id",
          person_name: "Jane Doe",
          channel_id: "C123",
          user_id: "U123",
          thread_ts: "100.001",
        }),
        state: {
          values: {
            type_block: {
              type_select: { selected_option: { value: "Coffee" } },
            },
            notes_block: { notes_input: { value: "Caught up over coffee." } },
            date_block: { date_select: { selected_date: "2026-09-22" } },
          },
        },
      },
    }),
  }).toString();
}

test("submitting the Add Interaction modal dispatches the structured write to GitHub, not the modal-open path", async () => {
  const body = addInteractionSubmissionBody();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.deepEqual(dependencies.dispatched, [
    {
      channel_id: "C123",
      user_id: "U123",
      channel_type: "channel",
      thread_ts: "100.001",
      slack_event_type: "view_submission",
      person: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
      interaction_type: "Coffee",
      notes: "Caught up over coffee.",
      track_id: "",
      date: "2026-09-22",
    },
  ]);
});

test("a selected Track is included in the dispatched write", async () => {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "view_submission",
      view: {
        callback_id: "add_interaction_modal",
        private_metadata: JSON.stringify({
          person_page_id: "person-page-id",
          person_name: "Jane Doe",
          channel_id: "C123",
          user_id: "U123",
          thread_ts: "100.001",
        }),
        state: {
          values: {
            type_block: {
              type_select: { selected_option: { value: "Coffee" } },
            },
            track_block: {
              track_select: { selected_option: { value: "track-2" } },
            },
            notes_block: { notes_input: { value: "" } },
            date_block: { date_select: { selected_date: "2026-09-22" } },
          },
        },
      },
    }),
  }).toString();
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);
  await Promise.all(dependencies.deferred);

  assert.equal(dependencies.dispatched[0].track_id, "track-2");
});

test("the Add Interaction dispatch stays within GitHub's 10-property client_payload limit", async () => {
  // repository_dispatch rejects a client_payload with more than 10
  // top-level properties (HTTP 422); a regression here fails silently in
  // production because the dispatch is fire-and-forget.
  const body = addInteractionSubmissionBody();
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);
  await Promise.all(dependencies.deferred);

  assert.ok(Object.keys(dependencies.dispatched[0]).length <= 10);
});

test("a DM's Add Interaction submission preserves channel_type identity", async () => {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "view_submission",
      view: {
        callback_id: "add_interaction_modal",
        private_metadata: JSON.stringify({
          person_page_id: "person-page-id",
          person_name: "Jane Doe",
          channel_id: "D123",
          user_id: "U123",
        }),
        state: {
          values: {
            type_block: {
              type_select: { selected_option: { value: "Coffee" } },
            },
            notes_block: { notes_input: { value: "" } },
            date_block: { date_select: { selected_date: "2026-09-22" } },
          },
        },
      },
    }),
  }).toString();
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);
  await Promise.all(dependencies.deferred);

  assert.equal(dependencies.dispatched[0].channel_type, "im");
  assert.equal(dependencies.dispatched[0].track_id, "");
});

test("a retried Add Interaction submission is acknowledged without a second dispatch", async () => {
  const body = addInteractionSubmissionBody();
  const dependencies = testDependencies();
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(NOW_SECONDS),
    "x-slack-signature": sign(body),
    "x-slack-retry-num": "1",
  });
  const request = new Request("https://example.test/api/slack", {
    method: "POST",
    headers,
    body,
  });

  const response = await handleSlackRequest(request, dependencies.options);
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, []);
});

test("a view_submission for a different modal is ignored without dispatch", async () => {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "view_submission",
      view: {
        callback_id: "some_other_modal",
        private_metadata: "{}",
        state: { values: {} },
      },
    }),
  }).toString();
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, []);
});

function addFollowupTaskButtonClickBody(value, overrides = {}) {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      trigger_id: "trigger-456",
      actions: [
        {
          action_id: "add_followup_task",
          value: JSON.stringify(value),
        },
      ],
      channel: { id: "C123" },
      user: { id: "U123" },
      message: { ts: "111.222", thread_ts: "100.001" },
      ...overrides,
    }),
  }).toString();
}

test("clicking Add follow-up task opens the Task modal with Person shown and Track prefilled", async () => {
  const body = addFollowupTaskButtonClickBody({
    page_id: "person-page-id",
    name: "Jane Doe",
    priorities: ["High", "Medium", "Low"],
    tracks: [
      { id: "track-1", name: "AI Network" },
      { id: "track-2", name: "Investors" },
    ],
    default_track_id: "track-2",
  });
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, []);
  assert.equal(dependencies.openedModals.length, 1);
  const { triggerId, view } = dependencies.openedModals[0];
  assert.equal(triggerId, "trigger-456");
  assert.equal(view.callback_id, "add_followup_task_modal");
  assert.deepEqual(JSON.parse(view.private_metadata), {
    person_page_id: "person-page-id",
    person_name: "Jane Doe",
    channel_id: "C123",
    user_id: "U123",
    thread_ts: "100.001",
  });

  assert.equal(view.blocks[0].text.text, "*Person:* Jane Doe");
  const block = (id) => view.blocks.find((candidate) => candidate.block_id === id);
  assert.equal(block("name_block").optional, undefined);
  assert.equal(block("name_block").element.type, "plain_text_input");
  assert.equal(block("name_block").element.max_length, 2000);
  assert.equal(block("description_block").optional, true);
  assert.deepEqual(block("description_block").element, {
    type: "plain_text_input",
    action_id: "description_input",
    multiline: true,
    max_length: 2000,
  });
  assert.equal(view.blocks.indexOf(block("description_block")), 2);
  assert.equal(block("follow_up_block").optional, true);
  assert.equal(block("follow_up_block").element.type, "datepicker");
  assert.equal(block("follow_up_block").element.initial_date, undefined);
  assert.equal(block("priority_block").optional, true);
  assert.deepEqual(
    block("priority_block").element.options.map((option) => option.value),
    ["High", "Medium", "Low"]
  );
  assert.equal(block("priority_block").element.initial_option, undefined);
  assert.equal(block("track_block").optional, true);
  assert.deepEqual(block("track_block").element.initial_option, {
    text: { type: "plain_text", text: "Investors" },
    value: "track-2",
  });
});

test("clicking a suggested Task opens the same modal with Name, Description and Follow-up prefilled", async () => {
  const value = {
    page_id: "person-page-id",
    name: "Jane Doe",
    priorities: ["High", "Low"],
    tracks: [{ id: "track-1", name: "AI Network" }],
    default_track_id: "track-1",
    task_name: "Send the AI article",
    task_description: "The one about agents.",
    task_follow_up: "2026-10-02",
  };
  const body = addFollowupTaskButtonClickBody(value, {
    actions: [
      { action_id: "add_suggested_followup_task", value: JSON.stringify(value) },
    ],
  });
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, []);
  assert.equal(dependencies.openedModals.length, 1);
  const { view } = dependencies.openedModals[0];
  assert.equal(view.callback_id, "add_followup_task_modal");
  const block = (id) => view.blocks.find((candidate) => candidate.block_id === id);
  assert.equal(block("name_block").element.initial_value, "Send the AI article");
  assert.equal(block("name_block").element.action_id, "name_input");
  assert.equal(
    block("description_block").element.initial_value,
    "The one about agents."
  );
  assert.equal(block("follow_up_block").element.initial_date, "2026-10-02");
  assert.equal(block("priority_block").element.initial_option, undefined);
  assert.equal(block("track_block").element.initial_option.value, "track-1");
});

test("a suggested Task with only a name, or a malformed date, prefills only what is valid", async () => {
  const value = {
    page_id: "person-page-id",
    name: "Jane Doe",
    task_name: "Call back",
    task_description: 42,
    task_follow_up: "next Friday",
  };
  const body = addFollowupTaskButtonClickBody(value, {
    actions: [
      { action_id: "add_suggested_followup_task", value: JSON.stringify(value) },
    ],
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);

  const { view } = dependencies.openedModals[0];
  const block = (id) => view.blocks.find((candidate) => candidate.block_id === id);
  assert.equal(block("name_block").element.initial_value, "Call back");
  assert.equal(block("description_block").element.initial_value, undefined);
  assert.equal(block("follow_up_block").element.initial_date, undefined);
});

test("a Task button without Priority or Track options omits those selectors", async () => {
  const body = addFollowupTaskButtonClickBody({
    page_id: "person-page-id",
    name: "Jane Doe",
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);

  const { view } = dependencies.openedModals[0];
  assert.deepEqual(
    view.blocks.map((block) => block.block_id).filter(Boolean),
    ["name_block", "description_block", "follow_up_block"]
  );
});

test("a malformed, retried, or trigger-less Task click does not open a modal", async (t) => {
  const cases = [
    ["malformed value", addFollowupTaskButtonClickBody({ name: "Jane Doe" }), {}],
    [
      "missing trigger_id",
      addFollowupTaskButtonClickBody(
        { page_id: "person-page-id", name: "Jane Doe" },
        { trigger_id: "" }
      ),
      {},
    ],
    [
      "retried click",
      addFollowupTaskButtonClickBody({ page_id: "person-page-id", name: "Jane Doe" }),
      { "x-slack-retry-num": "1" },
    ],
  ];
  for (const [name, body, extraHeaders] of cases) {
    await t.test(name, async () => {
      const dependencies = testDependencies();
      const request = slackRequest(body);
      for (const [header, value] of Object.entries(extraHeaders)) {
        request.headers.set(header, value);
      }

      const response = await handleSlackRequest(request, dependencies.options);

      assert.equal(response.status, 200);
      assert.deepEqual(dependencies.openedModals, []);
      assert.deepEqual(dependencies.dispatched, []);
    });
  }
});

function addFollowupTaskSubmissionBody(values) {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "view_submission",
      view: {
        callback_id: "add_followup_task_modal",
        private_metadata: JSON.stringify({
          person_page_id: "person-page-id",
          person_name: "Jane Doe",
          channel_id: "C123",
          user_id: "U123",
          thread_ts: "100.001",
        }),
        state: { values },
      },
    }),
  }).toString();
}

test("submitting the Task modal dispatches the bundled Task fields to GitHub", async () => {
  const body = addFollowupTaskSubmissionBody({
    name_block: { name_input: { value: "Send the article" } },
    description_block: {
      description_input: { value: "Include the Q3 figures.\nThanks" },
    },
    follow_up_block: { follow_up_select: { selected_date: "2026-10-01" } },
    priority_block: { priority_select: { selected_option: { value: "High" } } },
    track_block: { track_select: { selected_option: { value: "track-2" } } },
  });
  const dependencies = testDependencies();

  const response = await handleSlackRequest(
    slackRequest(body),
    dependencies.options
  );
  await Promise.all(dependencies.deferred);

  assert.deepEqual(await response.json(), {});
  assert.deepEqual(dependencies.openedModals, []);
  assert.deepEqual(dependencies.dispatched, [
    {
      channel_id: "C123",
      user_id: "U123",
      channel_type: "channel",
      thread_ts: "100.001",
      slack_event_type: "view_submission",
      callback_id: "add_followup_task_modal",
      person: JSON.stringify({ page_id: "person-page-id", name: "Jane Doe" }),
      task: JSON.stringify({
        name: "Send the article",
        description: "Include the Q3 figures.\nThanks",
        follow_up: "2026-10-01",
        priority: "High",
        track_id: "track-2",
      }),
    },
  ]);
  assert.ok(Object.keys(dependencies.dispatched[0]).length <= 10);
});

test("empty optional Task fields are dispatched as empty strings", async () => {
  const body = addFollowupTaskSubmissionBody({
    name_block: { name_input: { value: "Send the article" } },
    follow_up_block: { follow_up_select: { selected_date: null } },
    priority_block: { priority_select: { selected_option: null } },
  });
  const dependencies = testDependencies();

  await handleSlackRequest(slackRequest(body), dependencies.options);
  await Promise.all(dependencies.deferred);

  assert.deepEqual(JSON.parse(dependencies.dispatched[0].task), {
    name: "Send the article",
    description: "",
    follow_up: "",
    priority: "",
    track_id: "",
  });
});

test("a retried Task submission is acknowledged without a second dispatch", async () => {
  const body = addFollowupTaskSubmissionBody({
    name_block: { name_input: { value: "Send the article" } },
  });
  const dependencies = testDependencies();
  const request = slackRequest(body);
  request.headers.set("x-slack-retry-num", "1");

  const response = await handleSlackRequest(request, dependencies.options);
  await Promise.all(dependencies.deferred);

  assert.equal(response.status, 200);
  assert.deepEqual(dependencies.dispatched, []);
});
