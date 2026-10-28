// Twitch Chat Poll - server
// Reads Twitch chat anonymously (read-only, no login), counts votes, pushes live state to an OBS overlay.
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { EventSubClient } = require("./eventsub");

// Load simple KEY=value entries for local development while preserving shell-provided overrides.
try {
  const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_all, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== "ENOENT") console.error("Could not read .env:", error.message);
}

const PORT = process.env.PORT || 3000;
// Bind to localhost by default so the control API is not reachable from the network.
const HOST = process.env.HOST || "127.0.0.1";
// Optional: if set, every control (POST) request must send this token. Required if you set HOST=0.0.0.0.
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const ENABLE_TEST_VOTES = process.env.ENABLE_TEST_VOTES !== "0";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const BONUS_REWARD_TITLE = process.env.BONUS_REWARD_TITLE || "Bonus Vote";
const configuredBonusVotes = Number.parseInt(process.env.BONUS_VOTES || "1", 10);
const BONUS_VOTES = Number.isSafeInteger(configuredBonusVotes) && configuredBonusVotes > 0 ? configuredBonusVotes : 1;
const MAX_HISTORY = 200;
const MAX_LEADERBOARD = 1000;

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !CONTROL_TOKEN) {
  console.error("Refusing to listen on " + HOST + " without CONTROL_TOKEN set.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws", maxPayload: 1024 });

// ---------- State ----------
let channel = "";
let poll = null; // { question, options:[{text,votes}], open, voters:Set }
let history = [];
let leaderboard = {}; // username -> votes cast

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  history = Array.isArray(saved.history) ? saved.history.slice(-MAX_HISTORY) : [];
  leaderboard = saved.leaderboard && typeof saved.leaderboard === "object" ? saved.leaderboard : {};
} catch (e) {
  if (e.code !== "ENOENT") console.error("Could not load data.json, starting fresh:", e.message);
}

function trimLeaderboard() {
  const entries = Object.entries(leaderboard);
  if (entries.length <= MAX_LEADERBOARD) return;
  leaderboard = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_LEADERBOARD));
}

// Debounced, atomic (write temp file then rename), async save.
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    history = history.slice(-MAX_HISTORY);
    trimLeaderboard();
    const tmp = DATA_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify({ history, leaderboard }, null, 2), (err) => {
      if (err) return console.error("save failed:", err.message);
      fs.rename(tmp, DATA_FILE, (err2) => err2 && console.error("save failed:", err2.message));
    });
  }, 500);
}

function publicState() {
  const total = poll ? poll.options.reduce((s, o) => s + o.votes, 0) : 0;
  const top = Object.entries(leaderboard)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, votes]) => ({ name, votes }));
  return {
    channel,
    connected: ircConnected,
    ircError,
    poll: poll
      ? {
          question: poll.question,
          open: poll.open,
          total,
          options: poll.options.map((o) => ({ text: o.text, votes: o.votes })),
        }
      : null,
    top,
    history: history.slice(-5).reverse(),
  };
}

// Throttle broadcasts: a busy chat can send hundreds of votes a second.
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const msg = JSON.stringify({ type: "state", state: publicState() });
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
  }, 100);
}

function broadcastBonus(event) {
  const msg = JSON.stringify({ type: "bonus", event });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", state: publicState() }));
});

// ---------- Twitch chat (anonymous IRC over WebSocket) ----------
let irc = null;
let ircConnected = false;
let ircError = "";
let reconnectTimer = null;
let reconnectAttempts = 0;
let watchdog = null;

function resetWatchdog(sock) {
  clearTimeout(watchdog);
  // Twitch pings about every 5 minutes; if we hear nothing for 6, the socket is dead.
  watchdog = setTimeout(() => { if (irc === sock) { try { sock.terminate(); } catch (_) {} } }, 6 * 60 * 1000);
}

function connectChat() {
  clearTimeout(reconnectTimer);
  clearTimeout(watchdog);
  if (irc) {
    const old = irc;
    irc = null; // mark stale first so its close event is ignored
    try { old.removeAllListeners(); old.on("error", () => {}); old.close(); } catch (_) {}
  }
  ircConnected = false;
  ircError = "";
  if (!channel) { broadcast(); return; }

  const sock = new WebSocket("wss://irc-ws.chat.twitch.tv:443", { handshakeTimeout: 10000 });
  irc = sock;
  const ch = channel;
  sock.on("open", () => {
    sock.send("PASS SCHMOOPIIE");
    sock.send("NICK justinfan" + (10000 + crypto.randomInt(89999)));
    sock.send("JOIN #" + ch);
    resetWatchdog(sock);
  });
  sock.on("message", (data) => {
    if (irc !== sock) return;
    resetWatchdog(sock);
    data.toString().split("\r\n").forEach((line) => {
      if (!line) return;
      if (line.startsWith("PING")) return sock.send("PONG :tmi.twitch.tv");
      if (line.includes(" 366 ")) { ircConnected = true; ircError = ""; reconnectAttempts = 0; console.log("Joined #" + ch); broadcast(); return; }
      if (/ NOTICE /.test(line) || /^:tmi\.twitch\.tv 4\d\d /.test(line)) {
        ircError = line.replace(/^.*?:/, "").slice(0, 200);
        console.error("IRC notice:", line);
        broadcast();
      }
      const m = line.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
      if (m) handleChat(m[1].toLowerCase(), m[2].trim());
    });
  });
  sock.on("close", () => {
    if (irc !== sock) return; // stale socket
    irc = null;
    ircConnected = false;
    broadcast();
    if (channel) {
      // exponential backoff: 3s, 6s, 12s ... capped at 60s
      const delay = Math.min(60000, 3000 * 2 ** reconnectAttempts++);
      reconnectTimer = setTimeout(connectChat, delay);
    }
  });
  sock.on("error", (e) => { console.error("IRC error:", e.message); ircError = e.message; });
}

// Accepts "1", "2", "!vote 2", "!1" etc. Returns true only if a vote was actually counted.
function handleChat(user, text) {
  if (!poll || !poll.open) return false;
  const m = text.match(/^(?:!vote\s+|!)?([1-9])$/i);
  if (!m) return false;
  const idx = parseInt(m[1], 10) - 1;
  if (idx >= poll.options.length) return false;
  if (poll.voters.has(user)) return false; // one vote per person
  poll.voters.add(user);
  poll.options[idx].votes++;
  leaderboard[user] = (leaderboard[user] || 0) + 1;
  broadcast();
  return true;
}

function addBonusVotes(name, count, preferredOption, source) {
  if (!poll || !poll.open || !poll.options.length) return false;
  let optionIndex = -1;
  const choice = String(preferredOption || "").trim();
  const numberChoice = choice.match(/^([1-9])$/);
  if (numberChoice) {
    const candidate = Number(numberChoice[1]) - 1;
    if (candidate < poll.options.length) optionIndex = candidate;
  } else if (choice) {
    optionIndex = poll.options.findIndex((option) => option.text.toLowerCase() === choice.toLowerCase());
  }
  if (optionIndex < 0) {
    optionIndex = 0;
    for (let i = 1; i < poll.options.length; i++) {
      if (poll.options[i].votes > poll.options[optionIndex].votes) optionIndex = i;
    }
  }

  const votes = Math.max(1, Math.floor(Number(count) || 1));
  const who = String(name || "Anonymous").slice(0, 80);
  poll.options[optionIndex].votes += votes;
  if (who.toLowerCase() !== "anonymous") {
    const key = who.toLowerCase();
    leaderboard[key] = (leaderboard[key] || 0) + votes;
  }
  save();
  broadcast();
  broadcastBonus({ who, votes, option: poll.options[optionIndex].text, source });
  return true;
}

function handleEventSub(type, event) {
  if (type === "channel.channel_points_custom_reward_redemption.add") {
    const rewardTitle = String(event.reward && event.reward.title || "");
    if (rewardTitle.toLowerCase() !== BONUS_REWARD_TITLE.toLowerCase()) return;
    addBonusVotes(event.user_name || event.user_login, BONUS_VOTES, event.user_input, "Channel Points");
    return;
  }
  if (type === "channel.subscribe") {
    // Gifted recipients are counted in channel.subscription.gift to avoid awarding twice.
    if (event.is_gift) return;
    addBonusVotes(event.user_name || event.user_login, BONUS_VOTES, "", "Subscription");
    return;
  }
  if (type === "channel.subscription.message") {
    addBonusVotes(event.user_name || event.user_login, BONUS_VOTES, "", "Resubscription");
    return;
  }
  if (type === "channel.subscription.gift") {
    const who = event.is_anonymous ? "Anonymous" : (event.user_name || event.user_login || "Anonymous");
    const total = Math.max(1, Math.floor(Number(event.total) || 1));
    addBonusVotes(who, BONUS_VOTES * total, "", total > 1 ? `${total} Gift Subscriptions` : "Gift Subscription");
  }
}

// ---------- Control API: token check + rate limit ----------
const hits = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.socket.remoteAddress;
  let h = hits.get(key);
  if (!h || h.resetAt < now) { h = { count: 0, resetAt: now + 10000 }; hits.set(key, h); }
  if (++h.count > 30) return res.status(429).json({ error: "Too many requests, slow down" });
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k); }, 60000).unref();

function requireAuth(req, res, next) {
  if (!CONTROL_TOKEN) return next();
  const given = Buffer.from(String(req.get("x-control-token") || ""));
  const want = Buffer.from(CONTROL_TOKEN);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.status(401).json({ error: "Invalid or missing control token" });
}

app.get("/api/state", (req, res) => res.json(publicState()));
app.use("/api", (req, res, next) => (req.method === "POST" ? rateLimit(req, res, () => requireAuth(req, res, next)) : next()));

app.post("/api/channel", (req, res) => {
  const c = String(req.body.channel || "").trim().toLowerCase().replace(/^#/, "");
  if (!/^[a-z0-9_]{3,25}$/.test(c)) return res.status(400).json({ error: "Invalid channel name" });
  channel = c;
  reconnectAttempts = 0;
  connectChat();
  res.json({ ok: true });
});

app.post("/api/poll", (req, res) => {
  if (!Array.isArray(req.body.options)) return res.status(400).json({ error: "options must be a list" });
  const question = String(req.body.question || "").trim().slice(0, 140);
  const seen = new Set();
  const options = [];
  for (const o of req.body.options) {
    if (typeof o !== "string") continue;
    const text = o.trim().slice(0, 60);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue; // skip blanks and duplicates
    seen.add(key);
    options.push(text);
    if (options.length === 6) break;
  }
  if (!question || options.length < 2) return res.status(400).json({ error: "Need a question and at least 2 different options" });
  poll = { question, options: options.map((text) => ({ text, votes: 0 })), open: true, voters: new Set() };
  broadcast();
  res.json({ ok: true });
});

app.post("/api/close", (req, res) => {
  if (!poll) return res.status(400).json({ error: "No poll" });
  if (!poll.open) return res.status(400).json({ error: "Poll already closed" });
  poll.open = false;
  const max = Math.max(...poll.options.map((o) => o.votes));
  const winners = poll.options.filter((o) => o.votes === max && max > 0).map((o) => o.text);
  history.push({ question: poll.question, winner: winners.join(" / ") || "No votes", total: poll.options.reduce((s, o) => s + o.votes, 0) });
  history = history.slice(-MAX_HISTORY);
  save();
  broadcast();
  res.json({ ok: true });
});

app.post("/api/clear", (req, res) => {
  poll = null;
  broadcast();
  res.json({ ok: true });
});

// Simulate a vote without Twitch (disable with ENABLE_TEST_VOTES=0).
app.post("/api/testvote", (req, res) => {
  if (!ENABLE_TEST_VOTES) return res.status(404).json({ error: "Test votes are disabled" });
  if (!poll || !poll.open) return res.status(400).json({ error: "No open poll" });
  const counted = handleChat("tester" + crypto.randomInt(1e9), String(req.body.option || "1"));
  if (!counted) return res.status(400).json({ error: "Vote not counted (invalid option?)" });
  save(); // keep test-voter leaderboard consistent with votes cast
  res.json({ ok: true });
});

// Express error handler: malformed JSON etc. -> clean 400 instead of stack trace.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad JSON" });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

// Flush data on shutdown so closed-poll history and leaderboard aren't lost.
const eventSub = new EventSubClient({
  onEvent: handleEventSub,
  logger: console,
});
eventSub.start();

function shutdown() {
  eventSub.stop();
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ history, leaderboard }, null, 2)); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Control panel: http://localhost:${PORT}/control.html`);
  console.log(`OBS overlay:   http://localhost:${PORT}/overlay.html`);
  if (CONTROL_TOKEN) console.log("Control token auth: ON");
});
