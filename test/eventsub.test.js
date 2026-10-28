const { test } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { EventSubClient, HELIX_SUBSCRIPTIONS } = require("../eventsub");

async function withFakeServer(run) {
  const server = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  try { await run(server, url); }
  finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitFor(predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for fake EventSub server"));
      setTimeout(check, 5);
    };
    check();
  });
}

function welcome(sessionId, keepaliveSeconds = 30) {
  return JSON.stringify({
    metadata: { message_type: "session_welcome" },
    payload: { session: { id: sessionId, keepalive_timeout_seconds: keepaliveSeconds } },
  });
}

function client(url, options = {}) {
  return new EventSubClient({
    url,
    clientId: "client-id",
    userToken: "user-token",
    broadcasterId: "12345",
    reconnectBaseMs: 20,
    reconnectMaxMs: 40,
    logger: { info() {}, error() {} },
    fetchImpl: async () => ({ ok: true, status: 202 }),
    ...options,
  });
}

test("subscribes to four events after welcome and deduplicates notifications", async () => {
  await withFakeServer(async (server, url) => {
    const requests = [];
    const received = [];
    const handled = [];
    const eventsub = client(url, {
      fetchImpl: async (requestUrl, options) => {
        requests.push({ requestUrl, options, body: JSON.parse(options.body) });
        return { ok: true, status: 202 };
      },
      onEvent: (...args) => handled.push(args),
    });
    server.on("connection", (socket) => {
      received.push(socket);
      socket.send(welcome("session-1"));
    });
    eventsub.start();
    await waitFor(() => requests.length === 4);

    assert.deepEqual(requests.map((request) => request.body.type), HELIX_SUBSCRIPTIONS);
    for (const request of requests) {
      assert.equal(request.requestUrl, "https://api.twitch.tv/helix/eventsub/subscriptions");
      assert.equal(request.options.headers["Client-Id"], "client-id");
      assert.equal(request.options.headers.Authorization, "Bearer user-token");
      assert.deepEqual(request.body.condition, { broadcaster_user_id: "12345" });
      assert.deepEqual(request.body.transport, { method: "websocket", session_id: "session-1" });
    }

    const notification = JSON.stringify({
      metadata: { message_type: "notification", message_id: "evt-1", subscription_type: "channel.subscribe" },
      payload: { event: { user_name: "viewer" } },
    });
    received[0].send(notification);
    received[0].send(notification);
    await waitFor(() => handled.length === 1);
    assert.deepEqual(handled[0], ["channel.subscribe", { user_name: "viewer" }, "evt-1"]);
    eventsub.stop();
  });
});

test("uses the reconnect URL and retains existing subscriptions during handoff", async () => {
  await withFakeServer(async (server, url) => {
    const connections = [];
    const requests = [];
    server.on("connection", (socket, request) => {
      connections.push({ socket, path: request.url });
      socket.send(welcome(`session-${connections.length}`));
    });
    const eventsub = client(url, {
      fetchImpl: async (_requestUrl, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, status: 202 };
      },
    });
    eventsub.start();
    await waitFor(() => requests.length === 4 && connections.length === 1);
    connections[0].socket.send(JSON.stringify({
      metadata: { message_type: "session_reconnect" },
      payload: { session: { reconnect_url: `${url}/handoff?keep=this` } },
    }));
    await waitFor(() => connections.length === 2 && !eventsub.handoffSocket && eventsub.socket.url.includes("/handoff"));
    assert.equal(connections[1].path, "/handoff?keep=this");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 4);
    eventsub.stop();
  });
});

test("reconnects after the keepalive watchdog expires", async () => {
  await withFakeServer(async (server, url) => {
    let connections = 0;
    server.on("connection", (socket) => {
      connections++;
      socket.send(welcome(`session-${connections}`, 0.04));
    });
    const eventsub = client(url, { watchdogGraceMs: 5 });
    eventsub.start();
    await waitFor(() => connections >= 2);
    eventsub.stop();
  });
});
