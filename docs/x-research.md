# X (Twitter) live chat — research notes

Status (2026-10-05): **X is paused in UniChat.** Live detection worked, but no no-login way to read X Live chat was found.

## What worked (no login, server-side)
- Anonymous guest token: `POST api.x.com/1.1/guest/activate.json` with X's public web bearer.
- Account → live broadcast: GraphQL `UserByScreenName` → `UserTweets` → first `x.com/i/broadcasts/<id>` link that is running and hosted by that account. Only finds a stream if the go-live post is among the recent posts; a pasted broadcast link is more reliable.
- Broadcast details: `1.1/broadcasts/show.json?ids=<id>`; fallback GraphQL `BroadcastQuery` (variables `{"id":…}`; logged-out pages send `{"broadcastId":…}`) → media key, title, state, host.
- Guest access gets 0 recent posts for some accounts, so the pasted-link path matters.

## What failed
- **Periscope chat (the classic method):** `1.1/live_video_stream/status/<mediaKey>` → `chatToken` → `POST proxsee-cf.pscp.tv/api/v2/accessChatPublic` → `{endpoint, access_token, room_id}` → WebSocket `<endpoint>/chatapi/v1/chatnow` (auth frame kind 3, join frame kind 2 `{room}`).
  It connects and stays open, but during a live test with active chat it delivered **presence frames only, zero chat messages**, whether joining the broadcast id or `room_id`.
- **X's own web player:** a signed-in x.com page makes no Periscope chat traffic; chat comes from a long-lived `GET https://api.x.com/live-chat?broadcastId=<id>&sessionId=<number>`. A signed-out (private) window makes **no `live-chat` request and shows no chat**. Response format and where `sessionId` comes from were not captured.
- Public reports: no 2025–2026 project reads X Live chat anonymously. Known tools either use the same Periscope flow (likely silent the same way) or a signed-in browser with DOM scraping.

## Options for later (ranked)
1. **Restream chat API** — if the stream already goes out through Restream: OAuth app on developers.restream.io, one-way WebSocket `wss://chat.api.restream.io/ws?accessToken=…`, X listed as event source 24, heartbeat ~45 s (reconnect after 60 s silence). Unverified: free-plan app access, token lifetimes, exact X payload fields. Uses a Restream sign-in, not an X one. Next step: create the app and print a few live events.
2. **Probe `api.x.com/live-chat` as a guest** (bearer + guest token, no cookies). Untested; evidence suggests it needs a signed-in session.
3. **Spare X account on the relay** (session cookies as a secret, used only for `live-chat`). Likely works, but breaks X's rules on automated access, risks locks, needs periodic re-sign-in. Requires relaxing the no-login rule.
4. **Official X Livestream API** (docs.x.com/livestream-api): chat as `broadcast.chat` Activity API events via webhook; OAuth 2.0 PKCE (`broadcast.read`) plus an access form aimed at companies. Usage is pay-per-use (roughly $0–65/month at small-stream volumes, price for this event unpublished); approval for an individual is unlikely.

## Re-enabling
The site keeps its X code behind one switch (see `X_ENABLED`); the relay keeps its X channel and status lookup. Saved X settings are kept.
