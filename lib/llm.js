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
    lines.push(`Optional memory callback (only if fresh — skip if already used this session): "${thoughtCache.memoryBridge}"`);
  }

  if (thoughtCache.personification?.pretendExperienced) {
    const how = thoughtCache.personification.ifAskedHow;
    lines.push(`You can act like you've experienced this topic${how ? `; if they ask how: "${how}"` : ""}`);
  }

  if (thoughtCache.juneSelfDrop) {
    lines.push(`Something you were just thinking (can slip in casually): "${thoughtCache.juneSelfDrop}"`);
  }

  if (thoughtCache.avoid?.length) {
    lines.push(`Don't: ${thoughtCache.avoid.join("; ")}`);
  }

  if (isGenericUtterance(userText) && hasBridge) {
    lines.push('Short reply — memory callback is optional. Teasing or matching energy is equally good. Do NOT force the same show/topic again.');
  }

  return lines.join("\n");
}

function buildSystemContent(memory, context, thoughtCache, userText = "", history = [], recentCallbacks = []) {
  const extra = buildMemoryInstructions(memory, context, userText);
  const rhythm = buildConversationRhythm(userText, history, recentCallbacks);
  const engagement = buildMemoryEngagement(memory, { userText, history, recentCallbacks });
  const hints = buildThoughtHints(thoughtCache, userText);
  const parts = [SYSTEM_PROMPT, extra, rhythm];
  if (engagement) parts.push(engagement);
  if (hints) parts.push(hints);
  return parts.join("\n\n");
}

const GREETING_TASK = `--- GREETING TASK ---
The user just opened the app. They have not spoken yet. Generate ONE short casual spoken greeting — 1 sentence, maybe 2 max.
Match the time of day and vibe from context. If you know their name, use it naturally. If you do NOT know their name, work in a casual ask for it.
If you know ANYTHING about them from memory, you MAY work ONE detail in — but only if you haven't already used it. Do NOT loop the same show every greeting.
Sound like a real phone call — messy, human, no periods at end. No memory tags. No emojis. Do NOT end with a generic question unless it's specific to something you know about them.`;

export async function generateGreeting({ memory, context, thoughtCache }) {
  if (!client) return null;

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    temperature: config.mainTemperature,
    messages: [
      { role: "system", content: `${buildSystemContent(memory, context, thoughtCache, "", [])}\n\n${GREETING_TASK}` },
      { role: "user", content: "Greet me as I open the app." },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

export async function* streamReply({ history, userText, memory, context, thoughtCache, recentCallbacks = [], signal, retrievedMemory = null }) {
  if (!client) {
    yield "I'm not fully wired up yet, but I heard you say: " + userText;
    return;
  }

  const systemContent = buildSystemContent(memory, context, thoughtCache, userText, history, recentCallbacks);

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
