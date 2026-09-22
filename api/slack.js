import { waitUntil } from "@vercel/functions";
import { handleSlackRequest } from "./slack-request.js";

async function openModal(triggerId, view) {
  try {
    const response = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      console.error("Slack views.open failed:", result.error);
    }
  } catch (error) {
    console.error("Failed to open Slack modal:", error);
  }
}

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
      openModal,
      defer: waitUntil,
    });
  },
};
