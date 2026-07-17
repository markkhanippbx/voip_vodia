from odoo import models
from odoo.addons.phone_validation.tools import phone_validation


class VoipCall(models.Model):
    _inherit = "voip.call"

    def get_contact_info(self):
        """Fallback on top of the native contact matching: PBXs often deliver
        the caller number in national format (e.g. "5162100684") while
        contacts are stored in international format ("+1 516-210-0684"). When
        the native lookup finds nothing and the number carries no
        international prefix, retry after formatting it to E.164 using the
        company country.
        """
        self.ensure_one()
        info = super().get_contact_info()
        if info:
            return info
        number = self.phone_number or ""
        if not number or number.startswith(("+", "00")):
            return info
        country = self.env.company.country_id
        if not country:
            return info
        try:
            formatted = phone_validation.phone_format(
                number,
                country.code,
                country.phone_code,
                force_format="E164",
                raise_exception=True,
            )
        except Exception:
            return info
        if formatted == number:
            return info
        original_number = self.phone_number
        self.phone_number = formatted
        info = super().get_contact_info()
        if not info:
            # No match either way: keep the number as it was received.
            self.phone_number = original_number
        return info
