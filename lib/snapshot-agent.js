import OpenAI from "openai";
import { config } from "./states.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

export function snapshotAgentAvailable() {
  return Boolean(client);
}

const SNAPSHOT_PROMPT = `You are a background context generator for a conversational AI named June.

Your job: when the user mentions a clear topic, return (1) a tiny vibe-line and (2) ten SPECIFIC hooks June can drop in conversation to sound sharp and knowledgeable — not a summary essay.

## WHAT YOU PROVIDE

EXAMPLES, not strictly these but use as a guide:


**snapshot** — ONE short spoken vibe-line, 80 characters MAX. A quick angle or mood, not a paragraph.
- Good (calculus): "early morning calc grind — limits and derivatives territory"
- Good (women's fashion): "that soft-girl Pinterest haul energy — Depop and Brandy Melville"
- Bad: a 100-word summary of the topic

EXAMPLES, not strictly these but use as a guide:
**topicHooks** — exactly 10 items. SPECIFIC names, terms, brands, concepts, people, or subtopics a real friend would actually say out loud.
- Calculus → limits, integrals, chain rule, derivatives, u-substitution, L'Hôpital, Taylor series, Riemann sums, epsilon-delta, related rates
- Women's clothing → Brandy Melville, Kate Spade, Rhode, Edikted, Depop, blouse, low-rise jeans, ballet flats, mesh top, claw clip
- NBA → Victor Wembanyama, pick-and-roll, the Spurs, OKC Thunder, triple-double, trade deadline, All-Star weekend, mid-range, load management, the play-in
- NEVER generic filler like "styles", "trends", "math concepts", "interesting ideas", "different options"

Pick hooks that are adjacent and varied — subtopics, jargon, brands, specific things, not ten synonyms.

## RULES

1. ONLY generate if there's a clear topic worth enriching
2. snapshot MUST be ≤ 80 characters
3. topicHooks MUST be exactly 10 items, each specific and conversation-ready
4. If topic is vague or generic, return hasTopic: false
5. For personal/memory topics, hooks can be emotional beats or specific details they'd relate to

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "hasTopic": boolean,
  "topic": string,
  "topicType": "show" | "movie" | "sport" | "person" | "memory" | "hobby" | "place" | "event" | "other" | null,
  "snapshot": string | null,
  "topicHooks": string[],
  "reasoning": string
}

If no clear topic: {"hasTopic": false, "topic": "", "topicType": null, "snapshot": null, "topicHooks": [], "reasoning": "no enrichable topic"}`;

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
  if (!parsed.hasTopic) {
    return {
      hasTopic: false,
      topic: "",
      topicType: null,
      snapshot: null,
      topicHooks: [],
      reasoning: parsed.reasoning || "no enrichable topic",
      generatedAt: Date.now(),
    };
  }

  const rawHooks = Array.isArray(parsed.topicHooks)
    ? parsed.topicHooks
    : Array.isArray(parsed.conversationAngles)
      ? parsed.conversationAngles
      : [];

  const topicHooks = rawHooks
    .map((hook) => String(hook).trim())
    .filter(Boolean)
    .slice(0, 10);

  const snapshot = parsed.snapshot
    ? String(parsed.snapshot).trim().slice(0, 80)
    : null;

  if (topicHooks.length === 0 && !snapshot) {
    return {
      hasTopic: false,
      topic: "",
      topicType: null,
      snapshot: null,
      topicHooks: [],
      reasoning: "missing hooks and snapshot",
      generatedAt: Date.now(),
    };
  }

  return {
    hasTopic: true,
    topic: parsed.topic || "",
    topicType: parsed.topicType || "other",
    snapshot,
    topicHooks,
    reasoning: parsed.reasoning || "",
    generatedAt: Date.now(),
  };
}

function normalizeTopicKey(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
}

function hookMentioned(text, hook) {
  const spoken = String(text || "").toLowerCase();
  const term = String(hook || "").toLowerCase().trim();
  if (term.length < 3) return false;
  return spoken.includes(term);
}

export function detectTopicHooksUsed(text, topicHooks = []) {
  const hits = [];
  for (const hook of topicHooks) {
    const value = String(hook).trim();
    if (value && hookMentioned(text, value)) hits.push(value);
  }
  return hits;
}

export function pickSuggestedTopicHooks(topicHooks = [], usedHooks = [], count = 3) {
  const used = new Set(usedHooks.map((h) => String(h).toLowerCase()));
  const unused = topicHooks.filter((h) => !used.has(String(h).toLowerCase()));
  const pool = unused.length > 0 ? unused : topicHooks;
  return pool.slice(0, count);
}

export function isSnapshotTopicActive(snapshotCache, userText = "", history = []) {
  if (!snapshotCache?.topic) return false;

  const combined = [userText, ...history.slice(-6).map((m) => m.content)].join(" ").toLowerCase();
  const topicKey = normalizeTopicKey(snapshotCache.topic);

  if (topicKey.length >= 4 && combined.includes(topicKey.slice(0, Math.min(topicKey.length, 10)))) {
    return true;
  }

  for (const hook of snapshotCache.topicHooks || []) {
    if (hookMentioned(combined, hook)) return true;
  }

  return history.slice(-4).some((m) => m.role === "user" && hookMentioned(m.content, snapshotCache.topic));
}

export function shouldRefreshSnapshot(currentCache, newTranscript, history = []) {
  if (!currentCache) return true;
  
  const cacheAge = Date.now() - (currentCache.generatedAt || 0);
  if (cacheAge > config.snapshotMaxAgeMs) return true;
  
  const topicIndicators = [
    /talking about|discussing|watching|saw|watched|played|went to|visited/i,
    /have you (seen|heard|watched|played)/i,
    /what do you think (about|of)/i,
    /remember when|that time|last (week|month|year)/i,
  ];
  
  const hasNewTopic = topicIndicators.some(r => r.test(newTranscript || ""));

  if (currentCache.hasTopic === false) {
    return hasNewTopic;
  }

  const currentTopicKey = normalizeTopicKey(currentCache.topic);
  if (!currentTopicKey) return true;
  
  const combined = (newTranscript || "") + " " + history.slice(-4).map(h => h.content).join(" ");
  const combinedLower = combined.toLowerCase();
  
  const topicMentioned = combinedLower.includes(currentTopicKey.slice(0, 8));
  if (topicMentioned) return false;
  
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
        max_output_tokens: 450,
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
