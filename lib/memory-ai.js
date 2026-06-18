import OpenAI from "openai";
import { config } from "./states.js";
import { Fn } from "./functions.js";
import { memoryNow } from "./memory.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

const CATEGORIES = ['preference', 'fact', 'relationship', 'opinion', 'interest', 'habit'];

const FUNCTION_RULES = `## SESSION FUNCTIONS (dynamic intent — never hardcode phrases)

Detect when the user wants to control the voice session itself. Infer intent from meaning, not exact wording.

**${Fn.PAUSE}** — user wants June to go quiet and stop engaging for now:
- "hang on", "wait a sec", "one second", "shush", "be quiet", "go away" (temporary), "give me a minute", "hold on", "not now", etc.
- They need space or are busy — do NOT treat as end of session.

**${Fn.RESUME}** — user wants June to engage again after a pause:
- "I'm back", "okay you can talk", "go ahead", "what were you saying", "continue", etc.
- Only suggest when sessionPaused is true unless they clearly undo a just-asked pause.

**null** — normal conversation. Do NOT trigger pause for "go to sleep" (handled separately).

Be conservative: only trigger when intent is clear.`;

const MEMORY_AI_PROMPT = `You are a dedicated Turn Intelligence system — completely separate from the conversational AI.
Your job: analyze conversation turns for (1) what to store about the user, and (2) session control functions.

You think like a sharp human who actually listens. You catch implicit facts, corrections, preferences, moods, and context.

## TIERED MEMORY MODEL

**identity** (core permanent): name, age, birthday, location, hometown, timezone — these are ALWAYS important (importance: 1.0)

**semantic** (long-term knowledge): categorized facts about the user that persist
- Categories: ${CATEGORIES.join(', ')}
- Only store things that are likely to remain true over time
- Assign confidence (0.0-1.0) based on how explicitly stated

**logs** (transient): passing moments — "ate waffles today", "feeling tired right now", "watching a show tonight"
- These have lower importance (0.2-0.5) and may be consolidated or forgotten

## IMPORTANCE SCORING (0.0 to 1.0)
- 1.0: Identity facts (name, birthday, age), strong explicit preferences ("I love X", "I hate Y")
- 0.8-0.9: Clear preferences, job, relationships, recurring habits
- 0.6-0.7: Interests, opinions, one-time explicit statements
- 0.4-0.5: Inferred facts, things mentioned in passing
- 0.2-0.3: Transient states, current mood, today's plans

## CALLBACK WEIGHT (0.0 to 1.0) — how often the main AI should reference this memory unprompted
This is SEPARATE from importance. Importance = how true/permanent is this fact. callbackWeight = how much should June bring it up.

**HIGH callbackWeight (0.7-1.0) — reference occasionally, these are great conversation hooks:**
- Sports teams, athletes, games, matches, leagues they follow
- Music artists, bands, albums they genuinely love (not just "I heard that song")
- Active hobbies: gym, running, climbing, yoga, gaming they actively do
- Shows/movies they're currently watching or deeply into
- A job, major project, or recurring life thing they mention often

**MEDIUM callbackWeight (0.35-0.65) — mention at most once per session if very natural:**
- A show/movie mentioned once without strong emotion
- A book they're reading
- A mild preference ("I like jazz", "I prefer hiking over running")
- Something they seem interested in but only brought up once

**LOW callbackWeight (0.0-0.15) — store for context, NEVER bring up proactively:**
- Any food or drink they mentioned in passing ("I had lemonade", "I ate pasta today")
- A one-time state ("I was tired", "I had a headache")
- Casual filler mentions that weren't the point of the conversation
- Anything with "today", "yesterday", "just now" unless it was a big deal

Key examples:
- "I like lemonade" → callbackWeight: 0.04 (trivial, don't ask about their lemonade)
- "watched Spurs vs OKC last night" → callbackWeight: 0.70 (sports = great hook; "you been watching the NBA?")
- "my favorite artist is Drake, I've loved him for years" → callbackWeight: 0.90 (core anchor)
- "I've been watching Breaking Bad" → callbackWeight: 0.60 (solid, mention once naturally)
- "I go to the gym every morning" → callbackWeight: 0.75 (habit + active lifestyle = great hook)

## SOURCE CLASSIFICATION
- "explicit": User directly stated it ("My name is...", "I love...", "I work at...")
- "inferred": You deduced it from context or implication
- "correction": User is correcting previous information

## CATEGORY ASSIGNMENT
- preference: likes, dislikes, favorites ("I love pizza", "I hate mornings")
- fact: objective information (job, location, physical traits)
- relationship: people in their life (friends, family, partners, pets)
- opinion: beliefs, views, takes ("I think...", "I believe...")
- interest: hobbies, media, activities ("I play guitar", "I watch anime")
- habit: routines, patterns ("I always...", "Every morning I...")

## YOUR ANALYSIS PROCESS

1. Read the user message carefully — explicit AND implicit facts
2. Check if they're correcting something in knownSemanticMemory or identity
3. For each fact: assign category, importance, source, and decide tier (semantic vs log-only)
4. Skip duplicates already in known memory
5. If user states or corrects their name → setName field
6. Detect session control intent

## LONG-TERM (semantic) SIGNALS
- "I love", "I hate", "my favorite", "I always", "I work at", "I live in", "I'm from", "I play", "my name is"
- Identity facts stated plainly
- Preferences without time qualifiers

## TRANSIENT (log-only) SIGNALS
- "today", "right now", "just", "tonight", "this morning", "yesterday", "currently", "at the moment"

${FUNCTION_RULES}

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "function": "${Fn.PAUSE}" | "${Fn.RESUME}" | null,
  "functionReason": string | null,
  "setName": string | null,
  "updates": [
    {
      "subject": string,
      "value": string,
      "category": "${CATEGORIES.join('" | "')}",
      "importance": number (0.0-1.0),
      "callbackWeight": number (0.0-1.0),
      "source": "explicit" | "inferred" | "correction",
      "longTerm": boolean,
      "reason": string
    }
  ],
  "corrections": [
    {
      "subject": string,
      "oldValue": string | null,
      "newValue": string,
      "category": "${CATEGORIES.join('" | "')}",
      "reason": string
    }
  ],
  "reasoning": string
}

- subject: short natural label ("favorite player", "job", "mood", "pet name")
- reason: one-line why you classified it this way
- If nothing new: {"function":null,"functionReason":null,"setName":null,"updates":[],"corrections":[],"reasoning":"nothing new"}`;

const INTENT_AI_PROMPT = `You are a dedicated Turn Intelligence system — completely separate from the conversational AI.
Your ONLY job: detect session control intent from the user's latest message.

${FUNCTION_RULES}

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "function": "${Fn.PAUSE}" | "${Fn.RESUME}" | null,
  "functionReason": string | null
}

If no session control intent: {"function":null,"functionReason":null}`;

const CONSOLIDATION_PROMPT = `You are a memory consolidation system. Your job is to analyze a conversation session and:
1. Create a brief summary of the session
2. Extract key topics discussed
3. Determine overall mood/tone
4. Identify any facts worth promoting to long-term memory

## INPUT
You'll receive:
- Session logs (transient observations from this session)
- Recent conversation history
- Existing semantic memory (to avoid duplicates)

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "sessionSummary": {
    "summary": string (1-2 sentences capturing the essence of the conversation),
    "topics": string[] (3-5 main topics discussed),
    "mood": "positive" | "neutral" | "negative" | "mixed",
    "turnCount": number
  },
  "promoteToSemantic": [
    {
      "subject": string,
      "value": string,
      "category": "${CATEGORIES.join('" | "')}",
      "confidence": number (0.0-1.0),
      "reason": string
    }
  ],
  "reasoning": string
}

Guidelines:
- Summary should be conversational, not clinical
- Only promote facts that seem durable (not transient moods/plans)
- Don't duplicate what's already in semantic memory
- Topics should be specific enough to be useful for future context`;

const DEDUPLICATION_PROMPT = `You are a memory deduplication system. Your job is to identify redundant or overlapping entries in semantic memory.

## INPUT
You'll receive an array of semantic memory entries with: id, subject, value, category, confidence, createdAt

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "merges": [
    {
      "keepId": string (ID of entry to keep),
      "removeIds": string[] (IDs of entries to remove),
      "mergedValue": string (combined/best value to use),
      "reason": string
    }
  ],
  "reasoning": string
}

Guidelines:
- Merge entries that refer to the same underlying fact
- Keep the entry with higher confidence or more recent update
- Combine values if they add complementary information
- Be conservative — only merge when clearly redundant`;

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

export function memoryAiAvailable() {
  return Boolean(client);
}

function normalizeAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const fn = parsed.function;
  const validFn = fn === Fn.PAUSE || fn === Fn.RESUME ? fn : null;
  
  const updates = Array.isArray(parsed.updates) ? parsed.updates.map(u => ({
    subject: u.subject || "",
    value: u.value || "",
    category: CATEGORIES.includes(u.category) ? u.category : "fact",
    importance: typeof u.importance === "number" ? Math.max(0, Math.min(1, u.importance)) : 0.5,
    callbackWeight: typeof u.callbackWeight === "number" ? Math.max(0, Math.min(1, u.callbackWeight)) : null,
    source: ["explicit", "inferred", "correction"].includes(u.source) ? u.source : "inferred",
    longTerm: u.longTerm !== false,
    reason: u.reason || ""
  })) : [];

  const corrections = Array.isArray(parsed.corrections) ? parsed.corrections.map(c => ({
    subject: c.subject || "",
    oldValue: c.oldValue || null,
    newValue: c.newValue || "",
    category: CATEGORIES.includes(c.category) ? c.category : "fact",
    reason: c.reason || ""
  })) : [];

  return {
    function: validFn,
    functionReason: parsed.functionReason || null,
    setName: parsed.setName || null,
    updates,
    corrections,
    reasoning: parsed.reasoning || "",
  };
}

export async function analyzeUserIntent({ userText, memory, context, history = [], sessionPaused = false }) {
  if (!client) return null;

  const recentHistory = history.slice(-4).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const response = await client.responses.create({
    model: config.memoryAiModel,
    input: [
      { role: "system", content: INTENT_AI_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          userMessage: userText,
          sessionPaused,
          context: {
            timezone: context?.timezone || null,
            location: context?.location || null,
          },
          knownIdentity: memory?.identity || {},
          recentHistory,
        }),
      },
    ],
  });

  const parsed = parseJsonObject(extractOutputText(response));
  if (!parsed) return null;
  return {
    function: parsed.function === Fn.PAUSE || parsed.function === Fn.RESUME ? parsed.function : null,
    functionReason: parsed.functionReason || null,
  };
}

export async function analyzeTurnMemory({ userText, assistantText, memory, context, history = [], sessionPaused = false }) {
  if (!client) return null;

  const recentHistory = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const knownSemanticSummary = (memory?.semantic || []).slice(0, 30).map(s => ({
    subject: s.subject,
    value: s.value,
    category: s.category
  }));

  const response = await client.responses.create({
    model: config.memoryAiModel,
    input: [
      { role: "system", content: MEMORY_AI_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          turn: { user: userText, assistant: assistantText },
          sessionPaused,
          context: {
            timezone: context?.timezone || null,
            location: context?.location || null,
          },
          knownIdentity: memory?.identity || {},
          knownSemanticMemory: knownSemanticSummary,
          recentLogs: (memory?.logs || []).slice(-15).map(l => ({
            subject: l.subject,
            value: l.value
          })),
          recentHistory,
        }),
      },
    ],
  });

  return normalizeAnalysis(parseJsonObject(extractOutputText(response)));
}

export async function consolidateSessionMemory({ sessionLogs, history, existingSemanticMemory }) {
  if (!client) return null;
  if (!sessionLogs || sessionLogs.length === 0) return null;

  const logsForContext = sessionLogs.slice(-50).map(l => ({
    subject: l.subject,
    value: l.value,
    importance: l.importance,
    ts: l.ts
  }));

  const recentHistory = history.slice(-10).map(m => ({
    role: m.role,
    content: m.content?.slice(0, 500)
  }));

  const existingSummary = (existingSemanticMemory || []).slice(0, 20).map(s => ({
    subject: s.subject,
    value: s.value,
    category: s.category
  }));

  const response = await client.responses.create({
    model: config.memoryAiModel,
    input: [
      { role: "system", content: CONSOLIDATION_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          sessionLogs: logsForContext,
          recentHistory,
          existingSemanticMemory: existingSummary,
          totalTurns: history.filter(h => h.role === 'user').length
        }),
      },
    ],
  });

  const parsed = parseJsonObject(extractOutputText(response));
  if (!parsed) return null;

  return {
    sessionSummary: parsed.sessionSummary ? {
      summary: parsed.sessionSummary.summary || "Conversation session",
      topics: Array.isArray(parsed.sessionSummary.topics) ? parsed.sessionSummary.topics : [],
      mood: parsed.sessionSummary.mood || "neutral",
      turnCount: parsed.sessionSummary.turnCount || logsForContext.length
    } : null,
    promoteToSemantic: Array.isArray(parsed.promoteToSemantic) ? parsed.promoteToSemantic.map(p => ({
      subject: p.subject || "",
      value: p.value || "",
      category: CATEGORIES.includes(p.category) ? p.category : "fact",
      confidence: typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0.7,
      reason: p.reason || ""
    })) : [],
    reasoning: parsed.reasoning || ""
  };
}

export async function deduplicateMemories(semanticMemory) {
  if (!client) return null;
  if (!semanticMemory || semanticMemory.length < 5) return null;

  const entries = semanticMemory.slice(0, 100).map(s => ({
    id: s.id,
    subject: s.subject,
    value: s.value,
    category: s.category,
    confidence: s.confidence,
    createdAt: s.createdAt
  }));

  const response = await client.responses.create({
    model: config.memoryAiModel,
    input: [
      { role: "system", content: DEDUPLICATION_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ semanticMemory: entries }),
      },
    ],
  });

  const parsed = parseJsonObject(extractOutputText(response));
  if (!parsed) return null;

  return {
    merges: Array.isArray(parsed.merges) ? parsed.merges.map(m => ({
      keepId: m.keepId || "",
      removeIds: Array.isArray(m.removeIds) ? m.removeIds : [],
      mergedValue: m.mergedValue || "",
      reason: m.reason || ""
    })) : [],
    reasoning: parsed.reasoning || ""
  };
}

export function applyDeduplication(memory, deduplicationResult) {
  if (!deduplicationResult?.merges?.length) return memory;

  const removeSet = new Set();
  const updateMap = new Map();

  for (const merge of deduplicationResult.merges) {
    for (const id of merge.removeIds) {
      removeSet.add(id);
    }
    if (merge.keepId && merge.mergedValue) {
      updateMap.set(merge.keepId, merge.mergedValue);
    }
  }

  memory.semantic = memory.semantic.filter(s => !removeSet.has(s.id));
  
  for (const sem of memory.semantic) {
    if (updateMap.has(sem.id)) {
      sem.value = updateMap.get(sem.id);
      sem.updatedAt = memoryNow();
    }
  }

  return memory;
}
