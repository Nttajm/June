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

export function buildMemoryEngagement(memory, { userText = "", recentCallbacks = [] } = {}) {
  memory = normalizeMemory(memory);
  const hooks = flattenInterestHooks(memory, 10);
  if (hooks.length === 0) return "";

  const lines = [];
  lines.push("--- MEMORY ENGAGEMENT (seasoning, not the meal) ---");
  lines.push("ONE detail every few turns max. Follow their current topic.");
  lines.push("Use recallScore as a dial: 0.65+ can be proactive if natural; below 0.65 should mostly stay quiet unless the user brings it up.");
  lines.push("Use scan_memory_category / get_memory_detail when you need a specific fact — do not invent.");
  lines.push("CRITICAL: these are THEIR interests. Reference as you/they — NEVER claim you were just watching/playing the same thing.");

  if (recentCallbacks.length > 0) {
    lines.push(`Already brought up this session — skip: ${recentCallbacks.join(", ")}`);
  }

  if (userText && isDryUtterance(userText)) {
    lines.push("Short/generic reply — memory callback optional.");
  }

  lines.push("Known interest/topic titles (content behind tools):");
  for (const h of hooks.slice(0, 8)) {
    const used = recentCallbacks.some((v) => matchesTopic(v, h.title) || matchesTopic(v, h.value));
    const score = Number.isFinite(h.recallScore) ? h.recallScore.toFixed(2) : "0.50";
    const policy = h.recallScore >= PROACTIVE_RECALL_MIN_SCORE ? "okay if natural" : "only if user reopens it";
    lines.push(`- [${h.category}] ${h.title} (recallScore ${score}, ${policy})${used ? " ← used, skip" : ""}`);
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

// ── Stream / tag helpers (unchanged) ─────────────────────────────────

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

export function mergeCleanDelta(gen, delta) {
  gen.rawBuffer = (gen.rawBuffer || "") + delta;

  const raw = gen.rawBuffer;
  let clean = "";
  let i = 0;

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
      clean += raw.slice(i, j);
      i = j;
      continue;
    }
    clean += raw[i];
    i++;
  }

  const prev = gen.cleanLen || 0;
  gen.cleanLen = clean.length;
  const fresh = clean.slice(prev);
  return fresh || null;
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

const OPENER_STYLES = [
  "reaction-sound",
  "blunt-statement",
  "name-or-noun-first",
  "mid-thought-cut",
  "silent-jump-to-content",
];

const REACTION_SOUND_RE = /^(oh|ooh|ouu|ahh|hmm|huh|ouch|wow|whoa|right|wait|hey|yo|mhm|mm|alright|okay|ok|so)\b/i;
const BLUNT_START_RE = /^(i|i'm|im|you|you're|youre|that|that's|thats|it's|its|nah|no|yeah|yes|sure|fine|not|my|we)\b/i;
const MID_THOUGHT_RE = /^(?:--|…|\.\.\.)|^(?:\S+\s+){0,2}\S*(?:--|…|\.\.\.)/;

/**
 * Classify how an assistant turn opens — structural shape, not exact words.
 * Used to rotate opening *style* so the model can't synonym-swap past a word ban.
 */
export function classifyOpenerStyle(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "silent-jump-to-content";
  const first = raw
    .replace(/^\[(?:laughter|giggles|laugh)\]\s*/i, "")
    .replace(/^[\s"'*_]+/, "")
    .trim();

  if (MID_THOUGHT_RE.test(first) || /^--/.test(first)) return "mid-thought-cut";
  if (REACTION_SOUND_RE.test(first)) return "reaction-sound";

  // Capitalized multi-letter token that isn't a pronoun → likely name/noun lead
  const firstWord = first.split(/[\s,?.!]+/)[0] || "";
  if (/^[A-Z][a-zA-Z]{2,}/.test(firstWord) && !/^(I|I'm|Im)$/i.test(firstWord)) {
    return "name-or-noun-first";
  }
  // lowercase noun-ish lead (the mentalist?, cake?, food —)
  if (/^[a-z][a-z0-9'-]{2,}[?]/.test(first) || /^[a-z][a-z0-9'-]{3,}\s*[—–-]/.test(first)) {
    return "name-or-noun-first";
  }

  if (BLUNT_START_RE.test(first)) return "blunt-statement";
  return "silent-jump-to-content";
}

export function extractRecentOpenerStyles(history = [], limit = 2) {
  return history
    .filter((m) => m.role === "assistant")
    .slice(-limit)
    .map((m) => classifyOpenerStyle(m.content))
    .filter(Boolean);
}

const STYLE_HINTS = {
  "reaction-sound": "open with a quick reaction sound then the point (not a soft ack ladder)",
  "blunt-statement": "open with a blunt take or statement — I/you/that/nah first",
  "name-or-noun-first": "lead with a name, noun, or topic word — no warm-up",
  "mid-thought-cut": "cut in mid-thought as if continuing a beat already in your head",
  "silent-jump-to-content": "jump straight into content with zero soft opener",
};

/** Pick a style different from the last 1–2 used. */
export function pickNextOpenerStyle(recentStyles = []) {
  const used = new Set(recentStyles.filter(Boolean));
  const fresh = OPENER_STYLES.filter((s) => !used.has(s));
  const pool = fresh.length > 0 ? fresh : OPENER_STYLES.filter((s) => s !== recentStyles[recentStyles.length - 1]);
  return pool[Math.floor(Math.random() * pool.length)] || "silent-jump-to-content";
}

const OPINION_REQUEST_RE = /\bwhat (do|did|would) you (think|say|do|reckon)\b|\byour (take|thoughts?|opinion|view)\b|\bdo you (think|agree|believe)\b|\byou tell me\b|\bwhat('s| is) your\b/i;

export function isUserAskingForOpinion(userText = "") {
  return OPINION_REQUEST_RE.test(userText || "");
}

export function buildConversationRhythm(userText = "", history = [], recentCallbacks = [], { hooksEngaged = false, suggestedHooks = [], dryReplyStreak = 0 } = {}) {
  const lines = [];
  lines.push("--- THIS TURN (phone call rhythm) ---");
  lines.push("Friend on a call — lead with a reaction, take, or specific detail. Never open by restating what they just said.");

  const assistantTurns = history.filter((m) => m.role === "assistant").slice(-2);
  const lastAssistant = assistantTurns[assistantTurns.length - 1];
  const prevAssistant = assistantTurns.length >= 2 ? assistantTurns[0] : null;
  const askedLastTurn = lastAssistant?.content?.includes("?");
  const askedPrevTurn = prevAssistant?.content?.includes("?");
  const dryStreak = dryReplyStreak || countDryReplyStreak(history, userText);

  const recentStyles = extractRecentOpenerStyles(history, 2);
  const nextStyle = pickNextOpenerStyle(recentStyles);
  if (recentStyles.length > 0) {
    lines.push(`Last opener style${recentStyles.length > 1 ? "s" : ""}: ${recentStyles.join(" → ")}.`);
  }
  lines.push(`This turn open with style: ${nextStyle} — ${STYLE_HINTS[nextStyle]}`);

  if (isUserAskingForOpinion(userText)) {
    lines.push("They want YOUR opinion — give one. Commit. Do not bounce it back.");
  }

  if (hooksEngaged) {
    lines.push(`Topic hooks live — name-drop one: ${suggestedHooks.join(" · ")}.`);
    if (askedLastTurn && askedPrevTurn) {
      lines.push("Already asked twice — react-only, still weave a hook if you can.");
    } else if (askedLastTurn) {
      lines.push("You asked last turn — only ask again if it names a fresh hook.");
    } else {
      lines.push("Prefer one sharp hook-tied question, or a hook baked into a reaction.");
    }
  } else if (askedLastTurn && askedPrevTurn) {
    lines.push("Last two turns asked questions — this turn ends as a statement.");
  } else if (askedLastTurn) {
    lines.push("You asked last turn — prefer reaction, opinion, or tangent.");
  }

  if (isDryUtterance(userText)) {
    if (dryStreak >= 3) {
      lines.push("Dry streak — pivot hard. No questions about the current thread.");
    } else if (dryStreak >= 2) {
      lines.push("Second short reply — thread closed. React or share something of yours.");
    } else if (askedLastTurn) {
      lines.push("Minimal answer — that thread is done. Do not re-ask.");
    } else {
      lines.push("Short reply — match energy, tease, or share YOUR thought.");
    }
  }

  lines.push("Add ONE new thing this turn (take, tease, detail). Soft ack + another question = robotic.");

  if (recentCallbacks.length > 0) {
    lines.push(`Already brought up this session — skip unless they reopen: ${recentCallbacks.join(", ")}`);
  }

  return lines.join("\n");
}
