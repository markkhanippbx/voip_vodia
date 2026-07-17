{
    "name": "VoIP Vodia",
    "summary": """Vodia PBX support for the VoIP application.""",
    "description": """Adds "Vodia" as a provider type to the VoIP application.
Vodia PBXs use a proprietary JSON-over-WebSocket protocol instead of SIP over
WebSocket, and authenticate users through server-minted session tokens
(third-party login) so that users never need to know a PBX password.
The native FreePBX/SIP behavior is left untouched.""",
    "category": "Productivity/VOIP",
    "version": "1.0.0",
    "depends": ["voip"],
    "data": [
        "views/voip_provider_views.xml",
    ],
    "license": "OPL-1",
    "assets": {
        "web.assets_backend": [
            "voip_vodia/static/src/**/*",
        ],
    },
}
