(function () {
  const STORAGE_KEY = 'june_memory';
  const SCHEMA_VERSION = 2;
  const IDENTITY_KEYS = new Set(['name', 'age', 'birthday', 'location', 'hometown', 'timezone']);
  const MAX_LOGS = 100;
  const MAX_EPISODIC = 20;
  const MAX_SEMANTIC = 200;

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function memoryNow() {
    return new Date().toISOString();
  }

  function memoryTimeMs(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }

  function toMemoryDate(value) {
    if (value == null) return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? memoryNow() : new Date(ms).toISOString();
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return memoryNow();
    return new Date(n).toISOString();
  }

  function migrateMemoryDates(memory) {
    if (!memory?.meta) return memory;
    for (const field of ['createdAt', 'lastSessionAt', 'previousSessionAt', 'consolidatedAt']) {
      if (memory.meta[field] != null) memory.meta[field] = toMemoryDate(memory.meta[field]);
    }
    for (const sem of memory.semantic || []) {
      for (const field of ['createdAt', 'updatedAt', 'lastAccessedAt']) {
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

  function inferCategory(key, value) {
    const k = (key || '').toLowerCase();
    const v = (value || '').toLowerCase();
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

  function normalize(memory) {
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

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return normalize(parsed);
      }
    } catch (e) {
      console.warn('[JuneMemory] Failed to load memory:', e);
    }
    return createEmptyMemory();
  }

  function save(memory) {
    try {
      const normalized = normalize(memory);
      const trimmed = trimMemory(normalized);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return trimmed;
    } catch (e) {
      console.warn('[JuneMemory] Failed to save memory:', e);
      return memory;
    }
  }

  function applyFromServer(memory) {
    const normalized = normalize(memory);
    return save(normalized);
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
    const memory = load();
    return memory.meta?.currentSessionId || null;
  }

  function clearTier(tier) {
    const memory = load();
    if (tier === 'identity') memory.identity = {};
    else if (tier === 'semantic') memory.semantic = [];
    else if (tier === 'episodic') memory.episodic = [];
    else if (tier === 'logs') memory.logs = [];
    else if (tier === 'all') {
      return save(createEmptyMemory());
    }
    return save(memory);
  }

  function getStorageStats() {
    const memory = load();
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    return {
      version: memory.version,
      byteSize: new Blob([raw]).size,
      identityCount: Object.keys(memory.identity).length,
      semanticCount: memory.semantic.length,
      episodicCount: memory.episodic.length,
      logsCount: memory.logs.length,
      totalSessions: memory.meta?.totalSessions || 0,
      lastSessionAt: memory.meta?.lastSessionAt,
      consolidatedAt: memory.meta?.consolidatedAt
    };
  }

  function addSemanticEntry(entry) {
    const memory = load();
    const existing = memory.semantic.find(
      s => s.subject.toLowerCase() === (entry.subject || '').toLowerCase()
    );
    if (existing) {
      existing.value = entry.value;
      existing.updatedAt = memoryNow();
      existing.accessCount = (existing.accessCount || 0) + 1;
      existing.confidence = Math.max(existing.confidence || 0.5, entry.confidence || 0.5);
      if (entry.category) existing.category = entry.category;
    } else {
      memory.semantic.push({
        id: generateId(),
        category: entry.category || inferCategory(entry.subject, entry.value),
        subject: entry.subject,
        value: entry.value,
        confidence: entry.confidence || 0.7,
        source: entry.source || 'explicit',
        createdAt: memoryNow(),
        updatedAt: memoryNow(),
        accessCount: 1,
        lastAccessedAt: memoryNow()
      });
    }
    return save(memory);
  }

  function addLog(log) {
    const memory = load();
    const isDuplicate = memory.logs.some(
      l => l.subject === log.subject && l.value === log.value
    );
    if (!isDuplicate) {
      memory.logs.push({
        id: generateId(),
        subject: log.subject,
        value: log.value,
        ts: toMemoryDate(log.ts) || memoryNow(),
        importance: log.importance || 0.5,
        sessionId: memory.meta?.currentSessionId || null
      });
    }
    return save(memory);
  }

  function setIdentity(key, value) {
    const memory = load();
    memory.identity[key] = value;
    return save(memory);
  }

  function addEpisodicSummary(summary) {
    const memory = load();
    memory.episodic.unshift({
      id: generateId(),
      summary: summary.summary,
      topics: summary.topics || [],
      mood: summary.mood || 'neutral',
      createdAt: memoryNow(),
      turnCount: summary.turnCount || 0
    });
    memory.meta.consolidatedAt = memoryNow();
    return save(memory);
  }

  function markAccessedEntries(ids) {
    const memory = load();
    const now = memoryNow();
    for (const sem of memory.semantic) {
      if (ids.includes(sem.id)) {
        sem.accessCount = (sem.accessCount || 0) + 1;
        sem.lastAccessedAt = now;
      }
    }
    return save(memory);
  }

  window.JuneMemory = {
    load,
    save,
    applyFromServer,
    startSession,
    getSessionId,
    clearTier,
    getStorageStats,
    addSemanticEntry,
    addLog,
    setIdentity,
    addEpisodicSummary,
    markAccessedEntries,
    generateId,
    inferCategory,
    SCHEMA_VERSION,
    MAX_LOGS,
    MAX_EPISODIC,
    MAX_SEMANTIC
  };
})();
