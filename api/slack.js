import { waitUntil } from "@vercel/functions";

async function triggerGitHub(payload) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          event_type: "slack_message",
          client_payload: payload,
        }),
      }
    );

    if (!response.ok) {
      console.error(
        "GitHub error:",
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error("Failed to trigger GitHub:", error);
  }
}

export default {
  async fetch(request) {
    try {
      const contentType = request.headers.get("content-type") ?? "";

      // -------------------------------------------------------
      // Slack Events API
      // -------------------------------------------------------
      if (contentType.includes("application/json")) {
        const body = await request.json();

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
          if (
            event?.bot_id ||
            event?.subtype === "bot_message"
          ) {
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

            waitUntil(
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

      const formData = await request.formData();

      const text = formData.get("text") ?? "";
      const responseUrl = formData.get("response_url") ?? "";
      const channelId = formData.get("channel_id") ?? "";
      const userId = formData.get("user_id") ?? "";

      waitUntil(
        triggerGitHub({
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

      // Slack skal have svar meget hurtigt.
      return new Response("", {
        status: 200,
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
  },
};
