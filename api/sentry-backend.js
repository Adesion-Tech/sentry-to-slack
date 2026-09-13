// api/sentry-backend.js
import {config as sharedConfig, methodGuard, notifySlack, resolveChannel} from "./_sentrySlack.js";

export const config = sharedConfig;

export default async function handler(req, res) {
    if (!methodGuard(req, res)) return;

    if (!process.env.SLACK_CHANNEL_BACKEND) return res.status(500).json({error: "Missing SLACK_CHANNEL_BACKEND"});
    const channel = resolveChannel(req, process.env.SLACK_CHANNEL_BACKEND);

    try {
        await notifySlack(channel, req.body || {});

        res.status(200).json({ok: true});
    } catch (err) {
        console.error("sentry-backend error:", err);
        res.status(500).json({error: String(err?.message || err)});
    }
}
