import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_REQUEST_AGE_SECONDS = 5 * 60;

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
  { signingSecret, triggerGitHub, defer, now = Date.now }
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
          // Hvis beskeden IKKE er i en thread,
          // ignorerer vi den foreløbig.
          //
          // Nye opgaver starter via /testbot.
          if (!event.thread_ts) {
            return new Response("", {
              status: 200,
            });
          }

          defer(
            triggerGitHub({
              text: event.text ?? "",
              channel_id: event.channel ?? "",
              user_id: event.user ?? "",

              // thread_ts peger på root-beskeden
              thread_ts: event.thread_ts,

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

    // -------------------------------------------------------
    // Slack slash command
    // -------------------------------------------------------

    const formData = new URLSearchParams(bodyText);

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

        // Slash command starter en NY samtale.
        // Derfor er der endnu ikke noget thread_ts.
        thread_ts: "",

        slack_event_type: "slash_command",
      })
    );

    // Acknowledge every authenticated slash command at the transport layer.
    return Response.json({
      response_type: "ephemeral",
      text: "Request received…",
    });
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
