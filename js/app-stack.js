/**
 * JuneAppStack — os.html Stack3D cascade inside .voice.
 *
 * Flow: show dock → flip through apps → land on target → open →
 * cascade real result subcards. Orb tucks top-left. No chrome panel.
 *
 * Installed apps (Gmail) persist on the dock, open a real pane, and
 * animate in via install("gmail"). YouTube is pre-installed and plays
 * background audio on a Music · YouTube card.
 */
(function () {
  'use strict';

  const root = document.getElementById('appStack');
  if (!root) return;

  const dockEl = document.getElementById('appStackDock');
  const labelEl = document.getElementById('appStackLabel');
  const windowEl = document.getElementById('appStackWindow');
  const frameEl = document.getElementById('appStackFrame');
  const navEl = document.getElementById('appStackNav');
  const navPrev = document.getElementById('appStackPrev');
  const navNext = document.getElementById('appStackNext');
  const navAll = document.getElementById('appStackAll');
  const orb = document.querySelector('.orb');
  const voiceSection = document.querySelector('.voice');
  const STORE_KEY = 'june_installed_apps';

  const ICONS = {
    internet: `<svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.2"/>
      <ellipse cx="12" cy="12" rx="3.4" ry="8.2"/>
      <path d="M3.8 12h16.4"/>
      <path d="M5.1 8h13.8M5.1 16h13.8"/>
    </svg>`,
    memory: `<svg viewBox="0 0 24 24">
      <rect x="7" y="7" width="10" height="10" rx="1.6"/>
      <rect x="10" y="10" width="4" height="4" rx=".6"/>
      <path d="M9 4.6v2.4M12 4.6v2.4M15 4.6v2.4"/>
      <path d="M9 17v2.4M12 17v2.4M15 17v2.4"/>
      <path d="M4.6 9h2.4M4.6 12h2.4M4.6 15h2.4"/>
      <path d="M17 9h2.4M17 12h2.4M17 15h2.4"/>
    </svg>`,
    messages: `<svg viewBox="0 0 24 24">
      <path d="M4.2 6.2A2.2 2.2 0 0 1 6.4 4h8.4A2.2 2.2 0 0 1 17 6.2v5.4a2.2 2.2 0 0 1-2.2 2.2H8.4L4.8 16.6v-3H6.4A2.2 2.2 0 0 1 4.2 11.4V6.2Z"/>
      <path d="M17 10.4h.6A2.2 2.2 0 0 1 19.8 12.6v5.4a2.2 2.2 0 0 1-2.2 2.2h-1.4v2.6l-3.4-2.6H9.6"/>
    </svg>`,
    gmail: `<svg class="app-stack-gmail-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5.2"/>
      <path d="M6 9.1 12 13.6 18 9.1"/>
      <path d="M6 9.2v6.1A1.5 1.5 0 0 0 7.5 16.8h9A1.5 1.5 0 0 0 18 15.3V9.2"/>
    </svg>`,
    youtube: `<svg class="app-stack-yt-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.2" y="6.2" width="19.6" height="11.6" rx="3.4"/>
      <path d="M10 9.2v5.6l5.2-2.8z"/>
    </svg>`,
    brainstorm: `<svg class="app-stack-brainstorm-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.2 15.4c.2 1.1.7 1.8 1.4 2.2h2.8c.7-.4 1.2-1.1 1.4-2.2"/>
      <path d="M12 3.4a5.4 5.4 0 0 0-3.2 9.7c.5.4.8 1 .9 1.6h4.6c.1-.6.4-1.2.9-1.6A5.4 5.4 0 0 0 12 3.4z"/>
      <path d="M10.2 19.2h3.6M10.8 21h2.4"/>
    </svg>`,
    artifacts: `<svg class="app-stack-artifacts-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5.2" r="1.85"/>
      <circle cx="6.1" cy="12" r="1.85"/>
      <circle cx="17.9" cy="12" r="1.85"/>
      <circle cx="12" cy="18.8" r="1.85"/>
    </svg>`,
  };

  const BASE_APPS = [
    { id: 'memory', name: 'Memory', icon: 'memory', accent: '#2c241c' },
    { id: 'internet', name: 'Web', icon: 'internet', accent: '#e4452a' },
    { id: 'messages', name: 'Chats', icon: 'messages', accent: '#7c5cbf' },
  ];

  const CATALOG = {
    youtube: {
      id: 'youtube',
      name: 'YouTube',
      icon: 'youtube',
      accent: '#ff0033',
      persistent: true,
    },
    gmail: {
      id: 'gmail',
      name: 'Gmail',
      icon: 'gmail',
      accent: '#ea4335',
      persistent: true,
    },
    brainstorm: {
      id: 'brainstorm',
      name: 'Brainstorm',
      icon: 'brainstorm',
      accent: '#dc3232',
      persistent: true,
    },
    artifacts: {
      id: 'artifacts',
      name: 'Artifacts',
      icon: 'artifacts',
      accent: '#3a2a1c',
      persistent: true,
    },
  };

  const DOCK_STEP = { x: 22, y: -30, z: -95 };
  const BROWSE_STEP = { x: 30, y: -40, z: -118 };
  const SUB_STEP = { x: 22, y: -18, z: -80 };
  const TILE_STEP = { x: 14, y: -12, z: -55 };
  const MAIL_STEP = { x: 16, y: -15, z: -70 };
  const MUSIC_STEP = { x: 16, y: -15, z: -70 };
  const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const DOCK_MOVE_MS = 380;
  const INTRO_MS = 520;
  const SUB_FLIP_MS = 640;
  const SEARCH_TILE_FLIP_MS = 165;
  const MAX_CARDS = 6;
  const MIN_SHOW_MS = 3400;
  const PER_CARD_MS = 520;
  const MAX_SHOW_MS = 7200;
  const SEARCH_MIN_SHOW_MS = 1400;
  const SEARCH_PER_CARD_MS = 160;
  const SEARCH_MAX_SHOW_MS = 2600;
  const FINISH_GRACE_MS = 520;
  const HIDE_MS = 620;

  function loadInstalled() {
    let set;
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      set = new Set((Array.isArray(raw) ? raw : []).filter((id) => CATALOG[id]));
    } catch {
      set = new Set();
    }
    if (!set.has('youtube')) set.add('youtube');
    if (!set.has('artifacts')) set.add('artifacts');
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...set]));
    } catch { /* ignore quota / private mode */ }
    return set;
  }

  function saveInstalled() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...installedIds]));
    } catch { /* ignore quota / private mode */ }
    try {
      window.dispatchEvent(new CustomEvent('june-apps-changed', { detail: [...installedIds] }));
    } catch { /* ignore */ }
  }

  let installedIds = loadInstalled();

  function getApps() {
    const extra = [];
    for (const id of installedIds) {
      if (CATALOG[id]) extra.push(CATALOG[id]);
    }
    return BASE_APPS.concat(extra);
  }

  function isSearchKind() {
    return state.kind === 'internet';
  }

  function subFlipMs() {
    return isSearchKind() ? SEARCH_TILE_FLIP_MS : SUB_FLIP_MS;
  }

  function syncFastClass() {
    root.classList.toggle('is-fast', isSearchKind());
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function nextMotion() {
    state.motionGen += 1;
    return state.motionGen;
  }

  function isLive(gen) {
    return gen === state.motionGen;
  }

  function motionMs(ms) {
    return prefersReducedMotion() ? 0 : ms;
  }

  function dockStep() {
    return state.browsing ? BROWSE_STEP : DOCK_STEP;
  }

  function shortestDelta(from, to, n) {
    if (!n) return 0;
    const fwd = wrapIndex(to - from, n);
    const back = wrapIndex(from - to, n);
    if (fwd === 0) return 0;
    return fwd <= back ? fwd : -back;
  }

  function clearIconInlineMotion() {
    for (const el of state.dockIcons) {
      if (!el) continue;
      el.style.transition = '';
    }
  }

  function revealStack() {
    root.classList.remove('is-dock', 'is-pane');
    root.classList.toggle('is-mail', useMail());
    root.classList.toggle('is-music-yt', useMusicYt());
    root.classList.toggle('is-brainstorm-app', useBrainstorm());
    root.classList.toggle('is-artifacts', useArtifacts());
    setVoiceActive(true);
    moveOrbToCorner(true);
    renderDock();
    openApp();
  }

  function syncNav() {
    if (!navEl) return;
    const show = state.active && !state.paneOpen && !state.isOpen && !state.installing;
    navEl.hidden = !show;
    if (navAll) navAll.setAttribute('aria-pressed', state.browsing ? 'true' : 'false');
    root.classList.toggle('is-browse', state.browsing);
  }

  const state = {
    active: false,
    kind: null,
    index: 0,
    cursor: 0,
    isOpen: false,
    paneOpen: false,
    installing: false,
    browsing: false,
    introPlayed: false,
    autoClose: false,
    motionGen: 0,
    subIndex: 0,
    cards: [],
    dockIcons: [],
    subEls: [],
  };

  const gmailUi = {
    status: null,
    messages: [],
    view: 'home',
    selected: null,
    loading: false,
    sending: false,
    notice: '',
    confirmAddress: '',
    draft: { to: '', subject: '', body: '' },
    pollTimer: null,
  };

  const youtubeUi = {
    videoId: '',
    title: '',
    thumbnail: '',
    playing: false,
  };

  const brainstormUi = {
    phase: 'off',
    dump: '',
    title: '',
    body: '',
  };

  const artifactUi = {
    items: [],
    selectedId: '',
    view: 'list',
  };
  try {
    artifactUi.items = window.JuneArtifacts?.list?.() || [];
  } catch {
    artifactUi.items = [];
  }

  let dockFlipTimer = null;
  let subFlipTimer = null;
  let fadeTimer = null;
  let hideTimer = null;
  let openTimer = null;
  let gmailShowSeq = 0;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (s) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[s]));
  }

  function truncate(s, n) {
    const t = String(s || '').trim();
    if (!t) return '';
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  function initials(str) {
    return String(str || '?').trim().slice(0, 2).toUpperCase() || '?';
  }

  function wrapIndex(v, n) {
    return ((v % n) + n) % n;
  }

  function dockOpacity(r, isOpen) {
    if (isOpen) return r === 0 ? 1 : 0;
    const d = Math.abs(r);
    if (d === 0) return 1;
    if (state.browsing) return Math.max(0.28, 0.78 - (d - 1) * 0.16);
    return Math.max(0.1, 0.55 - (d - 1) * 0.2);
  }

  function subOpacity(r) {
    if (r === 0) return 1;
    return Math.max(0.16, 0.5 - (r - 1) * 0.16);
  }

  function appIndex(kind) {
    return getApps().findIndex((a) => a.id === kind);
  }

  function isInstalled(appId) {
    return installedIds.has(String(appId || '').trim());
  }

  function listInstalled() {
    return [...installedIds];
  }

  function ensureInstalled(appId) {
    const id = String(appId || '').trim();
    if (!CATALOG[id] || installedIds.has(id)) return isInstalled(id);
    installedIds.add(id);
    saveInstalled();
    buildDock();
    renderDock();
    return true;
  }

  function paneEl() {
    let el = document.getElementById('appStackPane');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appStackPane';
      el.className = 'app-stack-pane';
      el.hidden = true;
      root.appendChild(el);
    }
    return el;
  }

  function buildDock() {
    dockEl.innerHTML = '';
    const apps = getApps();
    state.dockIcons = apps.map((app) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'app-stack-dock-icon';
      el.dataset.appId = app.id;
      el.innerHTML = ICONS[app.icon] || ICONS.memory;
      el.style.color = app.accent || '';
      el.title = app.name;
      el.setAttribute('aria-label', `Open ${app.name}`);
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.installing) return;
        const slot = Number(el.dataset.slot);
        if (slot && slot !== 0) {
          stepBy(slot);
          return;
        }
        activateApp(app);
      });
      dockEl.appendChild(el);
      return el;
    });
  }

  function renderDock() {
    const apps = getApps();
    const n = apps.length;
    if (!n) return;
    const step = dockStep();
    state.index = wrapIndex(state.cursor, n);
    for (let i = 0; i < n; i++) {
      const el = state.dockIcons[i];
      if (!el) continue;
      let slot = i - state.index;
      if (slot > n / 2) slot -= n;
      if (slot < -n / 2) slot += n;
      const selected = slot === 0;
      el.classList.toggle('selected', selected);
      el.dataset.slot = String(slot);
      const scale = selected
        ? 1.1
        : Math.max(0.86, 1 - Math.abs(slot) * (state.browsing ? 0.04 : 0.05));
      el.style.transform = `translate3d(${slot * step.x}px, ${slot * step.y}px, ${slot * step.z}px) scale(${scale})`;
      el.style.opacity = String(dockOpacity(slot, state.isOpen || state.paneOpen));
      el.style.zIndex = String(100 - Math.abs(slot));
      el.style.filter = slot === 0 ? 'blur(0px)' : `blur(${Math.min(Math.abs(slot) * 0.5, 2.2)}px)`;
      el.style.visibility = (state.isOpen || state.paneOpen) && !selected ? 'hidden' : '';
    }
    const app = apps[state.index];
    if (labelEl) {
      labelEl.textContent = app
        ? (app.id === 'youtube' ? 'Music · YouTube' : app.name)
        : '';
      labelEl.style.opacity = (state.isOpen || state.paneOpen) ? '0' : '0.85';
    }
    syncNav();
  }

  function activateApp(app) {
    if (!app) return;
    state.autoClose = false;
    if (app.persistent) open(app.id);
    else start(app.id);
  }

  function stepBy(delta) {
    if (state.paneOpen || state.installing) return;
    const apps = getApps();
    const n = apps.length;
    if (!n || !delta) return;
    nextMotion();
    stopDockFlip();
    state.cursor += delta;
    state.index = wrapIndex(state.cursor, n);
    const app = apps[state.index];
    if (app) state.kind = app.id;
    renderDock();
  }

  async function flipTo(target, gen) {
    const apps = getApps();
    const n = apps.length;
    if (!n) return true;
    const dest = wrapIndex(target, n);
    const current = wrapIndex(state.cursor, n);
    const delta = shortestDelta(current, dest, n);
    state.cursor += delta;
    state.index = dest;
    renderDock();
    if (delta !== 0) await wait(motionMs(DOCK_MOVE_MS));
    return isLive(gen);
  }

  async function playDockIntro(gen) {
    if (state.introPlayed) return isLive(gen);
    state.introPlayed = true;
    const apps = getApps();
    const n = apps.length;
    if (!n || prefersReducedMotion()) {
      renderDock();
      return isLive(gen);
    }
    const step = dockStep();
    const fromExtra = n + 1;
    for (let i = 0; i < n; i++) {
      const el = state.dockIcons[i];
      if (!el) continue;
      let slot = i - state.index;
      if (slot > n / 2) slot -= n;
      if (slot < -n / 2) slot += n;
      const from = slot + fromExtra;
      el.style.transition = 'none';
      el.style.transform = `translate3d(${from * step.x}px, ${from * step.y}px, ${from * step.z}px) scale(0.84)`;
      el.style.opacity = '0';
      el.style.filter = 'blur(2.4px)';
    }
    await waitFrame();
    if (!isLive(gen)) return false;
    for (let i = 0; i < n; i++) {
      const el = state.dockIcons[i];
      if (!el) continue;
      const delay = Math.abs(i - state.index) * 48;
      el.style.transition =
        `transform ${INTRO_MS}ms ${EASE_OUT} ${delay}ms,` +
        ` opacity 0.46s ease ${delay}ms,` +
        ` filter 0.46s ease ${delay}ms`;
    }
    renderDock();
    await wait(INTRO_MS + Math.max(0, n - 1) * 48);
    if (!isLive(gen)) return false;
    clearIconInlineMotion();
    return true;
  }

  function selectedApp() {
    const apps = getApps();
    return apps[state.index] || apps[0] || null;
  }

  function cardKey(card) {
    if (card && card.id) return `id:${card.id}`;
    return `${card.domain || ''}|${card.title || ''}|${card.sub || ''}|${card.snip || ''}`;
  }

  function renderSubBody(card) {
    if (card.sub) {
      return `<ul class="sc-rows"><li>${escapeHtml(truncate(card.sub, 72))}</li></ul>`;
    }
    if (card.domain) {
      return `<ul class="sc-rows"><li>${escapeHtml(card.domain)}</li></ul>`;
    }
    return `<ul class="sc-rows"><li>${escapeHtml(truncate(card.title || '', 72))}</li></ul>`;
  }

  function badgeHtml(card) {
    if (card.domain) {
      return `<img alt="" loading="lazy" referrerpolicy="no-referrer" ` +
        `src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(card.domain)}&sz=64" ` +
        `onerror="this.remove()" />`;
    }
    return escapeHtml(initials(card.letter || card.title));
  }

  function useTiles() {
    return state.kind === 'internet';
  }

  function useMail() {
    return state.kind === 'gmail';
  }

  function useMusicYt() {
    return state.kind === 'youtube';
  }

  function useBrainstorm() {
    return state.kind === 'brainstorm';
  }

  function useArtifacts() {
    return state.kind === 'artifacts';
  }

  function cardSurfaceClass() {
    if (useTiles()) return 'app-stack-tile';
    if (useMail()) return 'app-stack-mail';
    if (useMusicYt()) return 'app-stack-music-yt';
    if (useBrainstorm()) return 'app-stack-brainstorm';
    if (useArtifacts()) return 'app-stack-artifact';
    return 'app-stack-subcard';
  }

  function surfaceKind(el) {
    if (el.classList.contains('app-stack-tile')) return 'app-stack-tile';
    if (el.classList.contains('app-stack-mail')) return 'app-stack-mail';
    if (el.classList.contains('app-stack-music-yt')) return 'app-stack-music-yt';
    if (el.classList.contains('app-stack-brainstorm')) return 'app-stack-brainstorm';
    if (el.classList.contains('app-stack-artifact')) return 'app-stack-artifact';
    return 'app-stack-subcard';
  }

  function ensureSubcards() {
    const n = state.cards.length;
    const cls = cardSurfaceClass();
    while (state.subEls.length < n) {
      const el = document.createElement('div');
      el.className = cls;
      el.dataset.cardKey = '';
      frameEl.appendChild(el);
      state.subEls.push(el);
    }
    while (state.subEls.length > n) {
      const el = state.subEls.pop();
      el.remove();
    }
    for (const el of state.subEls) {
      const cls = cardSurfaceClass();
      if (surfaceKind(el) !== cls) {
        el.className = cls;
        el.dataset.cardKey = '';
      }
    }
  }

  function tileHtml(card) {
    if (card.domain) {
      return `<img alt="" loading="lazy" referrerpolicy="no-referrer" ` +
        `src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(card.domain)}&sz=64" ` +
        `onerror="this.parentElement.classList.add('is-fallback');this.remove();" />`;
    }
    return escapeHtml(initials(card.letter || card.title || '?'));
  }

  function mailFromName(from) {
    const s = String(from || '').trim();
    if (!s) return 'Mail';
    const named = s.match(/^"?([^"<]+)"?\s*</);
    if (named) return named[1].trim() || s;
    return s.replace(/<.*>/, '').trim() || s.split('@')[0] || s;
  }

  function mailHtml(card) {
    return (
      `<span class="sc-mail-bar" aria-hidden="true"></span>` +
      `<span class="sc-mail-copy">` +
        `<span class="sc-mail-from">${escapeHtml(truncate(card.title || 'Mail', 24))}</span>` +
        `<span class="sc-mail-subject">${escapeHtml(truncate(card.sub || '', 34))}</span>` +
        `<span class="sc-mail-snip">${escapeHtml(truncate(card.snip || '', 44))}</span>` +
      `</span>`
    );
  }

  function youtubeThumbUrl(videoId) {
    const id = String(videoId || '').trim();
    return id ? `https://img.youtube.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : '';
  }

  function musicYtHtml(card) {
    const thumb = card.thumbnail || youtubeThumbUrl(card.videoId);
    const title = card.title || 'YouTube';
    const img = thumb
      ? `<img class="sc-music-yt-thumb" alt="" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(thumb)}" />`
      : `<div class="sc-music-yt-thumb is-empty" aria-hidden="true"></div>`;
    return (
      `<div class="sc-music-yt">` +
        img +
        `<div class="sc-music-yt-meta">` +
          `<span class="sc-music-yt-label">Music · YouTube</span>` +
          `<span class="sc-music-yt-title">${escapeHtml(truncate(title, 42))}</span>` +
          `<span class="sc-music-yt-bars" aria-hidden="true"><i></i><i></i><i></i></span>` +
        `</div>` +
      `</div>`
    );
  }

  function brainstormHtml(card) {
    return (
      `<div class="sc-brainstorm">` +
        `<span class="sc-brainstorm-label">Brainstorm</span>` +
        `<span class="sc-brainstorm-status">${escapeHtml(card.sub || 'Ready')}</span>` +
        `<span class="sc-brainstorm-snip">${escapeHtml(card.snip || 'Say enter brainstorm mode')}</span>` +
      `</div>`
    );
  }

  function artifactKindLabel(kind) {
    if (kind === 'email') return 'Email';
    if (kind === 'list') return 'List';
    if (kind === 'draft') return 'Draft';
    return 'Note';
  }

  function artifactHtml(card) {
    return (
      `<div class="sc-artifact">` +
        `<span class="sc-artifact-kind">${escapeHtml(artifactKindLabel(card.artKind))}</span>` +
        `<span class="sc-artifact-title">${escapeHtml(truncate(card.title || 'Untitled', 28))}</span>` +
        `<span class="sc-artifact-snip">${escapeHtml(truncate(card.snip || '', 52))}</span>` +
      `</div>`
    );
  }

  function renderSubcards() {
    ensureSubcards();
    bindFrameOnce();
    const n = state.cards.length;
    const mail = useMail();
    const music = useMusicYt();
    const brainstorm = useBrainstorm();
    const artifacts = useArtifacts();
    const tiles = useTiles();
    root.classList.toggle('is-mail', mail && state.isOpen && !state.paneOpen);
    root.classList.toggle('is-music-yt', music && state.isOpen && !state.paneOpen);
    root.classList.toggle('is-brainstorm-app', brainstorm && state.isOpen && !state.paneOpen);
    root.classList.toggle('is-artifacts', artifacts && state.isOpen && !state.paneOpen);
    if (!n) {
      windowEl.classList.remove('open');
      return;
    }
    windowEl.classList.add('open');
    const apps = getApps();
    const app = apps[state.index] || apps[1] || BASE_APPS[1];
    const step = tiles ? TILE_STEP : mail ? MAIL_STEP : music || brainstorm || artifacts ? MUSIC_STEP : SUB_STEP;
    const keyTag = tiles ? '|tile' : mail ? '|mail' : music ? '|music' : brainstorm ? '|brainstorm' : artifacts ? '|artifact' : '|card';

    for (let i = 0; i < n; i++) {
      const el = state.subEls[i];
      const card = state.cards[i];
      const key = cardKey(card) + keyTag;
      if (el.dataset.cardKey !== key) {
        el.dataset.cardKey = key;
        el.style.setProperty('--card-accent', card.accent || app.accent || '#c9b6a0');
        if (tiles) {
          el.classList.toggle('is-fallback', !card.domain);
          el.innerHTML = tileHtml(card);
          el.title = card.title || card.domain || '';
        } else if (mail) {
          el.classList.toggle('is-unread', Boolean(card.unread));
          el.innerHTML = mailHtml(card);
          el.title = [card.title, card.sub].filter(Boolean).join(' — ');
          el.setAttribute('role', 'button');
          el.tabIndex = 0;
          el.setAttribute('aria-label', el.title || 'Email');
        } else if (music) {
          el.innerHTML = musicYtHtml(card);
          el.title = card.title || 'Music · YouTube';
          el.classList.toggle('is-playing', Boolean(youtubeUi.playing && card.videoId === youtubeUi.videoId));
        } else if (brainstorm) {
          el.innerHTML = brainstormHtml(card);
          el.title = card.title || 'Brainstorm';
          el.classList.toggle('is-live', card.live === true);
        } else if (artifacts) {
          el.innerHTML = artifactHtml(card);
          el.title = card.title || 'Artifact';
          el.setAttribute('role', 'button');
          el.tabIndex = 0;
          el.setAttribute('aria-label', card.title || 'Artifact');
        } else {
          el.innerHTML =
            `<div class="sc-header">` +
            `<div class="sc-badge">${badgeHtml(card)}</div>` +
            `<div class="sc-title">${escapeHtml(truncate(card.title || 'Result', 22))}</div>` +
            `</div>` +
            `<div class="sc-body">${renderSubBody(card)}</div>`;
        }
      } else if (mail) {
        el.classList.toggle('is-unread', Boolean(card.unread));
      } else if (music) {
        el.classList.toggle('is-playing', Boolean(youtubeUi.playing && card.videoId === youtubeUi.videoId));
      }
      const r = ((i - state.subIndex) % n + n) % n;
      el.classList.toggle('is-back', r !== 0);
      const scale = tiles
        ? (r === 0 ? 1 : Math.max(0.75, 1 - r * 0.08))
        : mail
          ? (r === 0 ? 1 : Math.max(0.9, 1 - r * 0.035))
          : 1;
      el.style.transform = `translate3d(${r * step.x}px, ${r * step.y}px, ${r * step.z}px) scale(${scale})`;
      el.style.opacity = String(subOpacity(r));
      el.style.zIndex = String(100 - r);
      el.style.filter = r === 0 ? 'blur(0px)' : `blur(${Math.min(r * 0.5, 2.2)}px)`;
    }
  }

  function bindFrameOnce() {
    if (!frameEl || frameEl.dataset.bound === '1') return;
    frameEl.dataset.bound = '1';
    frameEl.addEventListener('click', onStackCardClick);
  }

  function onStackCardClick(e) {
    if ((!useMail() && !useArtifacts()) || state.paneOpen) return;
    const el = e.target.closest(useArtifacts() ? '.app-stack-artifact' : '.app-stack-mail');
    if (!el || !frameEl.contains(el)) return;
    e.preventDefault();
    const i = state.subEls.indexOf(el);
    if (i < 0) return;
    const n = state.cards.length;
    const r = ((i - state.subIndex) % n + n) % n;
    if (r !== 0) {
      stopSubFlip();
      state.subIndex = i;
      renderSubcards();
      startSubFlip();
      return;
    }
    const card = state.cards[i];
    if (!card) return;
    if (useArtifacts()) {
      if (card.id) {
        state.autoClose = false;
        openArtifactItem(card.id);
      }
      return;
    }
    if (card.action === 'connect') {
      window.open('/api/gmail/auth', '_blank', 'noopener');
      startGmailPoll();
      return;
    }
    if (card.id) {
      state.autoClose = false;
      openMailMessage(card.id);
    }
  }

  function stepSub(delta) {
    const n = state.cards.length;
    if (n < 2 || !delta) return;
    stopSubFlip();
    state.subIndex = wrapIndex(state.subIndex + delta, n);
    renderSubcards();
    startSubFlip();
  }

  async function openMailMessage(id) {
    const msg = gmailUi.messages.find((m) => m.id === id);
    if (!msg) return;
    const gen = nextMotion();
    gmailUi.selected = msg;
    gmailUi.view = 'message';
    gmailUi.notice = '';
    stopSubFlip();
    windowEl.classList.remove('open');
    state.paneOpen = true;
    state.isOpen = true;
    const el = paneEl();
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    el.classList.remove('is-in', 'is-out');
    bindPaneOnce();
    renderGmailPane();
    root.classList.add('is-pane');
    root.classList.remove('is-dock', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    renderDock();
    await waitFrame();
    if (!isLive(gen)) return;
    el.classList.add('is-in');
  }

  function stopDockFlip() {
    if (dockFlipTimer) { clearInterval(dockFlipTimer); dockFlipTimer = null; }
  }

  function stopSubFlip() {
    if (subFlipTimer) { clearInterval(subFlipTimer); subFlipTimer = null; }
  }

  function startSubFlip() {
    stopSubFlip();
    if (state.cards.length < 2) return;
    subFlipTimer = setInterval(() => {
      state.subIndex = (state.subIndex + 1) % state.cards.length;
      renderSubcards();
    }, subFlipMs());
  }

  function setVoiceActive(on) {
    if (voiceSection) voiceSection.classList.toggle('is-app-stack', on);
  }

  function moveOrbToCorner(active) {
    if (!orb) return;
    if (active) {
      if (orb.classList.contains('is-mini')) return;
      const rect = orb.getBoundingClientRect();
      const parentRect = (voiceSection || orb.parentElement || document.body).getBoundingClientRect();
      orb.style.position = 'absolute';
      orb.style.top = `${rect.top - parentRect.top}px`;
      orb.style.left = `${rect.left - parentRect.left}px`;
      orb.style.width = `${rect.width}px`;
      orb.style.height = `${rect.height}px`;
      orb.style.margin = '0';
      // eslint-disable-next-line no-unused-expressions
      orb.offsetWidth;
      orb.classList.add('is-mini');
    } else if (orb.classList.contains('is-mini')) {
      orb.classList.remove('is-mini');
      const clearInline = () => {
        orb.style.position = '';
        orb.style.top = '';
        orb.style.left = '';
        orb.style.width = '';
        orb.style.height = '';
        orb.style.margin = '';
        orb.removeEventListener('transitionend', clearInline);
      };
      orb.addEventListener('transitionend', clearInline, { once: true });
      setTimeout(clearInline, 700);
    }
  }

  function showRoot(opts) {
    const miniOrb = Boolean(opts && opts.miniOrb);
    clearTimeout(hideTimer);
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    // eslint-disable-next-line no-unused-expressions
    root.offsetWidth;
    root.classList.add('active');
    if (miniOrb) {
      root.classList.remove('is-dock');
      setVoiceActive(true);
      moveOrbToCorner(true);
    }
  }

  function hideRoot() {
    nextMotion();
    hidePaneEl();
    state.introPlayed = false;
    state.browsing = false;
    root.classList.remove('active', 'is-fast', 'is-dock', 'is-pane', 'is-installing', 'is-browse', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    windowEl.classList.remove('open');
    setVoiceActive(false);
    moveOrbToCorner(false);
    syncNav();
    hideTimer = setTimeout(() => {
      root.hidden = true;
      root.setAttribute('aria-hidden', 'true');
      state.cards = [];
      state.subIndex = 0;
      state.isOpen = false;
      state.paneOpen = false;
      ensureSubcards();
    }, HIDE_MS);
  }

  function setDockOnly() {
    nextMotion();
    clearTimeout(hideTimer);
    stopDockFlip();
    stopSubFlip();
    hidePaneEl();
    state.active = true;
    state.paneOpen = false;
    state.isOpen = false;
    windowEl.classList.remove('open');
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('active', 'is-dock');
    root.classList.remove('is-pane', 'is-fast', 'is-installing', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    setVoiceActive(false);
    moveOrbToCorner(false);
    if (!state.dockIcons.length) buildDock();
    const app = selectedApp();
    if (app) state.kind = app.id;
    renderDock();
  }

  function settleOrHide() {
    if (state.paneOpen) return;
    if (installedIds.size) {
      state.cards = [];
      state.subIndex = 0;
      ensureSubcards();
      setDockOnly();
      return;
    }
    state.active = false;
    state.kind = null;
    hideRoot();
  }

  function openApp() {
    const apps = getApps();
    const app = apps[state.index] || apps[1] || BASE_APPS[1];
    state.isOpen = true;
    stopDockFlip();
    renderDock();
    if (app.id === 'gmail') {
      root.classList.add('is-mail');
      if (!state.cards.length) {
        state.cards = [{
          kind: 'mail',
          title: 'Gmail',
          sub: 'Inbox',
          snip: 'Opening…',
          accent: app.accent,
        }];
        state.subIndex = 0;
      }
      renderSubcards();
      startSubFlip();
      refreshGmail();
      return;
    }
    if (app.id === 'youtube') {
      root.classList.add('is-music-yt');
      if (!state.cards.length) {
        state.cards = [nowPlayingCard() || idleMusicCard(app)];
        state.subIndex = 0;
      }
      renderSubcards();
      return;
    }
    if (app.id === 'brainstorm') {
      root.classList.add('is-brainstorm-app');
      if (!state.cards.length) {
        state.cards = [brainstormCard()];
        state.subIndex = 0;
      }
      renderSubcards();
      return;
    }
    if (app.id === 'artifacts') {
      root.classList.add('is-artifacts');
      if (!state.cards.length) {
        state.cards = artifactCards();
        state.subIndex = 0;
      }
      renderSubcards();
      startSubFlip();
      return;
    }
    if (!state.cards.length) {
      // Placeholder while tools resolve
      if (app.id === 'internet') {
        state.cards = [{ title: 'Searching…', letter: 'W', accent: app.accent }];
      } else {
        state.cards = [{
          title: app.name,
          sub: app.id === 'memory' ? 'Scanning…' : 'Opening…',
          accent: app.accent,
          letter: app.name.slice(0, 1),
        }];
      }
      state.subIndex = 0;
    }
    renderSubcards();
    startSubFlip();
  }

  /**
   * Travel to `kind` along the cascade, then open smoothly.
   */
  async function start(kind) {
    if (kind && CATALOG[kind] && installedIds.has(kind)) {
      open(kind);
      return;
    }

    const target = appIndex(kind);
    if (target < 0) return;

    if (state.active && state.kind === kind && state.isOpen && !state.paneOpen) {
      clearTimeout(fadeTimer);
      return;
    }

    const gen = nextMotion();
    clearTimeout(fadeTimer);
    clearTimeout(hideTimer);
    clearTimeout(openTimer);
    stopDockFlip();
    stopSubFlip();

    if (state.paneOpen) {
      await closePane({ keepDock: true, silent: true, gen });
      if (!isLive(gen)) return;
    }

    if (!state.dockIcons.length) buildDock();

    const fromDock = root.classList.contains('is-dock') && root.classList.contains('active');
    const switchingKind = state.active && state.kind !== kind;

    state.active = true;
    state.kind = kind;
    state.browsing = false;
    syncFastClass();

    if (switchingKind || !state.isOpen) {
      state.isOpen = false;
      state.cards = [];
      state.subIndex = 0;
      windowEl.classList.remove('open');
      ensureSubcards();
    }

    if (fromDock) {
      showRoot({ miniOrb: false });
      renderDock();
    } else {
      showRoot({ miniOrb: true });
      root.classList.remove('is-dock', 'is-pane', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
      renderDock();
      if (!state.introPlayed && !await playDockIntro(gen)) return;
    }

    const apps = getApps();
    const dest = wrapIndex(target, apps.length);
    if (wrapIndex(state.cursor, apps.length) !== dest) {
      if (!await flipTo(dest, gen)) return;
    } else {
      state.cursor = dest;
      state.index = dest;
      renderDock();
    }

    if (!isLive(gen)) return;
    revealStack();
  }

  function setCards(cards) {
    if (!state.active || state.paneOpen || useMail() || useArtifacts()) return;
    clearTimeout(fadeTimer);
    const next = (Array.isArray(cards) ? cards : []).filter(Boolean).slice(0, MAX_CARDS);
    // Drop the temporary "Searching…" placeholder once real results land.
    state.cards = next.length ? next : state.cards;
    state.subIndex = 0;
    if (state.isOpen) {
      renderSubcards();
      startSubFlip();
    }
  }

  function pushCards(cards) {
    if (!state.active || state.paneOpen || useMail() || useArtifacts()) return;
    clearTimeout(fadeTimer);
    // Clear placeholder if present
    if (state.cards.length === 1) {
      const only = state.cards[0];
      if (/Searching|Scanning|Opening/.test(only.sub || only.title || '') && !only.domain) {
        state.cards = [];
      }
    }
    let added = false;
    for (const c of Array.isArray(cards) ? cards : []) {
      if (!c) continue;
      const key = cardKey(c);
      if (state.cards.some((x) => cardKey(x) === key)) continue;
      state.cards.push(c);
      added = true;
      if (state.cards.length > MAX_CARDS) state.cards.shift();
    }
    if (!added && state.cards.length) {
      if (state.isOpen) startSubFlip();
      return;
    }
    state.subIndex = Math.max(0, state.cards.length - 1);
    if (state.isOpen) {
      renderSubcards();
      startSubFlip();
    } else if (state.cards.length) {
      clearTimeout(openTimer);
      openTimer = setTimeout(openApp, isSearchKind() ? 30 : 80);
    }
  }

  function finish() {
    if (state.installing) return;
    if (state.kind === 'youtube' && youtubeUi.videoId) return;
    if (state.kind === 'brainstorm' && (brainstormUi.phase === 'capturing' || brainstormUi.phase === 'wrapup')) return;
    if (state.kind === 'gmail' && state.isOpen && !state.autoClose) return;
    if (state.kind === 'artifacts' && state.isOpen && !state.autoClose) return;
    if (!state.active) return;
    const minShow = isSearchKind() ? SEARCH_MIN_SHOW_MS : MIN_SHOW_MS;
    const perCard = isSearchKind() ? SEARCH_PER_CARD_MS : PER_CARD_MS;
    const maxShow = isSearchKind() ? SEARCH_MAX_SHOW_MS : MAX_SHOW_MS;
    const lingerMs = Math.min(maxShow, minShow + Math.max(1, state.cards.length) * perCard);
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (state.installing) return;
      if (state.kind === 'youtube' && youtubeUi.videoId) return;
      if (state.kind === 'brainstorm' && (brainstormUi.phase === 'capturing' || brainstormUi.phase === 'wrapup')) return;
      if (state.kind === 'gmail' && state.isOpen && !state.autoClose) return;
      if (state.kind === 'artifacts' && state.isOpen && !state.autoClose) return;
      stopDockFlip();
      stopSubFlip();
      clearTimeout(openTimer);
      const closeGmail = state.kind === 'gmail' && state.autoClose;
      if (closeGmail && state.paneOpen) {
        closePane({ keepDock: true }).then(() => {
          state.autoClose = false;
          settleOrHide();
        }).catch(() => settleOrHide());
        return;
      }
      if (closeGmail) state.autoClose = false;
      settleOrHide();
    }, lingerMs + FINISH_GRACE_MS);
  }

  function reset() {
    clearTimeout(fadeTimer);
    clearTimeout(hideTimer);
    clearTimeout(openTimer);
    stopDockFlip();
    stopSubFlip();
    stopGmailPoll();
    state.kind = null;
    state.isOpen = false;
    state.paneOpen = false;
    state.browsing = false;
    state.cards = [];
    state.subIndex = 0;
    windowEl.classList.remove('open');
    if (installedIds.size) {
      ensureSubcards();
      setDockOnly();
      return;
    }
    state.active = false;
    root.classList.remove('active', 'is-fast', 'is-dock', 'is-pane', 'is-installing', 'is-browse', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    setVoiceActive(false);
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    moveOrbToCorner(false);
    hidePaneEl();
    ensureSubcards();
  }

  async function open(appId) {
    const id = String(appId || '').trim();
    if (!CATALOG[id] || !installedIds.has(id)) return false;
    const gen = nextMotion();
    clearTimeout(fadeTimer);
    clearTimeout(hideTimer);
    clearTimeout(openTimer);
    stopDockFlip();
    stopSubFlip();
    const apps = getApps();
    const target = apps.findIndex((a) => a.id === id);
    if (target < 0) return false;
    if (state.paneOpen && state.kind === id && paneEl().classList.contains('is-in')) return true;
    if (id === 'gmail' && state.isOpen && !state.paneOpen && state.kind === 'gmail') {
      return true;
    }
    if (id === 'youtube' && state.isOpen && !state.paneOpen && state.kind === 'youtube') {
      return true;
    }
    if (id === 'brainstorm' && state.isOpen && !state.paneOpen && state.kind === 'brainstorm') {
      return true;
    }
    if (id === 'artifacts' && state.isOpen && !state.paneOpen && state.kind === 'artifacts') {
      return true;
    }

    if (state.paneOpen && state.kind !== id) {
      await closePane({ keepDock: true, silent: true, gen });
      if (!isLive(gen)) return false;
    }

    state.active = true;
    state.kind = id;
    state.isOpen = false;
    state.browsing = false;
    state.cards = [];
    state.subIndex = 0;
    windowEl.classList.remove('open');
    ensureSubcards();
    root.classList.remove('is-fast');
    if (!state.dockIcons.length) buildDock();

    const atDock = !root.classList.contains('active') || root.classList.contains('is-dock') || root.hidden;
    showRoot({ miniOrb: false });
    if (atDock) {
      root.classList.add('is-dock');
      root.classList.remove('is-pane');
    }
    renderDock();
    if (!state.introPlayed && !await playDockIntro(gen)) return false;
    const dest = wrapIndex(target, apps.length);
    if (wrapIndex(state.cursor, apps.length) !== dest) {
      if (!await flipTo(dest, gen)) return false;
    } else {
      state.cursor = dest;
      state.index = dest;
      renderDock();
    }
    if (!isLive(gen)) return false;
    if (id === 'gmail' || id === 'youtube' || id === 'brainstorm' || id === 'artifacts') {
      revealStack();
      return true;
    }
    preparePane(id);
    root.classList.add('is-pane');
    root.classList.remove('is-dock', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    moveOrbToCorner(true);
    setVoiceActive(true);
    renderDock();
    paneEl().classList.add('is-in');
    return true;
  }

  function nowPlayingCard() {
    if (!youtubeUi.videoId) return null;
    return {
      kind: 'music-yt',
      id: youtubeUi.videoId,
      videoId: youtubeUi.videoId,
      title: youtubeUi.title || 'YouTube',
      thumbnail: youtubeUi.thumbnail || youtubeThumbUrl(youtubeUi.videoId),
      accent: '#ff0033',
    };
  }

  function idleMusicCard(app) {
    return {
      kind: 'music-yt',
      id: 'idle',
      title: 'Nothing playing',
      thumbnail: '',
      accent: (app && app.accent) || '#ff0033',
    };
  }

  function brainstormStatusLabel() {
    if (brainstormUi.phase === 'capturing') return 'Capturing';
    if (brainstormUi.phase === 'wrapup') return brainstormUi.title ? 'Draft' : 'Wrap-up';
    return brainstormUi.title || brainstormUi.dump ? 'Last dump' : 'Ready';
  }

  function brainstormCard() {
    const dump = String(brainstormUi.dump || '').trim();
    const title = String(brainstormUi.title || '').trim();
    const body = String(brainstormUi.body || '').trim();
    const snip = title
      ? truncate(body || title, 72)
      : dump
        ? truncate(dump, 72)
        : (brainstormUi.phase === 'capturing' ? 'Listening…' : 'Say enter brainstorm mode');
    return {
      kind: 'brainstorm',
      title: title || 'Brainstorm',
      sub: brainstormStatusLabel(),
      snip,
      live: brainstormUi.phase === 'capturing' || brainstormUi.phase === 'wrapup',
      accent: '#dc3232',
    };
  }

  async function setBrainstorm({ phase = 'off', dump = '', title = '', body = '' } = {}) {
    brainstormUi.phase = phase || 'off';
    brainstormUi.dump = String(dump || '');
    brainstormUi.title = String(title || '');
    brainstormUi.body = String(body || '');
    const live = brainstormUi.phase === 'capturing' || brainstormUi.phase === 'wrapup';
    if (live) {
      if (!installedIds.has('brainstorm')) await install('brainstorm');
      else await open('brainstorm');
    } else if (!installedIds.has('brainstorm')) {
      return true;
    } else if (state.kind === 'brainstorm' && state.isOpen) {
      clearTimeout(fadeTimer);
    }
    if (state.kind === 'brainstorm') {
      state.cards = [brainstormCard()];
      state.subIndex = 0;
      renderSubcards();
    }
    return true;
  }

  function formatArtDate(raw) {
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function artifactCards() {
    const accent = (CATALOG.artifacts && CATALOG.artifacts.accent) || '#3a2a1c';
    const rows = artifactUi.items || [];
    if (!rows.length) {
      return [{
        kind: 'artifact',
        title: 'Artifacts',
        artKind: 'note',
        snip: 'Lists, drafts, and emails you keep land here',
        accent,
      }];
    }
    return rows.slice(0, MAX_CARDS).map((item) => ({
      kind: 'artifact',
      id: item.id,
      title: item.title,
      artKind: item.kind,
      snip: String(item.body || '').replace(/\s+/g, ' ').trim(),
      accent,
    }));
  }

  function syncArtifactCards() {
    const prevId = state.cards[state.subIndex]?.id;
    state.cards = artifactCards();
    if (prevId) {
      const idx = state.cards.findIndex((c) => c.id === prevId);
      if (idx >= 0) state.subIndex = idx;
    } else {
      state.subIndex = Math.min(state.subIndex, Math.max(0, state.cards.length - 1));
    }
    renderSubcards();
    startSubFlip();
  }

  async function openArtifactItem(id) {
    const item = artifactUi.items.find((row) => row.id === id);
    if (!item) return;
    const gen = nextMotion();
    artifactUi.selectedId = item.id;
    artifactUi.view = 'detail';
    stopSubFlip();
    windowEl.classList.remove('open');
    state.paneOpen = true;
    state.isOpen = true;
    const el = paneEl();
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    el.classList.remove('is-in', 'is-out');
    el.classList.add('is-artifacts');
    bindPaneOnce();
    renderArtifactPane();
    root.classList.add('is-pane');
    root.classList.remove('is-dock', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    renderDock();
    await waitFrame();
    if (!isLive(gen)) return;
    el.classList.add('is-in');
  }

  function artifactHeader(subtitle, actions) {
    return (
      `<div class="asp-header">` +
        `<div class="asp-mark">${ICONS.artifacts}</div>` +
        `<div class="asp-titles">` +
          `<div class="asp-name">Artifacts</div>` +
          `<div class="asp-sub">${escapeHtml(subtitle || '')}</div>` +
        `</div>` +
        `<div class="asp-actions">${actions || ''}` +
          `<button type="button" class="asp-icon-btn" data-artifact-action="close" aria-label="Close Artifacts">×</button>` +
        `</div>` +
      `</div>`
    );
  }

  function renderArtifactPane() {
    if (!state.paneOpen) return;
    const el = paneEl();
    el.classList.add('is-artifacts');
    const rows = artifactUi.items || [];
    if (artifactUi.view === 'detail') {
      const item = rows.find((row) => row.id === artifactUi.selectedId) || rows[0];
      if (!item) {
        artifactUi.view = 'list';
      } else {
        el.innerHTML =
          artifactHeader(artifactKindLabel(item.kind), `<button type="button" class="asp-icon-btn" data-artifact-action="back" aria-label="Back">Back</button>`) +
          `<div class="asp-body asp-art-detail">` +
            `<div class="asp-art-kicker">${escapeHtml(artifactKindLabel(item.kind))}</div>` +
            `<div class="asp-art-title">${escapeHtml(item.title)}</div>` +
            `<pre class="asp-art-body">${escapeHtml(item.body)}</pre>` +
            `<button type="button" class="asp-btn asp-btn-quiet" data-artifact-action="copy">Copy</button>` +
          `</div>`;
        return;
      }
    }
    let listHtml;
    if (!rows.length) {
      listHtml =
        `<div class="asp-inbox-empty">` +
          `<p class="asp-empty">Nothing saved yet</p>` +
          `<p class="asp-hint">Lists, drafts, and emails you keep land here — word for word.</p>` +
        `</div>`;
    } else {
      listHtml = `<ul class="asp-inbox asp-art-list">${rows.map((item) => (
        `<li>` +
          `<button type="button" class="asp-row" data-artifact-action="open" data-id="${escapeHtml(item.id)}">` +
            `<span class="asp-row-from">${escapeHtml(item.title)}</span>` +
            `<span class="asp-row-time">${escapeHtml(formatArtDate(item.updatedAt))}</span>` +
            `<span class="asp-row-subject">${escapeHtml(artifactKindLabel(item.kind))}</span>` +
            `<span class="asp-row-snip">${escapeHtml(truncate(String(item.body || '').replace(/\s+/g, ' '), 48))}</span>` +
          `</button>` +
        `</li>`
      )).join('')}</ul>`;
    }
    el.innerHTML =
      artifactHeader(rows.length ? `${rows.length} saved` : 'Empty', '') +
      `<div class="asp-body">${listHtml}</div>`;
  }

  function setArtifacts(store, opts) {
    const items = Array.isArray(store?.items) ? store.items : (Array.isArray(store) ? store : window.JuneArtifacts?.list?.() || []);
    artifactUi.items = items.slice();
    const focusId = String(opts?.focusId || '').trim();
    if (focusId) {
      showArtifacts({ focusId });
      return;
    }
    if (state.kind === 'artifacts' && state.isOpen && !state.paneOpen) syncArtifactCards();
    if (state.paneOpen && state.kind === 'artifacts') renderArtifactPane();
  }

  async function showArtifacts({ focusId, stayOpen } = {}) {
    ensureInstalled('artifacts');
    if (!installedIds.has('artifacts')) return false;
    if (state.paneOpen && state.kind === 'artifacts') {
      await closePane({ keepDock: true, silent: true });
    }
    state.autoClose = !stayOpen;
    const targetId = String(focusId || '').trim();
    await open('artifacts');
    syncArtifactCards();
    if (targetId) {
      const dest = state.cards.findIndex((c) => c.id === targetId);
      if (dest >= 0) {
        stopSubFlip();
        state.subIndex = dest;
        renderSubcards();
      }
    }
    return true;
  }

  async function playYouTube({ videoId, title, thumbnail } = {}) {
    const id = String(videoId || '').trim();
    if (!id) return false;
    const same = youtubeUi.videoId === id;
    youtubeUi.videoId = id;
    youtubeUi.title = String(title || youtubeUi.title || '').trim();
    youtubeUi.thumbnail = String(thumbnail || youtubeUi.thumbnail || youtubeThumbUrl(id));
    if (!same) youtubeUi.playing = false;
    clearTimeout(fadeTimer);

    const loadPromise = window.JuneYouTubePlayer?.load?.(id, {
      onStateChange({ playing }) {
        youtubeUi.playing = Boolean(playing);
        renderSubcards();
      },
    });

    open('youtube').then(() => {
      state.cards = [nowPlayingCard()];
      state.subIndex = 0;
      renderSubcards();
    }).catch(() => {});

    try { await loadPromise; } catch {}
    return true;
  }

  function pauseYouTube() {
    if (!youtubeUi.videoId) return false;
    window.JuneYouTubePlayer?.pause?.();
    youtubeUi.playing = false;
    renderSubcards();
    return true;
  }

  function resumeYouTube() {
    if (!youtubeUi.videoId) return false;
    window.JuneYouTubePlayer?.resume?.();
    youtubeUi.playing = true;
    clearTimeout(fadeTimer);
    open('youtube');
    state.cards = [nowPlayingCard()];
    state.subIndex = 0;
    renderSubcards();
    return true;
  }

  function stopYouTube() {
    window.JuneYouTubePlayer?.stop?.();
    youtubeUi.playing = false;
    youtubeUi.videoId = '';
    youtubeUi.title = '';
    youtubeUi.thumbnail = '';
    if (state.kind === 'youtube' && state.isOpen) {
      state.cards = [idleMusicCard(CATALOG.youtube)];
      state.subIndex = 0;
      renderSubcards();
    }
    return true;
  }

  async function install(appId) {
    const id = String(appId || '').trim();
    const spec = CATALOG[id];
    if (!spec) return false;
    if (installedIds.has(id)) {
      open(id);
      return true;
    }
    if (state.installing) return false;
    state.installing = true;
    root.classList.add('is-installing');
    try {
      await animateInstall(spec);
      open(id);
      return true;
    } finally {
      state.installing = false;
      root.classList.remove('is-installing');
    }
  }

  async function animateInstall(spec) {
    clearTimeout(fadeTimer);
    clearTimeout(hideTimer);
    clearTimeout(openTimer);
    stopDockFlip();
    stopSubFlip();
    if (state.paneOpen) await closePane({ keepDock: true, silent: true });

    state.active = true;
    state.isOpen = false;
    windowEl.classList.remove('open');
    showRoot({ miniOrb: true });
    if (!state.dockIcons.length) buildDock();
    renderDock();
    state.introPlayed = true;

    installedIds.add(spec.id);
    saveInstalled();
    buildDock();
    const apps = getApps();
    const idx = apps.findIndex((a) => a.id === spec.id);
    state.cursor = idx < 0 ? 0 : idx;
    state.index = state.cursor;
    renderDock();

    const iconEl = state.dockIcons[idx];
    if (iconEl) iconEl.classList.add('is-arriving');

    if (prefersReducedMotion()) {
      if (iconEl) iconEl.classList.remove('is-arriving');
      renderDock();
      return;
    }

    await playFlyer(spec, iconEl);
    if (iconEl) {
      iconEl.classList.remove('is-arriving');
      iconEl.classList.add('is-landed');
      renderDock();
      await wait(480);
      iconEl.classList.remove('is-landed');
    }
  }

  function playFlyer(spec, targetEl) {
    return new Promise((resolve) => {
      const host = voiceSection || document.body;
      const flyer = document.createElement('div');
      flyer.className = 'app-stack-flyer';
      flyer.setAttribute('aria-hidden', 'true');
      flyer.innerHTML =
        `<div class="asf-ring">` +
          `<svg viewBox="0 0 48 48">` +
            `<circle class="asf-track" cx="24" cy="24" r="20"></circle>` +
            `<circle class="asf-prog" cx="24" cy="24" r="20"></circle>` +
          `</svg>` +
          `<div class="asf-icon">${ICONS[spec.icon] || ICONS.memory}</div>` +
        `</div>` +
        `<div class="asf-name">${escapeHtml(spec.name)}</div>` +
        `<div class="asf-status">Downloading…</div>`;
      host.appendChild(flyer);

      const hostRect = host.getBoundingClientRect();
      flyer.style.left = `${Math.max(12, hostRect.width / 2 - 40)}px`;
      flyer.style.top = `${Math.max(16, hostRect.height * 0.34)}px`;

      const status = flyer.querySelector('.asf-status');
      const finish = () => {
        flyer.remove();
        resolve();
      };

      requestAnimationFrame(() => {
        flyer.classList.add('is-in');
      });

      wait(920).then(() => {
        if (status) status.textContent = 'Installing…';
        flyer.classList.add('is-flying');
        if (targetEl) {
          const fr = flyer.getBoundingClientRect();
          const tr = targetEl.getBoundingClientRect();
          const dx = (tr.left + tr.width / 2) - (fr.left + fr.width / 2);
          const dy = (tr.top + tr.height / 2) - (fr.top + fr.height / 2);
          flyer.style.transform = `translate(${dx}px, ${dy}px) scale(0.38)`;
          flyer.style.opacity = '0.2';
        }
        return wait(560);
      }).then(() => {
        flyer.classList.add('is-done');
        return wait(160);
      }).then(finish).catch(finish);
    });
  }

  function hidePaneEl() {
    const el = paneEl();
    el.classList.remove('is-in', 'is-out', 'is-artifacts');
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    root.classList.remove('is-pane');
    state.paneOpen = false;
  }

  function preparePane(appId) {
    state.paneOpen = true;
    state.isOpen = true;
    stopDockFlip();
    stopSubFlip();
    windowEl.classList.remove('open');
    const el = paneEl();
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    el.classList.remove('is-in', 'is-out');
    bindPaneOnce();
    if (appId === 'gmail') {
      gmailUi.view = 'home';
      gmailUi.selected = null;
      gmailUi.notice = '';
      gmailUi.loading = true;
      gmailUi.status = null;
      paneEl().classList.remove('is-artifacts');
      renderGmailPane();
      refreshGmail();
    }
    if (appId === 'artifacts') {
      artifactUi.view = 'list';
      artifactUi.selectedId = '';
      paneEl().classList.add('is-artifacts');
      renderArtifactPane();
    }
  }

  function openPane(appId) {
    preparePane(appId);
    root.classList.add('is-pane');
    root.classList.remove('is-dock', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    renderDock();
    paneEl().classList.add('is-in');
  }

  async function closePane(opts) {
    const gen = (opts && opts.gen) || nextMotion();
    const keepDock = opts && opts.keepDock;
    const el = paneEl();
    stopGmailPoll();
    el.classList.remove('is-in');
    el.classList.add('is-out');
    await wait(motionMs(220));
    if (!isLive(gen)) return;

    hidePaneEl();
    if (opts && opts.restoreStack) {
      state.isOpen = true;
      state.kind = 'gmail';
      root.classList.remove('is-pane', 'is-dock');
      root.classList.add('is-mail');
      setVoiceActive(true);
      moveOrbToCorner(true);
      renderDock();
      syncGmailCards();
      return;
    }
    state.isOpen = false;
    const stayDock = keepDock || installedIds.size;
    if (stayDock) {
      root.classList.add('is-dock');
      root.classList.remove('is-pane', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
      setVoiceActive(false);
      moveOrbToCorner(false);
    }
    renderDock();
    if (!stayDock) hideRoot();
  }

  function bindPaneOnce() {
    const el = paneEl();
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', onPaneClick);
    el.addEventListener('submit', onPaneSubmit);
    el.addEventListener('input', (e) => {
      if (gmailUi.view !== 'compose') return;
      const form = e.target.closest('[data-gmail-form="compose"]');
      if (!form) return;
      gmailUi.draft = {
        to: form.querySelector('[name="gmail-to"]')?.value || '',
        subject: form.querySelector('[name="gmail-subject"]')?.value || '',
        body: form.querySelector('[name="gmail-body"]')?.value || '',
      };
    });
  }

  function onPaneClick(e) {
    const artBtn = e.target.closest('[data-artifact-action]');
    if (artBtn && paneEl().contains(artBtn)) {
      const action = artBtn.getAttribute('data-artifact-action');
      if (action === 'close') {
        state.autoClose = false;
        closePane({ keepDock: true });
        return;
      }
      if (action === 'back') {
        artifactUi.view = 'list';
        artifactUi.selectedId = '';
        renderArtifactPane();
        return;
      }
      if (action === 'open') {
        const id = artBtn.getAttribute('data-id') || '';
        artifactUi.selectedId = id;
        artifactUi.view = 'detail';
        renderArtifactPane();
        return;
      }
      if (action === 'copy') {
        const item = artifactUi.items.find((row) => row.id === artifactUi.selectedId);
        const text = item?.body || '';
        if (text) {
          navigator.clipboard?.writeText(text).catch(() => {});
        }
        return;
      }
      return;
    }
    const btn = e.target.closest('[data-gmail-action]');
    if (!btn || !paneEl().contains(btn)) return;
    const action = btn.getAttribute('data-gmail-action');
    if (action === 'close') {
      state.autoClose = false;
      closePane();
      return;
    }
    if (action === 'connect') {
      window.open('/api/gmail/auth', '_blank', 'noopener');
      gmailUi.notice = 'Finish signing in, then this window will catch up.';
      renderGmailPane();
      startGmailPoll();
      return;
    }
    if (action === 'refresh') {
      refreshGmail();
      return;
    }
    if (action === 'compose') {
      gmailUi.view = 'compose';
      gmailUi.notice = '';
      gmailUi.draft = gmailUi.draft || { to: '', subject: '', body: '' };
      renderGmailPane();
      const to = paneEl().querySelector('[name="gmail-to"]');
      if (to) to.focus();
      return;
    }
    if (action === 'back') {
      closePane({ restoreStack: true });
      return;
    }
    if (action === 'open-msg') {
      const id = btn.getAttribute('data-id') || '';
      state.autoClose = false;
      gmailUi.selected = gmailUi.messages.find((m) => m.id === id) || null;
      gmailUi.view = 'message';
      renderGmailPane();
    }
  }

  function onPaneSubmit(e) {
    const form = e.target;
    if (!form || form.getAttribute('data-gmail-form') !== 'compose') return;
    e.preventDefault();
    sendGmailCompose(form);
  }

  async function sendGmailCompose(form) {
    if (gmailUi.sending) return;
    const to = String(form.querySelector('[name="gmail-to"]')?.value || '').trim();
    const subject = String(form.querySelector('[name="gmail-subject"]')?.value || '').trim();
    const body = String(form.querySelector('[name="gmail-body"]')?.value || '').trim();
    gmailUi.draft = { to, subject, body };
    if (!to) {
      gmailUi.notice = 'Add a recipient.';
      renderGmailPane();
      return;
    }
    gmailUi.sending = true;
    gmailUi.notice = 'Sending…';
    renderGmailPane();
    try {
      const res = await fetch('/api/gmail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body }),
      });
      if (res.ok) {
        gmailUi.view = 'home';
        gmailUi.notice = 'Sent.';
        gmailUi.draft = { to: '', subject: '', body: '' };
        gmailUi.sending = false;
        renderGmailPane();
        return;
      }
      gmailUi.notice = res.status === 404
        ? 'Ask June to send this — send isn’t wired yet.'
        : 'Couldn’t send. Try again, or ask June.';
    } catch {
      gmailUi.notice = 'Couldn’t send. Ask June to mail this for you.';
    }
    gmailUi.sending = false;
    renderGmailPane();
  }

  function stopGmailPoll() {
    if (gmailUi.pollTimer) {
      clearInterval(gmailUi.pollTimer);
      gmailUi.pollTimer = null;
    }
  }

  function startGmailPoll() {
    stopGmailPoll();
    let ticks = 0;
    gmailUi.pollTimer = setInterval(() => {
      ticks += 1;
      if (ticks > 30) {
        stopGmailPoll();
        return;
      }
      refreshGmail({ silent: true });
    }, 2000);
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return { ok: false, status: res.status, data: null };
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { ok: true, status: res.status, data: null };
      return { ok: true, status: res.status, data: await res.json() };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  function normalizeInbox(data) {
    if (!data) return [];
    const list = data.messages || data.threads || data.inbox || data.items || [];
    if (!Array.isArray(list)) return [];
    return list.slice(0, 24).map((m, i) => {
      const from = m.from || m.sender || m.from_email || m.fromName || 'Unknown';
      return {
        id: String(m.id || m.threadId || m.messageId || i),
        from: String(from),
        subject: String(m.subject || m.title || '(no subject)'),
        snippet: String(m.snippet || m.preview || m.snippet_text || m.text || ''),
        date: String(m.date || m.internalDate || m.received || m.time || ''),
        unread: Boolean(m.unread || m.isUnread || m.unseen),
        body: String(m.body || m.text || m.html || ''),
      };
    });
  }

  function formatMailDate(raw) {
    if (!raw) return '';
    const n = Number(raw);
    const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw).slice(0, 12);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function refreshGmail(opts) {
    const seq = gmailShowSeq;
    const silent = opts && opts.silent;
    if (!silent && state.paneOpen) {
      gmailUi.loading = true;
      renderGmailPane();
    }
    const statusRes = await fetchJson('/api/gmail/status');
    if (seq !== gmailShowSeq) return;
    gmailUi.status = statusRes.data || { configured: false, connected: false };
    if (gmailUi.status.connected) stopGmailPoll();
    gmailUi.messages = [];
    if (gmailUi.status.connected) {
      const inboxRes = await fetchJson('/api/gmail/inbox');
      if (seq !== gmailShowSeq) return;
      if (inboxRes.ok && inboxRes.data) {
        gmailUi.messages = normalizeInbox(inboxRes.data);
      }
    }
    gmailUi.loading = false;
    if (seq !== gmailShowSeq) return;
    if (state.kind === 'gmail' && state.isOpen && !state.paneOpen) syncGmailCards();
    if (state.paneOpen && state.kind === 'gmail') renderGmailPane();
  }

  function messagesToCards(messages) {
    return (messages || []).slice(0, MAX_CARDS).map((m) => ({
      kind: 'mail',
      id: m.id,
      title: mailFromName(m.from),
      sub: m.subject || '(no subject)',
      snip: m.snippet || '',
      unread: Boolean(m.unread),
      accent: '#ea4335',
    }));
  }

  function syncGmailCards() {
    const prevId = state.cards[state.subIndex]?.id;
    const status = gmailUi.status || {};
    const accent = (CATALOG.gmail && CATALOG.gmail.accent) || '#ea4335';
    if (status.connected) {
      const msgs = gmailUi.messages || [];
      state.cards = msgs.length
        ? messagesToCards(msgs)
        : [{
          kind: 'mail',
          title: 'Inbox',
          sub: status.email || 'Gmail',
          snip: 'No messages yet',
          accent,
        }];
    } else {
      state.cards = [{
        kind: 'mail',
        action: 'connect',
        title: 'Gmail',
        sub: 'Not connected',
        snip: 'Tap to connect your inbox',
        accent,
      }];
    }
    if (prevId) {
      const idx = state.cards.findIndex((c) => c.id === prevId);
      if (idx >= 0) state.subIndex = idx;
    } else {
      state.subIndex = Math.min(state.subIndex, Math.max(0, state.cards.length - 1));
    }
    renderSubcards();
    startSubFlip();
  }

  async function shuffleToMail(id) {
    const n = state.cards.length;
    if (!n) return;
    const dest = state.cards.findIndex((c) => c.id === id);
    stopSubFlip();
    if (dest < 0) {
      renderSubcards();
      return;
    }
    if (state.subIndex === dest) {
      renderSubcards();
      return;
    }
    const gen = state.motionGen;
    const stepMs = motionMs(Math.min(SUB_FLIP_MS, 220));
    while (isLive(gen) && state.subIndex !== dest) {
      const delta = shortestDelta(state.subIndex, dest, n);
      state.subIndex = wrapIndex(state.subIndex + (delta > 0 ? 1 : -1), n);
      renderSubcards();
      await wait(stepMs);
    }
  }

  /**
   * AI found mail: flip the stack to Gmail, land on the matching email,
   * linger, then finish() auto-closes back to the dock.
   */
  async function showMail({ messages, focusId, searching, openMessage, stayOpen } = {}) {
    ensureInstalled('gmail');
    if (!installedIds.has('gmail')) return false;
    if (state.paneOpen && state.kind === 'gmail' && !openMessage) {
      await closePane({ restoreStack: true });
    }
    const seq = ++gmailShowSeq;
    state.autoClose = !stayOpen;
    const list = Array.isArray(messages) ? normalizeInbox({ messages }) : [];
    const targetId = String(focusId || list[0]?.id || '').trim();
    if (list.length) {
      const byId = new Map(gmailUi.messages.map((m) => [m.id, m]));
      for (const m of list) byId.set(m.id, { ...(byId.get(m.id) || {}), ...m });
      gmailUi.messages = [...byId.values()];
    }

    await open('gmail');
    if (seq !== gmailShowSeq) return false;
    // Invalidate the fire-and-forget inbox refresh openApp started.
    gmailShowSeq += 1;
    const live = gmailShowSeq;

    if (searching && !list.length) {
      if (!state.cards.length) {
        state.cards = [{
          kind: 'mail',
          title: 'Gmail',
          sub: 'Inbox',
          snip: 'Looking…',
          accent: (CATALOG.gmail && CATALOG.gmail.accent) || '#ea4335',
        }];
        state.subIndex = 0;
        renderSubcards();
      }
      return true;
    }

    if (list.length) {
      state.cards = messagesToCards(list);
      if (state.subIndex >= state.cards.length) state.subIndex = 0;
      renderSubcards();
      if (targetId) await shuffleToMail(targetId);
      if (live !== gmailShowSeq) return false;
      if (openMessage && targetId) await openMailMessage(targetId);
      return true;
    }

    if (targetId) {
      if (!state.cards.length) syncGmailCards();
      await shuffleToMail(targetId);
      if (live !== gmailShowSeq) return false;
      if (openMessage) await openMailMessage(targetId);
    } else {
      syncGmailCards();
    }
    return true;
  }

  async function showSendConfirm({ to, address, subject, body, cc } = {}) {
    ensureInstalled('gmail');
    if (!installedIds.has('gmail')) return false;
    gmailUi.draft = {
      to: to || address || '',
      subject: subject || '',
      body: body || '',
      cc: cc || '',
    };
    gmailUi.confirmAddress = address || to || '';
    gmailUi.view = 'confirm';
    gmailUi.notice = '';
    state.autoClose = false;
    await open('gmail');
    const gen = nextMotion();
    stopSubFlip();
    windowEl.classList.remove('open');
    state.paneOpen = true;
    state.isOpen = true;
    const el = paneEl();
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    el.classList.remove('is-in', 'is-out');
    bindPaneOnce();
    renderGmailPane();
    root.classList.add('is-pane');
    root.classList.remove('is-dock', 'is-mail', 'is-music-yt', 'is-brainstorm-app', 'is-artifacts');
    renderDock();
    await waitFrame();
    if (!isLive(gen)) return false;
    el.classList.add('is-in');
    return true;
  }

  function clearSendConfirm() {
    if (gmailUi.view !== 'confirm') return;
    gmailUi.view = 'home';
    gmailUi.confirmAddress = '';
    state.autoClose = true;
    closePane({ keepDock: true });
  }

  function markSendSent({ address, to, subject } = {}) {
    gmailUi.view = 'confirm';
    gmailUi.confirmAddress = address || to || gmailUi.confirmAddress;
    gmailUi.notice = 'Sent.';
    if (subject) gmailUi.draft = { ...(gmailUi.draft || {}), subject };
    if (state.paneOpen) renderGmailPane();
    state.autoClose = true;
    window.setTimeout(() => {
      if (gmailUi.view === 'confirm') closePane({ keepDock: true });
    }, 1600);
  }

  function gmailHeader(subtitle, actions) {
    return (
      `<div class="asp-header">` +
        `<div class="asp-mark">${ICONS.gmail}</div>` +
        `<div class="asp-titles">` +
          `<div class="asp-name">Gmail</div>` +
          `<div class="asp-sub">${escapeHtml(subtitle || '')}</div>` +
        `</div>` +
        `<div class="asp-actions">${actions || ''}` +
          `<button type="button" class="asp-icon-btn" data-gmail-action="close" aria-label="Close Gmail">×</button>` +
        `</div>` +
      `</div>`
    );
  }

  function actionBtn(action, label) {
    const aria = action === 'refresh' ? 'Refresh inbox' : action === 'compose' ? 'Compose' : label;
    return `<button type="button" class="asp-icon-btn" data-gmail-action="${action}" aria-label="${escapeHtml(aria)}" title="${escapeHtml(aria)}">${label}</button>`;
  }

  function renderGmailPane() {
    if (!state.paneOpen) return;
    const el = paneEl();
    const status = gmailUi.status || {};
    const email = status.email || '';
    const connected = Boolean(status.connected);
    const notice = gmailUi.notice
      ? `<div class="asp-notice">${escapeHtml(gmailUi.notice)}</div>`
      : '';

    if (gmailUi.view === 'confirm') {
      const d = gmailUi.draft || { to: '', subject: '', body: '' };
      const who = gmailUi.confirmAddress || d.to || '';
      el.innerHTML =
        gmailHeader('Send?') +
        `<div class="asp-body asp-confirm">` +
          notice +
          `<div class="asp-confirm-kicker">Sending to</div>` +
          `<div class="asp-confirm-email">${escapeHtml(who)}</div>` +
          (d.subject ? `<div class="asp-confirm-subject">${escapeHtml(d.subject)}</div>` : '') +
          (d.body ? `<div class="asp-msg-body">${escapeHtml(d.body)}</div>` : '') +
          `<div class="asp-confirm-hint">Say yes to send, or no to cancel</div>` +
        `</div>`;
      return;
    }

    if (gmailUi.view === 'compose') {
      const d = gmailUi.draft || { to: '', subject: '', body: '' };
      el.innerHTML =
        gmailHeader(email || 'New message', actionBtn('back', 'Back')) +
        `<div class="asp-body">` +
          notice +
          `<form class="asp-compose" data-gmail-form="compose">` +
            `<label class="asp-field">To<input name="gmail-to" type="email" autocomplete="off" required placeholder="name@email.com" value="${escapeHtml(d.to)}"></label>` +
            `<label class="asp-field">Subject<input name="gmail-subject" type="text" placeholder="Subject" value="${escapeHtml(d.subject)}"></label>` +
            `<label class="asp-field asp-field-body">Message<textarea name="gmail-body" rows="5" placeholder="Write a note…">${escapeHtml(d.body)}</textarea></label>` +
            `<button type="submit" class="asp-btn" ${gmailUi.sending ? 'disabled' : ''}>${gmailUi.sending ? 'Sending…' : 'Send'}</button>` +
          `</form>` +
        `</div>`;
      return;
    }

    if (gmailUi.view === 'message' && gmailUi.selected) {
      const m = gmailUi.selected;
      el.innerHTML =
        gmailHeader(truncate(m.subject, 28), actionBtn('back', 'Inbox')) +
        `<div class="asp-body asp-msg">` +
          `<div class="asp-msg-from">${escapeHtml(m.from)}</div>` +
          `<div class="asp-msg-subject">${escapeHtml(m.subject)}</div>` +
          `<div class="asp-msg-meta">${escapeHtml(formatMailDate(m.date))}</div>` +
          `<div class="asp-msg-body">${escapeHtml(m.body || m.snippet || 'Ask June to read this email.')}</div>` +
        `</div>`;
      return;
    }

    const tools = connected
      ? actionBtn('compose', 'New') + actionBtn('refresh', '↻')
      : '';

    if (gmailUi.loading && !gmailUi.status) {
      el.innerHTML = gmailHeader('Opening…', '') + `<div class="asp-body"><p class="asp-empty">Loading Gmail…</p></div>`;
      return;
    }

    if (!connected) {
      const copy = status.configured === false
        ? 'June can put Gmail on this stack. Connect your account to read mail here.'
        : 'Connect Gmail to peek at your inbox without leaving June.';
      el.innerHTML =
        gmailHeader('Not connected', '') +
        `<div class="asp-body asp-connect">` +
          `<div class="asp-connect-mark">${ICONS.gmail}</div>` +
          `<p class="asp-empty">${escapeHtml(copy)}</p>` +
          notice +
          `<button type="button" class="asp-btn asp-btn-gmail" data-gmail-action="connect">Connect Gmail</button>` +
        `</div>`;
      return;
    }

    const rows = gmailUi.messages;
    let listHtml;
    if (!rows.length) {
      listHtml =
        `<div class="asp-inbox-empty">` +
          `<p class="asp-empty">Inbox — ask June to check your email.</p>` +
          `<p class="asp-hint">Connected as ${escapeHtml(email || 'your Gmail')}</p>` +
        `</div>`;
    } else {
      listHtml = `<ul class="asp-inbox">${rows.map((m) => (
        `<li>` +
          `<button type="button" class="asp-row${m.unread ? ' is-unread' : ''}" data-gmail-action="open-msg" data-id="${escapeHtml(m.id)}">` +
            `<span class="asp-row-from">${escapeHtml(truncate(m.from, 22))}</span>` +
            `<span class="asp-row-time">${escapeHtml(formatMailDate(m.date))}</span>` +
            `<span class="asp-row-subject">${escapeHtml(truncate(m.subject, 36))}</span>` +
            `<span class="asp-row-snip">${escapeHtml(truncate(m.snippet, 48))}</span>` +
          `</button>` +
        `</li>`
      )).join('')}</ul>`;
    }

    el.innerHTML =
      gmailHeader(email || 'Inbox', tools) +
      `<div class="asp-body">` +
        notice +
        (gmailUi.loading ? `<p class="asp-hint">Refreshing…</p>` : '') +
        listHtml +
      `</div>`;
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;

    if (e.key === 'Escape' && state.paneOpen) {
      closePane();
      return;
    }
    if (state.isOpen && useMusicYt() && !state.paneOpen) {
      if (e.key === 'Escape') {
        stopSubFlip();
        windowEl.classList.remove('open');
        state.isOpen = false;
        root.classList.remove('is-music-yt');
        setDockOnly();
        e.preventDefault();
        return;
      }
      return;
    }
    if (state.isOpen && useBrainstorm() && !state.paneOpen) {
      if (e.key === 'Escape') {
        stopSubFlip();
        windowEl.classList.remove('open');
        state.isOpen = false;
        root.classList.remove('is-brainstorm-app');
        setDockOnly();
        e.preventDefault();
        return;
      }
      return;
    }
    if (state.isOpen && useMail() && !state.paneOpen) {
      if (e.key === 'Escape') {
        stopSubFlip();
        windowEl.classList.remove('open');
        state.isOpen = false;
        state.cards = [];
        ensureSubcards();
        root.classList.remove('is-mail');
        setDockOnly();
        e.preventDefault();
        return;
      }
      if (tag === 'button') return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        stepSub(1);
        e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        stepSub(-1);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        const card = state.cards[state.subIndex];
        if (card && card.id) {
          state.autoClose = false;
          openMailMessage(card.id);
        }
        else if (card && card.action === 'connect') {
          window.open('/api/gmail/auth', '_blank', 'noopener');
          startGmailPoll();
        }
        e.preventDefault();
      }
      return;
    }
    if (tag === 'button') return;
    if (!state.active || state.paneOpen || state.isOpen || state.installing) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      stepBy(1);
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      stepBy(-1);
      e.preventDefault();
    } else if (e.key === 'Enter') {
      activateApp(selectedApp());
      e.preventDefault();
    }
  });

  if (navPrev) {
    navPrev.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      stepBy(1);
    });
  }
  if (navNext) {
    navNext.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      stepBy(-1);
    });
  }
  if (navAll) {
    navAll.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.paneOpen || state.installing) return;
      state.browsing = !state.browsing;
      renderDock();
    });
  }

  buildDock();
  renderDock();
  if (installedIds.size) {
    const apps = getApps();
    const persistAt = apps.findIndex((a) => a.persistent);
    if (persistAt >= 0) {
      state.cursor = persistAt;
      state.index = persistAt;
    }
    setDockOnly();
  }

  fetch('/api/gmail/status', { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data?.connected || data?.installed) ensureInstalled('gmail');
    })
    .catch(() => {});

  window.JuneAppStack = {
    start,
    setCards,
    pushCards,
    finish,
    reset,
    install,
    open,
    showMail,
    showSendConfirm,
    clearSendConfirm,
    markSendSent,
    isInstalled,
    listInstalled,
    ensureInstalled,
    playYouTube,
    pauseYouTube,
    resumeYouTube,
    stopYouTube,
    setBrainstorm,
    setArtifacts,
    showArtifacts,
  };
})();
