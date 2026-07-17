import { Voip } from "@voip/core/voip_service";

import { patch } from "@web/core/utils/patch";

/**
 * Vodia-specific configuration checks. The native `Object.assign(this,
 * this.store.voipConfig)` in the Voip constructor already copies the
 * `providerType`, `providerId` and `vodiaDomain` keys added by this module's
 * `res.users._init_store_data` override onto the service; only the two
 * validation getters need Vodia branches:
 * - the server is configured with a PBX address + Vodia domain (the native
 *   `ws_server` field is unused for Vodia: the WebSocket URL is derived from
 *   the PBX address),
 * - only the extension number is required as a credential (authentication
 *   uses server-minted session tokens, not a per-user secret).
 */
patch(Voip.prototype, {
    get areCredentialsSet() {
        if (this.providerType === "vodia") {
            return Boolean(this.store.settings.voip_username);
        }
        return super.areCredentialsSet;
    },
    get isServerConfigured() {
        if (this.providerType === "vodia") {
            return Boolean(this.pbxAddress && this.vodiaDomain);
        }
        return super.isServerConfigured;
    },
});
