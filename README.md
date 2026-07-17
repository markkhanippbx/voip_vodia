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
