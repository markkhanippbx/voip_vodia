import { Numpad } from "@voip/softphone/numpad";

import { patch } from "@web/core/utils/patch";

/**
 * Routes DTMF to the Vodia user agent. Only the VodiaUserAgent defines
 * `sendDtmf`, so this is a no-op for the native sip.js agent — whose own DTMF
 * handling inside super.onClickKey (via `session?.sipSession?…`) is in turn a
 * no-op for Vodia sessions. FreePBX behavior is therefore unchanged.
 */
patch(Numpad.prototype, {
    onClickKey(ev) {
        this.userAgentService.sendDtmf?.(ev.target.textContent);
        super.onClickKey(ev);
    },
});
