/**
 * Conversational memory helpers + prompt builders for category schema v3.
 * Schema CRUD lives in memory-store.js; retrieval tools in memory-tools.js.
 */

import {
  normalizeMemory,
  memoryNow,
  generateId,
  getGeneralFacts,
  getCategoryDirectory,
  getUserName,
  flattenInterestHooks,
  contentToString,
  applyCategoryUpdates,
  startNewSession,
  createEmptyMemory,
  upsertSubMemory,
  SCHEMA_VERSION,
  IDENTITY_KEYS,
} from "./memory-store.js";

export {
  normalizeMemory,
  memoryNow,
  generateId,
  applyCategoryUpdates,
  startNewSession,
  createEmptyMemory,
  SCHEMA_VERSION,
  IDENTITY_KEYS,
  getUserName,
  getCategoryDirectory,
  getGeneralFacts,
  flattenInterestHooks,
};

/** @deprecated use applyCategoryUpdates — kept as alias during transition */
export function applyMemoryUpdates(memory, analysis) {
  return applyCategoryUpdates(memory, analysis);
}

export function consolidateSession(memory, sessionSummary = null) {
  memory = normalizeMemory(memory);
  if (!sessionSummary) return memory;
  upsertSubMemory(memory, "topic_deep_dives", {
    title: (sessionSummary.topics?.[0] || "Session recap").slice(0, 80),
    content: {
      focus: sessionSummary.summary || "Conversation session",
      topics: sessionSummary.topics || [],
      mood: sessionSummary.mood || "neutral",
      turnCount: sessionSummary.turnCount || 0,
    },
  });
  memory.meta.consolidatedAt = memoryNow();
  return memory;
}

// ── Prompt builders ──────────────────────────────────────────────────

function formatGeneralFactBody(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object" && !Array.isArray(content)) {
    return Object.entries(content)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${typeof v === "object" ? contentToString(v) : v}`)
      .join("; ");
  }
  return contentToString(content);
}

/** Human-readable gap for prompts (e.g. "about 12 minutes", "2 days"). */
export function humanizeDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 90) return "under a couple minutes";
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? "about a minute" : `about ${min} minutes`;
  const hr = Math.round(min / 60);
  if (hr < 24) return hr === 1 ? "about an hour" : `about ${hr} hours`;
  const days = Math.round(hr / 24);
  if (days === 1) return "about a day";
  if (days < 14) return `about ${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return weeks === 1 ? "about a week" : `about ${weeks} weeks`;
  const months = Math.round(days / 30);
  return months <= 1 ? "about a month" : `about ${months} months`;
}

/** Coarse gap bucket so the model can reason about continuity vs fresh start. */
export function classifySessionGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 15 * 60 * 1000) return "very_recent"; // < 15m
  if (ms < 2 * 60 * 60 * 1000) return "short"; // < 2h
  if (ms < 12 * 60 * 60 * 1000) return "same_day"; // < 12h
  if (ms < 36 * 60 * 60 * 1000) return "overnight"; // < 36h
  if (ms < 7 * 24 * 60 * 60 * 1000) return "multi_day"; // < 1w
  return "long";
}

/**
 * Build greeting/session continuity fields from the latest saved chat + memory meta.
 * Prefers chat end_time (when they actually left) over session-start stamps.
 */
export function enrichGreetingContext(context = {}, { memory, lastChat } = {}) {
  const out = { ...(context || {}) };
  memory = memory ? normalizeMemory(memory) : null;

  const lastAtRaw =
    lastChat?.end_time ||
    lastChat?.start_time ||
    memory?.meta?.lastSessionAt ||
    memory?.meta?.previousSessionAt ||
    null;

  const lastAtMs = lastAtRaw ? Date.parse(lastAtRaw) : NaN;
  if (Number.isFinite(lastAtMs)) {
    const gapMs = Math.max(0, Date.now() - lastAtMs);
    out.lastChatAt = new Date(lastAtMs).toISOString();
    out.timeSinceLastChatMs = gapMs;
    out.timeSinceLastChat = humanizeDuration(gapMs);
    out.sessionGap = classifySessionGap(gapMs);
  }

  if (lastChat && (lastChat.title || lastChat.main_summary || (lastChat.topics || []).length)) {
    out.lastConversation = {
      title: lastChat.title || null,
      summary: lastChat.main_summary || null,
      topics: Array.isArray(lastChat.topics) ? lastChat.topics.slice(0, 8) : [],
      end_time: lastChat.end_time || lastChat.start_time || null,
    };
  }

  return out;
}

function buildLastConversationBlock(context) {
  if (!context?.timeSinceLastChat && !context?.lastConversation) return "";
  const lines = [
    "--- LAST CONVERSATION (greeting continuity — facts only; reason, don't template) ---",
    "Use this to decide whether the opening should feel like a quick return, a same-day check-in, or a fresh hello.",
    "Only reopen a prior thread when it still makes sense given the time gap (e.g. they were mid-activity and are back soon).",
    "If the gap is long or the prior topic is done/one-off, do NOT force a callback — greet fresh.",
    "Never invent what happened. Never copy example phrasings. Decide from these facts + GENERAL INFO.",
  ];
  if (context.timeSinceLastChat) {
    lines.push(
      `Time since last chat: ${context.timeSinceLastChat}` +
        (context.sessionGap ? ` (gap: ${context.sessionGap})` : "")
    );
  }
  if (context.lastChatAt) lines.push(`Last chat ended around: ${context.lastChatAt}`);
  const lc = context.lastConversation;
  if (lc) {
    if (lc.title) lines.push(`Last chat title: ${lc.title}`);
    if (lc.summary) lines.push(`Last chat summary: ${String(lc.summary).slice(0, 400)}`);
    if (lc.topics?.length) lines.push(`Topics then: ${lc.topics.join(", ")}`);
  } else {
    lines.push("No saved chat summary available — use time gap + GENERAL INFO only.");
  }
  return lines.join("\n");
}

export function buildMemoryInstructions(memory, context, _query = "") {
  const lines = [];
  const now = new Date();
  memory = normalizeMemory(memory);

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const hour = now.getHours();
  let timeOfDay = "morning";
  if (hour >= 12 && hour < 17) timeOfDay = "afternoon";
  else if (hour >= 17 && hour < 21) timeOfDay = "evening";
  else if (hour >= 21 || hour < 5) timeOfDay = "night";

  lines.push("--- CONTEXT ---");
  lines.push(`Date: ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`);
  lines.push(`Time: ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`);
  lines.push(`Time of day: ${timeOfDay}`);
  if (context?.timezone) lines.push(`Timezone: ${context.timezone}`);
  if (context?.location) lines.push(`Location: ${context.location}`);
  if (context?.timeSinceLastChat) {
    lines.push(
      `Time since last chat: ${context.timeSinceLastChat}` +
        (context.sessionGap ? ` (${context.sessionGap})` : "")
    );
  }

  const lastConvo = buildLastConversationBlock(context);
  if (lastConvo) {
    lines.push("");
    lines.push(lastConvo);
  }

  const name = getUserName(memory);
  const general = getGeneralFacts(memory);

  // Always present — greetings and every turn. Not gated behind tools.
  lines.push("");
  lines.push("--- GENERAL INFO (always read — every turn AND greetings; do NOT tool-fetch this) ---");
  lines.push("Standing facts + interaction instructions about the user. Follow them EVERY turn — not optional seasoning.");
  lines.push("Mandatory when present: preferred name/nickname, preferred language, location, work/school, speech/accent style, humor rules, always-do habits.");
  lines.push("Do not wait to be reminded. Interests/media/topics below are seasoning; this block is not.");
  if (name) {
    lines.push(`Name: ${name} — use this name/nickname naturally every turn (including greetings).`);
  } else {
    lines.push("Name: unknown — getting their name is a top priority.");
    lines.push('Ask casually — "wait, what do I even call you?" or "I don\'t think I caught your name" — vary it.');
  }
  if (general.length === 0) {
    lines.push("(no other general_info saved yet)");
  } else {
    for (const fact of general) {
      const body = formatGeneralFactBody(fact.content);
      lines.push(`- ${fact.title}: ${body || "(empty)"}`);
    }
  }

  const directory = getCategoryDirectory(memory).filter((c) => c.key !== "general_info");
  if (directory.length > 0) {
    lines.push("");
    lines.push("--- MEMORY DIRECTORY (titles gated — use tools to explore) ---");
    for (const cat of directory) {
      lines.push(`- ${cat.key} (${cat.title}): ${cat.count} memories — ${cat.description || ""}`);
    }
  }

  return lines.join("\n");
}

/** Alias matching plan naming */
export const buildMemoryOverviewPrompt = buildMemoryInstructions;

const PROACTIVE_RECALL_MIN_SCORE = 0.65;

export function buildMemoryEngagement(memory, { userText = "", recentCallbacks = [], knownTopic = null, memoryToolsOn = false } = {}) {
  memory = normalizeMemory(memory);
  const hooks = flattenInterestHooks(memory, 10);
  if (hooks.length === 0 && !knownTopic) return "";

  const lines = [];
  lines.push("--- MEMORY ENGAGEMENT (seasoning, not the meal) ---");
  lines.push("ONE detail every few turns max. Follow their current topic.");
  lines.push("Use recallScore as a dial: 0.65+ can be proactive if natural; below 0.65 should mostly stay quiet unless the user brings it up.");
  lines.push("Titles below are conversation seasoning — never the body of an answer when they asked you to tell them information.");
  if (memoryToolsOn) {
    lines.push("Use scan_memory_category / get_memory_detail only for a specific personal fact about THEM — not to answer a tell-me ask.");
  }
  lines.push("CRITICAL: these are THEIR interests. Reference as you/they — NEVER claim you were just watching/playing the same thing.");

  if (recentCallbacks.length > 0) {
    lines.push(`Already brought up this session — skip: ${recentCallbacks.join(", ")}`);
  }

  if (knownTopic) {
    lines.push(`Known live thread from snapshot: ${knownTopic} — prefer this over a blank status check.`);
  }

  if (userText && isDryUtterance(userText)) {
    if (hooks.length > 0 || knownTopic) {
      lines.push("Short/generic reply — you already know something about them. Open from ONE known title/thread, not a blank status ask.");
    } else {
      lines.push("Short/generic reply — memory callback optional.");
    }
  }

  if (hooks.length > 0) {
    lines.push("Known interest/topic titles (content behind tools):");
    for (const h of hooks.slice(0, 8)) {
      const used = recentCallbacks.some((v) => matchesTopic(v, h.title) || matchesTopic(v, h.value));
      const score = Number.isFinite(h.recallScore) ? h.recallScore.toFixed(2) : "0.50";
      const policy = h.recallScore >= PROACTIVE_RECALL_MIN_SCORE ? "okay if natural" : "only if user reopens it";
      lines.push(`- [${h.category}] ${h.title} (recallScore ${score}, ${policy})${used ? " ← used, skip" : ""}`);
    }
  }

  return lines.join("\n");
}

function matchesTopic(text, value) {
  if (!text || !value) return false;
  const t = String(text).toLowerCase();
  const v = String(value).toLowerCase();
  if (v.length < 3) return false;
  return t.includes(v) || v.includes(t);
}

export function detectMemoryCallbacks(text, memory) {
  const hits = [];
  const spoken = String(text || "").toLowerCase();
  if (!spoken) return hits;

  memory = normalizeMemory(memory);
  const name = getUserName(memory);
  if (name && spoken.includes(String(name).toLowerCase())) {
    // don't count name as a "callback" spam
  }

  for (const h of flattenInterestHooks(memory, 20)) {
    if (matchesTopic(spoken, h.title) || matchesTopic(spoken, h.value)) {
      hits.push({ key: h.title, value: h.title });
    }
  }
  return hits;
}

export function pickRotatedInterest(memory, recentCallbacks = [], minRecallScore = PROACTIVE_RECALL_MIN_SCORE) {
  const hooks = flattenInterestHooks(memory, 20).filter((h) => h.recallScore >= minRecallScore);
  if (hooks.length === 0) return null;
  if (recentCallbacks.length === 0) return hooks[0];
  const used = new Set(recentCallbacks.map((v) => String(v).toLowerCase()));
  const fresh = hooks.find((h) => !used.has(String(h.title).toLowerCase()));
  return fresh || hooks[recentCallbacks.length % hooks.length] || hooks[0];
}

export function buildMemoryThoughtCache(memory, { recentCallbacks = [] } = {}) {
  memory = normalizeMemory(memory);
  const hooks = flattenInterestHooks(memory, 8);
  if (hooks.length === 0) return null;

  const pick = pickRotatedInterest(memory, recentCallbacks);
  if (!pick) return null;
  const associations = hooks.slice(0, 4).map((h) => h.title);

  let memoryBridge = null;
  if (pick && !recentCallbacks.some((v) => matchesTopic(v, pick.title))) {
    memoryBridge = `Optional callback if natural — they care about ${pick.title}. Only if unused this session.`;
  }

  const avoid = [
    "don't list facts interview-style",
    "don't force memory if they clearly changed topic",
    "don't repeat a callback you already used this session",
  ];
  if (recentCallbacks.length > 0) {
    avoid.push(`already discussed: ${recentCallbacks.join(", ")} — skip these`);
  }

  return {
    topic: pick ? pick.title : "catching up",
    topicKey: "memory-anchor",
    confidence: Math.min(pick.recallScore, recentCallbacks.length >= 2 ? 0.3 : 0.55),
    associations,
    casualDrops: [],
    memoryBridge,
    juneSelfDrop: null,
    personification: {
      pretendExperienced: false,
      ifAskedHow: null,
    },
    avoid,
    reasoning: "sync memory anchor (rotated)",
    fromMemory: true,
  };
}

export function mergeThoughtCache(asyncCache, memory, { recentCallbacks = [], dryReplyStreak = 0 } = {}) {
  const sync = buildMemoryThoughtCache(memory, { recentCallbacks });
  if (!sync && !asyncCache) return null;
  if (!sync) return asyncCache;
  if (!asyncCache) return sync;

  const onDryStreak = dryReplyStreak >= 2;
  const suppressBridge = recentCallbacks.length >= 2 || onDryStreak;

  return {
    ...sync,
    ...asyncCache,
    confidence: onDryStreak
      ? Math.min(asyncCache.confidence || 0, 0.25)
      : recentCallbacks.length >= 2
        ? Math.min(asyncCache.confidence || 0, 0.45)
        : Math.max(sync.confidence, Math.min(asyncCache.confidence || 0, 0.55)),
    tone: asyncCache.tone || sync.tone || null,
    interjections: Array.isArray(asyncCache.interjections) ? asyncCache.interjections.slice(0, 2) : [],
    suggestions: onDryStreak
      ? (Array.isArray(asyncCache.suggestions) ? asyncCache.suggestions.slice(0, 1) : [])
      : (Array.isArray(asyncCache.suggestions) ? asyncCache.suggestions.slice(0, 3) : []),
    memoryBridge: suppressBridge ? null : (asyncCache.memoryBridge || sync.memoryBridge),
    expansionAngles: onDryStreak ? [] : (asyncCache.expansionAngles || []),
    juneSelfDrop: asyncCache.juneSelfDrop || sync.juneSelfDrop,
    casualDrops: onDryStreak
      ? (asyncCache.juneSelfDrop ? [] : [...new Set([...(asyncCache.casualDrops || []), ...(sync.casualDrops || [])])].slice(0, 1))
      : [...new Set([...(asyncCache.casualDrops || []), ...(sync.casualDrops || [])])].slice(0, 2),
    associations: [...new Set([...(asyncCache.associations || []), ...(sync.associations || [])])].slice(0, 4),
    personification: asyncCache.personification?.pretendExperienced
      ? asyncCache.personification
      : sync.personification,
    avoid: [
      ...(asyncCache.avoid || []),
      ...(onDryStreak ? ["interview questions on the current thread", "re-asking what they already answered vaguely"] : []),
    ],
    recallIntent: asyncCache.recallIntent || null,
    forceTools: Boolean(asyncCache.forceTools),
    sourceTranscript: asyncCache.sourceTranscript || "",
  };
}

/** No-op compatibility: access tracking was semantic-id based; categories use titles. */
export function markAccessedEntries(memory, _ids) {
  return normalizeMemory(memory);
}

/** Stub — retrieval is tool-driven now. */
export function retrieveRelevantMemories(memory, _query, _tokenBudget = null) {
  memory = normalizeMemory(memory);
  return {
    identity: {},
    semantic: [],
    episodic: [],
    logs: [],
    accessedIds: [],
    directory: getCategoryDirectory(memory),
    general: getGeneralFacts(memory),
  };
}

// ── Stream / tag helpers ─────────────────────────────────────────────

export const GAP_MIN_SEC = 0.3;
export const GAP_MAX_SEC = 2.0;

/** Clamp gap duration to the allowed spoken-pause range. */
export function clampGapSeconds(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return GAP_MIN_SEC;
  return Math.min(GAP_MAX_SEC, Math.max(GAP_MIN_SEC, v));
}

/** Strip completed `[gap N]` markers (display / history). */
export function stripGapMarkers(text) {
  return String(text || "").replace(/\[gap\s+\d+(?:\.\d+)?\s*\]/gi, "");
}

/**
 * Parse a full string into ordered speech segments (text + gaps).
 * Used for non-streaming paths (e.g. follow-up).
 */
export function parseSpeechSegments(text) {
  const raw = String(text || "");
  const segments = [];
  let i = 0;
  let buf = "";

  const flushText = () => {
    if (!buf) return;
    segments.push({ type: "text", value: buf });
    buf = "";
  };

  while (i < raw.length) {
    if (raw[i] === "[") {
      const m = raw.slice(i).match(/^\[gap\s+(\d+(?:\.\d+)?)\s*\]/i);
      if (m) {
        flushText();
        segments.push({ type: "gap", seconds: clampGapSeconds(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    buf += raw[i];
    i++;
  }
  flushText();
  return segments;
}

/** True if `raw.slice(i)` is an incomplete `[gap …]` that must wait for more tokens. */
function isIncompleteGapPrefix(raw, i) {
  const rest = raw.slice(i);
  if (!rest.startsWith("[")) return false;
  if (/^\[gap\s+\d+(?:\.\d+)?\s*\]/i.test(rest)) return false;
  // Enough chars to know this is not a gap marker → treat `[` as normal text.
  if (rest.length >= 5 && !/^\[gap\b/i.test(rest)) return false;
  if (rest.length >= 6 && /^\[gap\S/i.test(rest) && !/^\[gap\s/i.test(rest)) return false;
  return (
    /^\[$/i.test(rest)
    || /^\[g$/i.test(rest)
    || /^\[ga$/i.test(rest)
    || /^\[gap$/i.test(rest)
    || /^\[gap\s*$/i.test(rest)
    || /^\[gap\s+\d+\.?$/i.test(rest)
    || /^\[gap\s+\d+\.\d*$/i.test(rest)
    || /^\[gap\s+\d+(?:\.\d+)?\s*$/i.test(rest)
  );
}

export function stripMemoryTags(text) {
  let clean = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "(" && i + 2 < text.length && text[i + 1] === "*" && text[i + 2] === "*") {
      let depth = 1;
      let j = i + 3;
      while (j < text.length) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) { j++; break; }
        }
        j++;
      }
      if (depth === 0) { i = j; continue; }
    }
    clean += text[i];
    i++;
  }
  return clean.trim();
}

/**
 * Stream-safe cleaner. Strips memory tags and `[gap N]` from display text,
 * holds incomplete markers across token boundaries, and returns ordered
 * speech segments for TTS (text + silence gaps).
 *
 * @returns {{ text: string, segments: Array<{type:'text',value:string}|{type:'gap',seconds:number}> } | null}
 */
export function mergeCleanDelta(gen, delta) {
  gen.rawBuffer = (gen.rawBuffer || "") + delta;

  const raw = gen.rawBuffer;
  let clean = "";
  let i = 0;
  const segments = [];
  let textBuf = "";

  const flushTextSeg = () => {
    if (!textBuf) return;
    segments.push({ type: "text", value: textBuf });
    textBuf = "";
  };

  while (i < raw.length) {
    if (raw[i] === "(" && i + 2 < raw.length && raw[i + 1] === "*" && raw[i + 2] === "*") {
      let depth = 1;
      let j = i + 3;
      while (j < raw.length) {
        if (raw[j] === "(") depth++;
        else if (raw[j] === ")") {
          depth--;
          if (depth === 0) { j++; break; }
        }
        j++;
      }
      if (depth > 0) break;
      i = j;
      continue;
    }
    if (raw[i] === "{" && i + 1 < raw.length && raw[i + 1] === "-") {
      let j = i + 2;
      let found = false;
      while (j < raw.length) {
        if (raw[j] === "}" && raw[j - 1] === "-") {
          found = true;
          j++;
          break;
        }
        j++;
      }
      if (!found) break;
      textBuf += raw.slice(i, j);
      clean += raw.slice(i, j);
      i = j;
      continue;
    }
    if (raw[i] === "[") {
      if (isIncompleteGapPrefix(raw, i)) break;
      const m = raw.slice(i).match(/^\[gap\s+(\d+(?:\.\d+)?)\s*\]/i);
      if (m) {
        flushTextSeg();
        segments.push({ type: "gap", seconds: clampGapSeconds(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    textBuf += raw[i];
    clean += raw[i];
    i++;
  }
  flushTextSeg();

  const prev = gen.cleanLen || 0;
  gen.cleanLen = clean.length;
  const freshText = clean.slice(prev);

  const prevSegments = gen.lastSegments || [];
  const outSegments = [];
  for (let s = 0; s < segments.length; s++) {
    const next = segments[s];
    const prevSeg = prevSegments[s];
    if (!prevSeg) {
      outSegments.push(
        next.type === "gap"
          ? { type: "gap", seconds: next.seconds }
          : { type: "text", value: next.value },
      );
      continue;
    }
    if (next.type === "text" && prevSeg.type === "text" && next.value.length > prevSeg.value.length) {
      outSegments.push({ type: "text", value: next.value.slice(prevSeg.value.length) });
    }
  }
  gen.lastSegments = segments;
  gen.segments = segments;

  if (!freshText && !outSegments.length) return null;
  return { text: freshText, segments: outSegments };
}

export function extractMemoryCalls(text) {
  const calls = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "(" && i + 2 < text.length && text[i + 1] === "*" && text[i + 2] === "*") {
      let depth = 1;
      let j = i + 3;
      while (j < text.length) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) { j++; break; }
        }
        j++;
      }
      if (depth === 0) {
        const callRe = /(setName|remember|clearMemory)\(([^)]*)\)/g;
        const inner = text.slice(i + 3, j - 1);
        let cm;
        while ((cm = callRe.exec(inner)) !== null) {
          calls.push({ fn: cm[1], arg: cm[2].trim() });
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  return calls;
}

export function applyMemoryCalls(memory, calls) {
  memory = normalizeMemory(memory);
  for (const { fn, arg } of calls) {
    if (fn === "setName" && arg) {
      applyCategoryUpdates(memory, { setName: arg });
    } else if (fn === "remember") {
      const idx = arg.indexOf(":");
      if (idx === -1) continue;
      const subject = arg.slice(0, idx).trim();
      const value = arg.slice(idx + 1).trim();
      if (!subject || !value) continue;
      applyCategoryUpdates(memory, {
        categorized: [{ category: "interests", title: subject, content: value, recallScore: 0.65 }],
      });
    } else if (fn === "clearMemory") {
      memory = createEmptyMemory();
    }
  }
  return memory;
}

// ── Conversation rhythm / dry-utterance heuristics ───────────────────

const GENERIC_UTTERANCE_RE = /^(fine|good|okay|ok|yeah|yep|mhm|yep|nothing|not much|idk|i don't know|hey|hi|hello|mhmm|nm|cool|sure|thanks|thank you|yo|nah|nope|same|whatever|meh|right|true|exactly|fair enough|pretty much|not really)\.?$/i;
const CLOSURE_UTTERANCE_RE = /^(i guess(\s+(so|not|i just did|i did))?|just did|i just did|kind of|sort of|i dunno|dunno)\.?$/i;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "that", "this", "with", "from", "they", "we", "you", "your", "what", "when", "where", "which", "who",
  "why", "how", "all", "some", "such", "no", "not", "only", "same", "so", "than", "too", "very", "just",
  "don", "now", "like", "even", "also", "back", "after", "before", "here", "there", "then", "about",
  "into", "through", "during", "out", "off", "over", "under", "again", "know", "think", "mean", "really",
  "actually", "maybe", "probably", "something", "anything", "nothing", "sound", "sounds", "rough", "tough",
  "wow", "ouch", "honestly", "literally", "though", "right", "well", "still", "even", "going", "feel",
  "feels", "make", "made", "making", "whole", "morning", "early", "without", "empty", "least", "afterward",
]);

export function isGenericUtterance(text) {
  return GENERIC_UTTERANCE_RE.test((text || "").trim());
}

export function isDryUtterance(text) {
  const t = (text || "").trim();
  if (!t) return true;
  if (isGenericUtterance(t)) return true;
  if (CLOSURE_UTTERANCE_RE.test(t)) return true;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 3 && /^(i guess|not really|just|yeah|yep|nah|nope|sure|ok|okay|same|maybe|idk|right|true|exactly|fair|mhm|uh huh|i just|just did)/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Memory extraction gate (Mem0-style): almost always run the memory agent.
 * Only skip empty turns — the agent decides filler vs durable facts.
 * Do NOT reuse isDryUtterance here (that helper is for rhythm/thinker only).
 */
export function shouldSkipMemoryAnalysis(text) {
  return !String(text || "").trim();
}

export function countDryReplyStreak(history = [], userText = "") {
  if (!isDryUtterance(userText)) return 0;
  let streak = 1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    if (isDryUtterance(history[i].content)) streak++;
    else break;
  }
  return streak;
}

function extractThemeWords(text) {
  return [...new Set(
    String(text || "").toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  )];
}

export function extractRecentAssistantThemes(history = [], limit = 2) {
  const assistantMsgs = history.filter((m) => m.role === "assistant").slice(-limit);
  if (assistantMsgs.length === 0) return [];
  const counts = {};
  for (const msg of assistantMsgs) {
    for (const word of extractThemeWords(msg.content)) {
      counts[word] = (counts[word] || 0) + 1;
    }
  }
  const minCount = assistantMsgs.length >= 2 ? 2 : 1;
  return Object.entries(counts)
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);
}

export function extractRecentOpeners(history = [], limit = 3) {
  return history
    .filter((m) => m.role === "assistant")
    .slice(-limit)
    .map((m) => {
      const text = String(m.content || "").trim().toLowerCase();
      const words = text.replace(/^[\s"'*_]+/, "").split(/[\s,]+/).filter((w) => w.length > 1);
      return words.slice(0, 4).join(" ");
    })
    .filter((o) => o.length > 3);
}

/** @deprecated Prefer classifyOpenerStyle — kept for any external callers. */
export function extractVerbatimPhrases(text = "", minWords = 4, maxPhrases = 3) {
  const clean = String(text || "").replace(/[^\w\s''-]/g, " ").trim().toLowerCase();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return [];
  const phrases = [];
  for (let i = 0; i <= words.length - minWords && phrases.length < maxPhrases; i += Math.floor(words.length / (maxPhrases + 1)) || 1) {
    phrases.push(words.slice(i, i + minWords).join(" "));
  }
  return phrases;
}

// ── Turn syntax shapes (human clause structures, not opener words) ────

/**
 * Human spoken clause shapes — code picks one per turn.
 * These constrain SYNTAX, not just speech-acts.
 */
const TURN_SYNTAXES = [
  "bare-assessment",    // [thing] + [take], statement. "jetlag is evil"
  "noticing",           // you + observation, statement. "you sound wrecked"
  "parallel-share",     // I + one specific beat, statement. no question at end
  "noun-lead",          // content noun from their line + take. "food. yeah that tracks"
  "tease-statement",    // short roast as statement. "that's not an answer"
  "accept-reframe",     // [accept] + [reframe as real state], optional situated-ask
  "situated-ask",       // one WH/yes-no about a concrete noun already in play
  "statement-offer",    // I can / I'll + offer as statement (dry streak only)
];

/** Bad syntax shapes to detect and rotate away from (never picked, only classified). */
const BAD_SYNTAXES = [
  "echo-question",      // "Nothing?" — their word + ?
  "wait-echo",          // "wait, jetlagged?"
  "tag-question",       // ", huh?" / ", right?" after echo
  "alt-question",       // "are you X or Y" / "chilling or something else"
  "mind-probe",         // "what are you thinking" / "what's on your mind"
  "mood-label",         // "classic mood" / "that's a vibe"
];

// Detection patterns (used by classifyTurnSyntax)
const ECHO_QUESTION_RE = /^(\w{2,15})\?\s/i;  // single word + ? at start
const WAIT_ECHO_RE = /^wait[,\s]+\w+\?/i;
const TAG_QUESTION_RE = /[,\s]+(huh|right|eh|yeah)\?\s*$/i;
const ALT_QUESTION_RE = /\b(or is there|or some sort of|or something|just \w+ or)\b/i;
const MIND_PROBE_RE = /\b(what are you thinking|what's on your mind|how does that make you feel|what do you think)\b/i;
const MOOD_LABEL_RE = /\b(classic mood|that's a vibe|that's so you|very you|classic \w+ move)\b/i;

// Good syntax detection patterns
const ACCEPT_REFRAME_RE = /^(fair enough|yeah|okay|alright|sure)[,\s]+/i;
const NOTICING_RE = /^you\s+(sound|seem|look|are)\s+/i;
const PARALLEL_SHARE_RE = /^I\s+(was|am|just|have|had|think|feel)\s+/i;

/**
 * Classify the syntax shape of an assistant turn.
 * Returns a shape from TURN_SYNTAXES or BAD_SYNTAXES.
 */
export function classifyTurnSyntax(text = "", userLastWord = "") {
  const t = String(text || "").trim();
  if (!t) return "bare-assessment";

  // Bad shapes first (so we can rotate away)
  if (MOOD_LABEL_RE.test(t)) return "mood-label";
  if (MIND_PROBE_RE.test(t)) return "mind-probe";
  if (ALT_QUESTION_RE.test(t)) return "alt-question";
  if (TAG_QUESTION_RE.test(t)) return "tag-question";
  if (WAIT_ECHO_RE.test(t)) return "wait-echo";

  // Echo-question: first word matches user's last word and ends with ?
  const firstWord = t.split(/[\s?,!.]+/)[0]?.toLowerCase() || "";
  if (userLastWord && firstWord === userLastWord.toLowerCase() && /^\w+\?\s/.test(t)) {
    return "echo-question";
  }
  if (ECHO_QUESTION_RE.test(t) && t.split(/[.!?]/).length <= 2) {
    return "echo-question";
  }

  // Good shapes
  if (ACCEPT_REFRAME_RE.test(t)) return "accept-reframe";
  if (NOTICING_RE.test(t)) return "noticing";
  if (PARALLEL_SHARE_RE.test(t)) return "parallel-share";

  // Check for question at end
  const hasQuestion = /\?\s*$/.test(t);
  if (hasQuestion && t.split("?").length === 2) return "situated-ask";

  // Noun-lead: starts with a content word (not pronoun/article)
  if (/^[a-z][a-z'-]{2,}[.\s,]/i.test(t) && !/^(the|a|an|i|you|we|they|it|he|she)\b/i.test(t)) {
    return "noun-lead";
  }

  // Default to statement shapes
  if (!hasQuestion) return "bare-assessment";
  return "situated-ask";
}

/**
 * Extract last 1–2 assistant turn syntaxes.
 */
export function extractRecentSyntaxes(history = [], userText = "", limit = 2) {
  const userLastWord = String(userText || "").trim().split(/\s+/).pop() || "";
  return history
    .filter((m) => m.role === "assistant")
    .slice(-limit)
    .map((m) => classifyTurnSyntax(m.content, userLastWord))
    .filter(Boolean);
}

/**
 * Slot grammar for each syntax shape — positive build instructions only.
 */
const SYNTAX_SLOTS = {
  "bare-assessment": {
    build: "One spoken clause: name the thing, give your take.",
    end: "End as a statement — no question mark.",
  },
  "noticing": {
    build: "Notice something about them or how they sound.",
    end: "Statement.",
  },
  "parallel-share": {
    build: "Share one beat from your own life or thought.",
    end: "Statement — don't tack a question on.",
  },
  "noun-lead": {
    build: "Start on a content word from their last line, then a short take.",
    end: "Statement or trail off.",
  },
  "tease-statement": {
    build: "A short playful roast or challenge.",
    end: "Statement.",
  },
  "accept-reframe": {
    build: "Light accept, then reframe their short answer as a real/valid state.",
    end: "Optional one specific ask with a spoken tail (or what / or nah).",
  },
  "situated-ask": {
    build: "One question about a concrete noun, activity, or time already in play.",
    end: "One clause, one question mark.",
  },
  "statement-offer": {
    build: "Offer something as a statement (I can… / I'll…).",
    end: "Statement.",
  },
};

/**
 * Pick a syntax shape for this turn.
 * @param {object} opts - Context for picking
 * @returns {{ syntax: string, slots: object, note: string }}
 */
export function pickTurnSyntax({
  isDry = false,
  dryStreak = 0,
  askedLastTurn = false,
  askedLastTwo = false,
  recentSyntaxes = [],
  isOpinionRequest = false,
  hooksEngaged = false,
  softInitiateSlot = false,
  suggestedTopic = null,
} = {}) {
  const usedSet = new Set(recentSyntaxes);
  const isBadShape = (s) => BAD_SYNTAXES.includes(s);

  // Filter out bad shapes and recently used
  const available = TURN_SYNTAXES.filter((s) => !usedSet.has(s) && !isBadShape(s));

  // Dry small-talk WITH a concrete Thinker/snapshot lead: take the lead instead of
  // empty accept-reframe ping-pong ("i'm good" → "that's good" forever).
  if (
    isDry
    && dryStreak >= 1
    && dryStreak < 3
    && suggestedTopic
    && (hooksEngaged || softInitiateSlot)
    && !askedLastTurn
    && !usedSet.has("situated-ask")
  ) {
    return {
      syntax: "situated-ask",
      slots: SYNTAX_SLOTS["situated-ask"],
      note: `Dry reply + live lead — ask one concrete thing about: ${suggestedTopic}`,
    };
  }

  // Dry reply defaults to accept-reframe
  if (isDry && dryStreak >= 1) {
    if (!usedSet.has("accept-reframe")) {
      return {
        syntax: "accept-reframe",
        slots: SYNTAX_SLOTS["accept-reframe"],
        note: "Dry reply — accept their short answer, reframe as a real state",
      };
    }
    // If accept-reframe was just used, go to parallel-share or tease
    const fallback = available.find((s) => ["parallel-share", "tease-statement", "noun-lead"].includes(s));
    if (fallback) {
      return {
        syntax: fallback,
        slots: SYNTAX_SLOTS[fallback],
        note: "Dry reply, already accepted — share yours or tease",
      };
    }
  }

  // Dry streak >= 3: pivot hard, statement-offer allowed
  if (dryStreak >= 3 && !usedSet.has("statement-offer")) {
    return {
      syntax: "statement-offer",
      slots: SYNTAX_SLOTS["statement-offer"],
      note: "Dry streak — offer something as a statement",
    };
  }

  // Opinion request: force a take
  if (isOpinionRequest) {
    const opinionSyntaxes = ["bare-assessment", "parallel-share", "noticing"];
    const pick = opinionSyntaxes.find((s) => !usedSet.has(s)) || "bare-assessment";
    return {
      syntax: pick,
      slots: SYNTAX_SLOTS[pick],
      note: "They want YOUR opinion — commit to a take",
    };
  }

  // Asked last two turns: must be statement
  if (askedLastTwo) {
    const statementOnly = ["bare-assessment", "noticing", "parallel-share", "tease-statement", "noun-lead"];
    const pick = statementOnly.find((s) => !usedSet.has(s)) || "bare-assessment";
    return {
      syntax: pick,
      slots: SYNTAX_SLOTS[pick],
      note: "Asked twice already — end as a statement",
    };
  }

  // Soft initiative slot (rare): situated-ask with injected topic
  if (softInitiateSlot && suggestedTopic) {
    return {
      syntax: "situated-ask",
      slots: SYNTAX_SLOTS["situated-ask"],
      note: `Soft initiative — one specific ask about: ${suggestedTopic}`,
    };
  }

  // Hooks engaged: prefer situated-ask if not asked last turn
  if (hooksEngaged && !askedLastTurn && !usedSet.has("situated-ask")) {
    return {
      syntax: "situated-ask",
      slots: SYNTAX_SLOTS["situated-ask"],
      note: "Topic hook active — one sharp question naming the hook",
    };
  }

  // Asked last turn: prefer statement shapes
  if (askedLastTurn) {
    const statementPref = ["bare-assessment", "noticing", "parallel-share", "noun-lead", "tease-statement"];
    const pick = statementPref.find((s) => !usedSet.has(s)) || available[0] || "bare-assessment";
    return {
      syntax: pick,
      slots: SYNTAX_SLOTS[pick],
      note: "You asked last turn — prefer reaction/statement",
    };
  }

  // Default: rotate through available
  const pool = available.length > 0 ? available : TURN_SYNTAXES.filter((s) => s !== recentSyntaxes[recentSyntaxes.length - 1]);
  const pick = pool[Math.floor(Math.random() * pool.length)] || "bare-assessment";
  return {
    syntax: pick,
    slots: SYNTAX_SLOTS[pick],
    note: "",
  };
}

// ── Legacy opener-style exports (deprecated, kept for compatibility) ──

/** @deprecated Use classifyTurnSyntax instead */
export function classifyOpenerStyle(text = "") {
  const syntax = classifyTurnSyntax(text);
  // Map to old style names for any legacy callers
  const map = {
    "bare-assessment": "blunt-statement",
    "noticing": "blunt-statement",
    "parallel-share": "blunt-statement",
    "noun-lead": "name-or-noun-first",
    "accept-reframe": "reaction-sound",
    "situated-ask": "silent-jump-to-content",
  };
  return map[syntax] || "silent-jump-to-content";
}

/** @deprecated Use extractRecentSyntaxes instead */
export function extractRecentOpenerStyles(history = [], limit = 2) {
  return extractRecentSyntaxes(history, "", limit).map((s) => {
    const map = {
      "bare-assessment": "blunt-statement",
      "noticing": "blunt-statement",
      "parallel-share": "blunt-statement",
      "noun-lead": "name-or-noun-first",
    };
    return map[s] || "silent-jump-to-content";
  });
}

/** @deprecated Use pickTurnSyntax instead */
export function pickNextOpenerStyle(recentStyles = []) {
  return "silent-jump-to-content";
}

const OPINION_REQUEST_RE = /\bwhat (do|did|would) you (think|say|do|reckon)\b|\byour (take|thoughts?|opinion|view)\b|\bdo you (think|agree|believe)\b|\byou tell me\b|\bwhat('s| is) your\b/i;

const SOFT_INITIATIVE_MIN_GAP = 10;
const SOFT_INITIATIVE_FORCE_GAP = 15;

export function isUserAskingForOpinion(userText = "") {
  return OPINION_REQUEST_RE.test(userText || "");
}

/** Assistant turns since the last situated-ask (or total if never). */
export function turnsSinceAsk(history = []) {
  const assistants = history.filter((m) => m.role === "assistant");
  for (let i = assistants.length - 1; i >= 0; i--) {
    if (classifyTurnSyntax(assistants[i]?.content) === "situated-ask") {
      return assistants.length - 1 - i;
    }
  }
  return assistants.length;
}

/**
 * Rare soft-initiative slot: ~once every 10–15 assistant turns.
 * Eligible from gap 10; forced by gap 15 so it doesn't stall forever.
 */
export function shouldSoftInitiate(history = [], { askedLastTwo = false } = {}) {
  if (askedLastTwo) return false;
  const since = turnsSinceAsk(history);
  if (since < SOFT_INITIATIVE_MIN_GAP) return false;
  if (since >= SOFT_INITIATIVE_FORCE_GAP) return true;
  return Math.random() < 0.4;
}

/**
 * Build conversation rhythm — one human clause shape per turn.
 * Positive slot grammar only. Never names banned words/patterns (that primes them).
 */
export function buildConversationRhythm(userText = "", history = [], recentCallbacks = [], { hooksEngaged = false, suggestedHooks = [], dryReplyStreak = 0, suggestedTopic = null } = {}) {
  const lines = [];
  lines.push("--- THIS TURN ---");
  lines.push("One idea. Usually under three sentences. Add something new — don't restate what they just said three ways.");

  const assistantTurns = history.filter((m) => m.role === "assistant").slice(-2);
  const lastAssistant = assistantTurns[assistantTurns.length - 1];
  const prevAssistant = assistantTurns.length >= 2 ? assistantTurns[0] : null;
  const askedLastTurn = lastAssistant?.content?.includes("?");
  const askedPrevTurn = prevAssistant?.content?.includes("?");
  const dryStreak = dryReplyStreak || countDryReplyStreak(history, userText);
  const isDry = isDryUtterance(userText);

  // Internal only: rotate away from recent/bad shapes without naming them to the model
  const recentSyntaxes = extractRecentSyntaxes(history, userText, 2);
  const isOpinionRequest = isUserAskingForOpinion(userText);
  const softInitiateSlot = shouldSoftInitiate(history, {
    askedLastTwo: Boolean(askedLastTurn && askedPrevTurn),
  });

  const { syntax, slots, note } = pickTurnSyntax({
    isDry,
    dryStreak,
    askedLastTurn,
    askedLastTwo: Boolean(askedLastTurn && askedPrevTurn),
    recentSyntaxes,
    isOpinionRequest,
    hooksEngaged,
    softInitiateSlot,
    suggestedTopic: suggestedTopic || (suggestedHooks.length > 0 ? suggestedHooks[0] : null),
  });

  lines.push("");
  lines.push(`Shape this turn like: ${syntax}`);
  lines.push(slots.build);
  lines.push(slots.end);
  if (note) lines.push(note);

  if (hooksEngaged && suggestedHooks.length > 0 && syntax === "situated-ask") {
    lines.push(`Ask about something concrete on: ${suggestedHooks[0]}`);
  } else if (suggestedTopic && syntax === "situated-ask") {
    lines.push(`Ask about something concrete on: ${suggestedTopic}`);
  }

  if (recentCallbacks.length > 0) {
    lines.push(`Already brought up this session — skip: ${recentCallbacks.join(", ")}`);
  }

  return lines.join("\n");
}
