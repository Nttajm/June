import { scanCategory, getSubMemory, getCategoryDirectory } from "./memory-store.js";
import { pickSuggestedTopicHooks, isSnapshotTopicActive } from "./snapshot-agent.js";

export const THINKER_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_past_chats",
      description:
        "List recent past chat titles and short descriptions. Use when you need continuity from earlier sessions or a relevant prior topic.",
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
        "Open one past chat by session_id or title and return its description plus a few recent turns. Use after list_past_chats when one chat looks relevant.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_memory_category",
      description:
        "List memory titles in a category (title + recallScore only). Use before get_memory_detail.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Category key such as interests, topic_deep_dives, general_info.",
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
        "Fetch one memory's full content by category + title after scanning.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          title: { type: "string" },
        },
        required: ["category", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_snapshot_hooks",
      description:
        "Read the current cached topic snapshot and unused hooks. Use when the live topic needs a sharper, more human mention.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
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

function normalizePastChats(pastChats = []) {
  if (!Array.isArray(pastChats)) return [];
  return pastChats
    .filter((c) => c && (c.session_id || c.title))
    .map((c) => ({
      session_id: c.session_id || "",
      title: c.title || "Conversation",
      main_summary: c.main_summary || "",
      end_time: c.end_time || null,
      topics: Array.isArray(c.topics) ? c.topics.slice(0, 6) : [],
      previewTurns: Array.isArray(c.previewTurns)
        ? c.previewTurns.slice(-8).map((t) => ({
            role: t.role,
            content: String(t.content || "").slice(0, 180),
          }))
        : [],
    }));
}

export function summarizePastChatsForInit(chats = [], limit = 15) {
  return normalizePastChats(chats)
    .slice(0, limit)
    .map((c) => ({
      ...c,
      previewTurns: (c.previewTurns || []).slice(-6),
    }));
}

function listPastChats(pastChats, limit = 8) {
  const n = Math.max(1, Math.min(15, Number(limit) || 8));
  return {
    count: pastChats.length,
    chats: pastChats.slice(0, n).map((c) => ({
      session_id: c.session_id,
      title: c.title,
      main_summary: c.main_summary,
      end_time: c.end_time,
      topics: c.topics,
    })),
  };
}

function getPastChat(pastChats, { session_id = "", title = "", turnLimit = 8 } = {}) {
  const byId = session_id
    ? pastChats.find((c) => c.session_id === session_id)
    : null;
  const want = String(title || "").trim().toLowerCase();
  const byTitle = !byId && want
    ? pastChats.find((c) => String(c.title).toLowerCase().includes(want))
    : null;
  const match = byId || byTitle;
  if (!match) {
    return {
      error: "Past chat not found",
      available: pastChats.slice(0, 8).map((c) => ({
        session_id: c.session_id,
        title: c.title,
      })),
    };
  }
  const n = Math.max(1, Math.min(12, Number(turnLimit) || 8));
  return {
    session_id: match.session_id,
    title: match.title,
    main_summary: match.main_summary,
    end_time: match.end_time,
    topics: match.topics,
    previewTurns: (match.previewTurns || []).slice(-n),
  };
}

function checkSnapshot(snapshotCache, { userText = "", history = [], usedTopicHooks = [] } = {}) {
  const topicHooks = snapshotCache?.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache?.conversationAngles || [];

  if (!snapshotCache || (!snapshotCache.snapshot && topicHooks.length === 0)) {
    return {
      status: "not_ready",
      canUse: false,
      reason: "No cached snapshot hooks yet.",
    };
  }
  if (snapshotCache.hasTopic === false) {
    return {
      status: "no_topic",
      canUse: false,
      reason: "Snapshot found no clear topic.",
    };
  }

  const suggestedHooks = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 4);
  return {
    status: "ready",
    canUse: suggestedHooks.length > 0,
    topic: snapshotCache.topic || "",
    topicType: snapshotCache.topicType || "other",
    snapshot: snapshotCache.snapshot || null,
    topicActive: isSnapshotTopicActive(snapshotCache, userText, history),
    suggestedHooks,
    usedTopicHooks,
  };
}

/**
 * Pure sync thinker tool runner — no network.
 */
export function runThinkerTool(toolCall, {
  memory,
  pastChats = [],
  snapshotCache = null,
  userText = "",
  history = [],
  usedTopicHooks = [],
} = {}) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  const args = parseArgs(toolCall?.function?.arguments ?? toolCall?.arguments);
  const chats = normalizePastChats(pastChats);

  let result;
  switch (name) {
    case "list_past_chats":
      result = listPastChats(chats, args.limit);
      break;
    case "get_past_chat":
      result = getPastChat(chats, args);
      break;
    case "scan_memory_category":
      result = scanCategory(memory, args.category || "");
      break;
    case "get_memory_detail":
      result = getSubMemory(memory, args.category || "", args.title || "");
      break;
    case "check_snapshot_hooks":
      result = checkSnapshot(snapshotCache, { userText, history, usedTopicHooks });
      break;
    default:
      result = {
        error: `Unknown tool: ${name}`,
        available: THINKER_TOOLS.map((t) => t.function.name),
        memoryDirectory: getCategoryDirectory(memory),
      };
  }

  return {
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(result),
  };
}

export { normalizePastChats, listPastChats, getPastChat };
