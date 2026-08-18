import { config } from "./states.js";
import { getLlmClient } from "./llm-client.js";
import { getGmailStatus, getLocalAuthUrl, isGmailConnected } from "./gmail-auth.js";
import {
  gmailToolsAvailable,
  listGmailInbox,
  readGmailMessage,
  sendGmailMessage,
  offerGmailSendConfirm,
  normalizeGmailDraft,
  emptyGmailScan,
  GMAIL_PAGE_SIZE,
  GMAIL_MAX_SCAN,
} from "./gmail-tools.js";
import { chatModelOptions } from "./model-options.js";
import { normalizeChatUsage } from "./usage.js";

const client = getLlmClient();
const MAX_TOOL_ROUNDS = 6;
const AGENT_TIMEOUT_MS = 22000;

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_mail",
      description:
        "Search Gmail. Use a plain topic and/or Gmail query. Returns titles, senders, snippets. Start here for almost every ask. Then read_mail only if you need a body.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Plain topic or person, e.g. amazon, lease, mom, interview.",
          },
          query: {
            type: "string",
            description: "Gmail search syntax if useful, e.g. is:unread, from:alice@x.com, newer_than:7d.",
          },
          max_results: {
            type: "number",
            description: `Page size, 1-${GMAIL_PAGE_SIZE}. Default ${GMAIL_PAGE_SIZE}.`,
          },
          page_token: {
            type: "string",
            description: `From nextPageToken on the last search. Use this to check the next ~${GMAIL_PAGE_SIZE} if the email was not in that page. Stops at ${GMAIL_MAX_SCAN}.`,
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_mail",
      description: "Read one message body by id from search_mail. Use when they want contents, a summary of a specific email, or you need detail beyond the title.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "account_status",
      description: "Connected Gmail address and whether OAuth is ready.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_mail",
      description:
        "Prepare or send an email. First call with the draft (even if they already said send) so June can show the full recipient address and confirm. ONLY pass user_confirmed true if they just said yes AFTER seeing that confirm. Otherwise leave it false and put the draft in your final JSON with need_confirm_send true.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          cc: { type: "string" },
          user_confirmed: { type: "boolean" },
        },
        required: ["to", "subject", "body", "user_confirmed"],
      },
    },
  },
];

const AGENT_PROMPT = `You are June's MAIL AGENT. You never talk to the user. You inspect their Gmail and return a compact briefing for June to speak.

## JOB
Figure out ANY email ask dynamically. Inbox, unread, find related mail, scan titles, who emailed me, summarize a thread, "anything from X", follow-ups, "what's my gmail", drafts. Do not wait for a perfect phrasing.

## HOW
1. Call search_mail first for almost everything. Invent a good topic/query from their words (person, company, keyword, is:unread, newer_than:7d, from:). First page is ~20 titles.
2. Scan titles + snippets. If they want a summary of related mail, that is enough — do not read every body.
3. If the email they asked for is NOT in this page and hasMore is true, call search_mail AGAIN with the same topic/query and page_token = nextPageToken. Keep going page by page (~20 each). Stop when you find it, hasMore is false, or atCap / scanned hits 70.
4. read_mail 1-2 messages only when they asked to read/open one, or titles are not enough to answer.
5. account_status if they ask which account / am I connected.
6. For send: fill the draft. Do NOT actually send on the first pass — set need_confirm_send true so June can show the full address. send_mail with user_confirmed true ONLY after they said yes to that confirm.

Prefer finding the mail over being fast. First miss → look at the next 20. Do not invent. Cap is 70 scanned.

## RULES
- Never invent emails, senders, or subjects. If search is empty after you have looked as far as allowed, say so clearly (empty inbox / no matches) so June can try another source.
- If not_connected, say they need to connect. Do not fake inbox.
- spoken_summary: 1-4 short spoken sentences, casual, no markdown, no emdashes, no bullet dump. Title scan = count + who + what the subjects are about. Offer to open one if useful. For a send draft, say the FULL recipient email address.
- Keep highlights to the useful matches (max 8).

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "ok": true,
  "action": "search" | "read" | "inbox" | "draft" | "sent" | "status" | "none",
  "spoken_summary": string,
  "count": number,
  "highlights": [{ "id": string, "from": string, "subject": string, "why": string }],
  "draft": { "to": string, "subject": string, "body": string } | null,
  "need_confirm_send": boolean
}`;

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
  }
  return null;
}

async function runAgentTool(toolCall, ctx = {}) {
  const name = toolCall?.function?.name || "";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const wrap = (payload) => ({
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(payload),
  });

  try {
    if (name === "search_mail") {
      ctx.gmailScan = ctx.gmailScan || emptyGmailScan();
      return wrap(await listGmailInbox({
        topic: args.topic || "",
        query: args.query || args.q || "",
        maxResults: args.max_results,
        pageToken: args.page_token || args.pageToken || "",
        scan: ctx.gmailScan,
      }));
    }
    if (name === "read_mail") {
      return wrap(await readGmailMessage(args.message_id || args.id || ""));
    }
    if (name === "account_status") {
      return wrap(await getGmailStatus());
    }
    if (name === "send_mail") {
      const draft = normalizeGmailDraft(args);
      if (!args.user_confirmed || !ctx.gmailSendConfirmed) {
        return wrap(offerGmailSendConfirm(draft, ctx));
      }
      return wrap(await sendGmailMessage(draft));
    }
    return wrap({ error: `Unknown tool: ${name}` });
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 180);
    if (/401|403/.test(msg)) {
      const payload = {
        error: "not_connected",
        authUrl: getLocalAuthUrl(),
        detail: msg,
      };
      try { ctx.onGmailAuth?.(payload.authUrl); } catch {}
      return wrap(payload);
    }
    return wrap({ error: "gmail_failed", detail: msg });
  }
}

function normalizeBrief(parsed, fallback = "") {
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      action: "none",
      spoken_summary: fallback || "I couldn't pull that mail just now.",
      count: 0,
      highlights: [],
      draft: null,
      need_confirm_send: false,
    };
  }
  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.slice(0, 8).map((h) => ({
      id: String(h?.id || ""),
      from: String(h?.from || "").slice(0, 120),
      subject: String(h?.subject || "").slice(0, 180),
      why: String(h?.why || "").slice(0, 160),
    }))
    : [];
  const draft = parsed.draft && typeof parsed.draft === "object"
    ? {
      to: String(parsed.draft.to || ""),
      subject: String(parsed.draft.subject || ""),
      body: String(parsed.draft.body || "").slice(0, 2000),
    }
    : null;
  return {
    ok: parsed.ok !== false,
    action: String(parsed.action || "search").slice(0, 24),
    spoken_summary: String(parsed.spoken_summary || fallback || "").slice(0, 900),
    count: Number(parsed.count) || highlights.length,
    highlights,
    draft,
    need_confirm_send: Boolean(parsed.need_confirm_send),
  };
}

/**
 * Dynamic mail agent. Main LLM calls gmail_agent; this figures out search/read/send.
 */
export async function runGmailAgent(toolCall, ctx = {}) {
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const wrap = (payload) => ({
    tool_call_id: toolCall?.id || "",
    name: "gmail_agent",
    content: JSON.stringify(payload),
  });

  if (!gmailToolsAvailable()) {
    return wrap({ error: "gmail_not_configured", spoken_summary: "Gmail isn't configured on this server." });
  }
  if (!isGmailConnected()) {
    const payload = {
      error: "not_connected",
      authUrl: getLocalAuthUrl(),
      spoken_summary: "Gmail isn't connected yet. They need to finish signing in.",
    };
    try { ctx.onGmailAuth?.(payload.authUrl); } catch {}
    return wrap(payload);
  }
  if (!client) {
    return wrap({ error: "llm_unavailable" });
  }

  const task = String(args.task || ctx.userText || "").trim();
  if (!task) {
    return wrap({ error: "task is required" });
  }
  ctx.gmailScan = emptyGmailScan();

  const recent = (ctx.history || []).slice(-6).map((m) => ({
    role: m.role,
    content: String(m.content || "").slice(0, 400),
  }));

  const messages = [
    { role: "system", content: AGENT_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        task,
        userText: ctx.userText || task,
        recentHistory: recent,
      }),
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  if (ctx.signal) {
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const signal = controller.signal;

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break;
      const allowTools = round < MAX_TOOL_ROUNDS;
      const response = await client.chat.completions.create(
        {
          ...chatModelOptions(config.gmailAgentModel || config.memoryAiModel, {
            temperature: 0.2,
            maxTokens: 700,
          }),
          messages,
          ...(allowTools
            ? { tools: AGENT_TOOLS, tool_choice: round === 0 ? "required" : "auto" }
            : { tool_choice: "none" }),
        },
        { signal }
      );

      const usage = normalizeChatUsage(response.usage);
      if (usage) {
        try {
          ctx.onUsage?.({
            agent: "gmail",
            model: config.gmailAgentModel || config.memoryAiModel,
            usage,
          });
        } catch {}
      }

      const msg = response.choices?.[0]?.message;
      if (!msg) break;
      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length || !allowTools) {
        const brief = normalizeBrief(parseJsonObject(msg.content || ""));
        if (brief.need_confirm_send && brief.draft) {
          try { ctx.onGmailSendConfirm?.(normalizeGmailDraft(brief.draft)); } catch {}
        }
        try {
          ctx.onTrace?.({
            agent: "gmail",
            phase: "result",
            name: "gmail_agent",
            detail: {
              task,
              action: brief.action,
              count: brief.count,
              highlights: brief.highlights,
              focusId: brief.highlights.find((h) => h.id)?.id || "",
              need_confirm_send: brief.need_confirm_send,
              draft: brief.draft,
            },
          });
        } catch {}
        return wrap({
          ...brief,
          focusId: brief.highlights.find((h) => h.id)?.id || "",
          hint: brief.need_confirm_send
            ? "Do NOT send yet. Say the FULL recipient email from the draft. The confirm card is on screen. Wait for yes."
            : "Speak spoken_summary to the user. Do not invent extra mail. If they ask to open one, you can call gmail_read_message with that id. The on-screen stack will shuffle to the matching email — do not ask them to download Gmail.",
        });
      }

      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name || "";
        const result = await runAgentTool(tc, ctx);
        console.log(`[gmail-agent] ${name}`, String(tc.function?.arguments || "").slice(0, 80));
        try {
          ctx.onTrace?.({
            agent: "gmail",
            phase: "tool",
            name,
            detail: { args: parseArgs(tc.function?.arguments), result: result.content },
          });
        } catch {}
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.content,
        });
      }
    }
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.error("[gmail-agent]", err?.message || err);
    }
    return wrap({
      ok: false,
      error: err?.name === "AbortError" ? "timeout" : "gmail_agent_failed",
      spoken_summary: "Mail lookup took too long or failed. Try that ask again.",
    });
  } finally {
    clearTimeout(timer);
  }

  return wrap({
    ok: false,
    error: "no_result",
    spoken_summary: "I couldn't finish searching mail. Try once more.",
  });
}
