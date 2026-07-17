from odoo.addons.mail.tools.discuss import Store
from odoo.tests import common, tagged


@tagged("voip", "voip_vodia", "post_install", "-at_install")
class TestVodiaStoreData(common.TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.freepbx_provider = cls.env["voip.provider"].create({
            "name": "freepbx",
            "mode": "prod",
            "pbx_ip": "pbx.example.com",
            "ws_server": "wss://pbx.example.com:8089/ws",
        })
        cls.vodia_provider = cls.env["voip.provider"].create({
            "name": "vodia",
            "provider_type": "vodia",
            "mode": "prod",
            "pbx_ip": "vodia.example.com",
            "vodia_domain": "tenant.example.com",
            "vodia_admin_username": "admin",
            "vodia_admin_password": "s3cret",
        })

    def _get_voip_config(self):
        store = Store()
        self.env.user._init_store_data(store)
        return store.get_result()["Store"]["voipConfig"], store.get_result()

    def test_freepbx_config_unchanged(self):
        """Regression guard: with a FreePBX provider, the native voipConfig
        keys must keep the exact same values as without this module, plus the
        new providerType key defaulting to "freepbx"."""
        self.env.user.voip_provider_id = self.freepbx_provider
        voip_config, _data = self._get_voip_config()
        self.assertEqual(voip_config["mode"], "prod")
        self.assertEqual(voip_config["pbxAddress"], "pbx.example.com")
        self.assertEqual(voip_config["webSocketUrl"], "wss://pbx.example.com:8089/ws")
        self.assertIn("missedCalls", voip_config)
        self.assertEqual(voip_config["providerType"], "freepbx")
        self.assertEqual(voip_config["providerId"], self.freepbx_provider.id)
        self.assertNotIn("vodiaDomain", voip_config)

    def test_vodia_config(self):
        """A Vodia provider must expose its type and domain to the frontend."""
        self.env.user.voip_provider_id = self.vodia_provider
        voip_config, _data = self._get_voip_config()
        self.assertEqual(voip_config["providerType"], "vodia")
        self.assertEqual(voip_config["providerId"], self.vodia_provider.id)
        self.assertEqual(voip_config["vodiaDomain"], "tenant.example.com")
        self.assertEqual(voip_config["mode"], "prod")
        self.assertEqual(voip_config["pbxAddress"], "vodia.example.com")

    def test_admin_credentials_never_serialized(self):
        """The Vodia admin credentials must never reach the browser."""
        self.env.user.voip_provider_id = self.vodia_provider
        _voip_config, data = self._get_voip_config()
        serialized = str(data)
        self.assertNotIn("s3cret", serialized)
        self.assertNotIn("vodia_admin_username", serialized)
        self.assertNotIn("vodia_admin_password", serialized)
