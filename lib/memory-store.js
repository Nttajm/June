/** Category-based memory store (schema v3). Pure sync lookups — no I/O. */

export const SCHEMA_VERSION = 3;
export const SYSTEM_ID = "gemma_core_memory";
export const MAX_SUB_MEMORIES_PER_CATEGORY = 60;
export const DEFAULT_RECALL_SCORE = 0.5;

export const DEFAULT_CATEGORIES = Object.freeze({
  general_info: {
    title: "General User Info",
    description:
      "Standing profile + interaction rules: name, language, location, work, speech/humor prefs. Always on for June.",
  },
  interests: {
    title: "Broad Interests",
    description: "General hobbies, skills, and recurring topics.",
  },
  media: {
    title: "Media & Culture",
    description: "Songs, artists, shows, games, books, creators they mention — specific titles welcome.",
  },
  work_life: {
    title: "Work & Daily Life",
    description: "Job, school, projects, routines, and life logistics that are not one-off throwaways.",
  },
  topic_deep_dives: {
    title: "Highly Specific Fixations",
    description: "Dedicated nodes for topics the user is highly invested in. Generated dynamically.",
  },
});

const IDENTITY_KEYS = new Set(["name", "age", "birthday", "location", "hometown", "timezone"]);

const CATEGORY_RECALL_DEFAULTS = Object.freeze({
  general_info: 0.9,
  interests: 0.55,
  media: 0.4,
  work_life: 0.55,
  topic_deep_dives: 0.75,
});

export function memoryNow() {
  return new Date().toISOString();
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

function slugifyCategoryKey(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  return s || "misc";
}

function normalizeTitle(title) {
  return String(title || "").trim().toLowerCase();
}

function contentToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function normalizeRecallScore(value, fallback = DEFAULT_RECALL_SCORE) {
  const base = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_RECALL_SCORE;
  const n = Number(value);
  const score = Number.isFinite(n) ? n : base;
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

function defaultRecallScoreForCategory(categoryKey) {
  return CATEGORY_RECALL_DEFAULTS[categoryKey] ?? DEFAULT_RECALL_SCORE;
}

export function createEmptyMemory() {
  const categories = {};
  for (const [key, meta] of Object.entries(DEFAULT_CATEGORIES)) {
    categories[key] = {
      title: meta.title,
      description: meta.description,
      sub_memories: [],
    };
  }
  return {
    system_id: SYSTEM_ID,
    version: SCHEMA_VERSION,
    last_updated: memoryNow(),
    categories,
    meta: {
      createdAt: memoryNow(),
      lastSessionAt: null,
      previousSessionAt: null,
      totalSessions: 0,
      consolidatedAt: null,
      currentSessionId: null,
    },
  };
}

function migrateV2toV3(old) {
  const mem = createEmptyMemory();
  const identity = old.identity || {};
  if (Object.keys(identity).length > 0) {
    upsertSubMemory(mem, "general_info", {
      title: "Basic Demographics",
      content: { ...identity },
    });
  }

  for (const sem of old.semantic || []) {
    const cat = sem.category === "interest" || sem.category === "preference"
      ? "interests"
      : sem.category === "opinion" || sem.category === "habit"
        ? "topic_deep_dives"
        : IDENTITY_KEYS.has(String(sem.subject || "").toLowerCase())
          ? "general_info"
          : "interests";
    upsertSubMemory(mem, cat, {
      title: sem.subject || "Untitled",
      content: sem.value || "",
      timestamp: toMemoryDate(sem.updatedAt || sem.createdAt) || memoryNow(),
    });
  }

  for (const ep of old.episodic || []) {
    upsertSubMemory(mem, "topic_deep_dives", {
      title: (ep.topics?.[0] || "Past session").slice(0, 80),
      content: {
        focus: ep.summary || "Previous conversation",
        mood: ep.mood || "neutral",
        topics: ep.topics || [],
      },
      timestamp: toMemoryDate(ep.createdAt) || memoryNow(),
    });
  }

  if (old.meta) {
    mem.meta = {
      ...mem.meta,
      createdAt: toMemoryDate(old.meta.createdAt) || mem.meta.createdAt,
      lastSessionAt: toMemoryDate(old.meta.lastSessionAt),
      previousSessionAt: toMemoryDate(old.meta.previousSessionAt),
      totalSessions: old.meta.totalSessions || 0,
      consolidatedAt: toMemoryDate(old.meta.consolidatedAt),
      currentSessionId: old.meta.currentSessionId || null,
    };
  }
  return mem;
}

function migrateV1toV3(old) {
  const mem = createEmptyMemory();
  const lt = old.longTerm || {};
  const demographics = {};
  for (const [key, value] of Object.entries(lt)) {
    if (IDENTITY_KEYS.has(key.toLowerCase())) {
      demographics[key] = value;
    } else {
      upsertSubMemory(mem, "interests", {
        title: key,
        content: String(value),
      });
    }
  }
  if (Object.keys(demographics).length > 0) {
    upsertSubMemory(mem, "general_info", {
      title: "Basic Demographics",
      content: demographics,
    });
  }
  mem.meta.totalSessions = 1;
  return mem;
}

export function normalizeMemory(memory) {
  if (!memory) return createEmptyMemory();

  if (!memory.version || memory.version < SCHEMA_VERSION) {
    if (memory.identity || memory.semantic || memory.episodic || memory.logs) {
      return migrateV2toV3(memory);
    }
    if (memory.longTerm || memory.logs) {
      return migrateV1toV3(memory);
    }
    if (memory.categories && typeof memory.categories === "object") {
      // Partial v3 without version bump
    } else {
      return createEmptyMemory();
    }
  }

  if (!memory.categories || typeof memory.categories !== "object") {
    memory.categories = {};
  }

  for (const [key, meta] of Object.entries(DEFAULT_CATEGORIES)) {
    if (!memory.categories[key]) {
      memory.categories[key] = {
        title: meta.title,
        description: meta.description,
        sub_memories: [],
      };
    } else {
      if (!Array.isArray(memory.categories[key].sub_memories)) {
        memory.categories[key].sub_memories = [];
      }
      if (!memory.categories[key].title) memory.categories[key].title = meta.title;
      if (!memory.categories[key].description) memory.categories[key].description = meta.description;
    }
  }

  for (const [key, cat] of Object.entries(memory.categories)) {
    if (!cat || typeof cat !== "object") continue;
    if (!Array.isArray(cat.sub_memories)) cat.sub_memories = [];
    if (!cat.title) cat.title = key;
    if (!cat.description) cat.description = "";
    for (const sub of cat.sub_memories) {
      sub.recallScore = normalizeRecallScore(
        sub.recallScore,
        defaultRecallScoreForCategory(key),
      );
    }
  }

  if (!memory.meta) {
    memory.meta = {
      createdAt: memoryNow(),
      lastSessionAt: null,
      previousSessionAt: null,
      totalSessions: 0,
      consolidatedAt: null,
      currentSessionId: null,
    };
  }

  memory.system_id = memory.system_id || SYSTEM_ID;
  memory.version = SCHEMA_VERSION;
  memory.last_updated = memory.last_updated || memoryNow();
  return memory;
}

export function ensureCategory(memory, key, { title, description } = {}) {
  memory = normalizeMemory(memory);
  const catKey = slugifyCategoryKey(key);
  if (!memory.categories[catKey]) {
    const defaults = DEFAULT_CATEGORIES[catKey];
    memory.categories[catKey] = {
      title: title || defaults?.title || catKey.replace(/_/g, " "),
      description: description || defaults?.description || "",
      sub_memories: [],
    };
  } else {
    if (title) memory.categories[catKey].title = title;
    if (description) memory.categories[catKey].description = description;
  }
  return catKey;
}

function trimCategory(cat) {
  if (!cat?.sub_memories || cat.sub_memories.length <= MAX_SUB_MEMORIES_PER_CATEGORY) return;
  cat.sub_memories.sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
  cat.sub_memories = cat.sub_memories.slice(0, MAX_SUB_MEMORIES_PER_CATEGORY);
}

export function upsertSubMemory(memory, categoryKey, { title, content, timestamp, id, recallScore } = {}) {
  memory = normalizeMemory(memory);
  const catKey = ensureCategory(memory, categoryKey);
  const cat = memory.categories[catKey];
  const cleanTitle = String(title || "").trim() || "Untitled";
  const existing = cat.sub_memories.find((s) => normalizeTitle(s.title) === normalizeTitle(cleanTitle));

  if (existing) {
    existing.content = content;
    existing.timestamp = timestamp || memoryNow();
    existing.recallScore = normalizeRecallScore(
      recallScore,
      existing.recallScore ?? defaultRecallScoreForCategory(catKey),
    );
    memory.last_updated = memoryNow();
    return existing;
  }

  const entry = {
    id: id || generateId(),
    title: cleanTitle,
    timestamp: timestamp || memoryNow(),
    recallScore: normalizeRecallScore(recallScore, defaultRecallScoreForCategory(catKey)),
    content: content ?? "",
  };
  cat.sub_memories.push(entry);
  trimCategory(cat);
  memory.last_updated = memoryNow();
  return entry;
}

/** Step 1: titles only — never return content. */
export function scanCategory(memory, categoryKey) {
  memory = normalizeMemory(memory);
  const catKey = slugifyCategoryKey(categoryKey);
  const cat = memory.categories[catKey];
  if (!cat) {
    return {
      category: catKey,
      found: false,
      titles: [],
      available_categories: Object.keys(memory.categories),
    };
  }
  const entries = cat.sub_memories
    .map((s) => ({
      title: s.title,
      recallScore: normalizeRecallScore(s.recallScore, defaultRecallScoreForCategory(catKey)),
    }))
    .sort((a, b) => b.recallScore - a.recallScore);
  return {
    category: catKey,
    found: true,
    title: cat.title,
    description: cat.description,
    entries,
    titles: entries.map((s) => s.title),
  };
}

/** Step 2: single sub-memory with content (fuzzy title match). */
export function getSubMemory(memory, categoryKey, title) {
  memory = normalizeMemory(memory);
  const catKey = slugifyCategoryKey(categoryKey);
  const cat = memory.categories[catKey];
  if (!cat) {
    return { found: false, error: `Category "${catKey}" not found`, available_categories: Object.keys(memory.categories) };
  }

  const want = normalizeTitle(title);
  let match = cat.sub_memories.find((s) => normalizeTitle(s.title) === want);
  if (!match) {
    match = cat.sub_memories.find((s) => normalizeTitle(s.title).includes(want) || want.includes(normalizeTitle(s.title)));
  }
  if (!match) {
    return {
      found: false,
      error: `No sub-memory titled "${title}" in ${catKey}`,
      available_titles: cat.sub_memories.map((s) => s.title),
    };
  }
  return {
    found: true,
    category: catKey,
    title: match.title,
    timestamp: match.timestamp,
    recallScore: normalizeRecallScore(match.recallScore, defaultRecallScoreForCategory(catKey)),
    content: match.content,
  };
}

/** Cheap directory for system prompt — no content. */
export function getCategoryDirectory(memory) {
  memory = normalizeMemory(memory);
  return Object.entries(memory.categories).map(([key, cat]) => ({
    key,
    title: cat.title,
    description: cat.description,
    count: (cat.sub_memories || []).length,
  }));
}

/** Flatten general_info for always-on prompt injection. */
export function getGeneralFacts(memory) {
  memory = normalizeMemory(memory);
  const cat = memory.categories.general_info;
  if (!cat?.sub_memories?.length) return [];
  return cat.sub_memories.map((s) => ({
    title: s.title,
    content: s.content,
    recallScore: normalizeRecallScore(s.recallScore, defaultRecallScoreForCategory("general_info")),
  }));
}

export function getUserName(memory) {
  memory = normalizeMemory(memory);
  for (const sub of memory.categories.general_info?.sub_memories || []) {
    const c = sub.content;
    if (c && typeof c === "object" && c.name) return String(c.name);
    if (normalizeTitle(sub.title).includes("name") && typeof c === "string") return c;
  }
  return null;
}

export function applyCategoryUpdates(memory, analysis = {}) {
  memory = normalizeMemory(memory);

  if (analysis.setName) {
    const demos = memory.categories.general_info.sub_memories.find(
      (s) => normalizeTitle(s.title) === "basic demographics"
    );
    if (demos && demos.content && typeof demos.content === "object") {
      demos.content = { ...demos.content, name: analysis.setName };
      demos.timestamp = memoryNow();
    } else {
      upsertSubMemory(memory, "general_info", {
        title: "Basic Demographics",
        content: { name: analysis.setName },
      });
    }
  }

  for (const g of analysis.generalInfo || []) {
    if (!g?.title) continue;
    upsertSubMemory(memory, "general_info", {
      title: g.title,
      content: g.content ?? "",
      recallScore: g.recallScore,
    });
  }

  for (const c of analysis.categorized || []) {
    if (!c?.title || !c?.category) continue;
    const catKey = ensureCategory(memory, c.category, {
      title: c.categoryTitle,
      description: c.categoryDescription,
    });
    if (catKey === "general_info") {
      upsertSubMemory(memory, "general_info", {
        title: c.title,
        content: c.content ?? "",
        recallScore: c.recallScore,
      });
      continue;
    }
    upsertSubMemory(memory, catKey, {
      title: c.title,
      content: c.content ?? "",
      recallScore: c.recallScore,
    });
  }

  for (const corr of analysis.corrections || []) {
    if (!corr?.title || !corr?.category) continue;
    const catKey = ensureCategory(memory, corr.category);
    upsertSubMemory(memory, catKey, {
      title: corr.title,
      content: corr.content ?? "",
      recallScore: corr.recallScore,
    });
  }

  memory.last_updated = memoryNow();
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

export function listSubMemoryTitles(memory, categoryKey) {
  return scanCategory(memory, categoryKey).titles || [];
}

export function flattenInterestHooks(memory, limit = 12) {
  memory = normalizeMemory(memory);
  const out = [];
  for (const [key, cat] of Object.entries(memory.categories || {})) {
    if (key === "general_info" || !cat) continue;
    for (const sub of cat.sub_memories || []) {
      out.push({
        category: key,
        title: sub.title,
        value: contentToString(sub.content).slice(0, 200),
        recallScore: normalizeRecallScore(sub.recallScore, defaultRecallScoreForCategory(key)),
        timestamp: sub.timestamp || "",
      });
    }
  }
  return out
    .sort((a, b) => {
      if (b.recallScore !== a.recallScore) return b.recallScore - a.recallScore;
      return Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0);
    })
    .slice(0, limit);
}

export function memoryStats(memory) {
  memory = normalizeMemory(memory);
  const cats = Object.entries(memory.categories).map(([key, cat]) => ({
    key,
    count: (cat.sub_memories || []).length,
  }));
  return {
    version: memory.version,
    system_id: memory.system_id,
    last_updated: memory.last_updated,
    categories: cats,
    totalSubMemories: cats.reduce((n, c) => n + c.count, 0),
    totalSessions: memory.meta?.totalSessions || 0,
  };
}

export { contentToString, slugifyCategoryKey, normalizeTitle, IDENTITY_KEYS };
