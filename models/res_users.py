from odoo import models


class ResUsers(models.Model):
    _inherit = "res.users"

    def _init_store_data(self, store):
        super()._init_store_data(store)
        if not self.env.user._is_internal():
            return
        provider = self.env.user.voip_provider_id
        # Re-add the complete voipConfig rather than only the new keys: the
        # native keys are reproduced with the exact same expressions as in
        # voip/models/res_users.py, so the result is correct whether the store
        # merges or replaces values for an already-added key.
        voip_config = {
            "mode": provider.mode or "demo",
            "missedCalls": self.env["voip.call"]._get_number_of_missed_calls(),
            "pbxAddress": provider.pbx_ip or "localhost",
            "webSocketUrl": provider.ws_server or "ws://localhost",
            "providerType": provider.provider_type or "freepbx",
            "providerId": provider.id,
        }
        if provider.provider_type == "vodia":
            voip_config["vodiaDomain"] = provider.sudo().vodia_domain or ""
        store.add({"voipConfig": voip_config})
