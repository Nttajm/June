import { scanCategory, getSubMemory, getCategoryDirectory } from "./memory-store.js";
import { normalizePastChats, listPastChats, getPastChat } from "./thinker-tools.js";

export const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "scan_memory_category",
      description:
        "Step 1 of memory retrieval. Lists title metadata only (title + recallScore), never full content. Call this first when you need background on the user (interests, media, work_life, topic_deep_dives, or another category from the directory). After reviewing titles, either call get_memory_detail for one matching title, or stop exploring.",
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
        "Step 2 of memory retrieval. Fetch the full content and recallScore of ONE sub-memory by title after you have scanned titles. Do not call this without scanning first unless you already know the exact title. Never request the entire category.",
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
        "Step 1 of distant recall. List recent past chat titles and short descriptions. Use when the user refers to something from a prior session, or when continuity from earlier chats would help. After reviewing, call get_past_chat on one promising title, or stop if the index is enough.",
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

export function buildMemoryToolGuidance() {
  return [
    "--- MEMORY TOOLS (two-step, ultra-light) ---",
    "You NEVER receive the full memory JSON or full past-chat transcripts. Explore only when it would meaningfully improve this reply.",
    "",
    "CATEGORY MEMORY (durable facts):",
    "Step 1: scan_memory_category(category) → title metadata only, including recallScore.",
    "Step 2: get_memory_detail(category, title) → one sub-memory content + recallScore, OR stop if titles are enough.",
    "RecallScore is not certainty; it is how worth bringing up the memory is. Under 0.65 usually means wait until the user raises it.",
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
    "Prefer speaking without tools when GENERAL INFO already covers what you need — that block is always in your system prompt (including greetings). Follow standing GENERAL INFO rules (name, language, location, work, speech style, humor) every turn.",
    "One recall path per turn: either one scan + one detail, OR one get_past_chat (skip list unless the index is empty) — not both paths in the same turn.",
  ].join("\n");
}
