import unittest

from slack_authorization import is_private_data_request_authorized


class PrivateDataAuthorizationTests(unittest.TestCase):
    def test_existing_authorized_channel_is_allowed(self):
        self.assertTrue(
            is_private_data_request_authorized(
                channel_id="C-allowed",
                channel_type="channel",
                user_id="U-any-user",
                authorized_user_id="U-authorized",
                authorized_channel_id="C-allowed",
            )
        )

    def test_authorized_user_in_an_actual_dm_is_allowed(self):
        self.assertTrue(
            is_private_data_request_authorized(
                channel_id="D-private",
                channel_type="im",
                user_id="U-authorized",
                authorized_user_id="U-authorized",
                authorized_channel_id="C-allowed",
            )
        )

    def test_user_id_match_without_dm_identity_is_rejected(self):
        self.assertFalse(
            is_private_data_request_authorized(
                channel_id="C-other",
                channel_type="channel",
                user_id="U-authorized",
                authorized_user_id="U-authorized",
                authorized_channel_id="C-allowed",
            )
        )

    def test_dm_authorization_uses_exact_user_id(self):
        self.assertFalse(
            is_private_data_request_authorized(
                channel_id="D-private",
                channel_type="im",
                user_id="u-authorized",
                authorized_user_id="U-authorized",
                authorized_channel_id="C-allowed",
            )
        )

    def test_missing_authorization_configuration_fails_closed(self):
        self.assertFalse(
            is_private_data_request_authorized(
                channel_id="D-private",
                channel_type="im",
                user_id="U-authorized",
                authorized_user_id="",
                authorized_channel_id="",
            )
        )


if __name__ == "__main__":
    unittest.main()
