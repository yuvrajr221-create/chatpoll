// Run with: npm test   (needs `npm install` first; Node 18+)
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

let port;
let BASE;
const TOKEN = "secret123";
let proc;

const post = (url, body, token = TOKEN) =>
  fetch(BASE + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Control-Token": token } : {}) },
    body: JSON.stringify(body || {}),
  });

before(async () => {
  const portFinder = net.createServer();
  await new Promise((resolve, reject) => {
    portFinder.once("error", reject);
    portFinder.listen(0, "127.0.0.1", resolve);
  });
  port = portFinder.address().port;
  await new Promise((resolve, reject) => portFinder.close((err) => err ? reject(err) : resolve()));
  BASE = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CONTROL_TOKEN: TOKEN, DATA_FILE: path.join(os.tmpdir(), `chatpoll-${port}.json`) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/api/state"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`server did not start on 127.0.0.1:${port} (exit code ${proc.exitCode})`);
});
after(() => proc && proc.kill());

test("control routes require the token", async () => {
  assert.strictEqual((await post("/api/clear", {}, "")).status, 401);
  assert.strictEqual((await post("/api/clear", {}, "wrong")).status, 401);
  assert.strictEqual((await post("/api/clear")).status, 200);
});

test("rejects bad poll input", async () => {
  assert.strictEqual((await post("/api/poll", { question: "q", options: "abc" })).status, 400);
  assert.strictEqual((await post("/api/poll", { question: "q", options: ["a", "A", " a "] })).status, 400); // duplicates
  assert.strictEqual((await post("/api/poll", { question: "", options: ["a", "b"] })).status, 400);
});

test("vote counting: one vote per user, invalid option not counted, close picks winner", async () => {
  assert.strictEqual((await post("/api/poll", { question: "Pick", options: ["A", "B"] })).status, 200);
  assert.strictEqual((await post("/api/testvote", { option: "2" })).status, 200);
  assert.strictEqual((await post("/api/testvote", { option: "9" })).status, 400); // no option 9
  await new Promise((r) => setTimeout(r, 150));
  const s = await (await fetch(BASE + "/api/state")).json();
  assert.strictEqual(s.poll.total, 1);
  assert.strictEqual(s.poll.options[1].votes, 1);
  assert.strictEqual((await post("/api/close")).status, 200);
  assert.strictEqual((await post("/api/close")).status, 400); // already closed
  const s2 = await (await fetch(BASE + "/api/state")).json();
  assert.strictEqual(s2.history[0].winner, "B");
});

test("invalid channel name rejected", async () => {
  assert.strictEqual((await post("/api/channel", { channel: "bad name!" })).status, 400);
});

test("malformed JSON gives 400, not 500", async () => {
  const r = await fetch(BASE + "/api/poll", { method: "POST", headers: { "Content-Type": "application/json", "X-Control-Token": TOKEN }, body: "{oops" });
  assert.strictEqual(r.status, 400);
});
