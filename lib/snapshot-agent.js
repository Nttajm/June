import OpenAI from "openai";
import { config } from "./states.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

export function snapshotAgentAvailable() {
  return Boolean(client);
}

const SNAPSHOT_PROMPT = `You are a background context generator for a conversational AI named June.

Your job: Generate a SHORT conversational snapshot (~100-150 words) about what the user is discussing. This helps June respond more naturally without having to look things up.

## WHAT YOU PROVIDE

When the user mentions a TOPIC (show, movie, sport, person, memory, hobby, place, etc.), generate:
- Key details that might come up naturally in conversation
- Common talking points, opinions, recent events
- Things a knowledgeable friend would know
- Conversation hooks or follow-up angles

## RULES

1. ONLY generate a snapshot if there's a clear topic worth enriching
2. Keep it conversational, not encyclopedic — like notes a friend would jot
3. ~100-150 words MAX — concise, useful context
4. Focus on what's CONVERSATIONALLY relevant, not trivia
5. If topic is personal/memory-based, note possible emotional hooks
6. If topic is vague or generic, return null

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "hasTopic": boolean,
  "topic": string,
  "topicType": "show" | "movie" | "sport" | "person" | "memory" | "hobby" | "place" | "event" | "other" | null,
  "snapshot": string | null,
  "conversationAngles": string[],
  "reasoning": string
}

If no clear topic: {"hasTopic": false, "topic": "", "topicType": null, "snapshot": null, "conversationAngles": [], "reasoning": "no enrichable topic"}`;

function extractOutputText(response) {
  if (response.output_text) return response.output_text.trim();
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) return part.text.trim();
    }
  }
  return "";
}

function parseJsonObject(text) {
  const raw = (text || "").trim();
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

function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.hasTopic) return null;
  
  return {
    topic: parsed.topic || "",
    topicType: parsed.topicType || "other",
    snapshot: parsed.snapshot || null,
    conversationAngles: Array.isArray(parsed.conversationAngles) ? parsed.conversationAngles.slice(0, 3) : [],
    reasoning: parsed.reasoning || "",
    generatedAt: Date.now(),
  };
}

function normalizeTopicKey(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
}

export function shouldRefreshSnapshot(currentCache, newTranscript, history = []) {
  if (!currentCache) return true;
  
  const cacheAge = Date.now() - (currentCache.generatedAt || 0);
  if (cacheAge > config.snapshotMaxAgeMs) return true;
  
  const currentTopicKey = normalizeTopicKey(currentCache.topic);
  if (!currentTopicKey) return true;
  
  const combined = (newTranscript || "") + " " + history.slice(-4).map(h => h.content).join(" ");
  const combinedLower = combined.toLowerCase();
  
  const topicMentioned = combinedLower.includes(currentTopicKey.slice(0, 8));
  if (topicMentioned) return false;
  
  const topicIndicators = [
    /talking about|discussing|watching|saw|watched|played|went to|visited/i,
    /have you (seen|heard|watched|played)/i,
    /what do you think (about|of)/i,
    /remember when|that time|last (week|month|year)/i,
  ];
  
  const hasNewTopic = topicIndicators.some(r => r.test(newTranscript || ""));
  if (hasNewTopic) return true;
  
  return false;
}

export async function runSnapshotAgent({ transcript, history = [], memory = {}, signal } = {}) {
  if (!client) return null;

  const recentHistory = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const identity = memory?.identity || {};
  const semantic = (memory?.semantic || []).slice(0, 10);

  let result = null;
  try {
    const response = await client.responses.create(
      {
        model: config.snapshotAiModel,
        max_output_tokens: 350,
        input: [
          { role: "system", content: SNAPSHOT_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              latestTranscript: transcript,
              recentHistory,
              userIdentity: identity,
              knownFacts: semantic,
            }),
          },
        ],
      },
      { signal }
    );

    if (signal?.aborted) return null;
    result = normalizeResult(parseJsonObject(extractOutputText(response)));
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) return null;
  }

  return result;
}
