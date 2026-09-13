
# Sentry → Slack (Vercel, Slack Bot token)

Two endpoints that receive Sentry webhooks and send formatted alerts to Slack **using a Slack App Bot token** (via `chat.postMessage`).

## Endpoints
- `api/sentry-backend.js` → for your backend project
- `api/sentry-frontend.js` → for your frontend project

Both reuse the shared helper in `api/_sentrySlack.js`.

## Setup

1) **Create a Slack App** (if you don't have one), add the **Bot Token Scopes**:
   - `chat:write`
   - `chat:write.public` (only if posting to public channels your bot isn't in)
   - `files:write` (only if you attach feedback screenshots — see `SENTRY_AUTH_TOKEN` below)
   - Invite the bot to the target channels.

2) **Get the channel IDs**  
   In Slack, open the channel → *About* → *Channel ID* (e.g., `C0123ABCDE`).

3) **Set Environment Variables in Vercel**  
   Project → *Settings* → *Environment Variables*:
   - `SLACK_APP_AUTH_TOKEN` = `xoxb-...`
   - `SLACK_CHANNEL_BACKEND` = `C0123ABCDE`
   - `SLACK_CHANNEL_FRONTEND` = `C0456FGHIJ`
   - `SLACK_CHANNEL_FEEDBACK` = `C0789KLMNO` *(optional)* — when set, Sentry **User Feedback** notifications
     are routed to this channel instead; when unset, everything goes to the backend/frontend channels
     as before. Feedback notifications include the reporter's original message.
   - `SENTRY_AUTH_TOKEN` = `sntrys_...` *(optional)* — when set, screenshots submitted with the
     feedback widget are fetched from the Sentry API (token needs the `project:read` scope) and
     attached to the Slack notification; when unset, feedback notifications post without images.

4) **Deploy and point Sentry Webhooks**
   - Backend Sentry project → Webhook URL: `https://<your-app>.vercel.app/api/sentry-backend`
   - Frontend Sentry project → Webhook URL: `https://<your-app>.vercel.app/api/sentry-frontend`

## Local dev (optional)
```bash
npm i -g vercel
vercel dev
```
Then POST the sample Sentry payload to `http://localhost:3000/api/sentry-backend` to test.

## Notes
- Uses Node 18+ global `fetch` (no extra deps).
- Handles Slack 429 rate-limit with a simple wait-and-retry.
- You can filter levels or add signature verification if desired (see comments in `_sentrySlack.js`).
