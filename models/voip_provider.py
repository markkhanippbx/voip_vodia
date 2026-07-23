import re
import ssl

import requests
import requests.adapters

from odoo import _, fields, models
from odoo.exceptions import UserError

VODIA_REQUEST_TIMEOUT = 10


class _LegacyTlsAdapter(requests.adapters.HTTPAdapter):
    """Connects to old PBXs (e.g. Vodia 67) whose TLS stack predates secure
    renegotiation (RFC 5746), which OpenSSL 3 rejects by default. Certificate
    verification stays fully enabled.
    """

    def init_poolmanager(self, *args, **kwargs):
        context = ssl.create_default_context()
        # ssl.OP_LEGACY_SERVER_CONNECT only exists on Python >= 3.12.
        context.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0x4)
        kwargs["ssl_context"] = context
        return super().init_poolmanager(*args, **kwargs)


class VoipProvider(models.Model):
    _inherit = "voip.provider"

    provider_type = fields.Selection(
        [
            ("freepbx", "FreePBX"),
            ("fusionpbx", "FusionPBX"),
            ("vodia", "Vodia"),
        ],
        string="Provider Type",
        default="freepbx",
        required=True,
        help="FreePBX and FusionPBX both use standard SIP over WebSocket (the native VoIP engine); "
        "FusionPBX serves WSS on port 7443 and registers against the tenant domain. "
        "Vodia uses its proprietary JSON-over-WebSocket protocol.",
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
    vodia_dialect = fields.Selection(
        [
            ("auto", "Auto (detect by version)"),
            ("legacy", "Legacy (v68 and older)"),
            ("modern", "Modern (v69+)"),
        ],
        string="Vodia Dialect",
        default="auto",
        help="Signaling dialect of the PBX. Vodia changed the caller-side WebRTC flow in v69: "
        "Auto picks based on the version the PBX reports; override only if a specific server misbehaves.",
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

    @staticmethod
    def _vodia_post(url, request_kwargs):
        """POST to the PBX, retrying with legacy TLS renegotiation permitted
        when the PBX's TLS stack predates RFC 5746 (e.g. Vodia 67).
        Certificate verification stays enabled in both attempts.
        """
        try:
            return requests.post(url, **request_kwargs)
        except requests.exceptions.SSLError as ssl_error:
            if "UNSAFE_LEGACY_RENEGOTIATION" not in str(ssl_error):
                raise
            session = requests.Session()
            session.mount("https://", _LegacyTlsAdapter())
            return session.post(url, **request_kwargs)

    def get_vodia_session(self):
        """Mints a token AND activates it server-side, returning the live
        session id to be passed in the WebSocket URL. Used by clients whose
        browsers cannot present third-party cookies on the WebSocket handshake
        (iOS/WebKit): unlike a browser, the server can read the Set-Cookie of
        the activation response.
        """
        token_info = self.get_vodia_session_token()
        url = f"https://{token_info['pbx']}/rest/system/session"
        try:
            response = self._vodia_post(url, {
                "json": {"name": "session", "value": token_info["token"]},
                "timeout": VODIA_REQUEST_TIMEOUT,
            })
            response.raise_for_status()
        except requests.exceptions.RequestException as error:
            raise UserError(
                _("Could not activate the Vodia session: %(error)s", error=error)
            ) from error
        session_id = response.cookies.get("session") or ""
        if not session_id:
            # Some versions may return it in the body instead.
            try:
                payload = response.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict):
                session_id = payload.get("session") or payload.get("value") or ""
        if not session_id:
            raise UserError(_("The Vodia PBX did not return a session id."))
        token_info["session"] = session_id
        return token_info

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
        url = f"https://{host}/rest/system/session"
        request_kwargs = {
            "auth": (provider.vodia_admin_username, provider.vodia_admin_password),
            "json": {"name": "3rd", "username": extension, "domain": provider.vodia_domain},
            "timeout": VODIA_REQUEST_TIMEOUT,
        }
        try:
            response = self._vodia_post(url, request_kwargs)
            # Vodia answers 404 when the endpoint exists but the referenced
            # domain or extension does not.
            if response.status_code == 404:
                raise UserError(
                    _(
                        'The Vodia PBX could not find the domain "%(domain)s" or the extension "%(extension)s". Please check that the Vodia Domain matches a domain on the PBX exactly and that the extension exists in it.',
                        domain=provider.vodia_domain,
                        extension=extension,
                    )
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
        # Vodia rejects bad credentials with HTTP 200 and the body "false".
        if not token or token.lower() == "false":
            raise UserError(
                _("The Vodia PBX rejected the token request. Please check the Vodia admin credentials.")
            )
        # e.g. "PBX/70.1" or "PBX/67.0.5 (Debian64)" — the frontend signaling
        # dialect differs between major versions.
        version_match = re.search(r"PBX/([\d.]+)", response.headers.get("Server", ""))
        if not version_match:
            # Some responses omit the Server header; the PBX root reliably
            # carries it.
            try:
                root_session = requests.Session()
                root_session.mount("https://", _LegacyTlsAdapter())
                root = root_session.get(
                    f"https://{host}/", timeout=VODIA_REQUEST_TIMEOUT, allow_redirects=False
                )
                version_match = re.search(r"PBX/([\d.]+)", root.headers.get("Server", ""))
            except requests.exceptions.RequestException:
                pass
        return {
            "token": token,
            "domain": provider.vodia_domain,
            "user": extension,
            "pbx": host,
            "version": version_match.group(1) if version_match else "",
            "dialect": provider.vodia_dialect or "auto",
        }
