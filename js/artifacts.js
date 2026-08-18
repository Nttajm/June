(function () {
  const STORAGE_KEY = 'june_artifacts';
  const SCHEMA_VERSION = 1;
  const MAX_ITEMS = 80;
  const MAX_BODY = 12000;
  const KINDS = new Set(['list', 'email', 'note', 'draft']);

  function nowIso() {
    return new Date().toISOString();
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normalizeKind(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (s === 'email' || s === 'mail') return 'email';
    if (s === 'list') return 'list';
    if (s === 'draft') return 'draft';
    if (s === 'message' || s === 'note' || s === 'outline') return 'note';
    return KINDS.has(s) ? s : 'note';
  }

  function clipTitle(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    return (t || 'Untitled').slice(0, 120);
  }

  function clipBody(raw) {
    return String(raw || '').trim().slice(0, MAX_BODY);
  }

  function createEmpty() {
    return { version: SCHEMA_VERSION, items: [] };
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const body = clipBody(raw.body ?? raw.markdown ?? raw.text ?? raw.clipboardText);
    if (!body) return null;
    const createdAt = String(raw.createdAt || raw.timestamp || nowIso());
    return {
      id: String(raw.id || generateId()),
      kind: normalizeKind(raw.kind),
      title: clipTitle(raw.title),
      body,
      source: String(raw.source || 'save_artifact').slice(0, 40),
      createdAt,
      updatedAt: String(raw.updatedAt || createdAt),
    };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return createEmpty();
    const list = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : []);
    const items = [];
    const seen = new Set();
    for (const row of list) {
      const item = normalizeItem(row);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    items.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    return { version: SCHEMA_VERSION, items: items.slice(0, MAX_ITEMS) };
  }

  function write(store) {
    const next = normalize(store);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return write(JSON.parse(raw));
    } catch {}
    return write(createEmpty());
  }

  function save(store) {
    try {
      return write(store);
    } catch {
      return normalize(store);
    }
  }

  function applyFromServer(store) {
    return save(store);
  }

  function snapshot() {
    return load();
  }

  function list() {
    return load().items.slice();
  }

  function get(id) {
    const want = String(id || '').trim();
    if (!want) return null;
    return load().items.find((item) => item.id === want) || null;
  }

  window.JuneArtifacts = {
    load,
    save,
    applyFromServer,
    snapshot,
    list,
    get,
  };
})();
