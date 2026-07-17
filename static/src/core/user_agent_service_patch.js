import { userAgentService } from "@voip/core/user_agent_service";

import { patch } from "@web/core/utils/patch";

import { VodiaUserAgent } from "./vodia_user_agent";

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
