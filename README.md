# VoIP Vodia

Adds **Vodia** as a provider type to Odoo's native VoIP application, alongside the
existing (FreePBX/SIP) behavior — which is left completely untouched: this module
extends the native `voip` app purely through Odoo inheritance (`_inherit`, view
xpath, JS `patch()`), so nothing in the enterprise `voip` directory is modified.

## How it works

- **Provider Type** column in *Settings → VoIP → Manage Providers*: `FreePBX`
  (default — all existing providers keep working exactly as before) or `Vodia`.
- For Vodia providers, set:
  - **PBX Server (IP / Domain)**: the Vodia PBX FQDN (e.g. `pbx.example.com`).
    Must have a valid TLS certificate — the browser connects via `https://`/`wss://`.
  - **Vodia Domain**: the tenant/domain on the PBX (e.g. `tenant.example.com`).
  - **Vodia Admin Username / Password**: a system administrator account, used
    *only server-side* to mint per-user session tokens (visible to Odoo admins only).
- Each user only needs their **VoIP username / Extension number** set in their
  preferences (VoIP tab). No PBX password is needed for Vodia — authentication uses
  Vodia's [third-party login](https://doc.vodia.com/docs/thirdparty): the Odoo server
  mints a single-use ~10-second token for the user's extension, the browser activates
  it against the PBX to obtain a session, then opens the
  [JSON-over-WebSocket](https://doc.vodia.com/docs/websocket) connection.
- Calls are handled by `VodiaUserAgent` (`static/src/core/vodia_user_agent.js`),
  which implements Vodia's protocol (`sdp-packet`, `sdp-200ok`, `sip-bye`,
  `wrtc-hold`, `blind-transfer2`, `ice-candidate`, …) with manual WebRTC handling,
  behind the same interface as the native sip.js agent — the whole softphone UI
  works unchanged for both provider types. Demo mode always uses the native agent.

## FusionPBX

FusionPBX (FreeSWITCH) uses **standard SIP over WebSocket** — the native VoIP
engine, same as FreePBX. Select the *FusionPBX* provider type and configure:

- **WebSocket**: `wss://<server>:7443` (FreeSWITCH's WSS port). The TLS
  certificate on 7443 must be valid in browsers — replace FreeSWITCH's
  default self-signed cert (e.g. Let's Encrypt into `/etc/freeswitch/tls/`).
- **PBX Server (IP / Domain)**: the FusionPBX **tenant domain** (registration
  is `sip:<extension>@<domain>`), not the raw server IP.
- Per user: extension number as *VoIP username* and the extension's **SIP
  password** (not the portal login) as *VoIP secret*.
- The internal SIP profile must have the `wss-binding` enabled (FusionPBX
  default) and firewall must allow 7443/tcp plus the RTP range (16384–32768/udp
  by default).

## iOS / Safari (WebKit): WebSocket proxy

WebKit blocks third-party cookies entirely, so the Vodia session cookie can
never accompany a cross-origin WebSocket handshake from Odoo pages on
iOS/Safari. The client automatically falls back to the "proxy" auth strategy:
connecting through the **Odoo origin** (first-party everywhere) with the
server-activated session id in the URL. This requires one nginx block on the
Odoo server, inside the `server {}` that serves Odoo:

```nginx
location /vodia-ws/websocket {
    # Restrict which PBX hosts may be proxied (anti-open-proxy) — adjust to
    # your PBX domains:
    if ($arg_pbx !~* ^[A-Za-z0-9.-]+\.(bpsna\.net|bpsnapbx\.com)$) { return 403; }
    resolver 8.8.8.8 ipv6=off;
    proxy_pass https://$arg_pbx/websocket?domain=$arg_domain&user=$arg_user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $arg_pbx;
    # Vodia authenticates the handshake by cookie; the client passes the
    # server-activated session id as a URL parameter instead:
    proxy_set_header Cookie "session=$arg_session";
    proxy_ssl_server_name on;
    proxy_ssl_name $arg_pbx;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Then `nginx -t && systemctl reload nginx`. A bonus of this path: the WebSocket
reaches the PBX from the Odoo server's IP — the same IP that activated the
session — so it also works if the PBX binds sessions to the activating IP.

For debugging, force one auth strategy from the browser console:
`localStorage.setItem("voip_vodia.authStrategy", "session")` (values: cookie,
session, query, proxy; remove with `localStorage.removeItem(...)`).

## Requirements / notes

- Targets the same Odoo version as the native `voip` app it extends (Odoo 18 API).
- Vodia PBX version 70+ recommended (server-side token exchange).
- The PBX must allow CORS with credentials from the Odoo origin, and API access
  must be enabled on the PBX (*Settings → Security → Login*).
- Two integration points are deliberately isolated for live tuning against your
  PBX (inspect traffic from Vodia's own user portal with browser dev tools):
  - `VodiaUserAgent._authenticate()` — if the `SameSite=Strict` session cookie is
    not attached to the cross-site WebSocket handshake, switch to passing the
    session in the WebSocket URL query string or as the first frame.
  - `VodiaUserAgent._onWebSocketMessage()` — inbound message field names; unknown
    messages are logged to the console in debug mode (`?debug=1`).

## Tests

```bash
odoo-bin -d <db> -i voip_vodia --test-tags voip_vodia --stop-after-init
```

Also run the native suite (`--test-tags voip`) with this module installed to
confirm zero regressions.
