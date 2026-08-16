import {
  isSnapshotTopicActive,
  pickSuggestedTopicHooks,
} from "./snapshot-agent.js";

export const SNAPSHOT_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_snapshot_hooks",
      description:
        "Cached-only topic hook check. Use sparingly when you want to bring up a random, related, or sharper topic beat and need to know whether the background snapshot has fresh hooks. This does not refresh or call another model.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Short reason for checking, e.g. dry_user, random_topic, related_topic, sharper_followup.",
          },
        },
      },
    },
  },
];

function snapshotHooks(snapshotCache) {
  return snapshotCache?.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache?.conversationAngles || [];
}

/**
 * Pure sync dispatcher. Reads only the already-cached background snapshot.
 */
export function runSnapshotTool(snapshotCache, toolCall, { userText = "", history = [], usedTopicHooks = [] } = {}) {
  const topicHooks = snapshotHooks(snapshotCache);
  const ageMs = snapshotCache?.generatedAt ? Date.now() - snapshotCache.generatedAt : null;

  let result;
  if (!snapshotCache || (!snapshotCache.snapshot && topicHooks.length === 0)) {
    result = {
      status: "not_ready",
      canUse: false,
      reason: "No cached snapshot hooks are ready yet. Do not wait; continue naturally.",
    };
  } else if (snapshotCache.hasTopic === false) {
    result = {
      status: "no_topic",
      canUse: false,
      ageMs,
      reason: "Snapshot checked recently but found no clear topic. Use your own natural drift if needed.",
    };
  } else {
    const suggestedHooks = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 4);
    result = {
      status: "ready",
      canUse: suggestedHooks.length > 0,
      topic: snapshotCache.topic || "",
      topicType: snapshotCache.topicType || "other",
      snapshot: snapshotCache.snapshot || null,
      ageMs,
      topicActive: isSnapshotTopicActive(snapshotCache, userText, history),
      suggestedHooks,
      usedTopicHooks,
      instruction:
        "Use at most one hook, casually. If topicActive is false, bring it up only if it feels like a natural related/random pivot.",
    };
  }

  return {
    tool_call_id: toolCall?.id || "",
    name: "check_snapshot_hooks",
    content: JSON.stringify(result),
  };
}

export function buildSnapshotToolGuidance(snapshotCache) {
  const topicHooks = snapshotHooks(snapshotCache);
  if (!snapshotCache || (!snapshotCache.snapshot && topicHooks.length === 0)) return "";

  return [
    "--- SNAPSHOT TOOL (cached topic hooks, optional) ---",
    "Tool: check_snapshot_hooks(reason)",
    "Use it when a topic just opened and a sharper hook would help (album name, subtopic, specific angle) — or the user is dry and you need a fresh beat.",
    "STEP MODE: speak a real first reaction WITH the tool call, then continue mid-thought with ONE hook after results — never murmur \"hang on\" then dump facts.",
    "Do NOT call it every turn. It is cached-only: if no snapshot is ready, continue naturally without waiting.",
  ].join("\n");
}
