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
    /**
     * Remote ICE candidates received before the peer connection has a remote
     * description (e.g. the PBX trickles its candidate right after the
     * invitesdp, before the user accepts the call). They are applied as soon
     * as the remote description is set.
     *
     * @type {RTCIceCandidateInit[]}
     */
    pendingRemoteIceCandidates = [];
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
        // Mobile OSes suspend the page when the app is backgrounded, killing
        // the WebSocket; reconnect immediately when it comes back to the
        // foreground instead of waiting for a retry timer.
        document.addEventListener("visibilitychange", () => {
            if (
                document.visibilityState === "visible" &&
                !proxy.websocket &&
                !proxy.attemptingToReconnect &&
                proxy.voip.mode === "prod"
            ) {
                proxy.attemptReconnection();
            }
        });
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
        if (!this.session?.vodia || this.session.vodia.accepting) {
            // Already being accepted (double click on the Accept button).
            return;
        }
        this.session.vodia.accepting = true;
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
            this._flushPendingIceCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            // The answer is sent in the object form used by Vodia's own
            // client: {"sdp": {"sdp": ..., "type": "answer"}}.
            this._send({
                action: "sdp-200ok",
                sdp: { sdp: answer.sdp, type: "answer" },
                callid: vodia.callid,
                cseq: vodia.cseq,
            });
            vodia.answered = true;
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
        // WebSocket auth strategies, tried in order:
        // - "cookie": activate the token via fetch so the session cookie is
        //   presented on the WS handshake. Works on Chrome (desktop/Android),
        //   but WebKit (iOS/Safari) blocks third-party cookies entirely.
        // - "session": the Odoo server activates the token and returns the
        //   live session id, passed as the "session" WS URL parameter — no
        //   browser cookies involved (the iOS path).
        // - "query": pass the fresh unactivated token in the URL (some PBX
        //   versions may exchange it server-side).
        // - "proxy": connect through the Odoo origin (first-party for every
        //   browser); requires the nginx block documented in the README,
        //   which maps the session URL parameter to the Cookie header.
        // The first strategy that works is remembered for reconnections. For
        // debugging, one strategy can be forced from the browser console:
        //   localStorage.setItem("voip_vodia.authStrategy", "session")
        const ALL_STRATEGIES = ["cookie", "session", "query", "proxy"];
        const forced = window.localStorage?.getItem("voip_vodia.authStrategy");
        const strategies = ALL_STRATEGIES.includes(forced)
            ? [forced]
            : this.__wsAuthStrategy
              ? [
                    this.__wsAuthStrategy,
                    ...ALL_STRATEGIES.filter((strategy) => strategy !== this.__wsAuthStrategy),
                ]
              : ALL_STRATEGIES;
        const failures = [];
        for (const strategy of strategies) {
            try {
                await this._connectOnce(strategy);
                this.__wsAuthStrategy = strategy;
                console.info(`[voip_vodia] connected (auth strategy: ${strategy})`);
                return;
            } catch (error) {
                failures.push(`${strategy}: ${error.data?.message || error.message}`);
                console.info(`[voip_vodia] auth strategy "${strategy}" failed:`, error.message);
            }
        }
        // Per-strategy detail so the failure cause is visible on devices
        // without an accessible console (iOS).
        throw new Error(failures.join("\n"));
    }

    /** @param {"cookie"|"session"|"query"} strategy */
    async _connectOnce(strategy) {
        // A fresh token per attempt: they are single-use and ~10s-lived. The
        // "session" strategy asks the server to also activate it and return
        // the live session id.
        const method = ["session", "proxy"].includes(strategy)
            ? "get_vodia_session"
            : "get_vodia_session_token";
        const tokenInfo = await this.voip.orm.call("voip.provider", method, [
            [this.voip.providerId],
        ]);
        // Signaling dialect differs by PBX major version (see _onRemoteSdp).
        // The provider can force it; "auto" picks by the reported version.
        this.pbxVersion = parseFloat(tokenInfo.version) || 0;
        const dialect = tokenInfo.dialect || "auto";
        this.useLegacyDialect =
            dialect === "legacy" ||
            (dialect === "auto" && this.pbxVersion > 0 && this.pbxVersion < 69);
        console.info(
            `[voip_vodia] PBX version: ${tokenInfo.version || "unknown"}, dialect: ${
                this.useLegacyDialect ? "legacy" : "modern"
            }`
        );
        let url;
        if (strategy === "proxy") {
            // Through the Odoo origin: first-party in every browser. The
            // nginx block forwards to the PBX and turns the session
            // parameter into the Cookie header Vodia expects.
            url =
                `wss://${window.location.host}/vodia-ws/websocket` +
                `?pbx=${encodeURIComponent(tokenInfo.pbx)}` +
                `&domain=${encodeURIComponent(tokenInfo.domain)}` +
                `&user=${encodeURIComponent(tokenInfo.user)}` +
                `&session=${encodeURIComponent(tokenInfo.session)}`;
        } else {
            url = `wss://${tokenInfo.pbx}/websocket?domain=${encodeURIComponent(
                tokenInfo.domain
            )}&user=${encodeURIComponent(tokenInfo.user)}`;
            if (strategy === "cookie") {
                await this._authenticate(tokenInfo);
            } else if (strategy === "session") {
                url += `&session=${encodeURIComponent(tokenInfo.session)}`;
            } else {
                url += `&session=${encodeURIComponent(tokenInfo.token)}`;
            }
        }
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
                // domain-calls delivers "call-state" events (alerting →
                // connected), used to detect when an outgoing call is picked
                // up — the PBX sends no explicit connect message to the
                // caller's socket.
                this._send({ action: "domain-calls", subscribe: true });
                // Registers this WebSocket as a phone for the extension: the
                // PBX only routes incoming calls to registered endpoints
                // (they go straight to voicemail otherwise). Same message
                // Vodia's own portal sends on startup.
                this._send({
                    action: "sip-register",
                    useragent: `Odoo VoIP (${window.navigator.userAgent})`,
                });
                this.voip.resolveError();
                resolve();
            };
            websocket.onmessage = (ev) => this._onWebSocketMessage(ev);
            websocket.onclose = (ev) => {
                clearInterval(this.keepAliveInterval);
                reject(new Error(`WebSocket closed (code ${ev.code}).`));
                // Only treat as a lost connection if this socket had actually
                // opened; a close before onopen is a failed connect attempt
                // handled by the strategy loop, not a disconnection.
                if (this.websocket === websocket) {
                    this._onWebSocketDisconnected(ev);
                }
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

    /**
     * Applies a remote ICE candidate, or queues it until the peer connection
     * has a remote description (adding earlier throws).
     *
     * @param {RTCIceCandidateInit} candidateInit
     */
    _addRemoteIceCandidate(candidateInit) {
        if (this.peerConnection?.remoteDescription) {
            this.peerConnection
                .addIceCandidate(candidateInit)
                .catch((error) => console.error(error));
        } else {
            this.pendingRemoteIceCandidates.push(candidateInit);
        }
    }

    _flushPendingIceCandidates() {
        if (!this.peerConnection?.remoteDescription) {
            return;
        }
        for (const candidateInit of this.pendingRemoteIceCandidates.splice(0)) {
            this.peerConnection
                .addIceCandidate(candidateInit)
                .catch((error) => console.error(error));
        }
    }

    _cleanUpPeerConnection() {
        this._cleanUpRemoteAudio();
        this.pendingRemoteIceCandidates = [];
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
        // Candidates the PBX trickled before this call was accepted must
        // survive the cleanup of the previous connection.
        const pendingCandidates = this.pendingRemoteIceCandidates;
        this._cleanUpPeerConnection();
        this.pendingRemoteIceCandidates = pendingCandidates;
        const pc = new window.RTCPeerConnection();
        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                this._send({ action: "ice-candidate", candidate: ev.candidate, callid });
            }
        };
        pc.ontrack = () => this._setUpRemoteAudio();
        pc.oniceconnectionstatechange = () =>
            console.info("[voip_vodia] ICE state:", pc.iceConnectionState);
        pc.onconnectionstatechange = () =>
            console.info("[voip_vodia] connection state:", pc.connectionState);
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
        // For external calls the full E.164 number (+1...) is usually in the
        // "from" SIP URI, while "from-user" may hold the national form.
        const uriMatch = /<sip:([^@;>]+)@/.exec(message.from || "");
        const phoneNumber =
            uriMatch?.[1] || message["from-user"] || message["from-number"] || _t("Unknown");
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
            vodia: { callid, cseq, isCaller: false, remoteOffer: message.invitesdp || message.sdp },
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
     * Triggered when the PBX terminates our call leg: remote party hangup, or
     * an error condition — the message then carries a SIP-style "code" (e.g.
     * {"bye": "true", "callid": ..., "code": 415}).
     *
     * @param {Object} [message]
     */
    async _onRemoteBye(message = {}) {
        if (!this.session) {
            return;
        }
        this.ringtoneService.stopPlaying();
        const statusCode = Number(message.code) || 0;
        if (statusCode >= 400) {
            this.voip.triggerError(
                _t("The PBX terminated the call (code %(code)s).", { code: statusCode }),
                { isNonBlocking: true }
            );
        }
        if (this.session.call.state === "ongoing") {
            await this.callService.end(this.session.call);
        } else if (this.session.call.direction === "incoming") {
            // The caller hung up before the call was answered.
            await this.callService.miss(this.session.call);
        } else if (statusCode >= 400) {
            await this.callService.reject(this.session.call);
        } else {
            await this.callService.abort(this.session.call);
        }
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
        // Most PBX-to-client messages carry NO "action" field (observed on
        // Vodia 70.1): they are identified by their payload fields instead.
        if (!message.action) {
            if (message.invitesdp) {
                // Incoming call: the PBX's SDP offer for our leg.
                this._onIncomingInvitation(message).catch((error) => console.error(error));
            } else if (message.bye) {
                this._onRemoteBye(message).catch((error) => console.error(error));
            } else if (message.sdp) {
                // SDP for our pending call (e.g. code 183 early media). The
                // PBX sends its own OFFER (a=setup:actpass) regardless of the
                // SDP we sent in sdp-packet, and expects an answer back.
                this._onRemoteSdp(message).catch((error) => console.error(error));
            } else if (message.candidate) {
                // Trickle ICE from the PBX: a raw candidate string, plus an
                // "adr" list of (address, port) pairs to substitute into it —
                // one candidate per address (mirrors Vodia's own client).
                const fields = String(message.candidate).trim().split(" ");
                // sdpMLineIndex only (no sdpMid): audio is always the first
                // m-line, and old PBX SDP may lack a=mid, which would make a
                // literal sdpMid fail to match.
                if (Array.isArray(message.adr) && fields.length > 5) {
                    for (const [address, port] of message.adr) {
                        const variant = [...fields];
                        variant[4] = String(address);
                        variant[5] = String(port);
                        this._addRemoteIceCandidate({
                            candidate: variant.join(" "),
                            sdpMLineIndex: 0,
                        });
                    }
                } else {
                    this._addRemoteIceCandidate({
                        candidate: fields.join(" "),
                        sdpMLineIndex: 0,
                    });
                }
            }
            return;
        }
        switch (message.action) {
            case "sdp-packet":
            case "sdp-200ok":
            case "sdp-answer":
                this._onRemoteSdp(message).catch((error) => console.error(error));
                break;
            case "call-state":
                this._onCallState(message);
                break;
            case "sip-ringing":
            case "ringing": {
                if (this.session?.vodia?.isCaller) {
                    this.session.inviteState = "ringing";
                }
                break;
            }
            case "ice-candidate": {
                if (message.candidate) {
                    this._addRemoteIceCandidate(message.candidate);
                }
                break;
            }
            case "sip-bye":
            case "bye":
                this._onRemoteBye(message).catch((error) => console.error(error));
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
            // Informational messages, no call-control impact.
            case "user-change":
            case "blf":
            case "missed-calls":
            case "rec-start":
            case "rec-stop":
            case "bye-response":
                break;
            default:
                break;
        }
    }

    /**
     * Handles SDP pushed by the PBX for our current call. On Vodia the PBX
     * itself makes the WebRTC offer for each leg (its SDP has
     * a=setup:actpass), even for calls we initiate: the client must roll back
     * its own pending offer, apply the PBX's offer and reply with an answer
     * ("sdp-200ok"), otherwise the leg never completes codec negotiation and
     * the PBX kills the call with code 415 on pickup.
     *
     * @param {Object} message
     */
    async _onRemoteSdp(message) {
        if (!this.session || !this.peerConnection) {
            return;
        }
        const pc = this.peerConnection;
        const sdp = typeof message.sdp === "object" ? message.sdp.sdp : message.sdp;
        if (!sdp) {
            return;
        }
        if (message.callid) {
            this.session.vodia.callid = message.callid;
        }
        if (message.cseq !== undefined) {
            this.session.vodia.cseq = message.cseq;
        }
        const statusCode = Number(message.code) || 0;
        if (statusCode >= 400) {
            this._onOutgoingInvitationRejected(statusCode, message.reason || "");
            return;
        }
        let isOffer = /a=setup:actpass/.test(sdp);
        // Dialect split (verified against live 70.1 and 67.0 servers):
        // - v69/70+: the PBX ignores the SDP sent in sdp-packet and sends its
        //   own OFFER to the caller, expecting an sdp-200ok answer back.
        // - v67/68: classic flow — the client's sdp-packet SDP is the offer
        //   and the PBX's SDP is the ANSWER (often mislabeled a=setup:actpass;
        //   its own client forces type "answer" regardless).
        if (isOffer && this.useLegacyDialect && this.session.vodia.isCaller) {
            isOffer = false;
        }
        try {
            if (isOffer) {
                if (pc.signalingState === "have-local-offer") {
                    await pc.setLocalDescription({ type: "rollback" });
                }
                await pc.setRemoteDescription({ type: "offer", sdp });
                this._flushPendingIceCandidates();
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this._send({
                    action: "sdp-200ok",
                    sdp: { sdp: answer.sdp, type: "answer" },
                    callid: this.session.vodia.callid,
                    cseq: this.session.vodia.cseq,
                });
            } else if (pc.signalingState === "have-local-offer") {
                // Answers must declare an active or passive DTLS role;
                // normalize mislabeled actpass answers from old servers.
                const answerSdp = sdp.replace(/a=setup:actpass/g, "a=setup:passive");
                await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
                this._flushPendingIceCandidates();
            }
        } catch (error) {
            console.error("[voip_vodia] could not apply remote SDP:", error);
            return;
        }
        this.session.vodia.answered = true;
        this._setUpRemoteAudio();
        // Local tones stop here: ringback now comes as early media over RTP.
        this.ringtoneService.stopPlaying();
        if (statusCode === 183 || statusCode === 180) {
            this.session.inviteState = "ringing";
        } else if (this.session.vodia.isCaller) {
            // Final responses to our invite are acknowledged (Vodia's own
            // client sends sip-ack for any code >= 200).
            if (statusCode >= 200) {
                this._send({ action: "sip-ack", callid: this.session.vodia.callid });
            }
            this._markConnected();
        }
    }

    /**
     * Marks the outgoing call as picked up (idempotent). Triggered by a
     * code-200 SDP or by a "call-state" event reporting the call connected.
     */
    _markConnected() {
        if (!this.session || this.session.call.state === "ongoing") {
            return;
        }
        this.ringtoneService.stopPlaying();
        this.session.inviteState = "ok";
        if (this.voip.willCallFromAnotherDevice) {
            this.transfer(this.session.transferTarget);
            return;
        }
        this.callService.start(this.session.call);
    }

    /**
     * Handles "call-state" events (domain-calls subscription): used to detect
     * that our outgoing call transitioned to "connected", since the PBX does
     * not push an explicit connect message to the caller's socket.
     *
     * @param {Object} message
     */
    _onCallState(message) {
        if (!this.session?.vodia?.isCaller || !Array.isArray(message.calls)) {
            return;
        }
        const ownCall = message.calls.find(
            (call) =>
                call["from-number"] === this.extension ||
                (call.extension || []).some((ext) => String(ext).replace("*", "") === this.extension)
        );
        if (ownCall?.state === "connected" || (ownCall?.connect && ownCall.connect !== "")) {
            this._markConnected();
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
        // The play() promise rejects with a stackless DOMException when
        // interrupted by pause() (e.g. a call that fails right away), which
        // crashes Odoo's uncaught-rejection formatter: always swallow it.
        Promise.resolve(this.remoteAudio.play()).catch(() => {});
    }

    /** @param {Object} data */
    _send(data) {
        if (this.websocket?.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify(data));
        }
    }
}
