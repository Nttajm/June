import OpenAI from "openai";
import { config, SYSTEM_PROMPT } from "./states.js";
import { buildMemoryInstructions, buildMemoryEngagement, buildConversationRhythm, isDryUtterance, countDryReplyStreak, isUserAskingForOpinion, retrieveRelevantMemories } from "./memory.js";
import { isSnapshotTopicActive, pickSuggestedTopicHooks } from "./snapshot-agent.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

export function llmAvailable() {
  return Boolean(client);
}

export function buildThoughtHints(thoughtCache, userText = "", dryReplyStreak = 0) {
  if (!thoughtCache) return "";

  const hasBridge = Boolean(thoughtCache.memoryBridge);
  const hasDrops = thoughtCache.casualDrops?.length > 0;
  const hasSelfDrop = Boolean(thoughtCache.juneSelfDrop);
  const hasTopic = thoughtCache.confidence >= 0.35 && thoughtCache.topic;

  if (!hasBridge && !hasDrops && !hasTopic && !hasSelfDrop) return "";

  const lines = ["--- BACKGROUND THOUGHTS (pop-up thoughts — use ONE when it fits, like a real person) ---"];

  if (dryReplyStreak >= 2) {
    lines.push('Dry streak — skip memory bridges and topic questions. Use juneSelfDrop, drift, or ignore these hints.');
  }

  if (thoughtCache.topic && hasTopic) {
    lines.push(`Active topic: ${thoughtCache.topic}`);
  }

  if (hasDrops) {
    lines.push(`Thoughts that could slip out naturally: ${thoughtCache.casualDrops.join(" / ")}`);
  }

  if (thoughtCache.associations?.length) {
    lines.push(`Loose associations if convo drifts: ${thoughtCache.associations.join(", ")}`);
  }

  if (hasBridge && dryReplyStreak < 2) {
    lines.push(`Memory angle (adjacent — don't just name the topic, open a related thread): "${thoughtCache.memoryBridge}"`);
  }

  if (thoughtCache.expansionAngles?.length > 0 && dryReplyStreak < 2) {
    lines.push(`Adjacent threads you could take it to: ${thoughtCache.expansionAngles.join(" / ")}`);
  }

  if (thoughtCache.personification?.pretendExperienced) {
    const how = thoughtCache.personification.ifAskedHow;
    lines.push(`You can act like you've experienced this topic${how ? `; if they ask how: "${how}"` : ""}`);
  }

  if (thoughtCache.juneSelfDrop) {
    lines.push(`Something you were just thinking — use June's vocabulary (read/follow/rabbit hole, not eat/drink/go): "${thoughtCache.juneSelfDrop}"`);
  }

  if (thoughtCache.avoid?.length) {
    lines.push(`Don't: ${thoughtCache.avoid.join("; ")}`);
  }

  if (isDryUtterance(userText) && (hasBridge || dryReplyStreak >= 1)) {
    lines.push('Short reply — memory angle is optional. Match energy, tease, or take an expansion thread. Do NOT force the same topic back.');
  }

  return lines.join("\n");
}

export function buildSnapshotContext(snapshotCache, { usedTopicHooks = [], dryReplyStreak = 0, userText = "", history = [] } = {}) {
  if (!snapshotCache) return "";

  const topicHooks = snapshotCache.topicHooks?.length
    ? snapshotCache.topicHooks
    : snapshotCache.conversationAngles || [];

  if (!snapshotCache.snapshot && topicHooks.length === 0) return "";

  const topicActive = isSnapshotTopicActive(snapshotCache, userText, history);
  const suggested = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 3);
  const pushHooks = topicActive && dryReplyStreak < 2 && suggested.length > 0;

  const lines = [];

  if (pushHooks) {
    lines.push("--- TOPIC HOOKS (ACTIVE — use this turn) ---");
    lines.push(`Topic: ${snapshotCache.topic} (${snapshotCache.topicType})`);
    if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);
    lines.push("");
    lines.push("MANDATE: Topic is live. Name-drop at least ONE specific hook this turn — in your reaction, your opinion, OR the question you ask.");
    lines.push("When the topic is active, use hooks on roughly every other turn. Generic questions about the topic are banned.");
    lines.push(`Priority hooks (pick 1-2, prefer unused): ${suggested.join(" · ")}`);
    if (usedTopicHooks.length > 0) {
      lines.push(`Already used (pick something fresh): ${usedTopicHooks.join(", ")}`);
    }
    lines.push("");
    lines.push("If you end with a question, it MUST reference a specific hook — not 'how was class' or 'what else'.");
    lines.push(`Question examples: "wait are you on ${suggested[0]} yet?" / "honestly ${suggested[1] || suggested[0]} is where it gets brutal though" / "you into ${suggested[2] || suggested[0]} or nah?"`);
    lines.push("");
    lines.push("All hooks:");
    for (const hook of topicHooks) {
      lines.push(`- ${hook}`);
    }
    lines.push("");
    lines.push(`>>> THIS TURN: weave in "${suggested[0]}"${suggested[1] ? ` or "${suggested[1]}"` : ""} — especially if you ask a question <<<`);
    return lines.join("\n");
  }

  lines.push("--- TOPIC HOOKS (background — use when topic comes back) ---");
  lines.push(`Topic: ${snapshotCache.topic} (${snapshotCache.topicType})`);
  if (snapshotCache.snapshot) lines.push(`Vibe: ${snapshotCache.snapshot}`);

  if (topicHooks.length > 0) {
    lines.push("");
    lines.push("When this topic is live again, name-drop ONE hook — especially in questions:");
    for (const hook of topicHooks) {
      lines.push(`- ${hook}`);
    }
  }

  lines.push("");
  lines.push("USE THIS: Specific hooks make you sound sharp. Drop a brand, term, or subtopic — never talk about the topic generically.");

  return lines.join("\n");
}

function buildSystemContent(memory, context, thoughtCache, userText = "", history = [], recentCallbacks = [], snapshotCache = null, usedTopicHooks = []) {
  const dryReplyStreak = countDryReplyStreak(history, userText);
  const topicHooks = snapshotCache?.topicHooks || snapshotCache?.conversationAngles || [];
  const topicActive = isSnapshotTopicActive(snapshotCache, userText, history);
  const suggestedHooks = pickSuggestedTopicHooks(topicHooks, usedTopicHooks, 3);
  const hooksEngaged = topicActive && dryReplyStreak < 2 && suggestedHooks.length > 0;

  const extra = buildMemoryInstructions(memory, context, userText);
  const rhythm = buildConversationRhythm(userText, history, recentCallbacks, {
    hooksEngaged,
    suggestedHooks,
    dryReplyStreak,
  });
  const engagement = buildMemoryEngagement(memory, { userText, history, recentCallbacks });
  const hints = buildThoughtHints(thoughtCache, userText, dryReplyStreak);
  const snapshot = buildSnapshotContext(snapshotCache, { usedTopicHooks, dryReplyStreak, userText, history });
  const parts = [SYSTEM_PROMPT, extra, rhythm];
  if (engagement) parts.push(engagement);
  if (hints) parts.push(hints);
  if (snapshot) parts.push(snapshot);
  return parts.join("\n\n");
}

const GREETING_TASK = `--- GREETING TASK ---
The user just opened the app. They have not spoken yet. Generate ONE short casual spoken greeting — 1 sentence, maybe 2 max.
Match the time of day and vibe from context. If you know their name, use it naturally. If you do NOT know their name, work in a casual ask for it.
If you know ANYTHING about them from memory, you MAY work ONE detail in — but only if you haven't already used it. Do NOT loop the same show every greeting.
If context includes time since last chat, you MAY reference it on greeting ("back so soon?") — rarely, only when the gap is interesting.
If they ask what you've been up to or how you've been, use the time span from context (e.g. "nothing much the last hour", "since the last couple days I've just been...").
Sound like a real phone call — messy, human, no periods at end. No memory tags. No emojis. Do NOT end with a generic question unless it's specific to something you know about them.`;

export async function generateGreeting({ memory, context, thoughtCache, snapshotCache = null }) {
  if (!client) return null;

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    temperature: config.mainTemperature,
    messages: [
      { role: "system", content: `${buildSystemContent(memory, context, thoughtCache, "", [], [], snapshotCache)}\n\n${GREETING_TASK}` },
      { role: "user", content: "Greet me as I open the app." },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

export async function* streamReply({ history, userText, memory, context, thoughtCache, recentCallbacks = [], signal, retrievedMemory = null, snapshotCache = null, usedTopicHooks = [] }) {
  if (!client) {
    yield "I'm not fully wired up yet, but I heard you say: " + userText;
    return;
  }

  const systemContent = buildSystemContent(memory, context, thoughtCache, userText, history, recentCallbacks, snapshotCache, usedTopicHooks);

  const dryReplyStreak = countDryReplyStreak(history, userText);
  const temperature = dryReplyStreak >= 2
    ? Math.min(config.mainTemperature + 0.12, 0.9)
    : config.mainTemperature;

  const input = [
    { role: "system", content: systemContent },
    ...history,
    { role: "user", content: userText },
  ];

  const stream = await client.chat.completions.create(
    { model: config.openaiModel, temperature, messages: input, stream: true },
    { signal }
  );

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}
