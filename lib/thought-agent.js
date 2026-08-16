import OpenAI from "openai";
import { config } from "./states.js";
import { flattenInterestHooks, getGeneralFacts, getUserName, getCategoryDirectory } from "./memory-store.js";
import { chatModelOptions } from "./model-options.js";
import { THINKER_TOOLS, runThinkerTool, normalizePastChats } from "./thinker-tools.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;
const MAX_TOOL_ROUNDS = 2;

export function thoughtAgentAvailable() {
  return Boolean(client);
}

const THINKER_PROMPT = `You are June's THINKER — a background reasoning mind that whispers to the main conversational AI.
You never speak to the user directly. You only produce compact coaching for the main AI.

## YOUR JOB

1. Read the user's tone/energy carefully.
2. Decide what June could say or mention NEXT that feels human, relevant, and non-robotic.
3. Use tools only when they improve the next suggestion:
   - list_past_chats / get_past_chat — continuity from earlier sessions
   - scan_memory_category / get_memory_detail — deeper personal context
   - check_snapshot_hooks — sharper live-topic mentions
4. Prefer 0-1 tool round. Do not tool-spam. If the local payload already has enough, answer immediately.

## WHAT YOU GIVE THE MAIN AI

- interjections: short CONTENT beats June can weave in (a tease, a take, a noun reaction) — NOT soft warm-ups or filler crutches. Prefer "food? fridge empty?" over "alright..." / "honestly..." / "I mean..." / "ouch I respect that"
- suggestions: concrete mention/ask options grounded in memory, past chats, or snapshot hooks — specific, not interview prompts
- tone: how the user sounds right now and how June should match/contrast
- memoryBridge / juneSelfDrop / expansionAngles: same rules as before

## RULES

- Memory and past chats are about THE USER, not June.
- Never invent that June shares their hobbies as her own.
- Do not force a callback every turn.
- If the user is dry, prefer a light pivot or juneSelfDrop over interview questions.
- If recentCallbacks already used a topic, avoid repeating it.
- Keep output tight. Main AI is voice-speed — give usable whispers, not essays.
- Shape whispers like real call speech: substance first. Do not hand June an ack→restate→filler→question ladder.

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "topic": string,
  "topicKey": string,
  "confidence": number,
  "tone": {
    "userMood": string,
    "energy": "low" | "medium" | "high",
    "notes": string
  },
  "interjections": string[],
  "suggestions": string[],
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

If truly nothing useful:
{"topic":"","topicKey":"","confidence":0,"tone":{"userMood":"neutral","energy":"medium","notes":""},"interjections":[],"suggestions":[],"associations":[],"casualDrops":[],"expansionAngles":[],"memoryBridge":null,"juneSelfDrop":null,"personification":{"pretendExperienced":false,"ifAskedHow":null},"avoid":[],"reasoning":"nothing to work with"}`;

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
  const tone = parsed.tone && typeof parsed.tone === "object" ? parsed.tone : {};
  return {
    topic: parsed.topic || "",
    topicKey: parsed.topicKey || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    tone: {
      userMood: tone.userMood || "neutral",
      energy: ["low", "medium", "high"].includes(tone.energy) ? tone.energy : "medium",
      notes: tone.notes || "",
    },
    interjections: Array.isArray(parsed.interjections)
      ? parsed.interjections.map((s) => String(s).trim()).filter(Boolean).slice(0, 2)
      : [],
    suggestions: Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : [],
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

/**
 * Background Thinker: reasoning model + optional tools.
 * Never blocks voice — session runs this async and injects the result next turn.
 */
export async function runThoughtAgent({
  transcript,
  history = [],
  memory = {},
  recentCallbacks = [],
  dryReplyStreak = 0,
  pastChats = [],
  snapshotCache = null,
  usedTopicHooks = [],
  signal,
  onTrace,
} = {}) {
  if (!client) return null;

  const recentHistory = history.slice(-6).map((m) => ({
    role: m.role,
    content: String(m.content || "").slice(0, 280),
  }));

  const interestHooks = flattenInterestHooks(memory, 12).map((h) => ({
    category: h.category,
    title: h.title,
    preview: String(h.value || "").slice(0, 80),
    recallScore: h.recallScore,
  }));

  const chats = normalizePastChats(pastChats);
  const payload = {
    latestTranscript: transcript || "",
    recentHistory,
    userName: getUserName(memory),
    generalInfo: getGeneralFacts(memory).slice(0, 4),
    interestHooks,
    memoryDirectory: getCategoryDirectory(memory),
    recentCallbacks,
    dryReplyStreak,
    dryReplyMode: dryReplyStreak >= 2,
    pastChatIndex: chats.slice(0, 6).map((c) => ({
      session_id: c.session_id,
      title: c.title,
      main_summary: String(c.main_summary || "").slice(0, 120),
      topics: c.topics,
    })),
    snapshotBrief: snapshotCache?.hasTopic === false
      ? { hasTopic: false }
      : snapshotCache
        ? {
            topic: snapshotCache.topic || "",
            topicType: snapshotCache.topicType || null,
            snapshot: snapshotCache.snapshot || null,
            hookCount: (snapshotCache.topicHooks || []).length,
            usedTopicHooks,
          }
        : null,
  };

  const messages = [
    { role: "system", content: THINKER_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];

  const toolCtx = {
    memory,
    pastChats: chats,
    snapshotCache,
    userText: transcript || "",
    history,
    usedTopicHooks,
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      if (signal?.aborted) return null;

      const allowTools = round < MAX_TOOL_ROUNDS;
      const response = await client.chat.completions.create(
        {
          ...chatModelOptions(config.thoughtAiModel, {
            maxTokens: 900,
            reasoningEffort: config.thoughtReasoningEffort,
          }),
          messages,
          ...(allowTools
            ? { tools: THINKER_TOOLS, tool_choice: "auto" }
            : { tool_choice: "none" }),
        },
        { signal }
      );

      if (signal?.aborted) return null;

      const msg = response.choices?.[0]?.message;
      if (!msg) return null;

      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length || !allowTools) {
        return normalizeResult(parseJsonObject(msg.content || ""));
      }

      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name || "";
        const argsRaw = tc.function?.arguments || "";
        let args = argsRaw;
        try { args = JSON.parse(argsRaw); } catch {}
        const result = runThinkerTool(tc, toolCtx);
        console.log(`[thinker-tool] ${name}`, argsRaw.slice?.(0, 80) || "");
        onTrace?.({
          agent: "thinker",
          phase: "tool",
          name,
          detail: { args, result: result.content },
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.content,
        });
      }
    }
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) return null;
    console.error("[thinker]", err.message);
  }

  return null;
}
