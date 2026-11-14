import { waitUntil } from "@vercel/functions";
import { runDirect } from "./_direct-runtime.js";
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

export default {
  async fetch(request) {
    return handleSlackRequest(request, {
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      runDirect,
      openModal,
      postToResponseUrl: fetch,
      defer: waitUntil,
    });
  },
};
