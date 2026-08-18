import { google } from "googleapis";
import {
  gmailConfigured,
  getGmailAuthClient,
  getLocalAuthUrl,
  isGmailConnected,
} from "./gmail-auth.js";

const BODY_MAX = 4000;
export const GMAIL_PAGE_SIZE = 20;
export const GMAIL_MAX_SCAN = 70;

export function emptyGmailScan() {
  return { total: 0, lastToken: "", lastKey: "" };
}

function scanKey(topic, query) {
  return `${String(topic || "").trim().toLowerCase()}|${String(query || "").trim().toLowerCase()}`;
}

function ensureScan(scan) {
  if (scan && typeof scan === "object") return scan;
  return emptyGmailScan();
}

export const GMAIL_TOOLS = [
  {
    type: "function",
    function: {
      name: "gmail_agent",
      description:
        "DEFAULT for anything email-related. Hand the user's request to June's mail agent. It searches, scans titles, reads, and summarizes dynamically. Use for inbox, unread, find related mail, who emailed me, summarize a thread, 'any mail about X', follow-ups, etc. Pass their ask in their words. Do not invent mail. If mail comes back empty or unrelated, June should switch to web_search or memory instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "What they want, in their words. Include topic, person, timeframe if they said it.",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_list_messages",
      description:
        "Search or list Gmail. First page is ~20 titles. If the email is not there, call again with page_token to check the next ~20, up to 70 total. Speak from real titles — do not invent mail.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Plain-language topic to find, e.g. amazon, lease, flight. Prefer this when they ask for related emails. Searches titles first, then body.",
          },
          query: {
            type: "string",
            description: "Optional extra Gmail search syntax, e.g. is:unread, from:alice, newer_than:7d. Empty with no topic = recent inbox.",
          },
          max_results: {
            type: "number",
            description: "Page size, 1-20. Default 20. If the email is not on this page, call again with page_token.",
          },
          page_token: {
            type: "string",
            description: "From the previous list result nextPageToken. Call again with this to scan the next ~20. Stops at 70 total.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_read_message",
      description:
        "Read one Gmail message by id from gmail_list_messages. Returns from, to, subject, date, and a plain-text body. Call when they ask to read a specific email.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "Gmail message id from gmail_list_messages.",
          },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_send_email",
      description:
        "Queue or send an email via Gmail. First call shows a confirm card with the FULL recipient address — it will not send. Only after they say yes (gmailSendConfirmed) does a second call actually send.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient email address.",
          },
          subject: {
            type: "string",
            description: "Email subject.",
          },
          body: {
            type: "string",
            description: "Plain-text body.",
          },
          cc: {
            type: "string",
            description: "Optional Cc address(es), comma-separated.",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
];

export function gmailToolsAvailable() {
  return gmailConfigured();
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeB64Url(data) {
  if (!data) return "";
  const pad = data.length % 4 === 0 ? "" : "=".repeat(4 - (data.length % 4));
  return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

function headerMap(payload) {
  const out = {};
  for (const h of payload?.headers || []) {
    const name = String(h?.name || "").toLowerCase();
    if (name) out[name] = String(h?.value || "");
  }
  return out;
}

function collectBodies(payload, acc = { text: "", html: "" }) {
  if (!payload) return acc;
  const mime = String(payload.mimeType || "");
  const data = payload.body?.data;
  if (data) {
    const decoded = decodeB64Url(data);
    if (mime === "text/plain" && !acc.text) acc.text = decoded;
    else if (mime === "text/html" && !acc.html) acc.html = decoded;
    else if (!mime.startsWith("multipart/") && !acc.text && !acc.html) {
      if (mime.includes("html")) acc.html = decoded;
      else acc.text = decoded;
    }
  }
  for (const part of payload.parts || []) collectBodies(part, acc);
  return acc;
}

function capBody(text) {
  const t = String(text || "").trim();
  if (t.length <= BODY_MAX) return t;
  return `${t.slice(0, BODY_MAX - 1).trim()}…`;
}

function encodeHeader(value) {
  const s = String(value || "").replace(/\r|\n/g, " ").trim();
  if (!s) return "";
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function buildRawMessage({ to, subject, body, cc }) {
  const lines = [
    `To: ${String(to).trim()}`,
  ];
  if (cc) lines.push(`Cc: ${String(cc).trim()}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=\"UTF-8\"");
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(String(body || "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function notConnectedPayload() {
  return {
    error: "not_connected",
    authUrl: getLocalAuthUrl(),
    hint: "User needs to connect Gmail in the opened tab, or Settings → Connect Gmail.",
  };
}

function gmailClient() {
  const auth = getGmailAuthClient();
  if (!auth) return null;
  return google.gmail({ version: "v1", auth });
}

function topicToQuery(topic) {
  const t = String(topic || "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const quoted = t.includes(" ") ? `"${t}"` : t;
  return `(subject:${quoted} OR ${quoted})`;
}

export function extractGmailTopic(userText = "") {
  const t = String(userText || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const patterns = [
    /(?:e-?mails?|gmail|inbox|mail)\s+(?:that\s+)?(?:are\s+)?(?:related\s+to|about|regarding|on|for)\s+(.+)/i,
    /(?:find|search|scan|look\s+for|pull\s+up)\s+(?:me\s+)?(?:any\s+)?(?:e-?mails?|mail|gmail)\s+(?:that\s+)?(?:are\s+)?(?:related\s+to|about|on|for)?\s*(.+)/i,
    /(?:summar(?:y|ize)|scan)\s+(?:the\s+)?(?:e-?mail\s+)?titles?\s+(?:related\s+to|about|on|for)\s+(.+)/i,
    /(?:related\s+to|about|regarding)\s+(.+?)(?:\s+(?:e-?mails?|in\s+(?:my\s+)?(?:inbox|gmail|mail)))?$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    let topic = m[1]
      .replace(/\b(please|real quick|for me|in my (?:inbox|gmail|mail)|and (?:then\s+)?(?:scan|summar(?:y|ize)|give).*)\b.*$/i, "")
      .replace(/[?.!,]+$/g, "")
      .trim();
    if (topic.length >= 2 && topic.length < 80) return topic;
  }
  return "";
}

export async function listGmailInbox({
  query = "",
  topic = "",
  maxResults,
  pageToken = "",
  scan = null,
} = {}) {
  if (!gmailToolsAvailable()) return { error: "gmail_not_configured", messages: [] };
  if (!isGmailConnected()) return { ...notConnectedPayload(), messages: [] };
  const gmail = gmailClient();
  if (!gmail) return { ...notConnectedPayload(), messages: [] };

  const topicQ = topicToQuery(topic);
  const userQ = String(query || "").trim();
  const q = [topicQ, userQ].filter(Boolean).join(" ");
  const isTopicScan = Boolean(topicQ);
  const key = scanKey(topic, userQ);
  const state = ensureScan(scan);
  if (state.lastKey && state.lastKey !== key) {
    state.total = 0;
    state.lastToken = "";
  }
  state.lastKey = key;

  const already = Math.max(0, Number(state.total) || 0);
  const remaining = GMAIL_MAX_SCAN - already;
  if (remaining <= 0) {
    return {
      query: q,
      topic: String(topic || "").trim() || undefined,
      scanned: already,
      count: 0,
      messages: [],
      titles: [],
      nextPageToken: "",
      hasMore: false,
      atCap: true,
      hint: "Reached the 70-email scan cap. Stop. Do not invent mail.",
    };
  }

  let token = String(pageToken || "").trim();
  if (!token && already > 0 && state.lastToken) token = state.lastToken;

  const want = Number(maxResults);
  const limit = Math.min(
    GMAIL_PAGE_SIZE,
    remaining,
    Number.isFinite(want) && want > 0 ? Math.max(1, want) : GMAIL_PAGE_SIZE,
  );
  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults: limit,
    q: q || undefined,
    pageToken: token || undefined,
  });
  const ids = (list.data?.messages || []).map((m) => m.id).filter(Boolean);
  const messages = [];
  await Promise.all(ids.map(async (id) => {
    const got = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });
    const headers = headerMap(got.data?.payload);
    const labels = got.data?.labelIds || [];
    messages.push({
      id,
      from: headers.from || "",
      subject: headers.subject || "(no subject)",
      date: headers.date || "",
      snippet: String(got.data?.snippet || "").replace(/\s+/g, " ").trim().slice(0, 220),
      unread: labels.includes("UNREAD"),
    });
  }));
  const order = new Map(ids.map((id, i) => [id, i]));
  messages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const scanned = already + messages.length;
  state.total = scanned;
  const next = String(list.data?.nextPageToken || "");
  const atCap = scanned >= GMAIL_MAX_SCAN;
  const hasMore = Boolean(next) && !atCap && messages.length > 0;
  state.lastToken = hasMore ? next : "";
  const topicLabel = String(topic || "").trim();
  let hint;
  if (atCap) {
    hint = "Hit the 70-email cap. If the email is not in these titles, say you did not find it. Do not invent.";
  } else if (hasMore) {
    hint = isTopicScan
      ? "Scan these titles. If the email is not here, call again with the same topic/query and this nextPageToken to check the next ~20."
      : "If the email is not in this page, call again with nextPageToken to check the next ~20. Cap 70.";
  } else if (isTopicScan) {
    hint = "Scan these titles and summarize matches. No further pages. Do not invent extras. Offer to open one.";
  }
  return {
    query: q,
    topic: topicLabel || undefined,
    scanned,
    count: messages.length,
    titles: messages.map((m) => m.subject),
    messages,
    nextPageToken: hasMore ? next : "",
    hasMore,
    atCap,
    hint,
  };
}

export async function readGmailMessage(messageId) {
  const id = String(messageId || "").trim();
  if (!id) return { error: "message_id is required" };
  if (!gmailToolsAvailable()) return { error: "gmail_not_configured" };
  if (!isGmailConnected()) return notConnectedPayload();
  const gmail = gmailClient();
  if (!gmail) return notConnectedPayload();

  const got = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  const headers = headerMap(got.data?.payload);
  const bodies = collectBodies(got.data?.payload);
  const body = capBody(bodies.text || htmlToText(bodies.html));
  return {
    id,
    from: headers.from || "",
    to: headers.to || "",
    subject: headers.subject || "(no subject)",
    date: headers.date || "",
    body,
  };
}

export async function sendGmailMessage({ to, subject, body, cc } = {}) {
  if (!gmailToolsAvailable()) return { error: "gmail_not_configured" };
  if (!isGmailConnected()) return notConnectedPayload();
  const gmail = gmailClient();
  if (!gmail) return notConnectedPayload();

  const dest = String(to || "").trim();
  const subj = String(subject || "").trim();
  if (!dest || !subj) return { error: "to and subject are required" };

  const raw = buildRawMessage({
    to: dest,
    subject: subj,
    body: String(body || ""),
    cc: String(cc || "").trim(),
  });
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return {
    ok: true,
    id: sent.data?.id || "",
    threadId: sent.data?.threadId || "",
  };
}

export function parseRecipient(to) {
  const raw = String(to || "").trim();
  const angled = raw.match(/<([^>]+@[^>]+)>/);
  const bare = raw.match(/[^\s<>]+@[^\s<>]+/);
  const address = String(angled?.[1] || bare?.[0] || raw).trim();
  return { raw, address };
}

export function normalizeGmailDraft({ to, subject, body, cc } = {}) {
  const parsed = parseRecipient(to);
  return {
    to: parsed.raw || parsed.address,
    address: parsed.address,
    subject: String(subject || "").trim(),
    body: String(body || "").trim(),
    cc: String(cc || "").trim(),
  };
}

export function offerGmailSendConfirm(draft, ctx = {}) {
  const normalized = normalizeGmailDraft(draft);
  try { ctx.onGmailSendConfirm?.(normalized); } catch {}
  const who = normalized.address || normalized.to || "them";
  return {
    ok: false,
    need_confirm_send: true,
    action: "draft",
    draft: normalized,
    to: normalized.to,
    address: normalized.address,
    spoken_summary: `One more check — I'm about to send this to ${who}. Want me to send it?`,
    hint: "Do NOT send yet. Say the FULL email address out loud. A confirm card is on screen. Wait for them to say yes.",
  };
}

export function detectGmailSendConfirm(userText = "", { pending = false } = {}) {
  if (!pending) return false;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t || t.length > 90) return false;
  if (/\b(no|nah|nope|cancel|stop|wait|hold|change|edit|wrong|don'?t|dont)\b/.test(t)
    && !/\b(send|yes|yeah|yep)\b/.test(t)) {
    return false;
  }
  return /^(yeah|yep|yes|yea|yup|sure|ok|okay|send(\s+it)?|do\s+it|go\s+ahead|ship\s+it|please|alright)\b/.test(t)
    || /\b(send\s+it|go\s+ahead|do\s+it|ship\s+it|send\s+that|yes\s+send)\b/.test(t);
}

export function detectGmailSendDecline(userText = "", { pending = false } = {}) {
  if (!pending) return false;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  return /^(no|nah|nope|cancel|stop|wait|hold(\s+on)?|never\s+mind|nvm)\b/.test(t)
    || /\b(don'?t send|dont send|cancel that|not yet|wrong (email|address|person))\b/.test(t);
}

/**
 * Detect anything email-related. The mail agent handles the rest.
 * @returns {"mail"|"send"|null}
 */
export function detectExplicitGmailIntent(userText = "") {
  if (!gmailToolsAvailable()) return null;
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;

  const wantsSend =
    /\b(send|draft|write|compose)\b.{0,28}\b(e-?mail|gmail|mail)\b/.test(t)
    || /\b(e-?mail|mail)\s+(this\s+)?to\b/.test(t)
    || /\bsend\s+(an?\s+)?(e-?mail|gmail|mail)\b/.test(t)
    || (/\be-?mail\s+\S+/.test(t) && /\b(send|write|draft|tell|let)\b/.test(t))
    || (
      /\be-?mail\s+[a-z0-9]/.test(t)
      && !/\be-?mail\s+(me|my|the|this|that|app|inbox|account|address)\b/.test(t)
    );
  if (wantsSend) return "send";

  const looksLikeMail =
    /\b(e-?mails?|gmail|inbox)\b/.test(t)
    || /\b(unread|newsletters?)\b/.test(t)
    || (/\bmail\b/.test(t) && !/\b(blackmail|chainmail|mailman|mail\s+it\s+in)\b/.test(t))
    || /\b(who\s+emailed|did\s+\w+\s+email|emailed\s+me)\b/.test(t);
  if (looksLikeMail) return "mail";

  return null;
}

export function buildExplicitGmailNudge(kind, { installed = false, connected = false, topic = "" } = {}) {
  if (!gmailToolsAvailable() || !kind) return "";
  if (!installed && !connected) return "";
  if (kind === "mail" || kind === "search" || kind === "read") {
    const topicLine = topic ? `Their topic/person looks like: "${topic}". Include that in task.` : "";
    return [
      "--- GMAIL AGENT (MANDATORY THIS TURN) ---",
      "They asked something email-related. You MUST call gmail_agent this turn.",
      "Pass task as their request in their words. Do not pick a Gmail query yourself — the mail agent does that.",
      topicLine,
      "Then speak the agent's spoken_summary. Do not invent mail. Do not dump a raw list.",
      connected
        ? "Use only the agent result."
        : "If it returns not_connected, tell them a connect tab opened — do not invent mail.",
      "Speak a short beat WITH the tool call.",
    ].filter(Boolean).join("\n");
  }
  if (kind === "send") {
    return [
      "--- GMAIL SEND ---",
      "They want to send mail. Call gmail_agent (or gmail_send_email) with the draft.",
      "The first call only shows a confirm card with the FULL recipient address — it does not send.",
      "Say the full email address out loud and ask if they want to send it. Wait.",
    ].join("\n");
  }
  return "";
}

export function buildGmailToolGuidance({ installed = false, connected = false } = {}) {
  if (!gmailToolsAvailable()) return "";
  const ready = Boolean(installed || connected);
  const lines = [
    "--- GMAIL (dynamic mail agent) ---",
    `Gmail app downloaded: ${ready ? "YES — already on their dock from a previous setup. Do NOT ask to download, install, or set up Gmail. Do NOT call install_app. Treat this as done." : "no"}.`,
    `Gmail connected (OAuth): ${connected ? "yes" : "no"}.`,
    "This is a virtual Gmail app inside June's on-screen stack, not the phone Gmail app.",
    "",
  ];
  if (!ready) {
    lines.push(
      "DOWNLOAD (required before any mail work):",
      "- If they want anything email-related and the Gmail app is NOT downloaded: you MUST ask out loud if you can download the Gmail app. Use those words, casual spoken voice, like a friend: \"want me to download the gmail app real quick?\"",
      "- Do NOT silently install. Do NOT call install_app until they agree.",
      "- After they agree, call install_app with app_id \"gmail\", then proceed.",
      "",
    );
  } else {
    lines.push(
      "DOWNLOAD:",
      "- Already downloaded and saved. NEVER ask to download, install, or set up Gmail. NEVER call install_app. Skip straight to gmail_agent.",
      "",
    );
  }
  lines.push(
    "CONNECT:",
    connected
      ? "- Already connected. Use gmail_agent. Do not tell them to connect or open an auth tab."
      : "- Not connected yet. Tell them to connect. A connect tab should open (localhost Gmail auth). You can mention Settings → Connect Gmail. Do not read a long URL unless they ask.",
    "- Never invent inbox contents or pretend a send landed if a tool returns not_connected or an error.",
    "- If a specific email is not in the first page, gmail_agent keeps scanning ~20 at a time up to 70. Do not invent mail it did not find.",
    "",
    "ANY EMAIL ASK:",
    "- Call gmail_agent with task = their request in their words. The mail agent searches, scans titles, reads, and summarizes. You do not need a special phrase.",
    "- Inbox, unread, find related mail, who emailed me, summarize a thread, mail about X, follow-ups — all gmail_agent.",
    "- Speak the agent's spoken_summary. Casual. Do not dump every title unless they asked for a list.",
    "- If they then want one opened, gmail_read_message with that id (or gmail_agent again).",
    "- If mail is empty or unrelated to the ask, switch to web_search or memory — do not invent inbox contents.",
    "",
    "SEND:",
    "- Call gmail_agent / gmail_send_email with the draft. The first call NEVER sends — it shows a confirm card with the full address.",
    "- Read the FULL recipient email out loud (not just a name) and ask once more: want me to send it?",
    "- Only after they say yes does a later send actually go out. Never claim you sent without ok.",
    "",
    "Voice: casual, spoken, no emdashes. Asking to download should sound like a friend, not corporate.",
  );
  return lines.join("\n");
}

export function buildGmailDownloadNudge() {
  if (!gmailToolsAvailable()) return "";
  return [
    "--- GMAIL APP NOT INSTALLED (MANDATORY THIS TURN) ---",
    "They want email and the Gmail app is NOT downloaded yet.",
    "You MUST ask out loud if you can download the Gmail app. Use those words. Casual, like a friend: \"want me to download the gmail app real quick?\"",
    "Do NOT call install_app until they agree. Do not silently install. Do not check mail yet. Do not invent inbox contents.",
  ].join("\n");
}

/**
 * @param {object} toolCall
 * @param {{ onGmailAuth?: (url: string) => void }} [ctx]
 */
export async function runGmailTool(toolCall, ctx = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const wrap = (payload) => ({
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(payload),
  });

  if (!gmailToolsAvailable()) {
    return wrap({ error: "gmail_not_configured" });
  }

  if (!isGmailConnected()) {
    const payload = notConnectedPayload();
    try {
      ctx.onGmailAuth?.(payload.authUrl);
    } catch {}
    return wrap(payload);
  }

  try {
    if (name === "gmail_list_messages") {
      const topic = String(args.topic || "").trim();
      const query = String(args.query || args.q || "").trim();
      const maxResults = Math.min(GMAIL_PAGE_SIZE, Math.max(1, Number(args.max_results) || GMAIL_PAGE_SIZE));
      ctx.gmailScan = ensureScan(ctx.gmailScan);
      return wrap(await listGmailInbox({
        query,
        topic,
        maxResults,
        pageToken: args.page_token || args.pageToken || "",
        scan: ctx.gmailScan,
      }));
    }

    if (name === "gmail_read_message") {
      const messageId = String(args.message_id || args.id || "").trim();
      return wrap(await readGmailMessage(messageId));
    }

    if (name === "gmail_send_email") {
      if (!ctx.gmailSendConfirmed) {
        return wrap(offerGmailSendConfirm(args, ctx));
      }
      return wrap(await sendGmailMessage({
        to: args.to,
        subject: args.subject,
        body: args.body,
        cc: args.cc,
      }));
    }

    return wrap({ error: `Unknown gmail tool: ${name}` });
  } catch (err) {
    const status = err?.code || err?.response?.status;
    const msg = String(err?.message || err).slice(0, 180);
    if (status === 401 || status === 403) {
      const payload = notConnectedPayload();
      try {
        ctx.onGmailAuth?.(payload.authUrl);
      } catch {}
      return wrap({ ...payload, detail: msg });
    }
    return wrap({
      error: "gmail_failed",
      detail: msg,
    });
  }
}
