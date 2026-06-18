import OpenAI from "openai";
import { config, SYSTEM_PROMPT } from "./states.js";
import { buildMemoryInstructions, buildMemoryEngagement, buildConversationRhythm, isGenericUtterance, retrieveRelevantMemories } from "./memory.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

export function llmAvailable() {
  return Boolean(client);
}

export function buildThoughtHints(thoughtCache, userText = "") {
  if (!thoughtCache) return "";

  const hasBridge = Boolean(thoughtCache.memoryBridge);
  const hasDrops = thoughtCache.casualDrops?.length > 0;
  const hasSelfDrop = Boolean(thoughtCache.juneSelfDrop);
  const hasTopic = thoughtCache.confidence >= 0.35 && thoughtCache.topic;

  if (!hasBridge && !hasDrops && !hasTopic && !hasSelfDrop) return "";

  const lines = ["--- BACKGROUND THOUGHTS (pop-up thoughts — use ONE when it fits, like a real person) ---"];

  if (thoughtCache.topic && hasTopic) {
    lines.push(`Active topic: ${thoughtCache.topic}`);
  }

  if (hasDrops) {
    lines.push(`Thoughts that could slip out naturally: ${thoughtCache.casualDrops.join(" / ")}`);
  }

  if (thoughtCache.associations?.length) {
    lines.push(`Loose associations if convo drifts: ${thoughtCache.associations.join(", ")}`);
  }

  if (hasBridge) {
    lines.push(`Memory angle (adjacent — don't just name the topic, open a related thread): "${thoughtCache.memoryBridge}"`);
  }

  if (thoughtCache.expansionAngles?.length > 0) {
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

  if (isGenericUtterance(userText) && hasBridge) {
    lines.push('Short reply — memory angle is optional. Match energy, tease, or take an expansion thread. Do NOT force the same topic back.');
  }

  return lines.join("\n");
}

export function buildSnapshotContext(snapshotCache) {
  if (!snapshotCache || !snapshotCache.snapshot) return "";

  const lines = ["--- TOPIC SNAPSHOT (background context — use naturally, don't dump facts) ---"];
  
  lines.push(`Topic: ${snapshotCache.topic} (${snapshotCache.topicType})`);
  lines.push("");
  lines.push(snapshotCache.snapshot);
  
  if (snapshotCache.conversationAngles?.length > 0) {
    lines.push("");
    lines.push(`Conversation angles: ${snapshotCache.conversationAngles.join(" | ")}`);
  }
  
  lines.push("");
  lines.push("NOTE: This is background context. Weave it in naturally — don't lecture or info-dump. Only reference what's relevant to what they're saying.");

  return lines.join("\n");
}

function buildSystemContent(memory, context, thoughtCache, userText = "", history = [], recentCallbacks = [], snapshotCache = null) {
  const extra = buildMemoryInstructions(memory, context, userText);
  const rhythm = buildConversationRhythm(userText, history, recentCallbacks);
  const engagement = buildMemoryEngagement(memory, { userText, history, recentCallbacks });
  const hints = buildThoughtHints(thoughtCache, userText);
  const snapshot = buildSnapshotContext(snapshotCache);
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

export async function* streamReply({ history, userText, memory, context, thoughtCache, recentCallbacks = [], signal, retrievedMemory = null, snapshotCache = null }) {
  if (!client) {
    yield "I'm not fully wired up yet, but I heard you say: " + userText;
    return;
  }

  const systemContent = buildSystemContent(memory, context, thoughtCache, userText, history, recentCallbacks, snapshotCache);

  const input = [
    { role: "system", content: systemContent },
    ...history,
    { role: "user", content: userText },
  ];

  const stream = await client.chat.completions.create(
    { model: config.openaiModel, temperature: config.mainTemperature, messages: input, stream: true },
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
