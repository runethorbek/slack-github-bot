import json
import os
import runpy
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class SlackToPythonContractTests(unittest.TestCase):
    def test_signed_root_dm_reaches_authorized_python_route_with_transport_identity(self):
        payload = self.capture_javascript_dm_dispatch()
        self.assertEqual(payload["user_id"], "U-authorized")
        self.assertEqual(payload["channel_id"], "D-private")
        self.assertEqual(payload["event_ts"], "100.001")
        self.assertEqual(payload["thread_ts"], "")
        self.assertEqual(payload["channel_type"], "im")

        requests_module, google_module, genai_module = self.fake_python_modules()
        environment = {
            "SLACK_TEXT": payload["text"],
            "SLACK_CHANNEL_ID": payload["channel_id"],
            "SLACK_USER_ID": payload["user_id"],
            "SLACK_CHANNEL_TYPE": payload["channel_type"],
            "SLACK_EVENT_TS": payload["event_ts"],
            "SLACK_THREAD_TS": payload["thread_ts"],
            "SLACK_EVENT_TYPE": payload["slack_event_type"],
            "SLACK_BOT_TOKEN": "fake-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
        }

        slack_response = Mock()
        slack_response.json.return_value = {"ok": True}
        requests_module.post.side_effect = None
        requests_module.post.return_value = slack_response

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        self.assertEqual(
            requests_module.post.call_args.kwargs["json"],
            {
                "channel": "D-private",
                "text": "DM conversation received.",
                "mrkdwn": True,
                "thread_ts": "100.001",
            },
        )
        requests_module.get.assert_not_called()
        genai_module.Client.assert_not_called()

    def test_workflow_maps_dm_identity_and_authorization_configuration(self):
        workflow = (
            Path(__file__).resolve().parents[1]
            / ".github"
            / "workflows"
            / "slack-message.yml"
        ).read_text(encoding="utf-8")

        expected_mappings = [
            "SLACK_USER_ID: ${{ github.event.client_payload.user_id }}",
            "SLACK_EVENT_TS: ${{ github.event.client_payload.event_ts }}",
            "SLACK_CHANNEL_TYPE: ${{ github.event.client_payload.channel_type }}",
            "AUTHORIZED_SLACK_USER_ID: ${{ secrets.AUTHORIZED_SLACK_USER_ID }}",
        ]
        for mapping in expected_mappings:
            self.assertIn(mapping, workflow)

    def test_authenticated_tasks_dispatch_reaches_notion_and_slack_without_gemini(self):
        payload = self.capture_javascript_dispatch()
        requests_module, google_module, genai_module = self.fake_python_modules()
        environment = {
            "SLACK_COMMAND": payload["command"],
            "SLACK_TEXT": payload["text"],
            "SLACK_CHANNEL_ID": payload["channel_id"],
            "SLACK_USER_ID": payload["user_id"],
            "SLACK_CHANNEL_TYPE": payload["channel_type"],
            "SLACK_THREAD_TS": payload["thread_ts"],
            "SLACK_EVENT_TYPE": payload["slack_event_type"],
            "SLACK_BOT_TOKEN": "fake-slack-token",
            "TASKS_SLACK_CHANNEL_ID": payload["channel_id"],
            "NOTION_API_KEY": "fake-notion-token",
            "NOTION_TASKS_DATA_SOURCE_ID": "fake-data-source-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        genai_module.Client.assert_not_called()
        requests_module.get.assert_called_once_with(
            "https://api.notion.com/v1/pages/track-id",
            headers={
                "Authorization": "Bearer fake-notion-token",
                "Content-Type": "application/json",
                "Notion-Version": "2025-09-03",
            },
            timeout=10,
        )
        self.assertEqual(
            [call.args[0] for call in requests_module.post.call_args_list],
            [
                "https://slack.com/api/chat.postMessage",
                "https://api.notion.com/v1/data_sources/fake-data-source-id/query",
                "https://slack.com/api/chat.postMessage",
            ],
        )
        reply_text = requests_module.post.call_args_list[-1].kwargs["json"]["text"]
        self.assertIn("Track: Known staging track", reply_text)

    def test_authenticated_people_suggest_button_click_reaches_the_existing_suggest_route(self):
        """A /people due button click must reuse Slice 1's suggest route.

        This is the strongest proof of reuse: it runs a signed Slack
        block_actions click through the real JS webhook handler, feeds the
        resulting dispatch into the real main.py, and checks it lands on
        the same handle_people_suggest path a typed `/people suggest <name>`
        command would - no duplicated Person resolution or Gemini prompt.
        """
        payload = self.capture_javascript_block_action_dispatch()
        self.assertEqual(payload["command"], "/people")
        self.assertEqual(payload["text"], "suggest Jane Doe")
        self.assertEqual(payload["slack_event_type"], "block_actions")
        self.assertEqual(payload["channel_type"], "im")

        requests_module, google_module, genai_module = self.fake_people_suggest_modules()
        environment = {
            "SLACK_COMMAND": payload["command"],
            "SLACK_TEXT": payload["text"],
            "SLACK_CHANNEL_ID": payload["channel_id"],
            "SLACK_USER_ID": payload["user_id"],
            "SLACK_CHANNEL_TYPE": payload["channel_type"],
            "SLACK_THREAD_TS": payload["thread_ts"],
            "SLACK_EVENT_TYPE": payload["slack_event_type"],
            "SLACK_BOT_TOKEN": "fake-slack-token",
            "AUTHORIZED_SLACK_USER_ID": "U-authorized",
            "TASKS_SLACK_CHANNEL_ID": "C-allowed",
            "NOTION_API_KEY": "fake-notion-token",
            "NOTION_PEOPLE_DATA_SOURCE_ID": "fake-people-id",
            "NOTION_INTERACTIONS_DATA_SOURCE_ID": "fake-interactions-id",
        }

        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(
                sys.modules,
                {
                    "requests": requests_module,
                    "google": google_module,
                    "google.genai": genai_module,
                },
            ),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module("main", run_name="__main__")

        self.assertEqual(exit_context.exception.code, 0)
        reply_text = requests_module.post.call_args_list[-1].kwargs["json"]["text"]
        self.assertEqual(
            reply_text, "Suggested message for Jane Doe:\n\nHey Jane, been a while!"
        )

    @staticmethod
    def capture_javascript_dm_dispatch():
        script = r"""
import { createHmac } from "node:crypto";
import { handleSlackRequest } from "./api/slack-request.js";

const signingSecret = "fake-signing-secret";
const timestamp = 1_700_000_000;
const body = JSON.stringify({
  type: "event_callback",
  event: {
    type: "message",
    text: "private root",
    channel: "D-private",
    user: "U-authorized",
    ts: "100.001",
    channel_type: "im",
  },
});
const signature = `v0=${createHmac("sha256", signingSecret)
  .update(`v0:${timestamp}:${body}`)
  .digest("hex")}`;
const request = new Request("https://example.test/api/slack", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  },
  body,
});
const dispatched = [];
const deferred = [];
await handleSlackRequest(request, {
  signingSecret,
  now: () => timestamp * 1000,
  triggerGitHub: async (payload) => dispatched.push(payload),
  defer: (promise) => deferred.push(promise),
});
await Promise.all(deferred);
process.stdout.write(JSON.stringify(dispatched[0]));
"""
        repository_root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=repository_root,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    @staticmethod
    def capture_javascript_block_action_dispatch():
        script = r"""
import { createHmac } from "node:crypto";
import { handleSlackRequest } from "./api/slack-request.js";

const signingSecret = "fake-signing-secret";
const timestamp = 1_700_000_000;
const body = new URLSearchParams({
  payload: JSON.stringify({
    type: "block_actions",
    actions: [{ action_id: "people_suggest", value: "Jane Doe" }],
    response_url: "https://hooks.slack.test/interaction",
    channel: { id: "D-private" },
    user: { id: "U-authorized" },
  }),
}).toString();
const signature = `v0=${createHmac("sha256", signingSecret)
  .update(`v0:${timestamp}:${body}`)
  .digest("hex")}`;
const request = new Request("https://example.test/api/slack", {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  },
  body,
});
const dispatched = [];
const deferred = [];
await handleSlackRequest(request, {
  signingSecret,
  now: () => timestamp * 1000,
  triggerGitHub: async (payload) => dispatched.push(payload),
  defer: (promise) => deferred.push(promise),
});
await Promise.all(deferred);
process.stdout.write(JSON.stringify(dispatched[0]));
"""
        repository_root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=repository_root,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    @staticmethod
    def fake_people_suggest_modules():
        people_response = Mock()
        people_response.json.return_value = {
            "results": [
                {
                    "id": "person-id",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Jane Doe"}],
                        },
                    },
                }
            ]
        }
        interactions_response = Mock()
        interactions_response.json.return_value = {"results": []}
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}

        requests_module = types.ModuleType("requests")
        requests_module.post = Mock(
            side_effect=[root_response, people_response, interactions_response, reply_response]
        )
        requests_module.get = Mock(
            side_effect=AssertionError("No Notion GET calls expected for /people suggest")
        )

        generated_response = Mock()
        generated_response.output_text = "Hey Jane, been a while!\n"
        client_instance = Mock()
        client_instance.interactions.create = Mock(return_value=generated_response)
        genai_module = types.ModuleType("google.genai")
        genai_module.Client = Mock(return_value=client_instance)
        google_module = types.ModuleType("google")
        google_module.genai = genai_module
        return requests_module, google_module, genai_module

    @staticmethod
    def capture_javascript_dispatch():
        script = r"""
import { createHmac } from "node:crypto";
import { handleSlackRequest } from "./api/slack-request.js";

const signingSecret = "fake-signing-secret";
const timestamp = 1_700_000_000;
const body = new URLSearchParams({
  command: "/tasks",
  text: "list",
  response_url: "https://hooks.slack.test/response",
  channel_id: "C-allowed",
  user_id: "U-user",
}).toString();
const signature = `v0=${createHmac("sha256", signingSecret)
  .update(`v0:${timestamp}:${body}`)
  .digest("hex")}`;
const request = new Request("https://example.test/api/slack", {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  },
  body,
});
const dispatched = [];
const deferred = [];
await handleSlackRequest(request, {
  signingSecret,
  now: () => timestamp * 1000,
  triggerGitHub: async (payload) => dispatched.push(payload),
  defer: (promise) => deferred.push(promise),
});
await Promise.all(deferred);
process.stdout.write(JSON.stringify(dispatched[0]));
"""
        repository_root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=repository_root,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    @staticmethod
    def fake_python_modules():
        notion_response = Mock()
        notion_response.json.return_value = {
            "results": [
                {
                    "url": "https://www.notion.so/example-task",
                    "properties": {
                        "Navn": {
                            "id": "title",
                            "type": "title",
                            "title": [{"plain_text": "Known staging task"}],
                        },
                        "Status": {
                            "type": "status",
                            "status": {"name": "Ikke started"},
                        },
                        "Track": {
                            "type": "relation",
                            "relation": [{"id": "track-id"}],
                        },
                    },
                }
            ]
        }
        track_response = Mock()
        track_response.json.return_value = {
            "properties": {
                "Navn": {
                    "type": "title",
                    "title": [{"plain_text": "Known staging track"}],
                },
                "Priority": {
                    "type": "select",
                    "select": {"name": "High"},
                },
            }
        }
        root_response = Mock()
        root_response.json.return_value = {"ok": True, "ts": "123.456"}
        reply_response = Mock()
        reply_response.json.return_value = {"ok": True}

        requests_module = types.ModuleType("requests")
        requests_module.post = Mock(
            side_effect=[root_response, notion_response, reply_response]
        )
        requests_module.get = Mock(return_value=track_response)

        genai_module = types.ModuleType("google.genai")
        genai_module.Client = Mock(
            side_effect=AssertionError("Gemini must not be initialized")
        )
        google_module = types.ModuleType("google")
        google_module.genai = genai_module
        return requests_module, google_module, genai_module


if __name__ == "__main__":
    unittest.main()
