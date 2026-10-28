const WebSocket = require("ws");

const HELIX_SUBSCRIPTIONS = [
  "channel.channel_points_custom_reward_redemption.add",
  "channel.subscribe",
  "channel.subscription.message",
  "channel.subscription.gift",
];

class EventSubClient {
  constructor({
    url = process.env.EVENTSUB_URL || "wss://eventsub.wss.twitch.tv/ws",
    clientId = process.env.TWITCH_CLIENT_ID || "",
    userToken = process.env.TWITCH_USER_TOKEN || "",
    broadcasterId = process.env.TWITCH_BROADCASTER_ID || "",
    WebSocketImpl = WebSocket,
    fetchImpl = globalThis.fetch,
    onEvent = () => {},
    logger = console,
    watchdogGraceMs = 0,
    reconnectBaseMs = 3000,
    reconnectMaxMs = 60000,
    maxSeenMessages = 5000,
  } = {}) {
    this.url = url;
    this.clientId = clientId;
    this.userToken = userToken;
    this.broadcasterId = broadcasterId;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.onEvent = onEvent;
    this.logger = logger;
    this.watchdogGraceMs = watchdogGraceMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.maxSeenMessages = maxSeenMessages;
    this.seenMessages = new Set();
    this.seenOrder = [];
    this.socket = null;
    this.handoffSocket = null;
    this.handoffUrl = "";
    this.watchdog = null;
    this.reconnectTimer = null;
    this.reconnectHandoff = false;
    this.reconnectAttempts = 0;
    this.stopped = true;
  }

  get configured() {
    return Boolean(this.clientId && this.userToken && this.broadcasterId && this.fetchImpl);
  }

  start() {
    if (!this.configured) {
      this.logger.info("EventSub disabled: set TWITCH_CLIENT_ID, TWITCH_USER_TOKEN, and TWITCH_BROADCASTER_ID.");
      return false;
    }
    if (!this.stopped) return true;
    this.stopped = false;
    this.connect(this.url, false);
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    this.reconnectHandoff = false;
    const sockets = new Set([this.socket, this.handoffSocket]);
    this.socket = null;
    this.handoffSocket = null;
    for (const socket of sockets) {
      if (!socket) continue;
      try { socket.removeAllListeners(); socket.on("error", () => {}); socket.close(); } catch (_) {}
    }
  }

  connect(url, handoff) {
    if (this.stopped) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(url, { handshakeTimeout: 10000 });
    } catch (error) {
      this.logger.error("EventSub connection failed:", error.message);
      this.scheduleReconnect(handoff ? url : this.url, handoff);
      return;
    }

    if (handoff) {
      this.handoffSocket = socket;
      this.handoffUrl = url;
    } else {
      this.socket = socket;
    }

    socket.on("open", () => {});
    socket.on("message", (data) => this.handleMessage(socket, data, handoff));
    socket.on("close", () => this.handleClose(socket, handoff));
    socket.on("error", (error) => this.logger.error("EventSub WebSocket error:", error.message));
  }

  handleMessage(socket, data, handoff) {
    let message;
    try { message = JSON.parse(data.toString()); } catch (_) { return; }
    const metadata = message.metadata || {};
    const payload = message.payload || {};

    if (metadata.message_type === "session_welcome") {
      const session = payload.session || {};
      if (handoff && this.handoffSocket === socket) {
        const oldSocket = this.socket;
        this.socket = socket;
        this.handoffSocket = null;
        this.handoffUrl = "";
        this.reconnectAttempts = 0;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.reconnectHandoff = false;
        this.armWatchdog(socket, session.keepalive_timeout_seconds);
        if (oldSocket && oldSocket !== socket) {
          try { oldSocket.close(); } catch (_) {}
        }
        this.logger.info("EventSub session handoff complete.");
      } else if (!handoff && this.socket === socket) {
        this.reconnectAttempts = 0;
        this.armWatchdog(socket, session.keepalive_timeout_seconds);
        void this.createSubscriptions(session.id);
      }
      return;
    }

    if (socket === this.socket || socket === this.handoffSocket) {
      if (socket === this.socket) this.refreshWatchdog(socket);
    }

    if (metadata.message_type === "session_keepalive") return;
    if (metadata.message_type === "session_reconnect") {
      const reconnectUrl = payload.session && payload.session.reconnect_url;
      if (socket === this.socket && reconnectUrl && !this.handoffSocket) {
        this.connect(reconnectUrl, true);
      }
      return;
    }
    if (metadata.message_type === "notification") {
      const messageId = metadata.message_id;
      if (!messageId || this.rememberMessage(messageId)) return;
      const subscriptionType = metadata.subscription_type || (payload.subscription && payload.subscription.type);
      try { this.onEvent(subscriptionType, payload.event || {}, messageId); }
      catch (error) { this.logger.error("EventSub event handler failed:", error.message); }
      return;
    }
    if (metadata.message_type === "revocation") {
      const subscription = payload.subscription || {};
      this.logger.error(`EventSub subscription revoked (${subscription.type || "unknown"}): ${subscription.status || "unknown"}`);
    }
  }

  armWatchdog(socket, seconds) {
    clearTimeout(this.watchdog);
    socket.keepaliveTimeoutSeconds = Number(seconds);
    const timeoutMs = Math.max(1, Number(seconds) * 1000) + this.watchdogGraceMs;
    this.watchdog = setTimeout(() => {
      if (this.socket !== socket || this.stopped) return;
      this.logger.error("EventSub keepalive timeout; reconnecting.");
      try { socket.terminate(); } catch (_) { this.handleClose(socket, false); }
    }, timeoutMs);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  refreshWatchdog(socket) {
    if (socket !== this.socket || !socket.keepaliveTimeoutSeconds) return;
    this.armWatchdog(socket, socket.keepaliveTimeoutSeconds);
  }

  handleClose(socket, handoff) {
    if (this.stopped) return;
    if (handoff && this.handoffSocket === socket) {
      const retryUrl = this.handoffUrl || this.url;
      this.handoffSocket = null;
      this.handoffUrl = "";
      this.scheduleReconnect(retryUrl, true);
      return;
    }
    if (this.socket !== socket) return;
    this.socket = null;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    this.scheduleReconnect(this.url);
  }

  scheduleReconnect(url, handoff = false) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectHandoff = handoff;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      const retryHandoff = this.reconnectHandoff;
      this.reconnectHandoff = false;
      this.connect(url, retryHandoff);
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  rememberMessage(messageId) {
    if (this.seenMessages.has(messageId)) return true;
    this.seenMessages.add(messageId);
    this.seenOrder.push(messageId);
    if (this.seenOrder.length > this.maxSeenMessages) {
      this.seenMessages.delete(this.seenOrder.shift());
    }
    return false;
  }

  async createSubscriptions(sessionId) {
    if (!sessionId || this.stopped) return;
    for (const type of HELIX_SUBSCRIPTIONS) {
      const body = {
        type,
        version: "1",
        condition: { broadcaster_user_id: this.broadcasterId },
        transport: { method: "websocket", session_id: sessionId },
      };
      try {
        const response = await this.fetchImpl("https://api.twitch.tv/helix/eventsub/subscriptions", {
          method: "POST",
          headers: {
            "Client-Id": this.clientId,
            Authorization: `Bearer ${this.userToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          this.logger.error(`Could not subscribe to ${type} (${response.status})${detail ? `: ${detail}` : ""}`);
        }
      } catch (error) {
        this.logger.error(`Could not subscribe to ${type}:`, error.message);
      }
    }
  }
}

module.exports = { EventSubClient, HELIX_SUBSCRIPTIONS };
