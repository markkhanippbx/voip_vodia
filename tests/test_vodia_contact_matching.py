from odoo.tests import common, tagged


@tagged("voip", "voip_vodia", "post_install", "-at_install")
class TestVodiaContactMatching(common.TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env.company.country_id = cls.env.ref("base.us")
        cls.partner = cls.env["res.partner"].create({
            "name": "Mudasar",
            "phone": "+1 516-210-0684",
        })

    def test_national_number_matches_international_contact(self):
        """A caller number delivered in national format must match a contact
        stored in international format via the E.164 fallback."""
        call = self.env["voip.call"].create({"phone_number": "5162100684"})
        info = call.get_contact_info()
        self.assertTrue(info)
        self.assertEqual(call.partner_id, self.partner)
        self.assertEqual(call.phone_number, "+15162100684")

    def test_unknown_number_keeps_original_format(self):
        """When nothing matches, the number must stay as received."""
        call = self.env["voip.call"].create({"phone_number": "9998887777"})
        info = call.get_contact_info()
        self.assertFalse(info)
        self.assertEqual(call.phone_number, "9998887777")
