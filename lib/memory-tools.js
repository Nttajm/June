import { scanCategory, getSubMemory, getCategoryDirectory } from "./memory-store.js";
import { normalizePastChats, listPastChats, getPastChat } from "./thinker-tools.js";

export const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "scan_memory_category",
      description:
        "Step 1 of personal recall. Lists title metadata only (title + recallScore). Use when the user wants you to remember something about THEM (who they are, what they told you). Never use this to answer a tell-me / how-does-X-work / what-happens question. If titles are empty or unrelated, stop and switch to web_search or gmail instead of inventing.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Category key, e.g. interests, media, work_life, topic_deep_dives, general_info, or a custom key from the directory.",
          },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory_detail",
      description:
        "Step 2 of personal recall. Fetch ONE sub-memory about the user by title after a scan. Never use this to answer a request to tell them information, explain a subject, or describe what typically happens — even if a title seems to match. If the body does not answer the ask, switch source instead of stretching it.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Category key containing the sub-memory.",
          },
          title: {
            type: "string",
            description: "Exact or close title of the sub-memory from the scan results.",
          },
        },
        required: ["category", "title"],
      },
    },
  },
];

/** Past-session continuity — same schemas Thinker uses. */
export const PAST_CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_past_chats",
      description:
        "Step 1 of distant recall. List recent past chat titles and short descriptions. Use when the user refers to something from a prior session, or when continuity from earlier chats would help. After reviewing, call get_past_chat on one promising title, or switch source if nothing matches.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max chats to return (default 8, max 15).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_past_chat",
      description:
        "Step 2 of distant recall. Open one past chat by session_id or title and return its description plus a few recent turns. Use after list_past_chats when one chat looks relevant.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
];

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Pure sync dispatcher — no I/O. Returns a JSON-serializable result string for tool messages.
 * @param {object} memory
 * @param {object} toolCall
 * @param {{ pastChats?: array }} [opts]
 */
export function runMemoryTool(memory, toolCall, { pastChats = [] } = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const chats = normalizePastChats(pastChats);

  let result;
  switch (name) {
    case "scan_memory_category":
      result = scanCategory(memory, args.category || "");
      break;
    case "get_memory_detail":
      result = getSubMemory(memory, args.category || "", args.title || "");
      break;
    case "list_past_chats":
      result = listPastChats(chats, args.limit ?? 8);
      break;
    case "get_past_chat":
      result = getPastChat(chats, {
        session_id: args.session_id || "",
        title: args.title || "",
        turnLimit: args.turnLimit ?? 8,
      });
      break;
    default:
      result = {
        error: `Unknown tool: ${name}`,
        available: [
          "scan_memory_category",
          "get_memory_detail",
          "list_past_chats",
          "get_past_chat",
        ],
        directory: getCategoryDirectory(memory),
      };
  }

  return {
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(result),
  };
}

/** Compact titles + summaries for system prompt (no turns). */
export function buildPastChatIndex(pastChats = [], limit = 6) {
  const chats = normalizePastChats(pastChats).slice(0, limit);
  if (chats.length === 0) return "";
  const lines = [
    "--- PAST CHATS (distant sessions — titles only; skip list_past_chats and call get_past_chat on a matching title) ---",
    "Not full transcripts. When digging one up, speak a real first reaction WITH the tool call, then continue mid-thought after results — never go silent. Do not invent prior chats.",
  ];
  for (const c of chats) {
    const summary = c.main_summary ? ` — ${String(c.main_summary).slice(0, 100)}` : "";
    lines.push(`- ${c.title}${summary}`);
  }
  return lines.join("\n");
}

/**
 * Detect when the user is explicitly asking June to dig up memory / past chats.
 * Used to force tool_choice + a hard prompt override (models otherwise skip tools).
 * @returns {"memory"|"past_chat"|null}
 */
export function detectExplicitRecall(userText = "") {
  const t = String(userText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (
    /\b(last (time|chat|call|conversation|session)|previous (chat|call|conversation|session)|earlier (chat|call|conversation|session)|past (chat|chats|conversation|conversations|session)|what we (talked|were talking|chatted|said)|what (were|was) we (talking|chatting|saying)|do you remember (when|what we)|remember (when|what) we)\b/.test(t)
  ) {
    return "past_chat";
  }

  if (
    /\b(remember|memory|memories|recall|retriev\w*|what do you (know|remember) about (me|us)|look up|pull up|dig up|check (your |the )?memory|from (your |the )?memory)\b/.test(t)
  ) {
    return "memory";
  }

  return null;
}

export function buildExplicitRecallNudge(kind) {
  if (kind === "past_chat") {
    return [
      "--- EXPLICIT RECALL (MANDATORY THIS TURN) ---",
      "The user is asking about a prior chat/session. You MUST call a tool this turn — do not guess or claim you have no logs.",
      "Prefer get_past_chat on a matching PAST CHATS title. If the index is empty/no match, call list_past_chats first.",
      "Speak one short real reaction WITH the tool call, then continue from the result. Never invent prior chats.",
    ].join("\n");
  }
  if (kind === "memory") {
    return [
      "--- EXPLICIT RECALL (MANDATORY THIS TURN) ---",
      "The user is asking you to retrieve/remember something about them. You MUST call memory tools this turn — titles alone are not enough.",
      "Call scan_memory_category on the best-fit category (interests, media, work_life, topic_deep_dives, etc.), then get_memory_detail on a matching title.",
      "Do NOT say you forgot, can't store memory, or don't keep logs. Speak one short real reaction WITH the tool call, then continue from the result.",
    ].join("\n");
  }
  return "";
}

export function buildMemoryToolsOffGuidance() {
  return [
    "--- MEMORY TOOLS (off unless a miss) ---",
    "Personal recall starts off so you do not dig memory for public facts. GENERAL INFO and titles in the prompt are standing context — not an answer vault.",
    "If they asked you to TELL them information, answer if you know or offer/web_search a look-up. Never fake a memory dig. Never recite a matching title as if you retrieved the answer.",
    "If another source already ran this turn and did not answer, memory tools may appear — then you MAY scan. Do not open a public/live ask with a memory dig.",
  ].join("\n");
}

export function buildMemoryToolGuidance() {
  return [
    "--- MEMORY TOOLS (two-step, ultra-light) ---",
    "You NEVER receive the full memory JSON or full past-chat transcripts. Titles in the prompt are NOT full content — call tools when you need the actual detail.",
    "",
    "EXPLICIT ASK = ALWAYS TOOL:",
    "If they ask you to remember, recall, retrieve memory, what you know about them, or what you talked about last time — you MUST call tools this turn. Never bluff, never invent, never claim you have no memory/logs.",
    "",
    "MEMORY vs TELL-ME:",
    "Memory tools are who THEY are and what they told you — not a vault of public answers.",
    "If they want YOU to provide information (how something works, what typically happens, what to expect), that is not a memory dig. Answer if you know, or offer to look it up. Never \"lemme see… it's in here somewhere\" for that.",
    "If you already scanned and nothing useful is there, switch to web_search or gmail instead of claiming a memory you do not have — unless the ask was clearly only about them.",
    "Short go-ahead follow-ups inherit the last ask. If they were asking to be told something, keep answering / offering look-up — do not switch to scan_memory.",
    "Thinker memory angles are personal callbacks while chatting, not a reason to reconstruct an informational answer from memory.",
    "",
    "CATEGORY MEMORY (durable facts):",
    "Step 1: scan_memory_category(category) → title metadata only, including recallScore.",
    "Step 2: get_memory_detail(category, title) → one sub-memory content + recallScore, OR stop if titles are enough.",
    "RecallScore is not certainty; it is how worth bringing up the memory is. Under 0.65 usually means wait until the user raises it — unless they explicitly asked you to dig.",
    "",
    "DISTANT PAST CHATS (what we said that time) — KEEP THIS FAST:",
    "The PAST CHATS index is already in your prompt. Skip list_past_chats. Call get_past_chat on the matching title immediately (one tool round).",
    "Only use list_past_chats if the index is empty or nothing matches.",
    "Use when the user refers to a prior session, or continuity from earlier chats would help. Prefer category tools for standing facts; past chats for session continuity.",
    "",
    "STEP MODE (speak → enrich → continue) — DEFAULT WHEN USING TOOLS:",
    "When you call a tool, ALWAYS speak ONE short real reaction FIRST in the same turn — substance (opinion, tease, noun lead), not a searching murmur.",
    "Example shape: \"oh yeah? I love her stuff\" + tool_call — NOT \"hang on...\" / \"ok lemm see here...\" / \"wait wait...\".",
    "While that first beat plays, tools resolve. After results land, CONTINUE mid-thought with ONE specific add-on — do not re-ack, restate, or restart the turn.",
    "Never sit quiet while tools run. Never read tool JSON aloud. Never dump chat logs or memory lists into speech.",
    "",
    "For casual turns (no recall ask): prefer speaking without tools when GENERAL INFO already covers what you need — that block is always in your system prompt (including greetings). Follow standing GENERAL INFO rules (name, language, location, work, speech style, humor) every turn.",
    "One memory path first: either one scan + one detail, OR one get_past_chat (skip list unless the index is empty). If that path misses, you MAY leave memory for web_search or gmail.",
  ].join("\n");
}
