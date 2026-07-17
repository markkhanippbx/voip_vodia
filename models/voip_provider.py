import requests

from odoo import _, fields, models
from odoo.exceptions import UserError

VODIA_REQUEST_TIMEOUT = 10


class VoipProvider(models.Model):
    _inherit = "voip.provider"

    provider_type = fields.Selection(
        [
            ("freepbx", "FreePBX"),
            ("vodia", "Vodia"),
        ],
        string="Provider Type",
        default="freepbx",
        required=True,
    )
    vodia_domain = fields.Char(
        "Vodia Domain",
        help="The tenant/domain configured on the Vodia PBX (e.g. company.pbx.example.com).",
        groups="base.group_system",
    )
    vodia_admin_username = fields.Char(
        "Vodia Admin Username",
        help="System administrator account used to mint per-user session tokens (third-party login).",
        groups="base.group_system",
    )
    vodia_admin_password = fields.Char(
        "Vodia Admin Password",
        groups="base.group_system",
    )

    def _get_vodia_host(self) -> str:
        """The PBX host (FQDN), without scheme or trailing slash. Both the REST
        base URL (https://{host}) and the WebSocket URL (wss://{host}/websocket)
        are derived from it.
        """
        self.ensure_one()
        host = (self.pbx_ip or "").strip().rstrip("/")
        for prefix in ("https://", "http://", "wss://", "ws://"):
            if host.startswith(prefix):
                host = host[len(prefix):]
        return host

    def get_vodia_session_token(self):
        """Mint a single-use Vodia login token for the calling user's extension
        using Vodia's third-party login (https://doc.vodia.com/docs/thirdparty).

        Called via RPC from the browser right before opening the WebSocket: the
        token is single-use and expires after ~10 seconds, so it is minted on
        demand and never cached. The extension is always derived from the
        calling user server-side, so a user cannot mint a token for someone
        else's extension. The admin credentials never leave the server.
        """
        self.ensure_one()
        if hasattr(self, "check_access"):  # Odoo >= 18
            self.check_access("read")
        else:  # Odoo <= 17
            self.check_access_rights("read")
            self.check_access_rule("read")
        provider = self.sudo()
        if provider.provider_type != "vodia":
            raise UserError(_("This provider is not a Vodia provider."))
        extension = self.env.user.voip_username
        if not extension:
            raise UserError(
                _("Your VoIP username (extension number) is not set. Please configure it in your user preferences.")
            )
        host = provider._get_vodia_host()
        if not (host and provider.vodia_domain and provider.vodia_admin_username and provider.vodia_admin_password):
            raise UserError(
                _("The Vodia provider is not fully configured. Please contact your administrator.")
            )
        try:
            response = requests.post(
                f"https://{host}/rest/system/session",
                auth=(provider.vodia_admin_username, provider.vodia_admin_password),
                json={"name": "3rd", "username": extension, "domain": provider.vodia_domain},
                timeout=VODIA_REQUEST_TIMEOUT,
            )
            response.raise_for_status()
        except requests.exceptions.RequestException as error:
            raise UserError(
                _("Could not authenticate with the Vodia PBX: %(error)s", error=error)
            ) from error
        # The token may come back as plain text or wrapped in a JSON value
        # depending on the Vodia version.
        token = response.text.strip().strip('"')
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            token = payload.get("session") or payload.get("value") or payload.get("token") or token
        elif isinstance(payload, str):
            token = payload
        if not token:
            raise UserError(_("The Vodia PBX did not return a session token."))
        return {
            "token": token,
            "domain": provider.vodia_domain,
            "user": extension,
            "pbx": host,
        }
