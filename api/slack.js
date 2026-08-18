import { waitUntil } from "@vercel/functions";

async function triggerGitHub(formData) {
  const text = formData.get("text") ?? "";
  const responseUrl = formData.get("response_url") ?? "";
  const channelId = formData.get("channel_id") ?? "";
  const userId = formData.get("user_id") ?? "";

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
        client_payload: {
          text,
          response_url: responseUrl,
          channel_id: channelId,
          user_id: userId,
        },
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
    const formData = await request.formData();

    // Start GitHub-kaldet i baggrunden
    waitUntil(triggerGitHub(formData));

    // Svar Slack med det samme
    return new Response("", {
      status: 200,
    });
  },
};
