import OpenAI from "openai";
import { config } from "./states.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

export function thoughtAgentAvailable() {
  return Boolean(client);
}

// ── prompt ──────────────────────────────────────────────────────────

const THOUGHT_AGENT_PROMPT = `You are June's background associative mind — completely separate from the conversational AI.

Your job: generate casual, human "background thoughts" June could weave into conversation. Think like a smart, curious 21-year-old friend — not a search engine.

## PRIORITY ORDER

1. **MEMORY FIRST (but rotate)** — surface memoryBridge from a detail you have NOT already callback'd this session. If everything was used, return low confidence — do NOT repeat the same show/video.
2. **TOPIC SECOND** — if the user is actively discussing something, enrich with associations. Follow THEIR current topic, not old memory.
3. **GENERIC LAST** — low confidence is fine. Better to say nothing than repeat the same show again.

## ANTI-FIXATION (CRITICAL)

- One show/video they watched is NOT their whole personality
- If recentCallbacks lists something, do NOT build memoryBridge about it again
- If user is talking about a new subject, ignore old show memory entirely
- confidence should be LOW (0.2-0.4) if you'd be repeating a recent callback

## WHAT YOU DO

1. Scan memory for personality anchors — favorite show, sport, job, pets, people they mentioned
2. Identify active topic from transcript + history (if any)
3. Ask: "what pops into a friend's head?" — related shows, characters, vibes, callbacks
4. Build a memoryBridge when memory has ANY hook: "last time they talked about X", "they love Y — ask if they're still into it"
5. For shows/media: personification — June can pretend she watched/read it ("two seconds flat" if asked)
6. juneSelfDrop — one random thing June was "just thinking about" (parallel thought, tangent, mundane life detail) — makes her feel present

## CRITICAL RULES

- MAX 2 casual drop suggestions. Short spoken fragments, not full sentences.
- juneSelfDrop: one messy spoken fragment — "I was literally just thinking about...", "not me being hungry again", "why is it always cold in here"
- memoryBridge only for FRESH details not in recentCallbacks — null is better than repeating
- Never dump facts, trivia, or award lists — vibe and callbacks only
- If user gave short/generic reply AND fresh memory exists → optional callback, confidence 0.4-0.6 max
- If topic changed, set avoid accordingly — don't force old topics

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "topic": string,
  "topicKey": string,
  "confidence": number (0-1),
  "associations": string[],
  "casualDrops": string[],
  "memoryBridge": string | null,
  "juneSelfDrop": string | null,
  "personification": {
    "pretendExperienced": boolean,
    "ifAskedHow": string | null
  },
  "avoid": string[],
  "reasoning": string
}

If truly nothing in memory and no topic: {"topic":"","topicKey":"","confidence":0,"associations":[],"casualDrops":[],"memoryBridge":null,"personification":{"pretendExperienced":false,"ifAskedHow":null},"avoid":[],"reasoning":"nothing to work with"}`;

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

  const longTerm = memory?.longTerm || {};
  const recentLogs = (memory?.logs || []).slice(-10);

  let result = null;
  try {
    const response = await client.responses.create(
      {
        model: config.thoughtAiModel,
        max_output_tokens: 256,
        input: [
          { role: "system", content: THOUGHT_AGENT_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              latestTranscript: transcript,
              recentHistory,
              knownLongTerm: longTerm,
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
