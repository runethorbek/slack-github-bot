// Port of tests/test_slack_authorization.py (PrivateDataAuthorizationTests).

import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateDataRequestAuthorized } from "../src/slack-authorization.ts";

test("test_existing_authorized_channel_is_allowed", () => {
  assert.equal(
    isPrivateDataRequestAuthorized({
      channelId: "C-allowed",
      channelType: "channel",
      userId: "U-any-user",
      authorizedUserId: "U-authorized",
      authorizedChannelId: "C-allowed",
    }),
    true,
  );
});

test("test_authorized_user_in_an_actual_dm_is_allowed", () => {
  assert.equal(
    isPrivateDataRequestAuthorized({
      channelId: "D-private",
      channelType: "im",
      userId: "U-authorized",
      authorizedUserId: "U-authorized",
      authorizedChannelId: "C-allowed",
    }),
    true,
  );
});

test("test_user_id_match_without_dm_identity_is_rejected", () => {
  assert.equal(
    isPrivateDataRequestAuthorized({
      channelId: "C-other",
      channelType: "channel",
      userId: "U-authorized",
      authorizedUserId: "U-authorized",
      authorizedChannelId: "C-allowed",
    }),
    false,
  );
});

test("test_dm_authorization_uses_exact_user_id (S1: case-sensitive)", () => {
  assert.equal(
    isPrivateDataRequestAuthorized({
      channelId: "D-private",
      channelType: "im",
      userId: "u-authorized",
      authorizedUserId: "U-authorized",
      authorizedChannelId: "C-allowed",
    }),
    false,
  );
});

test("test_missing_authorization_configuration_fails_closed (S1: empty value never authorizes)", () => {
  assert.equal(
    isPrivateDataRequestAuthorized({
      channelId: "D-private",
      channelType: "im",
      userId: "U-authorized",
      authorizedUserId: "",
      authorizedChannelId: "",
    }),
    false,
  );
});
