import { reactive } from "@odoo/owl";

import { cleanPhoneNumber } from "@voip/utils/utils";

import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";

/**
 * User agent implementing the Vodia PBX JSON-over-WebSocket protocol
 * (https://doc.vodia.com/docs/websocket) with manual WebRTC handling.
 *
 * It exposes the same public interface and reactive `session` shape as the
 * native sip.js-based UserAgent (@voip/core/user_agent_service), so the whole
 * softphone UI works unchanged. It is only instantiated when the user's
 * provider is of type "vodia" in production mode (see
 * user_agent_service_patch.js); demo mode keeps using the native UserAgent.
 *
 * @typedef VodiaSession
 * @property {"trying"|"ringing"|"ok"} [inviteState]
 * @property {boolean} isMute
 * @property {boolean} isOnHold
 * @property {import("@voip/core/call_model").Call} call
 * @property {string} [transferTarget]
 * @property {Object} vodia Protocol context: { callid, cseq, isCaller, remoteOffer }
 */
export class VodiaUserAgent {
    attemptingToReconnect = false;
    keepAliveInterval;
    /** @type {RTCPeerConnection} */
    peerConnection;
    preferredInputDevice;
    /** @type {HTMLAudioElement} */
    remoteAudio = new window.Audio();
    /** @type {VodiaSession} */
    session;
    voip;
    /** @type {WebSocket} */
    websocket;
    __closingIntentionally = false;

    constructor(env, services) {
        this.env = env;
        this.callService = services["voip.call"];
        this.multiTabService = services.multi_tab;
        this.notificationService = services.notification;
        this.ringtoneService = services["voip.ringtone"];
        this.voip = services.voip;
        this.softphone = this.voip.softphone;
        const proxy = reactive(this);
        proxy.init();
        return proxy;
    }

    /** @returns {string} The user's extension number on the PBX. */
    get extension() {
        return this.voip.store.settings.voip_username || "";
    }

    /** @returns {Object} */
    get mediaConstraints() {
        const constraints = { audio: true, video: false };
        if (this.preferredInputDevice) {
            constraints.audio = { deviceId: { exact: this.preferredInputDevice } };
        }
        return constraints;
    }

    /** @returns {string} The PBX host (FQDN), without scheme or trailing slash. */
    get pbxHost() {
        let host = (this.voip.pbxAddress || "").trim().replace(/\/+$/, "");
        for (const prefix of ["https://", "http://", "wss://", "ws://"]) {
            if (host.startsWith(prefix)) {
                host = host.slice(prefix.length);
            }
        }
        return host;
    }

    async init() {
        if (this.voip.mode !== "prod") {
            return;
        }
        if (!this.voip.hasRtcSupport) {
            this.voip.triggerError(
                _t(
                    "Your browser does not support some of the features required for VoIP to work. Please try updating your browser or using a different one."
                )
            );
            return;
        }
        if (!this.voip.isServerConfigured) {
            this.voip.triggerError(
                _t("The Vodia PBX address or domain is missing. Please check your settings.")
            );
            return;
        }
        if (!this.voip.areCredentialsSet) {
            this.voip.triggerError(
                _t("Your login details are not set correctly. Please contact your administrator.")
            );
            return;
        }
        this.voip.triggerError(_t("Connecting…"));
        try {
            await this._connect();
        } catch (error) {
            console.error(error);
            // RPC errors carry the meaningful server message (e.g. a
            // UserError raised while minting the token) in error.data.
            const message = error.data?.message || error.message;
            this.voip.triggerError(
                _t("Could not connect to the Vodia PBX:\n\n%(error)s", { error: message })
            );
        }
    }

    async acceptIncomingCall() {
        this.ringtoneService.stopPlaying();
        this.voip.triggerError(_t("Please accept the use of the microphone."));
        let stream;
        try {
            stream = await browser.navigator.mediaDevices.getUserMedia(this.mediaConstraints);
        } catch (error) {
            this._onGetUserMediaFailure(error);
            return;
        }
        this._onGetUserMediaSuccess(stream);
        const { vodia } = this.session;
        try {
            const pc = this._createPeerConnection(vodia.callid);
            for (const track of stream.getTracks()) {
                pc.addTrack(track, stream);
            }
            await pc.setRemoteDescription({ type: "offer", sdp: vodia.remoteOffer });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this._send({
                action: "sdp-200ok",
                sdp: pc.localDescription.sdp,
                callid: vodia.callid,
                cseq: vodia.cseq,
            });
            this.session.inviteState = "ok";
        } catch (error) {
            console.error(error);
            this.voip.triggerError(
                _t("An error occurred while answering the call:\n\n%(error)s", {
                    error: error.message,
                }),
                { isNonBlocking: true }
            );
            this.hangup();
        }
    }

    async attemptReconnection(attemptCount = 0) {
        if (attemptCount > 5) {
            this.voip.triggerError(
                _t("The WebSocket connection was lost and couldn't be reestablished.")
            );
            return;
        }
        if (this.attemptingToReconnect) {
            return;
        }
        this.attemptingToReconnect = true;
        try {
            // A new session token must be minted on every attempt: the previous
            // one is single-use and expires after ~10 seconds.
            await this._connect();
            this.voip.resolveError();
        } catch {
            setTimeout(
                () => this.attemptReconnection(attemptCount + 1),
                2 ** attemptCount * 1000 + Math.random() * 500
            );
        } finally {
            this.attemptingToReconnect = false;
        }
    }

    async hangup({ activityDone = true } = {}) {
        this.ringtoneService.stopPlaying();
        const vodia = this.session.vodia;
        if (vodia?.callid) {
            this._send({
                action: "sip-bye",
                caller: String(Boolean(vodia.isCaller)),
                callid: vodia.callid,
            });
        }
        this._cleanUpPeerConnection();
        switch (this.session.call.state) {
            case "calling":
                await this.callService.abort(this.session.call);
                break;
            case "ongoing":
                await this.callService.end(this.session.call, { activityDone });
                break;
        }
        this.session = null;
        if (this.softphone.isInAutoCallMode) {
            this.softphone.selectNextActivity();
        }
    }

    /** @param {Object} data */
    async makeCall(data) {
        if (!(await this.voip.willCallUsingVoip())) {
            window.location.assign(`tel:${data.phone_number}`);
            return;
        }
        const call = await this.callService.create(data);
        this.softphone.show();
        this.softphone.closeNumpad();
        this.notificationService.add(
            _t("Calling %(phone number)s", { "phone number": call.phoneNumber })
        );
        this.softphone.selectCorrespondence({ call });
        this.session = {
            inviteState: "trying",
            isMute: false,
            isOnHold: false,
            call,
            vodia: {},
        };
        this.ringtoneService.ringback.play();
        await this._invite(call.phoneNumber);
    }

    async rejectIncomingCall() {
        this.ringtoneService.stopPlaying();
        const { vodia } = this.session;
        this._send({
            action: "sip-busy",
            callid: vodia.callid,
            cseq: vodia.cseq,
            code: 603, // Decline
        });
        await this.callService.reject(this.session.call);
        this.session = null;
    }

    /** @param {string} key */
    sendDtmf(key) {
        const sender = this.peerConnection
            ?.getSenders()
            .find((sender) => sender.track?.kind === "audio");
        sender?.dtmf?.insertDTMF(key);
    }

    async setHold(hold) {
        if (!this.session?.vodia?.callid) {
            return;
        }
        this._send({
            action: "wrtc-hold",
            holdcmd: hold ? "sendonly" : "sendrecv",
            callid: this.session.vodia.callid,
        });
        this.session.isOnHold = hold;
        this.updateTracks();
    }

    /** @param {string} deviceId */
    async switchInputStream(deviceId) {
        if (!this.peerConnection) {
            return;
        }
        this.preferredInputDevice = deviceId;
        const stream = await browser.navigator.mediaDevices.getUserMedia(this.mediaConstraints);
        for (const sender of this.peerConnection.getSenders()) {
            if (sender.track) {
                await sender.replaceTrack(stream.getAudioTracks()[0]);
            }
        }
    }

    /**
     * Blind-transfers the call to the given number.
     *
     * @param {string} number
     */
    transfer(number) {
        const { vodia } = this.session;
        this._send({
            action: "blind-transfer2",
            id: vodia.callid,
            from: this.extension,
            to: cleanPhoneNumber(number),
        });
        this._cleanUpPeerConnection();
        this.callService.end(this.session.call);
        this.session = null;
    }

    updateTracks() {
        if (!this.peerConnection) {
            return;
        }
        for (const receiver of this.peerConnection.getReceivers()) {
            if (receiver.track) {
                receiver.track.enabled = !this.session.isOnHold;
            }
        }
        for (const sender of this.peerConnection.getSenders()) {
            if (sender.track) {
                sender.track.enabled = !this.session.isOnHold && !this.session.isMute;
            }
        }
    }

    /**
     * Establishes the authenticated WebSocket connection to the PBX:
     * 1. Asks the Odoo server to mint a single-use session token for the
     *    current user's extension (third-party login, admin credentials never
     *    reach the browser).
     * 2. Activates the token against the Vodia REST API so the session cookie
     *    lands in this browser for the PBX origin.
     * 3. Opens the WebSocket, starts the keep-alive and subscribes to call
     *    events.
     */
    async _connect() {
        const tokenInfo = await this.voip.orm.call("voip.provider", "get_vodia_session_token", [
            [this.voip.providerId],
        ]);
        await this._authenticate(tokenInfo);
        const url = `wss://${tokenInfo.pbx}/websocket?domain=${encodeURIComponent(
            tokenInfo.domain
        )}&user=${encodeURIComponent(tokenInfo.user)}`;
        await new Promise((resolve, reject) => {
            const websocket = new WebSocket(url);
            websocket.onopen = () => {
                this.websocket = websocket;
                this.__closingIntentionally = false;
                this._send({ action: "avoid-disconnect" });
                clearInterval(this.keepAliveInterval);
                this.keepAliveInterval = setInterval(
                    () => this._send({ action: "avoid-disconnect" }),
                    30000
                );
                this._send({ action: "own-calls", subscribe: true });
                this.voip.resolveError();
                resolve();
            };
            websocket.onmessage = (ev) => this._onWebSocketMessage(ev);
            websocket.onclose = (ev) => {
                clearInterval(this.keepAliveInterval);
                reject(new Error(`WebSocket closed (code ${ev.code}).`));
                this._onWebSocketDisconnected(ev);
            };
            websocket.onerror = () => {
                reject(new Error("WebSocket connection failed."));
            };
        });
    }

    /**
     * Activates the minted token so that the browser obtains the Vodia session
     * cookie for the PBX origin. Deliberately isolated: if the SameSite=Strict
     * cookie turns out not to be attached to the cross-site WebSocket handshake
     * on the target Vodia version, the fallback (passing the session in the
     * WebSocket URL query string, or sending it as the first frame after
     * connecting) is a change local to this function and to _connect().
     *
     * @param {{ token: string, pbx: string }} tokenInfo
     */
    async _authenticate(tokenInfo) {
        // Deliberately NO Content-Type header: it keeps the request "simple"
        // so the browser sends it without a CORS preflight — Vodia rejects
        // OPTIONS preflights with 403 (its own example client uses no-cors
        // mode for the same reason), while it accepts simple cross-origin
        // POSTs and reflects the origin with Allow-Credentials: true.
        const response = await fetch(`https://${tokenInfo.pbx}/rest/system/session`, {
            method: "POST",
            credentials: "include",
            body: JSON.stringify({ name: "session", value: tokenInfo.token }),
        });
        if (!response.ok) {
            throw new Error(`Vodia session activation failed (HTTP ${response.status}).`);
        }
    }

    _cleanUpPeerConnection() {
        this._cleanUpRemoteAudio();
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
    }

    _cleanUpRemoteAudio() {
        this.remoteAudio.srcObject = null;
        this.remoteAudio.pause();
    }

    /**
     * @param {string} callid
     * @returns {RTCPeerConnection}
     */
    _createPeerConnection(callid) {
        this._cleanUpPeerConnection();
        const pc = new window.RTCPeerConnection();
        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                this._send({ action: "ice-candidate", candidate: ev.candidate, callid });
            }
        };
        pc.ontrack = () => this._setUpRemoteAudio();
        this.peerConnection = pc;
        return pc;
    }

    /** @returns {string} */
    _generateCallId() {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    /** @param {string} phoneNumber */
    async _invite(phoneNumber) {
        let target;
        if (this.voip.willCallFromAnotherDevice) {
            target = this.voip.store.settings.external_device_number;
            this.session.transferTarget = phoneNumber;
        } else {
            target = phoneNumber;
        }
        let stream;
        try {
            stream = await browser.navigator.mediaDevices.getUserMedia(this.mediaConstraints);
        } catch (error) {
            this._onGetUserMediaFailure(error);
            return;
        }
        if (!this.session) {
            // The call was hung up while waiting for the microphone.
            return;
        }
        this._onGetUserMediaSuccess(stream);
        try {
            const callid = this._generateCallId();
            this.session.vodia = { callid, isCaller: true };
            const pc = this._createPeerConnection(callid);
            for (const track of stream.getTracks()) {
                pc.addTrack(track, stream);
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._send({
                action: "sdp-packet",
                to: cleanPhoneNumber(target),
                sdp: pc.localDescription.sdp,
                callid,
            });
        } catch (error) {
            console.error(error);
            this.voip.triggerError(
                _t(
                    "An error occurred trying to invite the following number: %(phoneNumber)s\n\nError: %(error)s",
                    { phoneNumber, error: error.message }
                )
            );
        }
    }

    /** @param {DOMException} error */
    _onGetUserMediaFailure(error) {
        console.error(error);
        const errorMessage = (() => {
            switch (error.name) {
                case "NotAllowedError":
                    return _t(
                        "Cannot access audio recording device. If you have denied access to your microphone, please allow it and try again. Otherwise, make sure that this website is running over HTTPS and that your browser is not set to deny access to media devices."
                    );
                case "NotFoundError":
                    return _t(
                        "No audio recording device available. The application requires a microphone in order to be used."
                    );
                case "NotReadableError":
                    return _t(
                        "A hardware error has occurred while trying to access the audio recording device. Please ensure that your drivers are up to date and try again."
                    );
                default:
                    return _t(
                        "An error occured involving the audio recording device (%(errorName)s):\n%(errorMessage)s",
                        { errorMessage: error.message, errorName: error.name }
                    );
            }
        })();
        this.voip.triggerError(errorMessage, { isNonBlocking: true });
        if (this.session.call.direction === "outgoing") {
            this.hangup();
        } else {
            this.rejectIncomingCall();
        }
    }

    /** @param {MediaStream} stream */
    _onGetUserMediaSuccess(stream) {
        this.voip.resolveError();
        switch (this.session.call.direction) {
            case "outgoing":
                this.ringtoneService.dial.play();
                break;
            case "incoming":
                this.callService.start(this.session.call);
                break;
        }
    }

    /**
     * Triggered when the PBX signals that the incoming call was canceled by
     * the caller before being answered: the call is missed.
     */
    _onIncomingInvitationCanceled() {
        this.ringtoneService.stopPlaying();
        this.callService.miss(this.session.call);
        this._cleanUpPeerConnection();
        this.session = null;
    }

    /**
     * Handles an incoming call invite (an "sdp-packet" pushed by the PBX).
     * Funnels into the exact same UI flow as the native SIP implementation:
     * the CallInvitation component and the softphone need no changes.
     *
     * @param {Object} message
     */
    async _onIncomingInvitation(message) {
        const { callid, cseq } = message;
        if (this.session) {
            this._send({ action: "sip-busy", callid, cseq, code: 486 /* Busy Here */ });
            return;
        }
        if (this.voip.store.settings.should_auto_reject_incoming_calls) {
            this._send({ action: "sip-busy", callid, cseq, code: 488 /* Not Acceptable Here */ });
            return;
        }
        // NOTE: the exact field carrying the caller's number must be confirmed
        // against live traffic from the target Vodia version.
        const phoneNumber = message.from || message.caller || message.user || _t("Unknown");
        const call = await this.callService.create({
            direction: "incoming",
            phone_number: cleanPhoneNumber(String(phoneNumber)),
            state: "calling",
        });
        this.softphone.selectCorrespondence({ call });
        this._send({ action: "sip-ringing", callid, cseq });
        this.session = {
            call,
            isMute: false,
            isOnHold: false,
            vodia: { callid, cseq, isCaller: false, remoteOffer: message.sdp },
        };
        this.softphone.show();
        if (this.multiTabService.isOnMainTab()) {
            this.ringtoneService.incoming.play();
        }
    }

    /**
     * Triggered when the PBX answers our outgoing call ("sdp-200ok"-like
     * message carrying the remote SDP answer).
     *
     * @param {Object} message
     */
    async _onOutgoingInvitationAccepted(message) {
        if (!this.session?.vodia?.isCaller || !this.peerConnection) {
            return;
        }
        this.ringtoneService.stopPlaying();
        // Vodia may assign its own call id instead of echoing ours: adopt it
        // so that subsequent messages (bye, hold, transfer) reference the id
        // the PBX knows.
        if (message.callid) {
            this.session.vodia.callid = message.callid;
        }
        if (message.cseq !== undefined) {
            this.session.vodia.cseq = message.cseq;
        }
        try {
            await this.peerConnection.setRemoteDescription({ type: "answer", sdp: message.sdp });
        } catch (error) {
            console.error(error);
            this.voip.triggerError(
                _t("An error occurred while establishing the call:\n\n%(error)s", {
                    error: error.message,
                }),
                { isNonBlocking: true }
            );
            this.hangup();
            return;
        }
        this.session.vodia.answered = true;
        this.session.inviteState = "ok";
        this._setUpRemoteAudio();
        if (this.voip.willCallFromAnotherDevice) {
            this.transfer(this.session.transferTarget);
            return;
        }
        this.callService.start(this.session.call);
    }

    /**
     * Handles an updated SDP for an already-established call (e.g. the final
     * answer after early media, or a renegotiation on hold/resume). Never
     * fatal: a failure to apply a renegotiated SDP must not kill the call.
     *
     * @param {Object} message
     */
    async _onUpdatedSdp(message) {
        if (!this.peerConnection || !message.sdp) {
            return;
        }
        if (message.callid) {
            this.session.vodia.callid = message.callid;
        }
        if (message.cseq !== undefined) {
            this.session.vodia.cseq = message.cseq;
        }
        try {
            // An RTCPeerConnection in "stable" state cannot take another
            // answer directly; a full renegotiation would require a new
            // offer/answer round. Applying is only attempted when legal.
            if (this.peerConnection.signalingState === "have-local-offer") {
                await this.peerConnection.setRemoteDescription({
                    type: "answer",
                    sdp: message.sdp,
                });
            }
        } catch (error) {
            console.error("[voip_vodia] could not apply updated SDP:", error);
        }
        this._setUpRemoteAudio();
    }

    /**
     * Triggered when the PBX rejects our outgoing call. Mirrors the native
     * SIP status-code-to-message mapping.
     *
     * @param {number} statusCode
     * @param {string} reasonPhrase
     */
    _onOutgoingInvitationRejected(statusCode, reasonPhrase = "") {
        this.ringtoneService.stopPlaying();
        if (statusCode === 487) {
            // Request Terminated: canceled by the user, session already ended.
            return;
        }
        const errorMessage = (() => {
            switch (statusCode) {
                case 404: // Not Found
                case 488: // Not Acceptable Here
                case 603: // Decline
                    return _t(
                        "The number is incorrect, the user credentials could be wrong or the connection cannot be made. Please check your configuration.\n(Reason received: %(reasonPhrase)s)",
                        { reasonPhrase }
                    );
                case 486: // Busy Here
                case 600: // Busy Everywhere
                    return _t("The person you try to contact is currently unavailable.");
                default:
                    return _t("Call rejected (reason: “%(reasonPhrase)s”)", { reasonPhrase });
            }
        })();
        this.voip.triggerError(errorMessage, { isNonBlocking: true });
        this.callService.reject(this.session.call);
        this._cleanUpPeerConnection();
        this.session = null;
    }

    /**
     * Triggered when the remote party hangs up an established call.
     */
    async _onRemoteBye() {
        if (!this.session) {
            return;
        }
        this.ringtoneService.stopPlaying();
        await this.callService.end(this.session.call);
        this._cleanUpPeerConnection();
        this.session = null;
        if (this.softphone.isInAutoCallMode) {
            this.softphone.selectNextActivity();
        }
    }

    /** @param {CloseEvent} ev */
    _onWebSocketDisconnected(ev) {
        this.websocket = null;
        if (this.__closingIntentionally) {
            return;
        }
        console.error(ev);
        this.voip.triggerError(
            _t(
                "The websocket connection to the server has been lost. Attempting to reestablish the connection…"
            )
        );
        this.attemptReconnection();
    }

    /**
     * Dispatches inbound WebSocket messages.
     *
     * NOTE: The Vodia documentation does not fully specify the inbound message
     * schemas. The action names handled here mirror the outbound protocol
     * actions; they must be tuned against live traffic captured from the
     * target PBX (e.g. from Vodia's own user portal via the browser dev
     * tools). Unknown messages are logged in debug mode to make that tuning
     * easy.
     *
     * @param {MessageEvent} ev
     */
    _onWebSocketMessage(ev) {
        let message;
        try {
            message = JSON.parse(ev.data);
        } catch {
            return;
        }
        // Always logged at debug level: enable the "Verbose" filter in the
        // browser console to capture the live message schemas.
        console.debug("[voip_vodia] received:", ev.data);
        const action = message.action || message.type || "";
        switch (action) {
            case "sdp-packet": {
                if (this.session?.vodia?.isCaller && !this.session.vodia.answered) {
                    // SDP sent to us while we have a pending outgoing call:
                    // this is the answer (possibly early media). Vodia may use
                    // its own call id rather than echoing ours, so do not
                    // require a callid match here.
                    this._onOutgoingInvitationAccepted(message);
                } else if (!this.session) {
                    this._onIncomingInvitation(message);
                } else if (this.session.vodia?.isCaller) {
                    // Updated SDP for the established call (e.g. on pickup
                    // after early media, or on hold/resume).
                    this._onUpdatedSdp(message);
                } else {
                    this._send({
                        action: "sip-busy",
                        callid: message.callid,
                        cseq: message.cseq,
                        code: 486 /* Busy Here */,
                    });
                }
                break;
            }
            case "sdp-200ok":
            case "sdp-answer":
                if (this.session?.vodia?.answered) {
                    this._onUpdatedSdp(message);
                } else {
                    this._onOutgoingInvitationAccepted(message);
                }
                break;
            case "sip-ringing":
            case "ringing": {
                if (this.session?.vodia?.isCaller) {
                    this.ringtoneService.ringback.play();
                    this.session.inviteState = "ringing";
                }
                break;
            }
            case "ice-candidate": {
                if (this.peerConnection && message.candidate) {
                    this.peerConnection
                        .addIceCandidate(message.candidate)
                        .catch((error) => console.error(error));
                }
                break;
            }
            case "sip-bye":
            case "bye":
                this._onRemoteBye();
                break;
            case "sip-cancel":
            case "cancel": {
                if (this.session && !this.session.vodia?.isCaller) {
                    this._onIncomingInvitationCanceled();
                }
                break;
            }
            case "sip-busy": {
                if (this.session?.vodia?.isCaller) {
                    this._onOutgoingInvitationRejected(
                        Number(message.code) || 486,
                        message.reason || ""
                    );
                }
                break;
            }
            default: {
                const statusCode = Number(message.code || message.statusCode);
                if (this.session?.vodia?.isCaller && statusCode >= 400) {
                    this._onOutgoingInvitationRejected(statusCode, message.reason || "");
                }
                break;
            }
        }
    }

    _setUpRemoteAudio() {
        if (!this.peerConnection) {
            return;
        }
        const remoteStream = new MediaStream();
        for (const receiver of this.peerConnection.getReceivers()) {
            if (receiver.track) {
                remoteStream.addTrack(receiver.track);
                // According to the SIP.js documentation, this is needed by Safari to work.
                this.remoteAudio.load();
            }
        }
        this.remoteAudio.srcObject = remoteStream;
        this.remoteAudio.play();
    }

    /** @param {Object} data */
    _send(data) {
        if (this.websocket?.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify(data));
        }
    }
}
