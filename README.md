
# Sentry → Slack (Vercel, Slack Bot token)

Two endpoints that receive Sentry webhooks and send formatted alerts to Slack **using a Slack App Bot token** (via `chat.postMessage`). Two optional extras: webhook requests can require a shared secret token, and every Sentry **User Feedback** notification can also be created as a task in a Notion database — see the environment variables below.

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
   - `SENTRY_WEBHOOK_TOKEN` = `<random string>` *(optional)* — when set, the endpoints only accept
     webhook requests presenting this token (as `?token=...` in the URL, an `X-Webhook-Token`
     header, or an `Authorization: Bearer` header); everything else gets `401`. When unset, all
     requests are accepted as before.
   - `NOTION_TOKEN` = `secret_...` *(optional)* — when set together with `NOTION_FEEDBACK_DB_ID`,
     every **User Feedback** notification is also created as a task in a Notion database. Create an
     internal integration at https://www.notion.so/my-integrations (needs *Insert content*
     capabilities) and add it to the target database (*•••* → *Add connections*).
   - `NOTION_FEEDBACK_DB_ID` = `<database id>` *(optional)* — the database feedback tasks land in.
     Its schema must contain: `Name` (title), `Status` (select with a `New` option),
     `Sentry Issue ID` (rich text), `Source URL` (url), `Reporter` (rich text). Repeated webhooks
     for the same feedback issue never duplicate the task (deduplicated by Sentry issue ID).

4) **Deploy and point Sentry Webhooks**
   - Backend Sentry project → Webhook URL: `https://<your-app>.vercel.app/api/sentry-backend`
   - Frontend Sentry project → Webhook URL: `https://<your-app>.vercel.app/api/sentry-frontend`
   - With `SENTRY_WEBHOOK_TOKEN` set, append the token to both webhook URLs (Sentry webhooks
     can't send custom headers, so the token rides in the query string), e.g.
     `https://<your-app>.vercel.app/api/sentry-frontend?token=<your-secret>`

## Local dev (optional)
```bash
npm i -g vercel
vercel dev
```
Then POST a Sentry webhook payload to `http://localhost:3000/api/sentry-backend` to test (append `?token=<your-secret>` if `SENTRY_WEBHOOK_TOKEN` is set).

## Notes
- Uses Node 18+ global `fetch` (no extra deps).
- Handles Slack 429 rate-limit with a simple wait-and-retry.
- Notion task descriptions carry the full feedback message, the reporter, the page URL the
  feedback was submitted from, and a link to the Sentry issue. Screenshots stay Slack-only — the
  Notion task links to the Sentry issue, where they're visible.
- You can filter levels or add signature verification if desired (see comments in `_sentrySlack.js`).
