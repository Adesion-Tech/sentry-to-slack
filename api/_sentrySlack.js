// api/_sentrySlack.js

import {timingSafeEqual} from "node:crypto";

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
const FEEDBACK_SUBJECT_LIMIT = 100;

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

// --- Feedback screenshots (optional, needs SENTRY_AUTH_TOKEN) ---
// Screenshots submitted with the feedback widget never travel inside the
// webhook payload — Sentry stores them as event attachments behind its API
// (https://docs.sentry.io/api/events/list-an-events-attachments/). We resolve
// the API coordinates from the webhook's own URLs, list the screenshot
// attachments, and download the first one.
function parseSentryApiContext(body) {
    const ev = body?.data?.event ?? {};
    const issue =
        body?.data?.issue ??
        ((!body?.data?.event && body?.id && body?.title) ? body : null);

    // Event-style payloads carry the event's own API url:
    // https://sentry.io/api/0/projects/{org}/{project}/events/{event_id}/
    if (ev.event_id) {
        const m = /^(https:\/\/[^/]+)\/api\/0\/projects\/([^/]+)\/([^/]+)\/events\//.exec(String(ev.url || ""));
        if (m) return {apiBase: m[1], org: m[2], project: m[3], eventId: ev.event_id};
    }

    // Feedback issues link to the feedback view, which carries the refs in
    // its query string:
    // https://{org}.sentry.io/issues/feedback/?projectSlug={slug}&eventId={id}
    // (https://docs.sentry.io/platforms/javascript/user-feedback/)
    for (const u of [issue?.permalink, issue?.web_url]) {
        if (typeof u !== "string" || !u) continue;
        let parsed;
        try {
            parsed = new URL(u);
        } catch {
            continue;
        }
        const eventId = parsed.searchParams.get("eventId") || parsed.searchParams.get("event_id");
        const project =
            parsed.searchParams.get("projectSlug") ||
            parsed.searchParams.get("project_slug") ||
            issue?.project?.slug;
        if (!eventId || !project) continue;
        if (parsed.hostname.endsWith(".sentry.io")) {
            return {
                apiBase: "https://sentry.io",
                org: parsed.hostname.slice(0, -".sentry.io".length),
                project, eventId,
            };
        }
        // Self-hosted: the org only appears in the issue API url
        const orgMatch = /\/api\/0\/organizations\/([^/]+)\//.exec(String(issue?.url || ""));
        if (orgMatch) return {apiBase: parsed.origin, org: orgMatch[1], project, eventId};
    }
    return null;
}

async function fetchFeedbackScreenshot(body) {
    const token = process.env.SENTRY_AUTH_TOKEN;
    if (!token || !isFeedback({body})) return null;

    const ctx = parseSentryApiContext(body);
    if (!ctx) return null;

    const auth = {Authorization: `Bearer ${token}`};
    const base = `${ctx.apiBase}/api/0/projects/${ctx.org}/${ctx.project}/events/${ctx.eventId}/attachments`;

    const listResp = await fetch(`${base}/?query=is:screenshot`, {headers: auth});
    if (!listResp.ok) throw new Error(`Sentry attachments list failed: ${listResp.status}`);
    const attachments = await listResp.json().catch(() => null);
    if (!Array.isArray(attachments) || attachments.length === 0) return null;

    const fileResp = await fetch(`${base}/${attachments[0].id}/?download=1`, {headers: auth});
    if (!fileResp.ok) throw new Error(`Sentry attachment download failed: ${fileResp.status}`);

    return {
        buffer: Buffer.from(await fileResp.arrayBuffer()),
        filename: attachments[0].name || "screenshot.png",
    };
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
    // Deliberately name-only: the email is already sent with the message
    // (event user context), so don't repeat it in the label.
    const feedbackFrom = feedbackName ? escapeMrkdwn(feedbackName) : "";

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

    // Sentry titles feedback issues "User Feedback[: subject]" — promote that
    // to a dedicated header line instead of the generic "Title:" label.
    const feedbackTitleMatch = /^User Feedback(?::\s*(.*))?$/i.exec(title);
    const feedbackSubject = feedbackTitleMatch
        ? (feedbackTitleMatch[1] ||
            (feedbackMessage
                ? clampText(escapeMrkdwn(feedbackMessage.split("\n")[0]), FEEDBACK_SUBJECT_LIMIT)
                : ""))
        : null;

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
        (feedbackTitleMatch
            ? (feedbackSubject ? `*User Feedback:* ${feedbackSubject}` : "*User Feedback*")
            : `*Title:* ${title}`),
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

// Slack image blocks only render publicly-hosted image_url values, and
// files.uploadV2 exists only inside Slack's SDKs — over plain HTTP the
// documented flow is getUploadURLExternal → POST the bytes →
// completeUploadExternal (https://docs.slack.dev/messaging/working-with-files/).
// The image rides in the completed upload's own blocks via a slack_file
// reference, so the file and the notification land as one message.
async function postToSlackWithScreenshot(channel, payload, screenshot) {
    const token = process.env.SLACK_APP_AUTH_TOKEN;
    if (!token) throw new Error("Missing SLACK_APP_AUTH_TOKEN");

    // Form-encoded on purpose: JSON bodies are documented as accepted here,
    // but real-world reports show them tripping invalid_arguments on this
    // method (see slackapi/bolt-js#2115) — both Slack SDKs send urlencoded
    // on the wire.
    const urlResp = await fetch("https://slack.com/api/files.getUploadURLExternal", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            filename: screenshot.filename,
            length: String(screenshot.buffer.length),
            alt_txt: "Feedback screenshot",
        }),
    });
    const urlData = await urlResp.json().catch(() => ({}));
    if (!urlData.ok) throw new Error(`Slack getUploadURLExternal error: ${urlData.error || urlResp.statusText}`);

    const uploadResp = await fetch(urlData.upload_url, {
        method: "POST",
        headers: {"Content-Type": "application/octet-stream"},
        body: screenshot.buffer,
    });
    if (!uploadResp.ok) throw new Error(`Slack file upload failed: ${uploadResp.status}`);

    // Show the image right after the quoted feedback message
    const imageBlock = {type: "image", slack_file: {id: urlData.file_id}, alt_text: "Feedback screenshot"};
    const blocks = [...payload.blocks];
    const feedbackIdx = blocks.findIndex(
        b => b.type === "section" && String(b.text?.text || "").startsWith(":speech_balloon:")
    );
    blocks.splice(feedbackIdx >= 0 ? feedbackIdx + 1 : 1, 0, imageBlock);

    const doneResp = await fetch("https://slack.com/api/files.completeUploadExternal", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
            channel_id: channel,
            files: [{id: urlData.file_id, title: "Feedback screenshot"}],
            blocks,
        }),
    });
    const doneData = await doneResp.json().catch(() => ({}));
    if (!doneData.ok) throw new Error(`Slack completeUploadExternal error: ${doneData.error || doneResp.statusText}`);
    return doneData;
}

// --- Notion feedback board (optional, needs NOTION_TOKEN + NOTION_FEEDBACK_DB_ID) ---
// When both variables are set, every User Feedback webhook is also created as
// a task in the Notion database. Sentry delivers webhooks at-least-once and
// the Notion API has no idempotent create, so tasks are deduplicated by
// Sentry issue ID. Notion failures only log — they can never break the Slack
// notification.
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // long-stable API line: parent.database_id + /databases/{id}/query

function notionEnabled() {
    return Boolean(process.env.NOTION_TOKEN && process.env.NOTION_FEEDBACK_DB_ID);
}

async function notionFetch(path, body) {
    const resp = await fetch(`${NOTION_API}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`Notion ${path} failed: ${resp.status} ${detail}`);
    }
    return resp.json().catch(() => ({}));
}

// Extracts the fields the Notion task needs. Mirrors the parsing in
// formatSlackMessage but keeps data the Slack message deliberately doesn't
// use (email, issue id, the page the feedback was submitted from) and stores
// project/environment as filterable task properties.
function extractFeedbackInfo(body) {
    const ev = body?.data?.event ?? {};
    const issue =
        body?.data?.issue ??
        ((!body?.data?.event && body?.id && body?.title) ? body : null);
    const fbCtx = ev?.contexts?.feedback ?? ev?.user_report ?? null;
    const tag = (name) =>
        (Array.isArray(ev?.tags) && ev.tags.find(t => t[0] === name)?.[1]) || undefined;

    const message = firstText(
        fbCtx?.message,
        fbCtx?.comments,
        issue?.metadata?.message,
        issue?.metadata?.value,
    );

    const title = issue?.title || ev.title || ev.message || "User Feedback";
    const subjectMatch = /^User Feedback(?::\s*(.*))?$/i.exec(title);
    const subject = subjectMatch
        ? (subjectMatch[1] ||
            (message ? message.replace(/\r\n?/g, "\n").split("\n")[0].slice(0, 100) : "") ||
            "User Feedback")
        : title;

    return {
        issueId: String(issue?.id ?? issue?.shortId ?? ev?.event_id ?? ""),
        subject,
        message,
        name: firstText(fbCtx?.name, issue?.metadata?.name),
        email: firstText(fbCtx?.contact_email, issue?.metadata?.contact_email, ev?.user?.email),
        sourceUrl: firstText(fbCtx?.url, ev?.request?.url, tag("url")),
        issueUrl: firstText(issue?.permalink, issue?.web_url, ev?.web_url),
        project: firstText(issue?.project?.name, issue?.project?.slug, ev?.project_slug),
        environment: firstText(issue?.environment, ev?.environment, tag("environment")),
    };
}

// Notion rich_text caps each text object at 2000 chars and feedback messages
// can reach ~4000, so long messages split across objects of one paragraph.
// Block content nests under the block-type key (paragraph), unlike property
// values which hold rich_text directly.
function messageParagraph(message) {
    const normalized = message.replace(/\r\n?/g, "\n");
    const richText = [];
    for (let i = 0; i < normalized.length; i += 2000) {
        richText.push({type: "text", text: {content: normalized.slice(i, i + 2000)}});
    }
    return {type: "paragraph", paragraph: {rich_text: richText}};
}

function textBlock(content, link) {
    return {type: "text", text: {content, ...(link ? {link: {url: link}} : {})}};
}

function buildNotionPage(info) {
    const reporter = [info.name, info.email].filter(Boolean).join(" • ");

    const children = [];
    if (info.message) children.push(messageParagraph(info.message));
    if (info.issueUrl) {
        children.push({type: "paragraph", paragraph: {rich_text: [
            textBlock("Open in Sentry: "),
            textBlock(info.issueUrl, info.issueUrl),
        ]}});
    }

    const properties = {
        Name: {title: [textBlock(info.subject)]},
        Status: {select: {name: "New"}},
    };
    if (info.issueId) properties["Sentry Issue ID"] = {rich_text: [textBlock(info.issueId)]};
    if (info.sourceUrl) properties["Source URL"] = {url: info.sourceUrl};
    if (reporter) properties.Reporter = {rich_text: [textBlock(reporter)]};
    if (info.project) properties.Project = {rich_text: [textBlock(info.project)]};
    if (info.environment) properties.Environment = {rich_text: [textBlock(info.environment)]};

    return {properties, children};
}

// Returns the created page id (null when skipped) so the screenshot attaches
// only to a page created in the same request — webhook retries would
// otherwise duplicate image blocks.
async function syncNotionFeedbackTask(body) {
    if (!notionEnabled() || !isFeedback({body})) return null;
    try {
        const info = extractFeedbackInfo(body);

        if (info.issueId) {
            const existing = await notionFetch(
                `/databases/${process.env.NOTION_FEEDBACK_DB_ID}/query`,
                {filter: {property: "Sentry Issue ID", rich_text: {equals: info.issueId}}, page_size: 1},
            );
            if (Array.isArray(existing.results) && existing.results.length > 0) return null;
        }

        const {properties, children} = buildNotionPage(info);
        const page = await notionFetch("/pages", {
            parent: {database_id: process.env.NOTION_FEEDBACK_DB_ID},
            properties,
            children,
        });
        return page.id || null;
    } catch (err) {
        console.error("notion feedback task skipped:", err);
        return null;
    }
}

const NOTION_IMAGE_TYPES = {png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp"};

// Notion has no URL-based image ingest, so the screenshot bytes go through
// the File Upload API: create an upload, POST the bytes to its upload_url
// (the /file_uploads/{id}/send endpoint wants multipart FormData — auth
// headers still required, FormData sets its own boundary), then reference
// the upload id in an image block appended to the task page. These additive
// endpoints work on the pinned 2022-06-28 version, and an unattached upload
// expires after an hour, so the image is attached right away.
async function attachNotionScreenshot(pageId, screenshot) {
    const ext = (/\.([a-z0-9]+)$/i.exec(screenshot.filename) || [])[1]?.toLowerCase();
    const contentType = NOTION_IMAGE_TYPES[ext] || "image/png";

    const created = await notionFetch("/file_uploads", {
        filename: screenshot.filename,
        content_type: contentType,
    });
    if (!created.id || !created.upload_url) throw new Error("Notion file upload was not created");

    const form = new FormData();
    form.append("file", new Blob([screenshot.buffer], {type: contentType}), screenshot.filename);
    const sentResp = await fetch(created.upload_url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
            "Notion-Version": NOTION_VERSION,
        },
        body: form,
    });
    if (!sentResp.ok) {
        throw new Error(`Notion ${created.upload_url} failed: ${sentResp.status} ${await sentResp.text().catch(() => "")}`);
    }

    const attached = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({children: [{
            object: "block",
            type: "image",
            image: {type: "file_upload", file_upload: {id: created.id}},
        }]}),
    });
    if (!attached.ok) {
        throw new Error(`Notion /blocks/${pageId}/children failed: ${attached.status} ${await attached.text().catch(() => "")}`);
    }
}

// Entry point for the endpoint handlers. Notion task sync and screenshot
// failures fall back to the plain post so they can never swallow the
// notification itself.
export async function notifySlack(channel, body) {
    const payload = formatSlackMessage(body || {});
    const notionPageId = await syncNotionFeedbackTask(body || {});
    try {
        const screenshot = await fetchFeedbackScreenshot(body || {});
        if (screenshot) {
            if (notionPageId) {
                try {
                    await attachNotionScreenshot(notionPageId, screenshot);
                } catch (err) {
                    console.error("notion screenshot skipped:", err);
                }
            }
            return await postToSlackWithScreenshot(channel, payload, screenshot);
        }
    } catch (err) {
        console.error("feedback screenshot skipped:", err);
    }
    return postToSlack(channel, payload);
}

// --- Static-token auth (optional, needs SENTRY_WEBHOOK_TOKEN) ---
// Sentry webhook settings only let you control the request URL (there's no
// way to add custom headers), so the token rides in the webhook URL as
// ?token=... — a Bearer or X-Webhook-Token header is accepted too for senders
// that can set them. Unset variable = guard disabled, preserving existing
// deployments.
export function authGuard(req, res) {
    const expected = process.env.SENTRY_WEBHOOK_TOKEN;
    if (!expected) return true;

    const authHeader = req?.headers?.authorization;
    const presented =
        req?.query?.token ||
        req?.headers?.["x-webhook-token"] ||
        (typeof authHeader === "string" ? (/^Bearer\s+(.+)$/i.exec(authHeader.trim()) || [])[1] : undefined);

    const expectedBuf = Buffer.from(expected);
    const presentedBuf = Buffer.from(String(presented ?? ""));
    if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
        res.status(401).json({error: "Unauthorized"});
        return false;
    }
    return true;
}

export function methodGuard(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({error: "Method not allowed"});
        return false;
    }
    return true;
}
