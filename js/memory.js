(function () {
  const STORAGE_KEY = 'june_memory';
  const SCHEMA_VERSION = 3;
  const SYSTEM_ID = 'gemma_core_memory';
  const MAX_SUB = 60;
  const DEFAULT_RECALL_SCORE = 0.5;
  const IDENTITY_KEYS = new Set(['name', 'age', 'birthday', 'location', 'hometown', 'timezone']);

  const DEFAULT_CATEGORIES = {
    general_info: {
      title: 'General User Info',
      description:
        'Standing profile + interaction rules: name, language, location, work, speech/humor prefs. Always on for June.',
    },
    interests: {
      title: 'Broad Interests',
      description: 'General hobbies, skills, and recurring topics.',
    },
    media: {
      title: 'Media & Culture',
      description: 'Songs, artists, shows, games, books, creators they mention — specific titles welcome.',
    },
    work_life: {
      title: 'Work & Daily Life',
      description: 'Job, school, projects, routines, and life logistics that are not one-off throwaways.',
    },
    topic_deep_dives: {
      title: 'Highly Specific Fixations',
      description: 'Dedicated nodes for topics the user is highly invested in.',
    },
  };

  const CATEGORY_RECALL_DEFAULTS = {
    general_info: 0.9,
    interests: 0.55,
    media: 0.4,
    work_life: 0.55,
    topic_deep_dives: 0.75,
  };

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function memoryNow() {
    return new Date().toISOString();
  }

  function normalizeRecallScore(value, fallback = DEFAULT_RECALL_SCORE) {
    const base = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_RECALL_SCORE;
    const n = Number(value);
    const score = Number.isFinite(n) ? n : base;
    return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
  }

  function defaultRecallScoreForCategory(categoryKey) {
    return CATEGORY_RECALL_DEFAULTS[categoryKey] ?? DEFAULT_RECALL_SCORE;
  }

  function slugify(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'misc';
  }

  function createEmptyMemory() {
    const categories = {};
    for (const [key, meta] of Object.entries(DEFAULT_CATEGORIES)) {
      categories[key] = { title: meta.title, description: meta.description, sub_memories: [] };
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

  function upsertSub(memory, catKey, { title, content, timestamp, recallScore }) {
    const key = slugify(catKey);
    if (!memory.categories[key]) {
      const def = DEFAULT_CATEGORIES[key];
      memory.categories[key] = {
        title: def?.title || key.replace(/_/g, ' '),
        description: def?.description || '',
        sub_memories: [],
      };
    }
    const cat = memory.categories[key];
    const want = String(title || '').trim().toLowerCase();
    const existing = cat.sub_memories.find((s) => String(s.title).trim().toLowerCase() === want);
    if (existing) {
      existing.content = content;
      existing.timestamp = timestamp || memoryNow();
      existing.recallScore = normalizeRecallScore(
        recallScore,
        existing.recallScore ?? defaultRecallScoreForCategory(key),
      );
      return existing;
    }
    const entry = {
      id: generateId(),
      title: String(title || 'Untitled').trim(),
      timestamp: timestamp || memoryNow(),
      recallScore: normalizeRecallScore(recallScore, defaultRecallScoreForCategory(key)),
      content: content ?? '',
    };
    cat.sub_memories.push(entry);
    if (cat.sub_memories.length > MAX_SUB) {
      cat.sub_memories.sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
      cat.sub_memories = cat.sub_memories.slice(0, MAX_SUB);
    }
    return entry;
  }

  function migrateV2toV3(old) {
    const mem = createEmptyMemory();
    const identity = old.identity || {};
    if (Object.keys(identity).length) {
      upsertSub(mem, 'general_info', { title: 'Basic Demographics', content: { ...identity } });
    }
    for (const sem of old.semantic || []) {
      const cat = sem.category === 'interest' || sem.category === 'preference'
        ? 'interests'
        : IDENTITY_KEYS.has(String(sem.subject || '').toLowerCase())
          ? 'general_info'
          : 'interests';
      upsertSub(mem, cat, { title: sem.subject || 'Untitled', content: sem.value || '' });
    }
    for (const ep of old.episodic || []) {
      upsertSub(mem, 'topic_deep_dives', {
        title: (ep.topics && ep.topics[0]) || 'Past session',
        content: { focus: ep.summary || 'Previous conversation', topics: ep.topics || [] },
      });
    }
    if (old.meta) {
      mem.meta = { ...mem.meta, ...old.meta, totalSessions: old.meta.totalSessions || 0 };
    }
    return mem;
  }

  function migrateV1toV3(old) {
    const mem = createEmptyMemory();
    const lt = old.longTerm || {};
    const demos = {};
    for (const [key, value] of Object.entries(lt)) {
      if (IDENTITY_KEYS.has(key.toLowerCase())) demos[key] = value;
      else upsertSub(mem, 'interests', { title: key, content: String(value) });
    }
    if (Object.keys(demos).length) {
      upsertSub(mem, 'general_info', { title: 'Basic Demographics', content: demos });
    }
    mem.meta.totalSessions = 1;
    return mem;
  }

  function normalize(memory) {
    if (!memory) return createEmptyMemory();

    if (!memory.version || memory.version < SCHEMA_VERSION) {
      if (memory.identity || memory.semantic || memory.episodic || memory.logs) return migrateV2toV3(memory);
      if (memory.longTerm) return migrateV1toV3(memory);
      if (!memory.categories) return createEmptyMemory();
    }

    if (!memory.categories || typeof memory.categories !== 'object') memory.categories = {};
    for (const [key, meta] of Object.entries(DEFAULT_CATEGORIES)) {
      if (!memory.categories[key]) {
        memory.categories[key] = { title: meta.title, description: meta.description, sub_memories: [] };
      } else if (!Array.isArray(memory.categories[key].sub_memories)) {
        memory.categories[key].sub_memories = [];
      }
    }
    for (const [key, cat] of Object.entries(memory.categories)) {
      if (!cat || typeof cat !== 'object') continue;
      if (!Array.isArray(cat.sub_memories)) cat.sub_memories = [];
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

  function needsPersistAfterNormalize(memory) {
    if (!memory || memory.version !== SCHEMA_VERSION || !memory.categories) return true;
    for (const cat of Object.values(memory.categories || {})) {
      for (const sub of cat?.sub_memories || []) {
        if (typeof sub.recallScore !== 'number') return true;
      }
    }
    return false;
  }

  function writeNormalized(normalized) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const shouldPersist = needsPersistAfterNormalize(parsed);
        const normalized = normalize(parsed);
        if (shouldPersist) writeNormalized(normalized);
        return normalized;
      }
    } catch (e) {
      console.warn('[JuneMemory] Failed to load memory:', e);
    }
    const empty = createEmptyMemory();
    try {
      return writeNormalized(empty);
    } catch (e) {
      console.warn('[JuneMemory] Failed to initialize memory storage:', e);
      return empty;
    }
  }

  function save(memory) {
    try {
      const normalized = normalize(memory);
      normalized.last_updated = memoryNow();
      return writeNormalized(normalized);
    } catch (e) {
      console.warn('[JuneMemory] Failed to save memory:', e);
      return memory;
    }
  }

  function applyFromServer(memory) {
    return save(normalize(memory));
  }

  function startSession() {
    const memory = load();
    if (memory.meta.lastSessionAt && (memory.meta.totalSessions || 0) > 0) {
      memory.meta.previousSessionAt = memory.meta.lastSessionAt;
    }
    memory.meta.currentSessionId = generateId();
    memory.meta.lastSessionAt = memoryNow();
    memory.meta.totalSessions = (memory.meta.totalSessions || 0) + 1;
    return save(memory);
  }

  function getSessionId() {
    return load().meta?.currentSessionId || null;
  }

  function clearAll() {
    return save(createEmptyMemory());
  }

  function getStorageStats() {
    const memory = load();
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    const cats = Object.entries(memory.categories || {}).map(([key, cat]) => ({
      key,
      count: (cat.sub_memories || []).length,
    }));
    return {
      version: memory.version,
      byteSize: new Blob([raw]).size,
      categories: cats,
      totalSubMemories: cats.reduce((n, c) => n + c.count, 0),
      totalSessions: memory.meta?.totalSessions || 0,
      lastSessionAt: memory.meta?.lastSessionAt,
    };
  }

  window.JuneMemory = {
    load,
    save,
    applyFromServer,
    startSession,
    getSessionId,
    clearAll,
    clearTier: clearAll,
    getStorageStats,
    generateId,
    SCHEMA_VERSION,
  };
})();
