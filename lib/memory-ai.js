import OpenAI from "openai";
import { config } from "./states.js";
import { Fn } from "./functions.js";
import { memoryNow, getCategoryDirectory, getGeneralFacts, flattenInterestHooks, normalizeRecallScore, getUserName } from "./memory-store.js";
import { responsesReasoningExtras, chatModelOptions } from "./model-options.js";
import { normalizePastChats, listPastChats, getPastChat } from "./thinker-tools.js";

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;
const MAX_TOOL_ROUNDS = 2;

export const MEMORY_AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_past_chats",
      description:
        "List recent past chat titles and short descriptions. Use when checking continuity, avoiding duplicate memories, or seeing what prior sessions covered.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max chats to return (default 5, max 15).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_past_chat",
      description:
        "Open one past chat by session_id or title and return its description plus recent turns (default last 5). Use after list_past_chats or when the most recent past session looks relevant.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          title: { type: "string" },
          turnLimit: {
            type: "number",
            description: "How many recent turns to include (default 5, max 12).",
          },
        },
      },
    },
  },
];

function runMemoryAiTool(toolCall, pastChats = []) {
  const name = toolCall?.function?.name || toolCall?.name || "";
  let args = {};
  try {
    args = JSON.parse(toolCall?.function?.arguments || "{}");
  } catch {
    args = {};
  }
  const chats = normalizePastChats(pastChats);
  let result;
  switch (name) {
    case "list_past_chats":
      result = listPastChats(chats, args.limit ?? 5);
      break;
    case "get_past_chat":
      result = getPastChat(chats, {
        session_id: args.session_id || "",
        title: args.title || "",
        turnLimit: args.turnLimit ?? 5,
      });
      break;
    default:
      result = { error: `Unknown tool: ${name}`, available: MEMORY_AI_TOOLS.map((t) => t.function.name) };
  }
  return {
    tool_call_id: toolCall?.id || "",
    name,
    content: JSON.stringify(result),
  };
}

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

const MEMORY_AI_PROMPT = `You are the Memory Update Agent for June — completely separate from the conversational AI.
Your job: analyze turns and update a CATEGORY-based long-term memory. Prefer SAVING useful details over skipping. Run async; accuracy over speed.

## MEMORY SCHEMA

Default categories (prefer these; invent new snake_case keys when nothing fits):
- general_info — standing profile + interaction rules. ALWAYS injected into June every turn.
  Prefer upsert titles: "Preferred Name", "Basic Demographics", "Preferred Language", "Location", "Work", "Speech Style", "Humor Rules"
- interests — broad hobbies / skills / recurring themes (string content ok)
- media — specific songs, artists, albums, shows, games, books, creators (e.g. "listening to Mac Miller — Self Care")
- work_life — job, school, projects, routines, commute, schedule logistics
- topic_deep_dives — deep ongoing obsessions / projects (content often an object)
- OR invent a new category (snake_case) with categoryTitle + categoryDescription (people, pets, places, health, etc.)

Each sub_memory: { title, content, recallScore } — title is a short human label; content is string OR object; recallScore 0.0–1.0 controls how often June proactively brings it up (NOT whether it is stored).

## SAVE AGGRESSIVELY

Save whenever the user mentions something that could matter later — even casually. Bias toward writing a memory with a low recallScore rather than returning empty.
DO save:
- Preferred language / bilingual habits → general_info "Preferred Language" (0.85–1.0)
- Where they live / are from / timezone vibes → general_info "Location" (0.8–1.0)
- Job, school, what they do → general_info "Work" AND/OR work_life detail (0.7–1.0 for stable role)
- Songs, artists, shows, games they name → media (specific title; 0.25–0.55 unless they gush, then higher)
- Hobbies / skills → interests
- Deep projects → topic_deep_dives or a custom category
- Standing interaction rules (name, speech, humor, always-do) → general_info (0.9–1.0) — NEVER skip

DO skip only true throwaways with no continuity value ("ate pasta today", "feeling tired", pure "yeah"/"ok"/"mhm").
Do NOT skip a song/show/game/artist mention just because it was casual.

## RULES

1. Update general_info when user states/corrects identity, language, location, work, OR standing interaction instructions.
2. STANDING / PROFILE in generalInfo (never bury speech/humor/address rules in interests):
   - Preferred name / nickname ("call me X")
   - Preferred language / when to switch languages
   - Location / hometown
   - Work / school / role
   - June's accent, voice style, speech mannerisms
   - Humor rules / always-do habits
   - Upsert stable titles; don't duplicate near-copies
3. Put specific media mentions into media (or invent a tight category). Example: "I listened to that Mac Miller song" → media title like "Mac Miller" or the song name, content with what they said, recallScore ~0.35.
4. Put broad hobbies into interests; deep fixations into topic_deep_dives; invent categories freely when useful.
5. Prefer upserting an existing title over creating near-duplicates.
6. setName when the user states or corrects their name — including short replies and nicknames.
   - If identity.nameMissing is true, treat name capture as high priority.
   - Also upsert general_info "Basic Demographics" with {"name":"..."}.
7. chatTitle: short session title (3-8 words) about the topic. For any real non-filler turn, still return a title even with no durable memory.
8. chatSummaryHint: one short description of what happened / what they wanted.
9. Detect session control intent.
10. recallScore = how often to BRING UP, not how important to STORE:
   - 0.15–0.35: remembered quietly (specific song, one-off show) — almost never proactive
   - 0.4–0.6: okay if the topic is already nearby
   - 0.7–0.9: strong recurring interest / active project
   - 0.9–1.0: core identity + standing rules (name, language, location, work role, speech/humor)
   June should NOT recite media/interests every turn. Low scores stay quiet unless the user reopens them. general_info stays always-on.
11. Past chats: use list_past_chats / get_past_chat to recover missing durable facts. Do NOT dump whole chats into memory.

${FUNCTION_RULES}

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "function": "${Fn.PAUSE}" | "${Fn.RESUME}" | null,
  "functionReason": string | null,
  "setName": string | null,
  "chatTitle": string | null,
  "chatSummaryHint": string | null,
  "generalInfo": [
    { "title": string, "content": object | string, "recallScore": number }
  ],
  "categorized": [
    {
      "category": "interests" | "media" | "work_life" | "topic_deep_dives" | string,
      "categoryTitle": string | null,
      "categoryDescription": string | null,
      "title": string,
      "content": object | string,
      "recallScore": number,
      "reason": string
    }
  ],
  "corrections": [
    {
      "category": string,
      "title": string,
      "content": object | string,
      "recallScore": number,
      "reason": string
    }
  ],
  "reasoning": string
}

If nothing new to store but the user made a real request, still set chatTitle and chatSummaryHint. Use the pure-filler template ONLY for acknowledgements like "yeah", "ok", "mhm", or silence — never for name/language/location/work/media facts.
If pure filler: {"function":null,"functionReason":null,"setName":null,"chatTitle":null,"chatSummaryHint":null,"generalInfo":[],"categorized":[],"corrections":[],"reasoning":"nothing new"}`;

const INTENT_AI_PROMPT = `You are a dedicated Turn Intelligence system — completely separate from the conversational AI.
Your ONLY job: detect session control intent from the user's latest message.

${FUNCTION_RULES}

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "function": "${Fn.PAUSE}" | "${Fn.RESUME}" | null,
  "functionReason": string | null
}

If no session control intent: {"function":null,"functionReason":null}`;

const CONSOLIDATION_PROMPT = `You are a memory consolidation + chat archive system.

Given a conversation session, produce:
1. A saved-chat style title + main_summary. The title must summarize the actual topic/theme, not quote the first message. The summary should be a compact description of what was discussed or decided.
2. Topics detected
3. Any durable facts to upsert into category memory
4. A recallScore for each promoted memory: 0.0 rarely mention, 1.0 core/stable.

## STANDING / PROFILE (critical)
Promote into category "general_info" (NOT interests): preferred name/nickname, preferred language, location, work/school, June's speech/accent style, humor rules, always-do habits. Prefer titles "Preferred Name", "Preferred Language", "Location", "Work", "Speech Style", "Humor Rules", "Basic Demographics". Use recallScore 0.85–1.0.

Media (songs/artists/shows/games) → category "media" with modest recallScore (0.25–0.55) unless they were strongly enthusiastic.
Hobbies → interests. Deep projects → topic_deep_dives. Job logistics → work_life. Invent new categories when useful.

## OUTPUT — return ONLY valid JSON, no markdown:
{
  "sessionSummary": {
    "title": string,
    "summary": string,
    "topics": string[],
    "mood": "positive" | "neutral" | "negative" | "mixed",
    "turnCount": number
  },
  "promote": [
    {
      "category": "general_info" | "interests" | "media" | "work_life" | "topic_deep_dives" | string,
      "categoryTitle": string | null,
      "categoryDescription": string | null,
      "title": string,
      "content": object | string,
      "recallScore": number,
      "reason": string
    }
  ],
  "reasoning": string
}`;

const DEDUPLICATION_PROMPT = `You deduplicate category sub_memories. Merge same-topic titles within a category.

## INPUT
Array of { category, id, title, recallScore, contentPreview }

## OUTPUT — return ONLY valid JSON:
{
  "merges": [
    {
      "category": string,
      "keepTitle": string,
      "removeTitles": string[],
      "mergedContent": object | string,
      "reason": string
    }
  ],
  "reasoning": string
}`;

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

function cleanChatTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  if (!title || title.toLowerCase() === "null") return null;
  return title.slice(0, 80);
}

function cleanChatSummary(value) {
  const summary = String(value || "").trim().replace(/\s+/g, " ");
  if (!summary || summary.toLowerCase() === "null") return null;
  return summary.slice(0, 220);
}

function normalizeAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const fn = parsed.function;
  const validFn = fn === Fn.PAUSE || fn === Fn.RESUME ? fn : null;

  return {
    function: validFn,
    functionReason: parsed.functionReason || null,
    setName: parsed.setName || null,
    chatTitle: cleanChatTitle(parsed.chatTitle),
    chatSummaryHint: cleanChatSummary(parsed.chatSummaryHint),
    generalInfo: Array.isArray(parsed.generalInfo)
      ? parsed.generalInfo.filter((g) => g?.title).map((g) => ({
          title: String(g.title).trim(),
          content: g.content ?? "",
          recallScore: normalizeRecallScore(g.recallScore, 0.9),
        }))
      : [],
    categorized: Array.isArray(parsed.categorized)
      ? parsed.categorized.filter((c) => c?.title && c?.category).map((c) => ({
          category: String(c.category).trim(),
          categoryTitle: c.categoryTitle || null,
          categoryDescription: c.categoryDescription || null,
          title: String(c.title).trim(),
          content: c.content ?? "",
          recallScore: normalizeRecallScore(c.recallScore, 0.5),
          reason: c.reason || "",
        }))
      : [],
    corrections: Array.isArray(parsed.corrections)
      ? parsed.corrections.filter((c) => c?.title && c?.category).map((c) => ({
          category: String(c.category).trim(),
          title: String(c.title).trim(),
          content: c.content ?? "",
          recallScore: normalizeRecallScore(c.recallScore, 0.5),
          reason: c.reason || "",
        }))
      : [],
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
    ...responsesReasoningExtras(config.memoryAiModel, { maxOutputTokens: 80 }),
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
          knownGeneral: getGeneralFacts(memory),
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

export async function analyzeTurnMemory({
  userText,
  assistantText,
  memory,
  context,
  history = [],
  sessionPaused = false,
  pastChats = [],
  onTrace,
} = {}) {
  if (!client) return null;

  const knownUserName = getUserName(memory);
  const chats = normalizePastChats(pastChats);
  const pastChatIndex = chats.slice(0, 5).map((c) => ({
    session_id: c.session_id,
    title: c.title,
    main_summary: String(c.main_summary || "").slice(0, 160),
    topics: c.topics,
    end_time: c.end_time,
  }));
  const mostRecent = chats[0] || null;
  const mostRecentPastChatTurns = mostRecent
    ? {
        session_id: mostRecent.session_id,
        title: mostRecent.title,
        main_summary: String(mostRecent.main_summary || "").slice(0, 160),
        previewTurns: (mostRecent.previewTurns || []).slice(-5),
      }
    : null;

  const recentHistory = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const messages = [
    { role: "system", content: MEMORY_AI_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        turn: { user: userText, assistant: assistantText },
        identity: {
          knownUserName,
          nameMissing: !knownUserName,
        },
        sessionPaused,
        context: {
          timezone: context?.timezone || null,
          location: context?.location || null,
        },
        categoryDirectory: getCategoryDirectory(memory),
        knownGeneralInfo: getGeneralFacts(memory),
        knownInterestTitles: flattenInterestHooks(memory, 25).map((h) => ({
          category: h.category,
          title: h.title,
        })),
        pastChatIndex,
        mostRecentPastChatTurns,
        recentHistory,
      }),
    },
  ];

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const allowTools = round < MAX_TOOL_ROUNDS && chats.length > 0;
      const response = await client.chat.completions.create({
        ...chatModelOptions(config.memoryAiModel, {
          maxTokens: 900,
          reasoningEffort: "medium",
        }),
        messages,
        ...(allowTools
          ? { tools: MEMORY_AI_TOOLS, tool_choice: "auto" }
          : { tool_choice: "none" }),
      });

      const msg = response.choices?.[0]?.message;
      if (!msg) return null;

      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length || !allowTools) {
        return normalizeAnalysis(parseJsonObject(msg.content || ""));
      }

      messages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const result = runMemoryAiTool(tc, chats);
        console.log(`[memory-tool] ${tc.function?.name}`, tc.function?.arguments?.slice?.(0, 80) || "");
        onTrace?.({
          agent: "memory",
          phase: "tool",
          name: tc.function?.name || "",
          detail: {
            args: (() => {
              try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return tc.function?.arguments || ""; }
            })(),
            result: result.content,
          },
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.content,
        });
      }
    }
  } catch (err) {
    console.error("[memory-ai]", err.message);
    return null;
  }

  return null;
}

export async function consolidateSessionMemory({ history, memory, existingDirectory }) {
  if (!client) return null;
  if (!history || history.length < 2) return null;

  const recentHistory = history.slice(-20).map((m) => ({
    role: m.role,
    content: m.content?.slice(0, 500),
  }));

  const response = await client.responses.create({
    model: config.memoryAiModel,
    ...responsesReasoningExtras(config.memoryAiModel, { maxOutputTokens: 500 }),
    input: [
      { role: "system", content: CONSOLIDATION_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          recentHistory,
          categoryDirectory: existingDirectory || getCategoryDirectory(memory),
          knownGeneral: getGeneralFacts(memory),
          totalTurns: history.filter((h) => h.role === "user").length,
        }),
      },
    ],
  });

  const parsed = parseJsonObject(extractOutputText(response));
  if (!parsed) return null;

  return {
    sessionSummary: parsed.sessionSummary
      ? {
          title: parsed.sessionSummary.title || "Conversation",
          summary: parsed.sessionSummary.summary || "Conversation session",
          topics: Array.isArray(parsed.sessionSummary.topics) ? parsed.sessionSummary.topics : [],
          mood: parsed.sessionSummary.mood || "neutral",
          turnCount: parsed.sessionSummary.turnCount || recentHistory.length,
        }
      : null,
    promote: Array.isArray(parsed.promote)
      ? parsed.promote.filter((p) => p?.title && p?.category).map((p) => ({
          category: p.category,
          categoryTitle: p.categoryTitle || null,
          categoryDescription: p.categoryDescription || null,
          title: p.title,
          content: p.content ?? "",
          recallScore: normalizeRecallScore(p.recallScore, p.category === "topic_deep_dives" ? 0.75 : 0.5),
          reason: p.reason || "",
        }))
      : [],
    // Back-compat aliases used by older session code
    promoteToSemantic: [],
    reasoning: parsed.reasoning || "",
  };
}

export async function deduplicateMemories(memory) {
  if (!client) return null;
  memory = memory || {};
  const entries = [];
  for (const [catKey, cat] of Object.entries(memory.categories || {})) {
    for (const sub of cat.sub_memories || []) {
      entries.push({
        category: catKey,
        id: sub.id,
        title: sub.title,
        recallScore: normalizeRecallScore(sub.recallScore, 0.5),
        contentPreview: typeof sub.content === "string"
          ? sub.content.slice(0, 120)
          : JSON.stringify(sub.content).slice(0, 120),
      });
    }
  }
  if (entries.length < 5) return null;

  const response = await client.responses.create({
    model: config.memoryAiModel,
    ...responsesReasoningExtras(config.memoryAiModel, { maxOutputTokens: 400 }),
    input: [
      { role: "system", content: DEDUPLICATION_PROMPT },
      { role: "user", content: JSON.stringify({ entries: entries.slice(0, 80) }) },
    ],
  });

  const parsed = parseJsonObject(extractOutputText(response));
  if (!parsed) return null;

  return {
    merges: Array.isArray(parsed.merges)
      ? parsed.merges.map((m) => ({
          category: m.category || "",
          keepTitle: m.keepTitle || "",
          removeTitles: Array.isArray(m.removeTitles) ? m.removeTitles : [],
          mergedContent: m.mergedContent ?? "",
          reason: m.reason || "",
        }))
      : [],
    reasoning: parsed.reasoning || "",
  };
}

export function applyDeduplication(memory, deduplicationResult) {
  if (!deduplicationResult?.merges?.length) return memory;

  for (const merge of deduplicationResult.merges) {
    const cat = memory.categories?.[merge.category];
    if (!cat) continue;
    const removeSet = new Set((merge.removeTitles || []).map((t) => String(t).trim().toLowerCase()));
    cat.sub_memories = (cat.sub_memories || []).filter(
      (s) => !removeSet.has(String(s.title).trim().toLowerCase())
    );
    if (merge.keepTitle && merge.mergedContent != null) {
      const keep = cat.sub_memories.find(
        (s) => String(s.title).trim().toLowerCase() === String(merge.keepTitle).trim().toLowerCase()
      );
      if (keep) {
        keep.content = merge.mergedContent;
        keep.timestamp = memoryNow();
      }
    }
  }
  memory.last_updated = memoryNow();
  return memory;
}
