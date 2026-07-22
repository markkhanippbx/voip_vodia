import { UserAgent, userAgentService } from "@voip/core/user_agent_service";

import { patch } from "@web/core/utils/patch";

import { VodiaUserAgent } from "./vodia_user_agent";

/**
 * Guards against double-acceptance of an incoming call: sip.js only allows
 * accept() from the "Initial" session state, but the native accept flow
 * awaits getUserMedia, leaving a window where a second click on Accept (or a
 * double click) reaches accept() again and throws "Invalid session state
 * Establishing" as an uncaught rejection.
 */
patch(UserAgent.prototype, {
    async acceptIncomingCall() {
        const state = this.session?.sipSession?.state;
        if (state && state !== "Initial") {
            return;
        }
        return super.acceptIncomingCall(...arguments);
    },
});

/**
 * Routes the "voip.user_agent" service to the Vodia implementation when the
 * user's provider is of type "vodia" in production mode. Every other case
 * (FreePBX, demo mode) keeps the native sip.js-based UserAgent, so the
 * existing behavior is untouched and the sip.js bundle is never loaded on the
 * Vodia path.
 */
patch(userAgentService, {
    start(env, services) {
        const voip = services.voip;
        if (voip.providerType === "vodia" && voip.mode === "prod") {
            return new VodiaUserAgent(env, services);
        }
        return super.start(env, services);
    },
});
