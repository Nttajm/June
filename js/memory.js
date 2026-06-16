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
        createdAt: Date.now(),
        lastSessionAt: null,
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
          createdAt: Date.now(),
          updatedAt: Date.now(),
          accessCount: 1,
          lastAccessedAt: Date.now()
        });
      }
    }

    for (const log of logs) {
      mem.logs.push({
        id: generateId(),
        subject: log.subject || '',
        value: log.value || '',
        ts: log.ts || Date.now(),
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
        return migrateV1toV2(memory);
      }
      return createEmptyMemory();
    }

    if (!memory.identity) memory.identity = {};
    if (!Array.isArray(memory.semantic)) memory.semantic = [];
    if (!Array.isArray(memory.episodic)) memory.episodic = [];
    if (!Array.isArray(memory.logs)) memory.logs = [];
    if (!memory.meta) {
      memory.meta = {
        createdAt: Date.now(),
        lastSessionAt: null,
        totalSessions: 0,
        consolidatedAt: null,
        currentSessionId: null
      };
    }
    return memory;
  }

  function trimMemory(memory) {
    if (memory.logs.length > MAX_LOGS) {
      memory.logs = memory.logs
        .sort((a, b) => (b.importance || 0.5) - (a.importance || 0.5) || (b.ts || 0) - (a.ts || 0))
        .slice(0, MAX_LOGS);
    }
    if (memory.episodic.length > MAX_EPISODIC) {
      memory.episodic = memory.episodic
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
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
    memory.meta.currentSessionId = generateId();
    memory.meta.lastSessionAt = Date.now();
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
      existing.updatedAt = Date.now();
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 1,
        lastAccessedAt: Date.now()
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
        ts: log.ts || Date.now(),
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
      createdAt: Date.now(),
      turnCount: summary.turnCount || 0
    });
    memory.meta.consolidatedAt = Date.now();
    return save(memory);
  }

  function markAccessedEntries(ids) {
    const memory = load();
    const now = Date.now();
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
