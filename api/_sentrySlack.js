// api/_sentrySlack.js

export const config = {
    api: {bodyParser: {sizeLimit: "2mb"}},
};

function fmtISO(x) {
    if (!x) return undefined;
    try {
        // Accept ISO string or epoch seconds
        if (typeof x === "number") return new Date(x * 1000).toISOString();
        if (/^\d+$/.test(String(x))) return new Date(Number(x) * 1000).toISOString();
        return new Date(x).toISOString();
    } catch {
        return undefined;
    }
}

function firstText(...vals) {
    return vals.find(v => typeof v === "string" && v.trim().length);
}

// Escapes characters Slack mrkdwn treats as markup so user-authored feedback
// text can never form mentions or links (<@user>, <#channel>, <url|label>).
function escapeMrkdwn(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function clampText(s, limit) {
    if (s.length <= limit) return s;
    return s.slice(0, limit).replace(/&[a-zA-Z]{0,4}$/, "").trimEnd() + " …";
}

const SLACK_BLOCK_TEXT_LIMIT = 3000; // Slack rejects section text longer than this
const FEEDBACK_TEXT_LIMIT = 500;

function quoteFeedbackMessage(message) {
    return message
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map(line => `> ${escapeMrkdwn(line)}`)
        .join("\n");
}

// Sentry allows feedback messages up to ~4000 chars, past Slack's section limit.
function buildFeedbackSectionText(feedbackFrom, message) {
    const header = `:speech_balloon: *Feedback${feedbackFrom ? ` from ${feedbackFrom}` : ""}:*`;
    let text = `${header}\n${quoteFeedbackMessage(message)}`;
    if (text.length > SLACK_BLOCK_TEXT_LIMIT) {
        const note = "\n> _(truncated — full message in Sentry)_";
        text = text.slice(0, SLACK_BLOCK_TEXT_LIMIT - note.length)
            .replace(/&[a-zA-Z]{0,4}$/, "") // drop a partially-cut mrkdwn entity (e.g. "&am")
            + note;
    }
    return text;
}

const LEVEL_ALIAS = {
    fatal: ":fire:",
    error: ":rotating_light:",
    warning: ":warning:",
    info: ":information_source:",
    debug: ":beetle:",
};
const STATUS_EMOJI = {
    unresolved: ":red_circle:",
    resolved: ":white_check_mark:",
    ignored: ":zzz:",
};

// Feedback arrives either as an "issue" webhook (issue at body.data.issue,
// issueCategory "feedback") or as an alert-fired event carrying
// contexts.feedback — see https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/
export function isFeedback(req) {
    const body = req?.body || {};
    const ev = body?.data?.event ?? {};
    const issue =
        body?.data?.issue ??
        ((!body?.data?.event && body?.id && body?.title) ? body : null);

    const category = String(issue?.issueCategory || issue?.category || "").toLowerCase();

    return Boolean(
        category === "feedback" ||
        String(issue?.issueType || "").toLowerCase() === "feedback" ||
        ev?.contexts?.feedback ||
        ev?.user_report ||
        ev?.type === "feedback" ||
        issue?.title === "User Feedback" ||
        String(issue?.title || "").startsWith("User Feedback:") ||
        (issue?.metadata?.contact_email && issue?.metadata?.message)
    );
}

// Routes feedback to SLACK_CHANNEL_FEEDBACK when set; otherwise keeps the
// default channel, preserving pre-feedback behavior for deployments that
// don't define the variable.
export function resolveChannel(req, defaultChannel) {
    const feedbackChannel = process.env.SLACK_CHANNEL_FEEDBACK;
    return feedbackChannel && isFeedback(req) ? feedbackChannel : defaultChannel;
}

export function formatSlackMessage(body) {
    // --- Normalization for Sentry event webhooks, Issue API responses, and
    // integration-platform issue webhooks (issue at body.data.issue) ---
    const ev = body?.data?.event ?? {};     // event-style
    const issue =
        body?.data?.issue ??                // integration-platform issue webhook
        ((!body?.data?.event && body?.id && body?.title) ? body : null); // issue-style

    // --- User Feedback: the reporter's original message and identity ---
    // The message lives at event.contexts.feedback.message (feedback events),
    // event.user_report.comments (crash-report feedback), or in feedback-issue
    // metadata — see https://docs.sentry.io/product/user-feedback/
    const fbCtx = ev?.contexts?.feedback ?? ev?.user_report ?? null;
    const issueIsFeedback = Boolean(
        String(issue?.issueCategory || issue?.category || "").toLowerCase() === "feedback" ||
        String(issue?.issueType || "").toLowerCase() === "feedback" ||
        issue?.title === "User Feedback" ||
        String(issue?.title || "").startsWith("User Feedback:") ||
        (issue?.metadata?.contact_email && issue?.metadata?.message)
    );

    const feedbackMessage = firstText(
        fbCtx?.message,
        fbCtx?.comments,
        issueIsFeedback ? issue?.metadata?.message : undefined,
        issueIsFeedback ? issue?.metadata?.value : undefined,
    );
    const feedbackName = firstText(
        fbCtx?.name,
        issueIsFeedback ? issue?.metadata?.name : undefined,
    );
    const feedbackEmail = firstText(
        fbCtx?.contact_email,
        fbCtx?.email,
        issueIsFeedback ? issue?.metadata?.contact_email : undefined,
    );
    const feedbackFromRaw =
        (feedbackName && feedbackEmail) ? `${feedbackName} (${feedbackEmail})`
            : (feedbackName || feedbackEmail || "");
    const feedbackFrom = escapeMrkdwn(feedbackFromRaw);

    const level =
        (ev.level ||
            (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "level")?.[1]) ||
            issue?.level ||
            "error").toLowerCase();

    const status = issue?.status || ev?.issue_status; // ev.issue_status rarely present
    const substatus = issue?.substatus;
    const priority = issue?.priority || ev?.issue_priority;

    const baseEmoji = LEVEL_ALIAS[level] || ":rotating_light:";
    const statusEmoji = STATUS_EMOJI[status] || "";
    const escalatingEmoji = substatus === "escalating" ? " :chart_with_upwards_trend:" : "";

    const title =
        issue?.title ||
        ev.title ||
        ev.message ||
        ev?.logentry?.formatted ||
        (feedbackMessage ? "User Feedback" : "Sentry Event");

    const culprit =
        issue?.culprit ||
        ev.culprit ||
        ev.location ||
        ev.metadata?.filename ||
        "";

    const environment =
        ev.environment ||
        (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "environment")?.[1]) ||
        undefined;

    const errorType =
        issue?.metadata?.type ||
        ev?.metadata?.type ||
        undefined;

    const projectName =
        issue?.project?.name ||
        ev.project_slug ||
        ev.project ||
        undefined;

    const projectSlug =
        issue?.project?.slug ||
        ev.project_slug ||
        undefined;

    const platform =
        issue?.platform ||
        ev.platform ||
        ev?.contexts?.runtime?.name ||
        undefined;

    const eventWebUrl = ev.web_url || issue?.permalink;
    const issueApiUrl = ev.issue_url || (issue?.permalink ? `${issue.permalink}events/` : undefined);

    const reqUrl =
        ev.request?.url ||
        (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "url")?.[1]) ||
        undefined;

    const browser =
        (ev?.contexts?.browser?.name && ev?.contexts?.browser?.version)
            ? `${ev.contexts.browser.name} ${ev.contexts.browser.version}`
            : (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "browser")?.[1]) ||
            (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "browser.name")?.[1]) ||
            undefined;

    const os =
        (ev?.contexts?.client_os?.name && ev?.contexts?.client_os?.version)
            ? `${ev.contexts.client_os.name} ${ev.contexts.client_os.version}`
            : (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "client_os")?.[1]) ||
            (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "client_os.name")?.[1]) ||
            undefined;

    const userBits = [
        ev.user?.email,
        ev.user?.id ||
        (Array.isArray(ev.tags) && ev.tags.find(t => t[0] === "user")?.[1]),
    ].filter(Boolean).join(" • ");

    // Timestamps
    const timestampISO =
        ev.datetime || fmtISO(ev.timestamp);
    const firstSeen = issue?.firstSeen ? fmtISO(issue.firstSeen) : undefined;
    const lastSeen = issue?.lastSeen ? fmtISO(issue.lastSeen) : undefined;

    // Counts
    const eventCount = issue?.count ? Number(issue.count) : undefined;
    const userCount = issue?.userCount ?? undefined;

    // Releases
    const firstRel = issue?.firstRelease?.shortVersion || issue?.firstRelease?.versionInfo?.description;
    const lastRel = issue?.lastRelease?.shortVersion || issue?.lastRelease?.versionInfo?.description;

    // --- Compose fields grid (Blocks "fields" expect pairs of mrkdwn) ---
    const fields = [];

    if (environment) fields.push({type: "mrkdwn", text: `*Env:*\n${environment}`});
    if (priority) fields.push({type: "mrkdwn", text: `*Priority:*\n${priority}`});

    if (status) fields.push({type: "mrkdwn", text: `*Status:*\n${status}${substatus ? ` (${substatus})` : ""}`});
    if (level) fields.push({type: "mrkdwn", text: `*Level:*\n${level}`});

    if (eventCount != null) fields.push({type: "mrkdwn", text: `*Events:*\n${eventCount}`});
    if (userCount != null) fields.push({type: "mrkdwn", text: `*Users:*\n${userCount}`});

    // Prefer issue timeframe; fall back to event timestamp
    if (firstSeen || timestampISO) fields.push({type: "mrkdwn", text: `*First seen:*\n${firstSeen || timestampISO}`});
    if (lastSeen) fields.push({type: "mrkdwn", text: `*Last seen:*\n${lastSeen}`});

    if (browser) fields.push({type: "mrkdwn", text: `*Browser:*\n${browser}`});
    if (os) fields.push({type: "mrkdwn", text: `*OS:*\n${os}`});
    if (userBits) fields.push({type: "mrkdwn", text: `*User:*\n${userBits}`});

    if (firstRel) fields.push({type: "mrkdwn", text: `*First release:*\n\`${firstRel}\``});
    if (lastRel) fields.push({type: "mrkdwn", text: `*Last release:*\n\`${lastRel}\``});

    // --- Context line (project / platform / shortId) ---
    const shortId = issue?.shortId || ev?.event_id;
    const contextItems = [
        projectName ? `Project: ${projectName}` : null,
        projectSlug ? `Slug: ${projectSlug}` : null,
        platform ? `Platform: ${platform}` : null,
        shortId ? `ID: ${shortId}` : null,
        errorType ? `Type: ${errorType}` : null,
    ].filter(Boolean);

    // --- Useful links ---
    const linkTexts = [];
    if (eventWebUrl) linkTexts.push(`<${eventWebUrl}|Open in Sentry>`);
    if (issueApiUrl) linkTexts.push(`<${issueApiUrl}|Events in Issue>`);
    if (reqUrl) linkTexts.push(`<${reqUrl}|Request URL>`);

    // --- Header & detail sections ---
    const headerLines = [
        `*${baseEmoji}${statusEmoji ? " " + statusEmoji : ""}${escalatingEmoji} Sentry ${level.toUpperCase()}*${(status || substatus) ? `  •  _${[status, substatus].filter(Boolean).join(" / ")}_` : ""}`,
        `*Title:* ${title}`,
        ...(culprit ? [`*Culprit:* \`${culprit}\``] : []),
        ...(issue?.metadata?.filename || ev?.metadata?.filename || ev?.metadata?.function
                ? [
                    `*Where:* \`${issue?.metadata?.filename || ev?.metadata?.filename || ""}${(issue?.metadata?.function || ev?.metadata?.function) ? `#${issue?.metadata?.function || ev?.metadata?.function}` : ""}\``
                ]
                : []
        ),
    ].join("\n");

    const feedbackSection = feedbackMessage ? {
        type: "section",
        text: {type: "mrkdwn", text: buildFeedbackSectionText(feedbackFrom, feedbackMessage)},
    } : null;

    const blocks = [
        {type: "section", text: {type: "mrkdwn", text: headerLines}},
        ...(feedbackSection ? [feedbackSection] : []),
        ...(fields.length ? [{type: "section", fields}] : []),
        ...(contextItems.length
            ? [{type: "context", elements: [{type: "mrkdwn", text: contextItems.join("  •  ")}]}]
            : []),
        {type: "divider"},
        ...(linkTexts.length
            ? [{type: "context", elements: [{type: "mrkdwn", text: linkTexts.join("  •  ")}]}]
            : []),
    ];

    const text = feedbackMessage
        ? `:speech_balloon: User Feedback${feedbackFrom ? ` from ${feedbackFrom}` : ""}: ${clampText(escapeMrkdwn(feedbackMessage.replace(/\r\n?/g, "\n")), FEEDBACK_TEXT_LIMIT)}`
        : `${baseEmoji} ${level.toUpperCase()}: ${title}`;

    return {text, blocks};
}

export async function postToSlack(channel, payload, attempt = 0) {
    const token = process.env.SLACK_APP_AUTH_TOKEN;
    if (!token) throw new Error("Missing SLACK_APP_AUTH_TOKEN");

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({channel, ...payload}),
    });

    if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "1", 10);
        const wait = (isNaN(retryAfter) ? 1 : retryAfter) * 1000;

        const jitter = Math.random() * 500;
        if (attempt < 3) {
            await new Promise((r) => setTimeout(r, wait + jitter));
            return postToSlack(channel, payload, attempt + 1);
        } else {
            throw new Error("Slack rate limit hit repeatedly");
        }
    }

    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
        throw new Error(`Slack API error: ${data.error || resp.statusText}`);
    }

    return data;
}

export function methodGuard(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({error: "Method not allowed"});
        return false;
    }
    return true;
}
