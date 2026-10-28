# Twitch Chat Poll

A live chat poll game for Twitch streamers, built for the Codex x TwitchCon Hackathon.

Viewers vote by typing `1`, `2`, `!1` or `!vote 2` in chat. Results appear live on an OBS overlay, with a top-voters leaderboard (votes cast).

## Parts
- **Server** (`server.js`): Node.js + Express. Reads Twitch chat anonymously over IRC (read-only `justinfan` connection, no login), counts votes (one vote per viewer), pushes live state over WebSocket.
- **Control panel** (`public/control.html`): connect a channel, create/close polls, see history.
- **Overlay** (`public/overlay.html`): transparent live results page for an OBS Browser Source.
- **Storage**: poll history (last 200) and leaderboard (top 1000) saved to `data.json` when a poll closes and on shutdown.

## Run
```bash
npm install
npm start
npm test      # API tests
```
- Control panel: http://localhost:3000/control.html
- OBS overlay: http://localhost:3000/overlay.html (Browser Source, e.g. 480x600)

## Security / config
| Env var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. Only local by default. |
| `CONTROL_TOKEN` | (none) | If set, control requests need this token (enter it in the control panel). **Required** if `HOST` is not localhost. |
| `ENABLE_TEST_VOTES` | `1` | Set `0` to disable `/api/testvote`. |
| `PORT` | `3000` | Port. |

Control endpoints are rate limited (30 requests / 10 s per client). Never expose the control panel publicly without `CONTROL_TOKEN` and HTTPS.

## Known limitations
- Active poll is in memory only; it is lost on restart (history/leaderboard are kept).
- Twitch connection status uses IRC `366`; verify against a live channel before streaming.
- The leaderboard counts votes cast, not wins.

## Try without Twitch
Create a poll in the control panel and press **+ Test vote**.
