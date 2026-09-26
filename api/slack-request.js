import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_REQUEST_AGE_SECONDS = 5 * 60;

// Matches PEOPLE_SUGGEST_ACTION_ID in people_due.py.
const PEOPLE_SUGGEST_ACTION_ID = "people_suggest";

// Matches ADD_INTERACTION_ACTION_ID / ADD_INTERACTION_CALLBACK_ID in
// people_interaction.py.
const ADD_INTERACTION_ACTION_ID = "people_add_interaction";
const ADD_INTERACTION_CALLBACK_ID = "add_interaction_modal";

// Matches ADD_FOLLOWUP_TASK_ACTION_ID / ADD_FOLLOWUP_TASK_CALLBACK_ID in
// followup_task.py.
const ADD_FOLLOWUP_TASK_ACTION_ID = "add_followup_task";
const ADD_FOLLOWUP_TASK_CALLBACK_ID = "add_followup_task_modal";

// Matches ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID in followup_task.py. Opens
// the same Task modal, prefilled with the suggestion Python validated.
const ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID = "add_suggested_followup_task";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function copenhagenToday(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now()));
}

function parseTrackOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const tracks = [];
  for (const entry of value) {
    if (
      typeof entry?.id === "string" &&
      entry.id &&
      typeof entry?.name === "string" &&
      entry.name
    ) {
      tracks.push({ id: entry.id, name: entry.name });
    }
  }
  return tracks;
}

function parseStringOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string" && entry);
}

function trackSelectBlock(tracks, defaultTrackId) {
  const options = tracks.map((track) => ({
    text: { type: "plain_text", text: track.name },
    value: track.id,
  }));
  const trackElement = {
    type: "static_select",
    action_id: "track_select",
    options,
  };
  const defaultOption = options.find((option) => option.value === defaultTrackId);
  if (defaultOption) {
    trackElement.initial_option = defaultOption;
  }
  return {
    type: "input",
    block_id: "track_block",
    optional: true,
    label: { type: "plain_text", text: "Track" },
    element: trackElement,
  };
}

function parseAddInteractionButtonValue(value) {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed?.page_id === "string" &&
      parsed.page_id &&
      typeof parsed?.name === "string" &&
      parsed.name
    ) {
      return {
        pageId: parsed.page_id,
        name: parsed.name,
        // All of these are already resolved from Notion by
        // people_suggest.py and carried forward opaquely, exactly like
        // page_id/name above - this handler never queries Notion itself.
        tracks: parseTrackOptions(parsed.tracks),
        defaultTrackId:
          typeof parsed?.default_track_id === "string" && parsed.default_track_id
            ? parsed.default_track_id
            : null,
        types: parseStringOptions(parsed.types),
      };
    }
  } catch {
    // Malformed button value; treated as absent below.
  }
  return null;
}

function parseAddFollowupTaskButtonValue(value) {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed?.page_id === "string" &&
      parsed.page_id &&
      typeof parsed?.name === "string" &&
      parsed.name
    ) {
      return {
        pageId: parsed.page_id,
        name: parsed.name,
        // Already resolved from Notion by followup_task.py and carried
        // forward opaquely - this handler never queries Notion itself.
        tracks: parseTrackOptions(parsed.tracks),
        defaultTrackId:
          typeof parsed?.default_track_id === "string" && parsed.default_track_id
            ? parsed.default_track_id
            : null,
        priorities: parseStringOptions(parsed.priorities),
        // A suggested Task already validated by followup_task.py; only
        // ever used as editable initial values in the modal.
        prefill: {
          name: parseOptionalString(parsed.task_name),
          description: parseOptionalString(parsed.task_description),
          followUp: ISO_DATE_PATTERN.test(parseOptionalString(parsed.task_follow_up))
            ? parsed.task_follow_up
            : "",
        },
      };
    }
  } catch {
    // Malformed button value; treated as absent below.
  }
  return null;
}

function parseOptionalString(value) {
  return typeof value === "string" ? value : "";
}

function parseAddInteractionPrivateMetadata(value) {
  try {
    const parsed = JSON.parse(value ?? "");
    if (
      typeof parsed?.channel_id === "string" &&
      parsed.channel_id &&
      typeof parsed?.user_id === "string" &&
      parsed.user_id &&
      typeof parsed?.person_page_id === "string" &&
      parsed.person_page_id &&
      typeof parsed?.person_name === "string" &&
      parsed.person_name
    ) {
      // thread_ts is a best-effort convenience (keeps the reply in the same
      // Slack thread as the suggestion message), not essential identity, so
      // its absence does not invalidate the rest of the metadata.
      return {
        ...parsed,
        thread_ts: typeof parsed.thread_ts === "string" ? parsed.thread_ts : "",
      };
    }
  } catch {
    // Malformed private_metadata; treated as absent below.
  }
  return null;
}

function buildAddInteractionView(
  personPageId,
  personName,
  channelId,
  userId,
  threadTs,
  today,
  interactionTypes,
  tracks = [],
  defaultTrackId = null
) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Person:* ${personName}` },
    },
    {
      type: "input",
      block_id: "type_block",
      label: { type: "plain_text", text: "Type" },
      element: {
        type: "static_select",
        action_id: "type_select",
        // Resolved from the live Notion Type schema by people_suggest.py
        // and carried forward via the button's value - see
        // parseStringOptions above. This dropdown is only a
        // usability guardrail; people_interaction.py independently
        // re-validates the submitted value against Notion before any
        // write.
        options: interactionTypes.map((option) => ({
          text: { type: "plain_text", text: option },
          value: option,
        })),
      },
    },
  ];

  // Slack rejects a static_select with an empty options array, so the
  // Track field is only offered at all when there is at least one Track
  // to choose from; otherwise Track is simply unavailable for this
  // Interaction, matching "leave Track unselected".
  if (tracks.length > 0) {
    blocks.push(trackSelectBlock(tracks, defaultTrackId));
  }

  blocks.push(
    {
      type: "input",
      block_id: "notes_block",
      optional: true,
      label: { type: "plain_text", text: "Notes" },
      element: {
        type: "plain_text_input",
        action_id: "notes_input",
        multiline: true,
      },
    },
    {
      type: "input",
      block_id: "date_block",
      label: { type: "plain_text", text: "Date" },
      element: {
        type: "datepicker",
        action_id: "date_select",
        initial_date: today,
      },
    }
  );

  return {
    type: "modal",
    callback_id: ADD_INTERACTION_CALLBACK_ID,
    private_metadata: JSON.stringify({
      person_page_id: personPageId,
      person_name: personName,
      channel_id: channelId,
      user_id: userId,
      thread_ts: threadTs,
    }),
    title: { type: "plain_text", text: "Add interaction" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function buildAddFollowupTaskView(
  personPageId,
  personName,
  channelId,
  userId,
  threadTs,
  priorities = [],
  tracks = [],
  defaultTrackId = null,
  prefill = {}
) {
  const nameElement = {
    type: "plain_text_input",
    action_id: "name_input",
    max_length: 2000,
  };
  const descriptionElement = {
    type: "plain_text_input",
    action_id: "description_input",
    multiline: true,
    max_length: 2000,
  };
  const followUpElement = { type: "datepicker", action_id: "follow_up_select" };
  // Initial values are only suggestions the user can edit; the submission
  // goes through the same Python validation as an empty modal's.
  if (prefill.name) {
    nameElement.initial_value = prefill.name;
  }
  if (prefill.description) {
    descriptionElement.initial_value = prefill.description;
  }
  if (prefill.followUp) {
    followUpElement.initial_date = prefill.followUp;
  }

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Person:* ${personName}` },
    },
    {
      type: "input",
      block_id: "name_block",
      label: { type: "plain_text", text: "Name" },
      // Notion rejects a title text longer than 2000 characters.
      element: nameElement,
    },
    {
      type: "input",
      block_id: "description_block",
      optional: true,
      label: { type: "plain_text", text: "Description" },
      // Notion rejects a rich_text content longer than 2000 characters.
      element: descriptionElement,
    },
    {
      type: "input",
      block_id: "follow_up_block",
      optional: true,
      label: { type: "plain_text", text: "Follow-up" },
      element: followUpElement,
    },
  ];

  // Slack rejects a static_select with an empty options array, so optional
  // selectors are only offered when there is something to choose from.
  // followup_task.py re-validates both against Notion before any write.
  if (priorities.length > 0) {
    blocks.push({
      type: "input",
      block_id: "priority_block",
      optional: true,
      label: { type: "plain_text", text: "Priority" },
      element: {
        type: "static_select",
        action_id: "priority_select",
        options: priorities.map((option) => ({
          text: { type: "plain_text", text: option },
          value: option,
        })),
      },
    });
  }
  if (tracks.length > 0) {
    blocks.push(trackSelectBlock(tracks, defaultTrackId));
  }

  return {
    type: "modal",
    callback_id: ADD_FOLLOWUP_TASK_CALLBACK_ID,
    private_metadata: JSON.stringify({
      person_page_id: personPageId,
      person_name: personName,
      channel_id: channelId,
      user_id: userId,
      thread_ts: threadTs,
    }),
    title: { type: "plain_text", text: "Add follow-up task" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function commandChannelType(channelId) {
  // Slack slash-command and interaction payloads do not include the Events
  // API's channel_type field. Slack DM conversation IDs begin with D.
  return channelId.startsWith("D") ? "im" : "channel";
}

export function hasValidSlackSignature(
  rawBody,
  headers,
  signingSecret,
  now = Date.now
) {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  const timestampSeconds = Number(timestamp);

  if (
    !signingSecret ||
    !timestamp ||
    !signature ||
    !Number.isInteger(timestampSeconds) ||
    Math.abs(Math.floor(now() / 1000) - timestampSeconds) >
      MAX_REQUEST_AGE_SECONDS
  ) {
    return false;
  }

  const expectedSignature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest("hex")}`;
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(signature);

  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function handleSlackRequest(
  request,
  { signingSecret, triggerGitHub, defer, openModal, now = Date.now }
) {
  try {
    const rawBody = Buffer.from(await request.arrayBuffer());

    if (!signingSecret) {
      console.error("SLACK_SIGNING_SECRET is not configured");
      return new Response("Internal server error", { status: 500 });
    }

    if (!hasValidSlackSignature(rawBody, request.headers, signingSecret, now)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    const bodyText = rawBody.toString("utf8");

    // -------------------------------------------------------
    // Slack Events API
    // -------------------------------------------------------
    if (contentType.includes("application/json")) {
      const body = JSON.parse(bodyText);

      // Slack bruger dette til at verificere Event Subscription URL
      if (body.type === "url_verification") {
        return Response.json({
          challenge: body.challenge,
        });
      }

      // Almindeligt event fra Slack
      if (body.type === "event_callback") {
        const event = body.event;

        // Ignorér beskeder fra botten selv.
        // Ellers kan vi ende i et loop:
        // bot -> Slack event -> GitHub -> bot -> Slack event -> ...
        if (event?.bot_id || event?.subtype === "bot_message") {
          return new Response("", {
            status: 200,
          });
        }

        // Vi er kun interesserede i message-events
        if (event?.type === "message") {
          const channelType = event.channel_type ?? "";
          const isDirectMessage = channelType === "im";

          // Root messages in ordinary channels are still ignored. A root DM
          // is forwarded so Python can authorize it and start a conversation
          // rooted at event.ts.
          if (!event.thread_ts && !isDirectMessage) {
            return new Response("", {
              status: 200,
            });
          }

          defer(
            triggerGitHub({
              text: event.text ?? "",
              channel_id: event.channel ?? "",
              user_id: event.user ?? "",
              event_ts: event.ts ?? "",

              // thread_ts peger på root-beskeden
              thread_ts: event.thread_ts ?? "",
              channel_type: channelType,

              slack_event_type: "message",
            })
          );
        }

        return new Response("", {
          status: 200,
        });
      }

      return new Response("", {
        status: 200,
      });
    }

    const formData = new URLSearchParams(bodyText);

    // -------------------------------------------------------
    // Slack interactivity (Block Kit button click)
    // -------------------------------------------------------
    //
    // Interactive component clicks are posted with the same content-type as
    // slash commands, as a single "payload" field containing JSON, instead
    // of the flat command/text fields. Handle that shape first so it never
    // falls through into the slash-command branch below with an empty
    // command/text.
    const interactionPayload = formData.get("payload");
    if (interactionPayload !== null) {
      const body = JSON.parse(interactionPayload);

      if (body?.type === "block_actions") {
        const action = body?.actions?.[0];
        const personName =
          action?.action_id === PEOPLE_SUGGEST_ACTION_ID ? action.value : "";

        if (personName) {
          const channelId = body.channel?.id ?? "";
          defer(
            triggerGitHub({
              command: "/people",
              text: `suggest ${personName}`,
              response_url: body.response_url ?? "",
              channel_id: channelId,
              user_id: body.user?.id ?? "",
              channel_type: commandChannelType(channelId),
              thread_ts: "",
              slack_event_type: "block_actions",
            })
          );
        } else if (
          action?.action_id === ADD_INTERACTION_ACTION_ID &&
          body.trigger_id &&
          // opening the modal is a real network call awaited below, unlike
          // every other branch here, so it can push the ack past Slack's
          // window and trigger a retried delivery of this same click. Without
          // this guard that retry would open a second modal.
          !request.headers.get("x-slack-retry-num")
        ) {
          const person = parseAddInteractionButtonValue(action.value ?? "");
          // Slack rejects a static_select with an empty options array, so a
          // button value with no Type options (which people_suggest.py
          // never produces - see build_suggestion_blocks) must not reach
          // openModal at all, rather than open a modal with a broken Type
          // field.
          if (person && person.types.length > 0 && openModal) {
            const channelId = body.channel?.id ?? "";
            const threadTs = body.message?.thread_ts || body.message?.ts || "";
            await openModal(
              body.trigger_id,
              buildAddInteractionView(
                person.pageId,
                person.name,
                channelId,
                body.user?.id ?? "",
                threadTs,
                copenhagenToday(now),
                person.types,
                person.tracks,
                person.defaultTrackId
              )
            );
          }
        } else if (
          (action?.action_id === ADD_FOLLOWUP_TASK_ACTION_ID ||
            action?.action_id === ADD_SUGGESTED_FOLLOWUP_TASK_ACTION_ID) &&
          body.trigger_id &&
          // Same retried-click guard as Add Interaction above.
          !request.headers.get("x-slack-retry-num")
        ) {
          const person = parseAddFollowupTaskButtonValue(action.value ?? "");
          if (person && openModal) {
            const channelId = body.channel?.id ?? "";
            const threadTs = body.message?.thread_ts || body.message?.ts || "";
            await openModal(
              body.trigger_id,
              buildAddFollowupTaskView(
                person.pageId,
                person.name,
                channelId,
                body.user?.id ?? "",
                threadTs,
                person.priorities,
                person.tracks,
                person.defaultTrackId,
                person.prefill
              )
            );
          }
        }

        return new Response("", { status: 200 });
      }

      // -----------------------------------------------------
      // Add follow-up Task modal submission
      // -----------------------------------------------------
      if (
        body?.type === "view_submission" &&
        body?.view?.callback_id === ADD_FOLLOWUP_TASK_CALLBACK_ID
      ) {
        // A Slack retry of an already-handled submission must not trigger a
        // second Task write.
        if (request.headers.get("x-slack-retry-num")) {
          return new Response("", { status: 200 });
        }

        const metadata = parseAddInteractionPrivateMetadata(
          body.view?.private_metadata
        );

        if (metadata) {
          const values = body.view?.state?.values ?? {};
          // Task fields are bundled into one JSON field, like the Person
          // identity, to stay within GitHub's 10-property client_payload
          // limit. callback_id tells main.py which modal this came from.
          defer(
            triggerGitHub({
              channel_id: metadata.channel_id,
              user_id: metadata.user_id,
              channel_type: commandChannelType(metadata.channel_id),
              thread_ts: metadata.thread_ts,
              slack_event_type: "view_submission",
              callback_id: ADD_FOLLOWUP_TASK_CALLBACK_ID,
              person: JSON.stringify({
                page_id: metadata.person_page_id,
                name: metadata.person_name,
              }),
              task: JSON.stringify({
                name: values.name_block?.name_input?.value ?? "",
                description:
                  values.description_block?.description_input?.value ?? "",
                follow_up:
                  values.follow_up_block?.follow_up_select?.selected_date ?? "",
                priority:
                  values.priority_block?.priority_select?.selected_option?.value ??
                  "",
                track_id:
                  values.track_block?.track_select?.selected_option?.value ?? "",
              }),
            })
          );
        }

        return Response.json({});
      }

      // -----------------------------------------------------
      // Add Interaction modal submission
      // -----------------------------------------------------
      //
      // The trigger_id used to open this modal already expired by the time
      // the modal is submitted, so the actual Notion write happens later,
      // asynchronously, exactly like every other command dispatch.
      if (
        body?.type === "view_submission" &&
        body?.view?.callback_id === ADD_INTERACTION_CALLBACK_ID
      ) {
        // A Slack retry of an already-handled submission must not trigger a
        // second Interaction write.
        if (request.headers.get("x-slack-retry-num")) {
          return new Response("", { status: 200 });
        }

        const metadata = parseAddInteractionPrivateMetadata(
          body.view?.private_metadata
        );

        if (metadata) {
          const values = body.view?.state?.values ?? {};
          const interactionType =
            values.type_block?.type_select?.selected_option?.value ?? "";
          const notes = values.notes_block?.notes_input?.value ?? "";
          const interactionDate =
            values.date_block?.date_select?.selected_date ?? "";
          const trackId =
            values.track_block?.track_select?.selected_option?.value ?? "";

          // GitHub's repository_dispatch client_payload allows at most 10
          // top-level properties. This dispatch already omits the
          // command/text/response_url fields view_submission never uses,
          // and bundles the Person identity into one JSON field (mirroring
          // the button's own value) to make room for track_id without
          // exceeding that limit.
          defer(
            triggerGitHub({
              channel_id: metadata.channel_id,
              user_id: metadata.user_id,
              channel_type: commandChannelType(metadata.channel_id),
              thread_ts: metadata.thread_ts,
              slack_event_type: "view_submission",
              person: JSON.stringify({
                page_id: metadata.person_page_id,
                name: metadata.person_name,
              }),
              interaction_type: interactionType,
              notes,
              track_id: trackId,
              date: interactionDate,
            })
          );
        }

        return Response.json({});
      }

      return new Response("", { status: 200 });
    }

    // -------------------------------------------------------
    // Slack slash command
    // -------------------------------------------------------

    const command = formData.get("command") ?? "";
    const text = formData.get("text") ?? "";
    const responseUrl = formData.get("response_url") ?? "";
    const channelId = formData.get("channel_id") ?? "";
    const userId = formData.get("user_id") ?? "";

    defer(
      triggerGitHub({
        command,
        text,
        response_url: responseUrl,
        channel_id: channelId,
        user_id: userId,
        channel_type: commandChannelType(channelId),

        // Slash command starter en NY samtale.
        // Derfor er der endnu ikke noget thread_ts.
        thread_ts: "",

        slack_event_type: "slash_command",
      })
    );

    // Acknowledge within Slack's three-second deadline. Command-specific
    // responses are sent later from Python through the signed response_url.
    return new Response("", { status: 200 });
  } catch (error) {
    console.error("Slack webhook failed:", error);

    return new Response(
      `Internal error: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        status: 500,
      }
    );
  }
}
