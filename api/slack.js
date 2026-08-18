import { waitUntil } from "@vercel/functions";

async function triggerGitHub(payload) {
  const githubResponse = await fetch(
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

  if (!githubResponse.ok) {
    console.error(
      "GitHub error:",
      githubResponse.status,
      await githubResponse.text()
    );
  }
}

export default {
  async fetch(request) {
    const contentType = request.headers.get("content-type") ?? "";

    // Slack Events API sender JSON
    if (contentType.includes("application/json")) {
      const body = await request.json();

      // Slack verificerer Request URL
      if (body.type === "url_verification") {
        return Response.json({
          challenge: body.challenge,
        });
      }

      // Almindeligt Slack-event
      if (body.type === "event_callback") {
        const event = body.event;

        // Ignorér bot-beskeder, ellers kan botten trigge sig selv
        if (event?.bot_id || event?.subtype === "bot_message") {
          return new Response("", { status: 200 });
        }

        if (event?.type === "message") {
          waitUntil(
            triggerGitHub({
              text: event.text ?? "",
              channel_id: event.channel ?? "",
              thread_ts: event.thread_ts ?? event.ts,
              slack_event_type: "message",
            })
          );
        }

        return new Response("", { status: 200 });
      }
    }

    // Slash command
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
        slack_event_type: "slash_command",
      })
    );

    return new Response("", {
      status: 200,
    });
  },
};
