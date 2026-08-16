(function () {
  const STORAGE_KEY = 'june_saved_chats';
  const MAX_CHATS = 50;

  function list() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('[JuneChatHistory] load failed:', e);
      return [];
    }
  }

  function persist(chats) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
    } catch (e) {
      console.warn('[JuneChatHistory] save failed:', e);
    }
  }

  function save(record) {
    if (!record || !record.session_id) return list();
    const chats = list().filter((c) => c.session_id !== record.session_id);
    chats.unshift(record);
    persist(chats);
    return chats;
  }

  function get(sessionId) {
    return list().find((c) => c.session_id === sessionId) || null;
  }

  function remove(sessionId) {
    const chats = list().filter((c) => c.session_id !== sessionId);
    persist(chats);
    return chats;
  }

  function clear() {
    persist([]);
    return [];
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return String(iso);
    }
  }

  window.JuneChatHistory = {
    list,
    save,
    get,
    remove,
    clear,
    formatTime,
    MAX_CHATS,
  };
})();
