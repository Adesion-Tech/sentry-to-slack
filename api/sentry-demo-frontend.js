// api/sentry-demo-frontend.js
// Demo lives in its own GCP/Firebase/Sentry project: every Slack notification,
// feedback included, goes to the single SLACK_CHANNEL_DEMO channel. Feedback
// still creates tasks on the shared Notion board.
import {authGuard, config as sharedConfig, methodGuard, notifySlack} from "./_sentrySlack.js";

export const config = sharedConfig;

export default async function handler(req, res) {
    if (!methodGuard(req, res)) return;
    if (!authGuard(req, res)) return;

    const channel = process.env.SLACK_CHANNEL_DEMO;
    if (!channel) return res.status(500).json({error: "Missing SLACK_CHANNEL_DEMO"});

    try {
        await notifySlack(channel, req.body || {});

        res.status(200).json({ok: true});
    } catch (err) {
        console.error("sentry-demo-frontend error:", err);
        res.status(500).json({error: String(err?.message || err)});
    }
}
