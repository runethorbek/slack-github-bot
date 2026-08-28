import { waitUntil } from "@vercel/functions";
import { handleSlackRequest } from "./slack-request.js";

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
    return handleSlackRequest(request, {
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      triggerGitHub,
      defer: waitUntil,
    });
  },
};
