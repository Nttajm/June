import { config } from "./states.js";

const SCHEMA_VERSION = 2;
const IDENTITY_KEYS = new Set(['name', 'age', 'birthday', 'location', 'hometown', 'timezone']);
const MAX_LOGS = 100;
const MAX_EPISODIC = 20;
const MAX_SEMANTIC = 200;

const LOG_FRESHNESS_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const SEMANTIC_FRESHNESS_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

const SCORE_WEIGHTS = {
  keywordRelevance: 0.45,
  freshness: 0.30,
  importance: 0.15,
  accessFrequency: 0.10
};

/** ISO date string for persisted memory timestamps */
export function memoryNow() {
  return new Date().toISOString();
}

/** Parse memory date (ISO string or legacy ms number) to epoch ms */
export function memoryTimeMs(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function toMemoryDate(value) {
  if (value == null) return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? memoryNow() : new Date(ms).toISOString();
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return memoryNow();
  return new Date(n).toISOString();
}

function migrateMemoryDates(memory) {
  if (!memory?.meta) return memory;

  for (const field of ["createdAt", "lastSessionAt", "previousSessionAt", "consolidatedAt"]) {
    if (memory.meta[field] != null) memory.meta[field] = toMemoryDate(memory.meta[field]);
  }
  for (const sem of memory.semantic || []) {
    for (const field of ["createdAt", "updatedAt", "lastAccessedAt"]) {
      if (sem[field] != null) sem[field] = toMemoryDate(sem[field]);
    }
  }
  for (const ep of memory.episodic || []) {
    if (ep.createdAt != null) ep.createdAt = toMemoryDate(ep.createdAt);
  }
  for (const log of memory.logs || []) {
    if (log.ts != null) log.ts = toMemoryDate(log.ts);
  }
  return memory;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function inferCategory(key, value) {
  const k = (key || '').toLowerCase();
  if (/favorite|love|hate|like|dislike|prefer/.test(k)) return 'preference';
  if (/friend|family|mom|dad|brother|sister|partner|girlfriend|boyfriend|wife|husband/.test(k)) return 'relationship';
  if (/think|believe|opinion|feel about/.test(k)) return 'opinion';
  if (/hobby|interest|into|watch|play|listen/.test(k)) return 'interest';
  if (/always|usually|every|routine|habit/.test(k)) return 'habit';
  return 'fact';
}

function createEmptyMemory() {
  return {
    version: SCHEMA_VERSION,
    identity: {},
    semantic: [],
    episodic: [],
    logs: [],
    meta: {
      createdAt: memoryNow(),
      lastSessionAt: null,
      previousSessionAt: null,
      totalSessions: 0,
      consolidatedAt: null,
      currentSessionId: null
    }
  };
}

function migrateV1toV2(oldMemory) {
  const mem = createEmptyMemory();
  const lt = oldMemory.longTerm || {};
  const logs = oldMemory.logs || [];

  for (const [key, value] of Object.entries(lt)) {
    if (IDENTITY_KEYS.has(key.toLowerCase())) {
      mem.identity[key] = value;
    } else {
      mem.semantic.push({
        id: generateId(),
        category: inferCategory(key, value),
        subject: key,
        value: String(value),
        confidence: 0.8,
        source: 'migrated',
        createdAt: memoryNow(),
        updatedAt: memoryNow(),
        accessCount: 1,
        lastAccessedAt: memoryNow()
      });
    }
  }

  for (const log of logs) {
    mem.logs.push({
      id: generateId(),
      subject: log.subject || '',
      value: log.value || '',
      ts: toMemoryDate(log.ts) || memoryNow(),
      importance: 0.5,
      sessionId: null
    });
  }

  mem.meta.totalSessions = 1;
  return mem;
}

export function normalizeMemory(memory) {
  if (!memory) return createEmptyMemory();
  
  if (!memory.version || memory.version < SCHEMA_VERSION) {
    if (memory.longTerm || memory.logs) {
      return migrateMemoryDates(migrateV1toV2(memory));
    }
    return createEmptyMemory();
  }

  if (!memory.identity) memory.identity = {};
  if (!Array.isArray(memory.semantic)) memory.semantic = [];
  if (!Array.isArray(memory.episodic)) memory.episodic = [];
  if (!Array.isArray(memory.logs)) memory.logs = [];
  if (!memory.meta) {
    memory.meta = {
      createdAt: memoryNow(),
      lastSessionAt: null,
      previousSessionAt: null,
      totalSessions: 0,
      consolidatedAt: null,
      currentSessionId: null
    };
  }
  return migrateMemoryDates(memory);
}

function trimMemory(memory) {
  if (memory.logs.length > MAX_LOGS) {
    memory.logs = memory.logs
      .sort((a, b) => (b.importance || 0.5) - (a.importance || 0.5) || memoryTimeMs(b.ts) - memoryTimeMs(a.ts))
      .slice(0, MAX_LOGS);
  }
  if (memory.episodic.length > MAX_EPISODIC) {
    memory.episodic = memory.episodic
      .sort((a, b) => memoryTimeMs(b.createdAt) - memoryTimeMs(a.createdAt))
      .slice(0, MAX_EPISODIC);
  }
  if (memory.semantic.length > MAX_SEMANTIC) {
    memory.semantic = memory.semantic
      .sort((a, b) => {
        const scoreA = (a.accessCount || 0) * 0.3 + (a.confidence || 0.5) * 0.7;
        const scoreB = (b.accessCount || 0) * 0.3 + (b.confidence || 0.5) * 0.7;
        return scoreB - scoreA;
      })
      .slice(0, MAX_SEMANTIC);
  }
  return memory;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function computeFreshnessScore(timestamp, halfLifeMs) {
  if (!timestamp) return 0.5;
  const age = Date.now() - memoryTimeMs(timestamp);
  return Math.pow(0.5, age / halfLifeMs);
}

function computeKeywordRelevance(query, entry) {
  if (!query || !entry) return 0;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (queryTerms.length === 0) return 0.3;

  const subject = (entry.subject || '').toLowerCase();
  const value = (entry.value || entry.summary || '').toLowerCase();
  const entryText = `${subject} ${value}`;

  let matches = 0;
  for (const term of queryTerms) {
    if (entryText.includes(term)) matches++;
  }

  return queryTerms.length > 0 ? matches / queryTerms.length : 0;
}

function normalizeAccessCount(accessCount, maxAccess = 50) {
  return Math.min((accessCount || 0) / maxAccess, 1);
}

export function scoreMemoryEntry(entry, query, type = 'semantic') {
  const halfLife = type === 'log' ? LOG_FRESHNESS_HALF_LIFE_MS : SEMANTIC_FRESHNESS_HALF_LIFE_MS;
  const timestamp = entry.updatedAt || entry.lastAccessedAt || entry.ts || entry.createdAt;

  const keywordScore = computeKeywordRelevance(query, entry);
  const freshnessScore = computeFreshnessScore(timestamp, halfLife);
  const importanceScore = entry.importance || entry.confidence || 0.5;
  const accessScore = normalizeAccessCount(entry.accessCount);

  const composite =
    SCORE_WEIGHTS.keywordRelevance * keywordScore +
    SCORE_WEIGHTS.freshness * freshnessScore +
    SCORE_WEIGHTS.importance * importanceScore +
    SCORE_WEIGHTS.accessFrequency * accessScore;

  return {
    ...entry,
    _score: composite,
    _keywordScore: keywordScore,
    _freshnessScore: freshnessScore,
    _type: type
  };
}

export function retrieveRelevantMemories(memory, query, tokenBudget = null) {
  tokenBudget = tokenBudget ?? config.memoryTokenBudget ?? 600;
  memory = normalizeMemory(memory);
  const retrieved = { identity: {}, semantic: [], episodic: [], logs: [], accessedIds: [] };
  let usedTokens = 0;

  const identityTokens = estimateTokens(JSON.stringify(memory.identity));
  if (identityTokens < tokenBudget * 0.2) {
    retrieved.identity = { ...memory.identity };
    usedTokens += identityTokens;
  }

  const scoredSemantic = memory.semantic.map(s => scoreMemoryEntry(s, query, 'semantic'));
  const scoredEpisodic = memory.episodic.map(e => scoreMemoryEntry(e, query, 'episodic'));
  const scoredLogs = memory.logs.slice(-30).map(l => scoreMemoryEntry(l, query, 'log'));

  const allScored = [...scoredSemantic, ...scoredEpisodic, ...scoredLogs]
    .sort((a, b) => b._score - a._score);

  const semanticBudget = tokenBudget * 0.5;
  const episodicBudget = tokenBudget * 0.15;
  const logsBudget = tokenBudget * 0.15;

  let semanticUsed = 0, episodicUsed = 0, logsUsed = 0;

  for (const entry of allScored) {
    const entryText = entry.summary || `${entry.subject}: ${entry.value}`;
    const entryTokens = estimateTokens(entryText);

    if (entry._type === 'semantic' && semanticUsed + entryTokens <= semanticBudget) {
      retrieved.semantic.push(entry);
      retrieved.accessedIds.push(entry.id);
      semanticUsed += entryTokens;
    } else if (entry._type === 'episodic' && episodicUsed + entryTokens <= episodicBudget) {
      retrieved.episodic.push(entry);
      episodicUsed += entryTokens;
    } else if (entry._type === 'log' && logsUsed + entryTokens <= logsBudget) {
      retrieved.logs.push(entry);
      logsUsed += entryTokens;
    }

    if (semanticUsed >= semanticBudget && episodicUsed >= episodicBudget && logsUsed >= logsBudget) {
      break;
    }
  }

  return retrieved;
}

export function buildMemoryInstructions(memory, context, query = '') {
  const lines = [];
  const now = new Date();
  const retrieved = retrieveRelevantMemories(memory, query);

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const hour = now.getHours();
  let timeOfDay = 'morning';
  if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
  else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
  else if (hour >= 21 || hour < 5) timeOfDay = 'night';

  lines.push('--- CONTEXT ---');
  lines.push(`Date: ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`);
  lines.push(`Time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`);
  lines.push(`Time of day: ${timeOfDay}`);
  if (context?.timezone) lines.push(`Timezone: ${context.timezone}`);
  if (context?.location) lines.push(`Location: ${context.location}`);

  const identity = retrieved.identity;
  if (!identity.name) {
    lines.push('');
    lines.push('--- NAME UNKNOWN (TOP PRIORITY) ---');
    lines.push('You do NOT know the user\'s name yet. Getting it is your #1 priority.');
    lines.push('Work their name into conversation naturally on most turns until you learn it.');
    lines.push('Ask casually — "wait, what do I even call you?" or "I don\'t think I caught your name" — vary it, don\'t repeat the same line.');
    lines.push('If they dodge or ignore it, keep circling back in later turns. Be persistent but not robotic.');
  }

  if (Object.keys(identity).length > 0) {
    lines.push('');
    lines.push('--- IDENTITY (core facts about the user) ---');
    if (identity.name) lines.push(`Name: ${identity.name} — greet them by name sometimes when natural.`);
    for (const [key, value] of Object.entries(identity)) {
      if (key === 'name') continue;
      lines.push(`- ${key}: ${value}`);
    }
  }

  if (retrieved.semantic.length > 0) {
    lines.push('');
    lines.push('--- RELEVANT MEMORIES (things you know — use sparingly) ---');
    const byCategory = {};
    for (const sem of retrieved.semantic) {
      const cat = sem.category || 'fact';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(sem);
    }
    for (const [cat, entries] of Object.entries(byCategory)) {
      lines.push(`[${cat}]`);
      for (const e of entries.slice(0, 5)) {
        lines.push(`- ${e.subject}: ${e.value}`);
      }
    }
  }

  if (retrieved.episodic.length > 0) {
    lines.push('');
    lines.push('--- RECENT SESSIONS (compressed history) ---');
    for (const ep of retrieved.episodic.slice(0, 2)) {
      const date = new Date(ep.createdAt).toLocaleDateString();
      lines.push(`[${date}] ${ep.summary}`);
      if (ep.topics?.length) lines.push(`  Topics: ${ep.topics.join(', ')}`);
    }
  }

  if (retrieved.logs.length > 0) {
    lines.push('');
    lines.push('--- RECENT OBSERVATIONS (may fade) ---');
    for (const log of retrieved.logs.slice(0, 8)) {
      lines.push(`- ${log.subject}: ${log.value}`);
    }
  }

  return lines.join('\n');
}

const GENERIC_UTTERANCE_RE = /^(fine|good|okay|ok|yeah|yep|mhm|yep|nothing|not much|idk|i don't know|hey|hi|hello|mhmm|nm|cool|sure|thanks|thank you|yo|nah|nope|same|whatever|meh|right|true|exactly|fair enough|pretty much|not really)\.?$/i;

const CLOSURE_UTTERANCE_RE = /^(i guess(\s+(so|not|i just did|i did))?|just did|i just did|kind of|sort of|i dunno|dunno)\.?$/i;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'that', 'this', 'with', 'from', 'they', 'we', 'you', 'your', 'what', 'when', 'where', 'which', 'who',
  'why', 'how', 'all', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very', 'just',
  'don', 'now', 'like', 'even', 'also', 'back', 'after', 'before', 'here', 'there', 'then', 'about',
  'into', 'through', 'during', 'out', 'off', 'over', 'under', 'again', 'know', 'think', 'mean', 'really',
  'actually', 'maybe', 'probably', 'something', 'anything', 'nothing', 'sound', 'sounds', 'rough', 'tough',
  'wow', 'ouch', 'honestly', 'literally', 'though', 'right', 'well', 'still', 'even', 'going', 'feel',
  'feels', 'make', 'made', 'making', 'whole', 'morning', 'early', 'without', 'empty', 'least', 'afterward',
]);

export function isGenericUtterance(text) {
  return GENERIC_UTTERANCE_RE.test((text || '').trim());
}

export function isDryUtterance(text) {
  const t = (text || '').trim();
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
    if (history[i].role !== 'user') continue;
    if (isDryUtterance(history[i].content)) streak++;
    else break;
  }
  return streak;
}

function extractThemeWords(text) {
  return [...new Set(
    String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  )];
}

export function extractRecentAssistantThemes(history = [], limit = 2) {
  const assistantMsgs = history.filter((m) => m.role === 'assistant').slice(-limit);
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
    .filter((m) => m.role === 'assistant')
    .slice(-limit)
    .map((m) => {
      const text = String(m.content || '').trim().toLowerCase();
      // strip leading punctuation/whitespace, grab first 4 meaningful words
      const words = text.replace(/^[\s"'*_]+/, '').split(/[\s,]+/).filter((w) => w.length > 1);
      return words.slice(0, 4).join(' ');
    })
    .filter((o) => o.length > 3);
}

export function extractVerbatimPhrases(text = '', minWords = 4, maxPhrases = 3) {
  const clean = String(text || '').replace(/[^\w\s''-]/g, ' ').trim().toLowerCase();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return [];

  const phrases = [];
  // grab a few anchor phrases: first sentence fragment, mid, any notable runs
  for (let i = 0; i <= words.length - minWords && phrases.length < maxPhrases; i += Math.floor(words.length / (maxPhrases + 1)) || 1) {
    phrases.push(words.slice(i, i + minWords).join(' '));
  }
  return phrases;
}

const OPINION_REQUEST_RE = /\bwhat (do|did|would) you (think|say|do|reckon)\b|\byour (take|thoughts?|opinion|view)\b|\bdo you (think|agree|believe)\b|\byou tell me\b|\bwhat('s| is) your\b/i;

export function isUserAskingForOpinion(userText = '') {
  return OPINION_REQUEST_RE.test(userText || '');
}

function matchesTopic(text, value) {
  if (!text || !value) return false;
  const t = String(text).toLowerCase();
  const v = String(value).toLowerCase();
  if (v.length < 3) return false;
  return t.includes(v) || v.includes(t);
}

export function pickRotatedInterest(memory, recentCallbacks = []) {
  const semantic = memory?.semantic || [];
  const interests = semantic.filter(s => 
    s.category === 'interest' || s.category === 'preference'
  );
  
  if (interests.length === 0) return null;
  if (recentCallbacks.length === 0) return interests[0];

  const used = new Set(recentCallbacks.map(v => String(v).toLowerCase()));
  const fresh = interests.find(s => !used.has(String(s.value).toLowerCase()));
  if (fresh) return fresh;

  return interests[recentCallbacks.length % interests.length] || interests[0];
}

export function detectMemoryCallbacks(text, memory) {
  const hits = [];
  const spoken = String(text || '').toLowerCase();
  if (!spoken) return hits;

  memory = normalizeMemory(memory);
  
  const identity = memory.identity || {};
  for (const [key, value] of Object.entries(identity)) {
    if (key === 'name') continue;
    if (matchesTopic(spoken, value)) hits.push({ key, value: String(value) });
  }

  for (const sem of memory.semantic.slice(-20)) {
    if (matchesTopic(spoken, sem.value)) {
      hits.push({ key: sem.subject, value: String(sem.value) });
    }
  }

  for (const log of memory.logs.slice(-15)) {
    if (matchesTopic(spoken, log.value)) {
      hits.push({ key: log.subject, value: String(log.value) });
    }
  }

  return hits;
}

export function buildConversationRhythm(userText = "", history = [], recentCallbacks = [], { hooksEngaged = false, suggestedHooks = [], dryReplyStreak = 0 } = {}) {
  const lines = [];
  lines.push('--- THIS TURN (phone call rhythm) ---');
  lines.push('Sound like a friend on a call — not an interviewer. Lead with reaction or a specific thought, not a recap.');
  lines.push('Never open by restating what they just said. Jump straight to YOUR reaction, opinion, or tangent.');

  const assistantTurns = history.filter((m) => m.role === 'assistant').slice(-2);
  const lastAssistant = assistantTurns[assistantTurns.length - 1];
  const prevAssistant = assistantTurns.length >= 2 ? assistantTurns[0] : null;
  const askedLastTurn = lastAssistant?.content?.includes('?');
  const askedPrevTurn = prevAssistant?.content?.includes('?');
  const dryStreak = dryReplyStreak || countDryReplyStreak(history, userText);
  const exploredThemes = extractRecentAssistantThemes(history, 2);

  // ── Anti-repetition: banned openers ─────────────────────────────────
  const recentOpeners = extractRecentOpeners(history, 3);
  if (recentOpeners.length > 0) {
    lines.push(`BANNED openers this turn (you already used these recently — hard ban, pick something different): ${recentOpeners.map(o => `"${o}"`).join(' / ')}`);
  }

  // ── Anti-echo: ban verbatim phrase fragments from last reply ─────────
  if (lastAssistant?.content) {
    const preview = lastAssistant.content.slice(0, 140).replace(/\s+/g, ' ');
    const echoPhrases = extractVerbatimPhrases(lastAssistant.content, 4, 3);
    lines.push(`Your last line: "${preview}${lastAssistant.content.length > 140 ? '...' : ''}" — do NOT repeat this angle or rephrase it back to them.`);
    if (echoPhrases.length > 0) {
      lines.push(`Hard-banned phrases (verbatim from last reply — do NOT reuse): ${echoPhrases.map(p => `"${p}"`).join(' / ')}`);
    }
  }

  // ── Sentence structure variety ───────────────────────────────────────
  if (prevAssistant?.content && lastAssistant?.content) {
    const prevOpener = extractRecentOpeners([prevAssistant], 1)[0] || '';
    const lastOpener = extractRecentOpeners([lastAssistant], 1)[0] || '';
    if (prevOpener && lastOpener && prevOpener.split(' ')[0] === lastOpener.split(' ')[0]) {
      lines.push(`Sentence structure: your last two replies both started with "${lastOpener.split(' ')[0]}" — open this turn with a completely different structure (statement, name, reaction sound, mid-thought, or cut right in).`);
    }
  }

  if (exploredThemes.length > 0 && !hooksEngaged) {
    lines.push(`Already explored — new beat required, no questions about: ${exploredThemes.join(', ')}`);
  }

  // ── Opinion pushback ─────────────────────────────────────────────────
  if (isUserAskingForOpinion(userText)) {
    lines.push('User is asking for YOUR opinion — give one. Do NOT deflect back with "what do you think?" or "what about you?". Take a real side, even if messy. You can disagree, be unsure, or give a hot take — but commit to something.');
  }

  if (hooksEngaged) {
    lines.push(`Topic hooks loaded — name-drop one: ${suggestedHooks.join(' · ')}. Use hooks often on this topic; end questions with a specific hook, not generic follow-ups.`);
    if (askedLastTurn && askedPrevTurn) {
      lines.push('Two questions in a row already — react-only this turn, but still weave in a hook by name if you can.');
    } else if (askedLastTurn) {
      lines.push('You asked last turn — only ask again if it names a FRESH topic hook. Otherwise react with a hook baked in.');
    } else {
      lines.push('Strong preference this turn: end with ONE sharp question tied to a topic hook.');
    }
  } else if (askedLastTurn && askedPrevTurn) {
    lines.push('Your last TWO replies both asked questions — this turn must NOT end with a question. React-only, hot take, tease, or tangent.');
  } else if (askedLastTurn) {
    lines.push('You asked a question last turn — prefer a reaction, opinion, tangent, or statement this turn. Skip the follow-up question.');
  } else {
    lines.push('Mix it up — react-only is fine, or share a parallel thought, or ask ONE specific question if you actually need to.');
  }

  if (isDryUtterance(userText)) {
    if (dryStreak >= 3) {
      lines.push('Dry streak — they are not biting. Pivot hard: share YOUR thought, tease lightly, drift to something new, or offer to ramble. NO questions about the current thread.');
    } else if (dryStreak >= 2) {
      lines.push('Second short reply in a row — thread is closed. React-only or share something of yours. Do NOT ask another question.');
    } else if (askedLastTurn) {
      lines.push('Minimal answer to your question — that thread is done. Do not re-ask in new words. React-only, tease, or pivot.');
    } else {
      lines.push('Short/generic user reply — match energy, tease, share YOUR thought, OR use a memory detail you have NOT used yet this session. Memory is optional.');
    }
  }

  lines.push('Add something NEW this turn — opinion, comparison, tangent, or tease. Validation alone plus another question = robotic.');
  lines.push('One "wow/rough/tough" per topic max — saying it twice on the same thread sounds scripted.');

  if (recentCallbacks.length > 0) {
    lines.push(`Already brought up this session — do NOT repeat unless user mentions it first: ${recentCallbacks.join(', ')}`);
  }

  return lines.join('\n');
}



export function buildMemoryEngagement(memory, { userText = "", history = [], recentCallbacks = [] } = {}) {
  memory = normalizeMemory(memory);
  const semantic = memory.semantic || [];
  const logs = memory.logs || [];

  // Tier semantic memories by callbackWeight
  const withWeight = semantic.map(s => ({
    ...s,
    _cw: typeof s.callbackWeight === "number" ? s.callbackWeight : defaultCallbackWeight(s.category, s.confidence || 0.5, false, s.subject, s.value)
  }));

  // HIGH: callbackWeight >= 0.65 — core personality anchors (artists, sports they follow, major life things)
  const highTier = withWeight.filter(s => s._cw >= 0.65).sort((a, b) => b._cw - a._cw).slice(0, 5);
  // MED: 0.3–0.64 — solid interests, mentioned a few times (a show, a hobby)
  const medTier = withWeight.filter(s => s._cw >= 0.3 && s._cw < 0.65).sort((a, b) => b._cw - a._cw).slice(0, 6);
  // LOW: < 0.3 — passing mentions, one-off stuff (lemonade, had waffles)
  // LOW tier is omitted from the prompt entirely — store for context but main AI should not bring up

  if (highTier.length === 0 && medTier.length === 0 && logs.length === 0) return '';

  const lines = [];
  lines.push('--- MEMORY ENGAGEMENT (remember them — but don\'t fixate) ---');
  lines.push('Memory is seasoning, not the whole meal. ONE detail every few turns max — not every reply.');
  lines.push('Follow their current topic. Never redirect back to old topics they\'re not talking about.');
  lines.push('Jump straight into reaction or substance. No "oh gotcha", "oh sorry", "what\'s on your mind?" preamble.');

  if (recentCallbacks.length > 0) {
    lines.push('');
    lines.push(`SESSION RULE — already brought up (DO NOT repeat): ${recentCallbacks.join(', ')}`);
    lines.push('Pick something different, or skip memory entirely this turn.');
  }

  const cleanUser = (userText || '').trim();
  if (cleanUser && isDryUtterance(cleanUser)) {
    lines.push('');
    lines.push('Short/generic reply — match energy or tease. Memory callback optional, not required.');
  }

  if (highTier.length > 0) {
    lines.push('');
    lines.push('CORE personality anchors (reference occasionally — once per session is enough):');
    for (const s of highTier) {
      const used = recentCallbacks.some(v => matchesTopic(v, s.value));
      lines.push(`- ${s.subject}: ${s.value}${used ? '  ← already used this session, skip' : ''}`);
    }
  }

  if (medTier.length > 0) {
    lines.push('');
    lines.push('Softer interests (mention at most once per session, only if very natural):');
    for (const s of medTier) {
      const used = recentCallbacks.some(v => matchesTopic(v, s.value));
      lines.push(`- ${s.subject}: ${s.value}${used ? '  ← already used, skip' : ''}`);
    }
  }

  // Show recent logs only for context, tagged clearly
  const recentLogs = logs.slice(-6).filter(l => l.importance > 0.4);
  if (recentLogs.length > 0) {
    lines.push('');
    lines.push('Recent context (background only — do NOT bring up proactively):');
    for (const log of recentLogs) {
      lines.push(`- ${log.subject}: ${log.value}`);
    }
  }

  lines.push('');
  lines.push('Rule: if something only got one passing mention from them, don\'t ask about it again — wait for them to bring it up.');

  return lines.join('\n');
}

export function buildMemoryThoughtCache(memory, { recentCallbacks = [] } = {}) {
  memory = normalizeMemory(memory);
  const semantic = memory.semantic || [];
  const logs = memory.logs || [];
  // Only surface interests/preferences with callbackWeight >= 0.3 to the thought agent
  const interests = semantic.filter(s => {
    if (s.category !== 'interest' && s.category !== 'preference') return false;
    const cw = typeof s.callbackWeight === "number" ? s.callbackWeight : defaultCallbackWeight(s.category, s.confidence || 0.5, false, s.subject, s.value);
    return cw >= 0.3;
  });

  if (interests.length === 0 && logs.length === 0) return null;

  const pick = pickRotatedInterest(memory, recentCallbacks);
  const associations = interests.slice(0, 4).map(s => s.value);

  let memoryBridge = null;
  if (pick && !recentCallbacks.some(v => matchesTopic(v, pick.value))) {
    memoryBridge = `Optional callback if natural — their ${pick.subject} is ${pick.value}. Only if you haven't brought it up yet.`;
  } else if (logs.length > 0) {
    const log = [...logs].reverse().find(l => !recentCallbacks.some(v => matchesTopic(v, l.value)));
    if (log) {
      memoryBridge = `Optional — they mentioned ${log.subject}: ${log.value}. Only if fresh, not repeated.`;
    }
  }

  const casualDrops = [];
  if (pick && !recentCallbacks.some(v => matchesTopic(v, pick.value))) {
    if (/show|movie|series|game|sport|team|book|music|band/i.test(pick.subject)) {
      casualDrops.push(`wait-- you still into ${pick.value}?`);
    }
  }

  const avoid = [
    'don\'t list facts interview-style',
    'don\'t force memory if they clearly changed topic',
    'don\'t repeat a callback you already used this session',
    'one show/video is not their whole personality',
  ];
  if (recentCallbacks.length > 0) {
    avoid.push(`already discussed: ${recentCallbacks.join(', ')} — skip these`);
  }

  return {
    topic: pick ? pick.subject : 'catching up',
    topicKey: 'memory-anchor',
    confidence: recentCallbacks.length >= 2 ? 0.3 : 0.5,
    associations,
    casualDrops: casualDrops.slice(0, 1),
    memoryBridge,
    juneSelfDrop: null,
    personification: {
      pretendExperienced: pick ? /show|movie|series|book|game/i.test(pick.subject) : false,
      ifAskedHow: 'I watched it really quick-- like two seconds flat',
    },
    avoid,
    reasoning: 'sync memory anchor (rotated)',
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
      ...(onDryStreak ? ['interview questions on the current thread', 're-asking what they already answered vaguely'] : []),
    ],
  };
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

export function mergeCleanDelta(gen, delta) {
  gen.rawBuffer = (gen.rawBuffer || '') + delta;

  const raw = gen.rawBuffer;
  let clean = '';
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === '(' && i + 2 < raw.length && raw[i + 1] === '*' && raw[i + 2] === '*') {
      let depth = 1;
      let j = i + 3;
      while (j < raw.length) {
        if (raw[j] === '(') depth++;
        else if (raw[j] === ')') {
          depth--;
          if (depth === 0) { j++; break; }
        }
        j++;
      }
      if (depth > 0) break;
      i = j;
      continue;
    }
    if (raw[i] === '{' && i + 1 < raw.length && raw[i + 1] === '-') {
      let j = i + 2;
      let found = false;
      while (j < raw.length) {
        if (raw[j] === '}' && raw[j - 1] === '-') {
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
        parseInner(text.slice(i + 3, j - 1), calls);
        i = j;
        continue;
      }
    }
    i++;
  }
  return calls;
}

function parseInner(inner, calls) {
  const callRe = /(setName|remember|clearMemory)\(([^)]*)\)/g;
  let cm;
  while ((cm = callRe.exec(inner)) !== null) {
    calls.push({ fn: cm[1], arg: cm[2].trim() });
  }
}

const TRANSIENT_RE = /\b(today|yesterday|right now|just now|just|tonight|this morning|earlier|currently)\b/i;

// Patterns that signal high-value conversation hooks (sports, music, media, hobbies)
const HIGH_HOOK_RE = /\b(nba|nfl|nhl|mlb|soccer|football|basketball|baseball|hockey|tennis|mma|ufc|sport|team|game|match|series|season|playoffs|draft|league|tournament|player|coach|athlete|gym|workout|training|running|yoga|hiking|climbing|cycling|swimming)\b/i;
const MED_HOOK_RE = /\b(show|movie|film|anime|series|watch|episode|season|netflix|hulu|streaming|book|novel|read|listen|music|song|album|artist|band|concert|podcast|playlist|genre|rapper|singer|actor|director)\b/i;
const LOW_HOOK_RE = /\b(ate|drink|drinking|drank|had|tried|eating|food|coffee|tea|juice|meal|snack|lunch|dinner|breakfast|restaurant|grocery|shopping|errands|weather|traffic|tired|sleep|slept|nap)\b/i;

/**
 * Default callbackWeight when the memory AI doesn't supply one.
 * Higher for sports/artists/media/hobbies, lower for trivial one-offs.
 */
function defaultCallbackWeight(category, importance, isTransient, subject = "", value = "") {
  if (isTransient) return 0.05;

  const text = `${subject} ${value}`.toLowerCase();

  // Trivial consumption/state — never bring up
  if (LOW_HOOK_RE.test(text) && category !== 'habit') return 0.06;

  // Sports, working out, teams — great conversation anchors
  if (HIGH_HOOK_RE.test(text)) return Math.min(0.5 + importance * 0.4, 0.85);

  // Shows, music, artists, media — solid hooks
  if (MED_HOOK_RE.test(text)) return Math.min(0.35 + importance * 0.35, 0.72);

  // Category-based fallback
  if (category === 'relationship') return 0.6;
  if (category === 'habit') return 0.5;
  if (category === 'interest') return Math.min(importance * 0.7, 0.65);
  if (category === 'preference') return Math.min(importance * 0.5, 0.5);
  if (category === 'opinion') return Math.min(importance * 0.4, 0.4);
  return Math.min(importance * 0.3, 0.3); // fact — mostly background
}

function alreadyExists(memory, subject, value) {
  const subjectLower = (subject || '').toLowerCase();
  const valueLower = (value || '').toLowerCase();
  
  for (const sem of memory.semantic) {
    if (sem.subject.toLowerCase() === subjectLower && sem.value.toLowerCase() === valueLower) {
      return true;
    }
  }
  
  for (const log of memory.logs.slice(-30)) {
    if (log.subject === subject && log.value === value) {
      return true;
    }
  }
  
  return false;
}

export function applyMemoryCalls(memory, calls) {
  memory = normalizeMemory(memory);

  for (const { fn, arg } of calls) {
    switch (fn) {
      case "setName":
        if (arg) {
          memory.identity.name = arg;
          if (!alreadyExists(memory, "name", arg)) {
            memory.logs.push({
              id: generateId(),
              subject: "name",
              value: arg,
              ts: memoryNow(),
              importance: 1.0,
              sessionId: memory.meta?.currentSessionId || null
            });
          }
        }
        break;

      case "remember": {
        const idx = arg.indexOf(":");
        if (idx === -1) break;
        const subject = arg.slice(0, idx).trim();
        const value = arg.slice(idx + 1).trim();
        if (!subject || !value || alreadyExists(memory, subject, value)) break;

        const isTransient = TRANSIENT_RE.test(value) || TRANSIENT_RE.test(subject);
        const category = inferCategory(subject, value);
        const importance = IDENTITY_KEYS.has(subject.toLowerCase()) ? 1.0 : 
                          isTransient ? 0.3 : 0.7;

        memory.logs.push({
          id: generateId(),
          subject,
          value,
          ts: memoryNow(),
          importance,
          sessionId: memory.meta?.currentSessionId || null
        });

        if (!isTransient) {
          const existing = memory.semantic.find(
            s => s.subject.toLowerCase() === subject.toLowerCase()
          );
          if (existing) {
            existing.value = value;
            existing.updatedAt = memoryNow();
            existing.accessCount = (existing.accessCount || 0) + 1;
          } else {
            memory.semantic.push({
              id: generateId(),
              category,
              subject,
              value,
              confidence: 0.8,
              source: 'explicit',
              createdAt: memoryNow(),
              updatedAt: memoryNow(),
              accessCount: 1,
              lastAccessedAt: memoryNow()
            });
          }
        }

        if (IDENTITY_KEYS.has(subject.toLowerCase())) {
          memory.identity[subject] = value;
        }

        break;
      }

      case "clearMemory":
        memory = createEmptyMemory();
        break;
    }
  }
  
  return trimMemory(memory);
}

export function applyMemoryUpdates(memory, { setName, updates, corrections } = {}) {
  memory = normalizeMemory(memory);

  for (const c of corrections || []) {
    const subject = (c.subject || "").trim();
    const newValue = (c.newValue || "").trim();
    if (!subject || !newValue) continue;

    if (IDENTITY_KEYS.has(subject.toLowerCase())) {
      memory.identity[subject] = newValue;
    }

    const existing = memory.semantic.find(
      s => s.subject.toLowerCase() === subject.toLowerCase()
    );
    if (existing) {
      existing.value = newValue;
      existing.updatedAt = memoryNow();
      existing.confidence = Math.min((existing.confidence || 0.5) + 0.1, 1.0);
    } else {
      memory.semantic.push({
        id: generateId(),
        category: inferCategory(subject, newValue),
        subject,
        value: newValue,
        confidence: 0.9,
        source: 'correction',
        createdAt: memoryNow(),
        updatedAt: memoryNow(),
        accessCount: 1,
        lastAccessedAt: memoryNow()
      });
    }

    if (!alreadyExists(memory, subject, newValue)) {
      memory.logs.push({
        id: generateId(),
        subject,
        value: newValue,
        ts: memoryNow(),
        importance: 0.8,
        sessionId: memory.meta?.currentSessionId || null
      });
    }
  }

  if (setName) {
    memory.identity.name = setName;
    if (!alreadyExists(memory, "name", setName)) {
      memory.logs.push({
        id: generateId(),
        subject: "name",
        value: setName,
        ts: memoryNow(),
        importance: 1.0,
        sessionId: memory.meta?.currentSessionId || null
      });
    }
  }

  for (const u of updates || []) {
    const subject = (u.subject || "").trim();
    const value = (u.value || "").trim();
    if (!subject || !value || alreadyExists(memory, subject, value)) continue;

    const isTransient = TRANSIENT_RE.test(value) || TRANSIENT_RE.test(subject);
    const category = u.category || inferCategory(subject, value);
    const importance = u.importance || (isTransient ? 0.3 : 0.6);
    const source = u.source || 'inferred';
    const promoteToSemantic = u.longTerm === true || 
                              IDENTITY_KEYS.has(subject.toLowerCase()) ||
                              (!isTransient && importance >= 0.5);

    memory.logs.push({
      id: generateId(),
      subject,
      value,
      ts: memoryNow(),
      importance,
      sessionId: memory.meta?.currentSessionId || null
    });

    if (promoteToSemantic) {
      const callbackWeight = typeof u.callbackWeight === "number"
        ? Math.max(0, Math.min(1, u.callbackWeight))
        : defaultCallbackWeight(category, importance, isTransient, subject, value);

      const existing = memory.semantic.find(
        s => s.subject.toLowerCase() === subject.toLowerCase()
      );
      if (existing) {
        existing.value = value;
        existing.updatedAt = memoryNow();
        existing.category = category;
        existing.confidence = Math.max(existing.confidence || 0.5, u.confidence || 0.7);
        // Only update callbackWeight if the new value is explicitly set (don't overwrite a high weight with a default)
        if (typeof u.callbackWeight === "number") {
          existing.callbackWeight = callbackWeight;
        } else if (existing.callbackWeight == null) {
          existing.callbackWeight = callbackWeight;
        }
      } else {
        memory.semantic.push({
          id: generateId(),
          category,
          subject,
          value,
          confidence: u.confidence || 0.7,
          callbackWeight,
          source,
          createdAt: memoryNow(),
          updatedAt: memoryNow(),
          accessCount: 1,
          lastAccessedAt: memoryNow()
        });
      }
    }

    if (IDENTITY_KEYS.has(subject.toLowerCase())) {
      memory.identity[subject] = value;
    }
  }

  return trimMemory(memory);
}

export function consolidateSession(memory, sessionSummary = null) {
  memory = normalizeMemory(memory);
  const sessionId = memory.meta?.currentSessionId;
  
  if (!sessionId) return memory;

  const sessionLogs = memory.logs.filter(l => l.sessionId === sessionId);
  if (sessionLogs.length === 0) return memory;

  if (sessionSummary) {
    memory.episodic.unshift({
      id: generateId(),
      summary: sessionSummary.summary || 'Conversation session',
      topics: sessionSummary.topics || [],
      mood: sessionSummary.mood || 'neutral',
      createdAt: memoryNow(),
      turnCount: sessionSummary.turnCount || sessionLogs.length
    });
  }

  const highImportanceLogs = sessionLogs.filter(l => (l.importance || 0) >= 0.7);
  for (const log of highImportanceLogs) {
    const exists = memory.semantic.some(
      s => s.subject.toLowerCase() === log.subject.toLowerCase() && 
           s.value.toLowerCase() === log.value.toLowerCase()
    );
    if (!exists && !TRANSIENT_RE.test(log.value)) {
      memory.semantic.push({
        id: generateId(),
        category: inferCategory(log.subject, log.value),
        subject: log.subject,
        value: log.value,
        confidence: log.importance || 0.7,
        source: 'promoted',
        createdAt: log.ts || memoryNow(),
        updatedAt: memoryNow(),
        accessCount: 1,
        lastAccessedAt: memoryNow()
      });
    }
  }

  memory.meta.consolidatedAt = memoryNow();
  return trimMemory(memory);
}

export function markAccessedEntries(memory, ids) {
  memory = normalizeMemory(memory);
  const now = memoryNow();
  for (const sem of memory.semantic) {
    if (ids.includes(sem.id)) {
      sem.accessCount = (sem.accessCount || 0) + 1;
      sem.lastAccessedAt = now;
    }
  }
  return memory;
}

export function startNewSession(memory) {
  memory = normalizeMemory(memory);
  if (memory.meta.lastSessionAt && (memory.meta.totalSessions || 0) > 0) {
    memory.meta.previousSessionAt = memory.meta.lastSessionAt;
  }
  memory.meta.currentSessionId = generateId();
  memory.meta.lastSessionAt = memoryNow();
  memory.meta.totalSessions = (memory.meta.totalSessions || 0) + 1;
  return memory;
}

export { 
  SCHEMA_VERSION, 
  IDENTITY_KEYS, 
  MAX_LOGS, 
  MAX_EPISODIC, 
  MAX_SEMANTIC,
  generateId,
  inferCategory,
  createEmptyMemory
};
