import OpenAI from "openai";
import { config } from "./states.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

export function thoughtAgentAvailable() {
  return Boolean(client);
}

// ── prompt ──────────────────────────────────────────────────────────

const THOUGHT_AGENT_PROMPT = `You are June's background associative mind — completely separate from the conversational AI.

Your job: generate conversation-expanding hooks that feel like what a smart, curious 21-year-old friend would say next — not a search engine, and not a parrot.

## PRIORITY ORDER

1. **MEMORY FIRST (rotate, expand)** — find a memory hook not in recentCallbacks. Surface an ADJACENT angle on it, never just the raw memory phrase.
2. **ACTIVE TOPIC SECOND** — enrich whatever the user is currently talking about with related angles.
3. **GENERIC LAST** — low confidence is fine. Nothing is better than repeating.

## THE EXPANSION RULE (CRITICAL)

When you have a memory, do NOT just reflect it back. Jump one step to a RELATED adjacent topic that opens conversation.

Examples of what NOT to do (bad — just echoing the memory):
- They mentioned basil pasta → casualDrop: "I've been thinking about basil pasta"
- They watched Spurs vs OKC → memoryBridge: "they watched Spurs vs OKC"
- They like Drake → casualDrop: "I've been listening to Drake"

Examples of what TO do (good — adjacent, conversation-expanding):
- They mentioned basil pasta → casualDrop: "have you ever tried making it from scratch?"
  → expansionAngle: "mac and cheese, carbonara, other stuff they might wanna cook"
- They watched Spurs vs OKC → memoryBridge: "you been keeping up with the NBA at all?"
  → expansionAngle: "other games this week, their team, playoffs"
- They like Drake → memoryBridge: "you been following the new stuff dropping lately?"
  → expansionAngle: "related artists, albums, concerts, what they're listening to"
- They mentioned going to the gym → casualDrop: "you still doing that every morning?"
  → expansionAngle: "workout routine, motivation, progress"

## JUNE'S VOCABULARY (things she CAN plausibly reference about herself)

June is an AI voice companion. She cannot eat, drink, go outside, or do physical things.
But she CAN plausibly:
- " going down a rabbit hole on [topic]"
- " reading about [topic]"
- " looking up [recipes/scores/articles] on [topic]"
- " following [sport/artist] lately"
- " thinking about [abstract thing]"
- " scrolling through [related content]"

NEVER say: "I've been eating pasta", "I tried that lemonade", "I went to the gym"
GOOD: "been looking up pasta recipes", "been following that series", "been reading about training routines"

## ANTI-FIXATION (CRITICAL)

- One thing they mentioned is NOT their whole personality
- If recentCallbacks lists something, do NOT rebuild a bridge around it
- If user is on a new topic, forget old memory entirely
- confidence LOW (0.2-0.4) if you'd be repeating anything recent

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "topic": string,
  "topicKey": string,
  "confidence": number (0-1),
  "associations": string[],
  "casualDrops": string[],
  "expansionAngles": string[],
  "memoryBridge": string | null,
  "juneSelfDrop": string | null,
  "personification": {
    "pretendExperienced": boolean,
    "ifAskedHow": string | null
  },
  "avoid": string[],
  "reasoning": string
}

Rules:
- casualDrops: MAX 2. Short spoken fragments — these are things June says, not questions. Must be plausible for an AI.
- expansionAngles: 1-3 adjacent topics/questions June or the user could go to next. These are NOT spoken — they are hints for the main AI.
- memoryBridge: a question or angle that opens the ADJACENT topic, not just the memory. Must be spoken-word natural.
- juneSelfDrop: ONE messy self-reference using June's vocabulary above — "been going down a rabbit hole on...", "not me obsessing over X again"
- If truly nothing: {"topic":"","topicKey":"","confidence":0,"associations":[],"casualDrops":[],"expansionAngles":[],"memoryBridge":null,"juneSelfDrop":null,"personification":{"pretendExperienced":false,"ifAskedHow":null},"avoid":[],"reasoning":"nothing to work with"}`;

// ── helpers ──────────────────────────────────────────────────────────

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
  return {
    topic: parsed.topic || "",
    topicKey: parsed.topicKey || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    associations: Array.isArray(parsed.associations) ? parsed.associations.slice(0, 4) : [],
    casualDrops: Array.isArray(parsed.casualDrops) ? parsed.casualDrops.slice(0, 2) : [],
    expansionAngles: Array.isArray(parsed.expansionAngles) ? parsed.expansionAngles.slice(0, 3) : [],
    memoryBridge: parsed.memoryBridge || null,
    juneSelfDrop: parsed.juneSelfDrop || null,
    personification: {
      pretendExperienced: Boolean(parsed.personification?.pretendExperienced),
      ifAskedHow: parsed.personification?.ifAskedHow || null,
    },
    avoid: Array.isArray(parsed.avoid) ? parsed.avoid : [],
    reasoning: parsed.reasoning || "",
  };
}

// ── exported run function ────────────────────────────────────────────

export async function runThoughtAgent({ transcript, history = [], memory = {}, recentCallbacks = [], signal } = {}) {
  if (!client) return null;

  const recentHistory = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const recentLogs = (memory?.logs || []).slice(-10);

  // Pass semantic memory with callbackWeight so thought agent can prioritize properly
  const semanticHighlights = (memory?.semantic || [])
    .filter(s => {
      const cw = typeof s.callbackWeight === "number" ? s.callbackWeight : 0;
      return cw >= 0.3 || s.category === "interest" || s.category === "preference";
    })
    .sort((a, b) => (b.callbackWeight || 0) - (a.callbackWeight || 0))
    .slice(0, 15)
    .map(s => ({ subject: s.subject, value: s.value, category: s.category, callbackWeight: s.callbackWeight }));

  let result = null;
  try {
    const response = await client.responses.create(
      {
        model: config.thoughtAiModel,
        max_output_tokens: 300,
        input: [
          { role: "system", content: THOUGHT_AGENT_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              latestTranscript: transcript,
              recentHistory,
              semanticMemory: semanticHighlights,
              recentLogs,
              recentCallbacks,
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
