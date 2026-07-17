from unittest.mock import Mock, patch

import requests

from odoo.exceptions import UserError
from odoo.tests import common, new_test_user, tagged

MOCK_PATH = "odoo.addons.voip_vodia.models.voip_provider.requests.post"


def _make_response(text="tok123", json_side_effect=ValueError, status_error=None):
    response = Mock()
    response.text = text
    response.json = Mock(side_effect=json_side_effect) if json_side_effect else Mock()
    if status_error:
        response.raise_for_status = Mock(side_effect=status_error)
    else:
        response.raise_for_status = Mock()
    return response


@tagged("voip", "voip_vodia", "post_install", "-at_install")
class TestVodiaSession(common.TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.vodia_provider = cls.env["voip.provider"].create({
            "name": "vodia",
            "provider_type": "vodia",
            "mode": "prod",
            "pbx_ip": "https://vodia.example.com/",
            "vodia_domain": "tenant.example.com",
            "vodia_admin_username": "admin",
            "vodia_admin_password": "s3cret",
        })
        cls.freepbx_provider = cls.env["voip.provider"].create({
            "name": "freepbx",
            "mode": "prod",
            "pbx_ip": "pbx.example.com",
            "ws_server": "wss://pbx.example.com:8089/ws",
        })
        cls.user = new_test_user(cls.env, login="voip_vodia_user")
        cls.env["res.users.settings"]._find_or_create_for_user(cls.user).update({
            "voip_username": "40",
            "voip_provider_id": cls.vodia_provider.id,
        })

    def test_token_minting_success(self):
        with patch(MOCK_PATH, return_value=_make_response(text="tok123")) as mocked_post:
            result = self.vodia_provider.with_user(self.user).get_vodia_session_token()
        self.assertEqual(result, {
            "token": "tok123",
            "domain": "tenant.example.com",
            "user": "40",
            "pbx": "vodia.example.com",
        })
        args, kwargs = mocked_post.call_args
        # Scheme/trailing slash stripped from pbx_ip when building the URL.
        self.assertEqual(args[0], "https://vodia.example.com/rest/system/session")
        self.assertEqual(kwargs["auth"], ("admin", "s3cret"))
        # The extension always comes from the calling user, never from an argument.
        self.assertEqual(
            kwargs["json"],
            {"name": "3rd", "username": "40", "domain": "tenant.example.com"},
        )

    def test_token_json_response_shapes(self):
        """Vodia may return the token as plain text or wrapped in JSON."""
        response = _make_response(text='"quoted"')
        with patch(MOCK_PATH, return_value=response):
            result = self.vodia_provider.with_user(self.user).get_vodia_session_token()
        self.assertEqual(result["token"], "quoted")

        response = Mock(text='{"session": "fromjson"}', raise_for_status=Mock())
        response.json = Mock(return_value={"session": "fromjson"})
        with patch(MOCK_PATH, return_value=response):
            result = self.vodia_provider.with_user(self.user).get_vodia_session_token()
        self.assertEqual(result["token"], "fromjson")

    def test_non_vodia_provider_rejected(self):
        with self.assertRaises(UserError):
            self.freepbx_provider.with_user(self.user).get_vodia_session_token()

    def test_missing_extension_rejected(self):
        self.user.res_users_settings_id.voip_username = False
        with self.assertRaises(UserError):
            self.vodia_provider.with_user(self.user).get_vodia_session_token()

    def test_incomplete_provider_rejected(self):
        self.vodia_provider.vodia_admin_password = False
        with self.assertRaises(UserError):
            self.vodia_provider.with_user(self.user).get_vodia_session_token()

    def test_http_failure_raises_user_error(self):
        error = requests.exceptions.ConnectionError("boom")
        with patch(MOCK_PATH, side_effect=error):
            with self.assertRaises(UserError):
                self.vodia_provider.with_user(self.user).get_vodia_session_token()
        response = _make_response(status_error=requests.exceptions.HTTPError("401"))
        with patch(MOCK_PATH, return_value=response):
            with self.assertRaises(UserError):
                self.vodia_provider.with_user(self.user).get_vodia_session_token()
