# Twitch Chat Poll

A live chat poll game for Twitch streamers, built for the Codex x TwitchCon Hackathon.

Viewers vote by typing `1`, `2`, `!1` or `!vote 2` in chat. Results appear live on an OBS overlay, with a top-voters leaderboard (votes cast).

## Parts
- **Server** (`server.js`): Node.js + Express. Reads Twitch chat anonymously over IRC (read-only `justinfan` connection, no login), counts votes (one vote per viewer), pushes live state over WebSocket.
- **EventSub** (`eventsub.js`): receives Channel Points reward redemptions, new subscriptions, resub messages, and gift batches over Twitch’s EventSub WebSocket. Matching events add bonus votes to the chosen option or current leader and appear briefly on the overlay.
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

## Twitch EventSub setup

1. In the [Twitch Developer Console](https://dev.twitch.tv/console/apps), register an application. Set its OAuth Redirect URL to `http://localhost:3000` and keep the app’s **Client ID** and **Client Secret** private. The secret is used by Twitch CLI when obtaining a user token; ChatPoll itself only needs the client ID and user token at runtime.
2. Install and configure the [Twitch CLI](https://dev.twitch.tv/docs/cli/): run `twitch configure` and enter the Client ID and Client Secret. Sign into Twitch as the broadcaster, then request a **user access token** with these exact scopes:

   ```sh
   twitch token --user-token --scopes 'channel:read:redemptions channel:read:subscriptions'
   ```

   Copy the resulting access token (not an app access token). These scopes authorize custom Channel Points redemption events and subscription events, including resubs and gift batches. The access token expires; rerun the CLI command and update `.env` when it does. [Twitch EventSub authorization](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/) · [Twitch CLI token command](https://dev.twitch.tv/docs/cli/token-command/)
3. Find the broadcaster’s numeric Twitch user ID. For example, with `curl` and the user token above, replace the placeholders and run:

   ```sh
   curl 'https://api.twitch.tv/helix/users?login=YOUR_CHANNEL_LOGIN' \
     -H 'Client-Id: YOUR_CLIENT_ID' \
     -H 'Authorization: Bearer YOUR_USER_ACCESS_TOKEN'
   ```

   Use the `id` in the returned `data` entry.
4. Copy `.env.example` to `.env` and set `TWITCH_CLIENT_ID`, `TWITCH_USER_TOKEN`, `TWITCH_BROADCASTER_ID`, and `BONUS_REWARD_TITLE`. Set `BONUS_VOTES` to the number of votes each qualifying event adds. `.env` is ignored by Git; do not commit real credentials.
5. In the broadcaster’s Creator Dashboard, create a custom Channel Points reward whose title exactly matches `BONUS_REWARD_TITLE` (matching ignores letter case). Its optional user input can be an option number (`1`, `2`, …) or an exact option label; blank or unmatched input awards votes to the current leader. New subs and resub messages award the configured amount to the current leader. Gift batches award that amount per gifted subscription; gifted recipients are not also counted as new subs.
6. Start ChatPoll with `npm start`, then open the control panel and connect it to the same channel. ChatPoll reads `.env` automatically, and connects to EventSub when the three Twitch credential/identity variables are present. `EVENTSUB_URL` can override Twitch’s WebSocket URL for local testing; normally leave it unset.

EventSub WebSocket subscriptions require a broadcaster **user access token**. ChatPoll reconnects and recreates subscriptions after a dropped connection; events missed while disconnected cannot be replayed by Twitch. [WebSocket behavior](https://dev.twitch.tv/docs/eventsub/handling-websocket-events)

## Known limitations
- Active poll is in memory only; it is lost on restart (history/leaderboard are kept).
- Twitch connection status uses IRC `366`; verify against a live channel before streaming.
- The leaderboard counts votes cast, not wins.

## Try without Twitch
Create a poll in the control panel and press **+ Test vote**.
