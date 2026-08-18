(function () {
  const STT_RATE = 16000;
  const TTS_RATE = 24000;
  const CHUNK_SAMPLES = STT_RATE * 0.08;

  const orb = document.querySelector('.orb');
  const pauseStatus = document.querySelector('.pause-status');
  const pauseIcon = document.querySelector('.pause-icon');
  const appCard = document.getElementById('appCard') || document.querySelector('main.card');
  const brainstormStatus = document.getElementById('brainstormStatus');
  const chatLog = document.getElementById('chatLog');
  const chatStatus = document.getElementById('chatStatus');
  const spinner = document.getElementById('spinner');
  const statusText = document.getElementById('statusText');
  const agentActivityList = document.getElementById('agentActivityList');
  const interim = document.getElementById('interim');
  const typeInput = document.getElementById('typeInput');
  const sendBtn = document.getElementById('sendBtn');
  const typeBar = document.querySelector('.type-bar');
  const textToggle = document.getElementById('textToggle');
  const settingsWheel = document.querySelector('.setting-wheel');
  const settingsOverlay = document.getElementById('settingsOverlay');
  const settingsClose = document.getElementById('settingsClose');
  const ttsProviderSelect = document.getElementById('ttsProviderSelect');
  const elevenLabsModelSelect = document.getElementById('elevenLabsModelSelect');
  const elevenLabsModelRow = document.getElementById('elevenLabsModelRow');
  const gmailStatusHint = document.getElementById('gmailStatusHint');
  const gmailConnectLink = document.getElementById('gmailConnectLink');
  const muteBtn = document.getElementById('muteBtn');
  const historyBtn = document.getElementById('historyBtn');
  const chatSidebar = document.getElementById('chatSidebar');
  const chatSidebarList = document.getElementById('chatSidebarList');
  const chatSidebarEmpty = document.getElementById('chatSidebarEmpty');
  const chatSidebarClose = document.getElementById('chatSidebarClose');
  const chatSidebarBackdrop = document.getElementById('chatSidebarBackdrop');

  const mem = window.JuneMemory;
  // Always resolve at call-time so a missing/late script can't permanently no-op saves
  function chatsApi() {
    if (window.JuneChatHistory) return window.JuneChatHistory;
    // Minimal inline fallback if chat-history.js failed to load
    const KEY = 'june_saved_chats';
    const api = {
      list() {
        try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
      },
      save(record) {
        if (!record?.session_id) return api.list();
        const next = api.list().filter((c) => c.session_id !== record.session_id);
        next.unshift(record);
        localStorage.setItem(KEY, JSON.stringify(next.slice(0, 50)));
        return next;
      },
      get(id) { return api.list().find((c) => c.session_id === id) || null; },
      formatTime(iso) {
        try {
          return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch { return String(iso || ''); }
      },
    };
    window.JuneChatHistory = api;
    console.warn('[June] JuneChatHistory missing — using inline fallback');
    return api;
  }

  function buildPastChatsPayload(limit = 15) {
    return chatsApi().list().slice(0, limit).map((c) => ({
      session_id: c.session_id,
      title: c.title,
      main_summary: c.main_summary,
      end_time: c.end_time,
      topics: c.extracted_context?.topics_detected || [],
      previewTurns: Array.isArray(c.chats)
        ? c.chats.slice(-6).map((t) => ({
            role: t.role,
            content: String(t.content || '').slice(0, 180),
          }))
        : [],
    }));
  }

  let currentMemory = mem.load();
  let currentTtsProvider = localStorage.getItem('june_tts_provider') || 'elevenlabs';
  let currentElevenLabsModel = localStorage.getItem('june_elevenlabs_model') || 'eleven_flash_v2_5';
  let availableTtsProviders = ['browser'];
  let availableElevenLabsModels = [
    { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (realtime)' },
    { id: 'eleven_v3', label: 'Eleven v3 (expressive)' },
  ];
  let activeSessionId = null;

  let ws = null;
  let running = false;
  let paused = false;
  let micMuted = false;

  let micStream = null;
  let inCtx = null;
  let workletNode = null;
  let resampleBuffer = [];

  let outCtx = null;
  let nextTime = 0;
  let liveSources = new Set();
  let playTurn = null;
  /** Last turnId that had a chunk scheduled — used to insert a seam between lines. */
  let lastScheduledTurn = null;
  /** Small pause between different spoken lines so they never overlap. */
  const AUDIO_QUEUE_GAP_SEC = 0.4;
  const droppedTurns = new Set();

  let thinkingStart = null;
  let statusMode = null; // 'thinking' | 'listening' | 'speaking' | 'brainstorm' | null
  let brainstormPhase = 'off';
  let brainstormDumpMsg = null;
  /** @type {Map<string, { title: string, meta: string, desc: string, done: boolean, hideAt: number|null }>} */
  const agentCards = new Map();
  let agentRenderTimer = null;
  let currentAssistantMsg = null;
  let lastAssistantMsg = null;
  let assistantTurnId = null;
  let wordIndex = 0;
  let lastUserMsgText = '';
  let lastUserMsgAt = 0;
  /** @type {Map<string, array>} cards that arrived before the assistant bubble finalized */
  const pendingCardsByTurn = new Map();

  let analyserNode = null;
  let analyserData = null;
  let userRms = 0;
  let smoothedRms = 0;
  let orbRaf = null;
  let orbState = 'idle'; // 'idle' | 'listening' | 'speaking' | 'thinking'

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/voice`;
  }

  function syncInstalledApps() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const apps = window.JuneAppStack?.listInstalled?.() || [];
    ws.send(JSON.stringify({ type: 'installed_apps', installedApps: apps }));
  }

  async function startVoice(on) {
    if (running) return;
    running = true;

    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.onmessage = onServerMessage;
    ws.onclose = () => stopVoice();
    ws.onerror = () => stopVoice();
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.addEventListener('error', rej, { once: true });
    });

    currentMemory = mem.startSession();
    activeSessionId = mem.getSessionId() || ('local_' + Date.now().toString(36));
    sessionStartedAtIso = new Date().toISOString();
    const ctx = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    ws.send(JSON.stringify({
      type: 'init',
      memory: currentMemory,
      context: ctx,
      ttsProvider: currentTtsProvider,
      elevenLabsModel: currentElevenLabsModel,
      history: clientHistory,
      pastChats: buildPastChatsPayload(),
      installedApps: window.JuneAppStack?.listInstalled?.() || [],
      artifacts: window.JuneArtifacts?.snapshot?.() || { version: 1, items: [] },
      debug:
        Boolean(window.JuneAgentInspector?.isOpen?.()) ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1',
    }));
    window.setTimeout(syncInstalledApps, 600);
    window.JuneAgentInspector?.onWsReady?.();

    if (!on) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    }

    inCtx = new AudioContext();
    await inCtx.audioWorklet.addModule(captureWorkletUrl());
    const source = inCtx.createMediaStreamSource(micStream);
    const captureRate = inCtx.sampleRate;
    workletNode = new AudioWorkletNode(inCtx, 'capture-processor');
    workletNode.port.onmessage = (e) => {
      if (!running) return;
      onMicFrame(e.data, captureRate);
    };
    source.connect(workletNode);

    outCtx = new AudioContext({ sampleRate: TTS_RATE });
    // Browsers (especially Chrome) may auto-suspend an AudioContext even when
    // created inside a user-gesture handler.  Resume immediately so the first
    // audio chunk isn't silently dropped.
    outCtx.resume().catch(() => {});
    analyserNode = outCtx.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.6;
    analyserData = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.connect(outCtx.destination);
    nextTime = 0;

    if (!on) {
      setOrbActive(true);
      showStatus('listening');
    }
  }

  function stopVoice() {
    if (!running) return;
    // Persist before tearing down the socket — server chat_saved often loses the race.
    persistCurrentChatLocally();
    running = false;
    paused = false;
    micMuted = false;
    if (muteBtn) { muteBtn.classList.remove('is-muted'); muteBtn.setAttribute('aria-label', 'Mute microphone'); }
    stopOrbLoop();
    flushPlayback();
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (inCtx) inCtx.close();
    if (outCtx) outCtx.close();
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    ws = null;
    micStream = inCtx = outCtx = workletNode = null;
    analyserNode = null;
    analyserData = null;
    userRms = 0;
    smoothedRms = 0;
    resampleBuffer = [];
    setOrbActive(false);
    hideStatus();
    clearInterim();
    brainstormPhase = 'off';
    brainstormDumpMsg = null;
    appCard?.classList.remove('is-brainstorm');
    if (brainstormStatus) brainstormStatus.hidden = true;
    window.JuneAppStack?.reset();
  }

  function onMicFrame(float32, inRate) {
    if (!running || paused || micMuted || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Track amplitude for orb
    let sq = 0;
    for (let i = 0; i < float32.length; i++) sq += float32[i] * float32[i];
    userRms = Math.sqrt(sq / float32.length);
    for (let i = 0; i < float32.length; i++) resampleBuffer.push(float32[i]);
    const ratio = inRate / STT_RATE;
    const needed = Math.floor(resampleBuffer.length / ratio);
    if (needed < CHUNK_SAMPLES) return;

    const out = new Int16Array(needed);
    for (let i = 0; i < needed; i++) {
      const s = Math.max(-1, Math.min(1, resampleBuffer[Math.floor(i * ratio)]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    resampleBuffer = resampleBuffer.slice(Math.floor(needed * ratio));
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(out.buffer);
  }

  function onServerMessage(ev) {
    if (ev.data instanceof ArrayBuffer) {
      playAudio(ev.data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        if (msg.ttsProviders) {
          availableTtsProviders = msg.ttsProviders;
          updateTtsProviderOptions();
        }
        if (msg.elevenLabsModels) {
          availableElevenLabsModels = msg.elevenLabsModels;
          updateElevenLabsModelOptions();
        }
        if (msg.ttsProvider) {
          // Prefer the client's saved provider; only adopt server default if we have none.
          if (!localStorage.getItem('june_tts_provider')) {
            currentTtsProvider = msg.ttsProvider;
          }
          if (ttsProviderSelect) ttsProviderSelect.value = currentTtsProvider;
        }
        // Never let server env Flash clobber a user-selected ElevenLabs model.
        if (elevenLabsModelSelect) elevenLabsModelSelect.value = currentElevenLabsModel;
        syncElevenLabsModelVisibility();
        // Re-assert preference if the live session started on a different model.
        if (
          ws &&
          ws.readyState === WebSocket.OPEN &&
          currentTtsProvider === 'elevenlabs' &&
          msg.elevenLabsModel &&
          msg.elevenLabsModel !== currentElevenLabsModel
        ) {
          ws.send(JSON.stringify({ type: 'set_tts_model', model: currentElevenLabsModel }));
        }
        if (
          ws &&
          ws.readyState === WebSocket.OPEN &&
          msg.ttsProvider &&
          msg.ttsProvider !== currentTtsProvider
        ) {
          ws.send(JSON.stringify({ type: 'set_tts_provider', provider: currentTtsProvider }));
        }
        if (msg.gmail?.connected || msg.gmail?.installed) {
          window.JuneAppStack?.ensureInstalled?.('gmail');
        }
        break;
      case 'tts_provider':
        currentTtsProvider = msg.provider;
        localStorage.setItem('june_tts_provider', msg.provider);
        if (ttsProviderSelect) ttsProviderSelect.value = msg.provider;
        if (msg.elevenLabsModel && !localStorage.getItem('june_elevenlabs_model')) {
          currentElevenLabsModel = msg.elevenLabsModel;
        }
        if (elevenLabsModelSelect) elevenLabsModelSelect.value = currentElevenLabsModel;
        syncElevenLabsModelVisibility();
        break;
      case 'tts_model':
        if (msg.elevenLabsModel) {
          currentElevenLabsModel = msg.elevenLabsModel;
          localStorage.setItem('june_elevenlabs_model', currentElevenLabsModel);
          if (elevenLabsModelSelect) elevenLabsModelSelect.value = currentElevenLabsModel;
          console.log('[June] TTS model confirmed:', currentElevenLabsModel);
        }
        break;
      case 'state':
        handleState(msg.state);
        break;
      case 'brainstorm':
        handleBrainstorm(msg);
        break;
      case 'transcript':
        if (msg.role === 'user') {
          if (msg.final) {
            clearInterim();
            addMessage('user', msg.text);
          } else {
            setInterim(msg.text);
          }
        }
        break;
      case 'assistant_delta':
        appendAssistantDelta(msg.text, msg.continuation, msg.turnId, msg.chunkFlush, msg.gapMarkers);
        break;
      case 'assistant_done':
        finalizeAssistant(msg.text, msg.continuation, msg.turnId, msg.speakFallback, msg.speechSegments);
        break;
      case 'reply_cards':
        attachReplyCards(msg.cards, msg.turnId);
        break;
      case 'clipboard':
        applyClipboardWrite(msg.text, msg.label);
        break;
      case 'app_install':
        if (window.JuneAppStack?.isInstalled?.(msg.appId || 'gmail')) break;
        window.JuneAppStack?.install?.(msg.appId || 'gmail');
        showClipboardToast(
          msg.appId === 'brainstorm' ? 'Brainstorm app installed'
            : msg.appId === 'artifacts' ? 'Artifacts app installed'
            : msg.appId === 'gmail' || !msg.appId ? 'Gmail app installed'
              : 'App installed'
        );
        break;
      case 'youtube_play':
        window.JuneAppStack?.playYouTube?.({
          videoId: msg.videoId,
          title: msg.title,
          thumbnail: msg.thumbnail,
        });
        break;
      case 'youtube_control':
        if (msg.action === 'pause') window.JuneAppStack?.pauseYouTube?.();
        else if (msg.action === 'resume') window.JuneAppStack?.resumeYouTube?.();
        else if (msg.action === 'stop') window.JuneAppStack?.stopYouTube?.();
        break;
      case 'gmail_send_confirm':
        if (msg.cancel) {
          window.JuneAppStack?.clearSendConfirm?.();
          break;
        }
        if (msg.sent) {
          window.JuneAppStack?.markSendSent?.({
            address: msg.address,
            to: msg.to,
            subject: msg.subject,
          });
          break;
        }
        window.JuneAppStack?.showSendConfirm?.({
          to: msg.to,
          address: msg.address,
          subject: msg.subject,
          body: msg.body,
          cc: msg.cc,
        });
        break;
      case 'open_url':
        if (msg.url) {
          const opened = window.open(msg.url, '_blank', 'noopener');
          if (!opened) {
            showClipboardToast('Connect Gmail in Settings if the tab was blocked');
          }
        }
        break;
      case 'memory_update':
        currentMemory = mem.applyFromServer(msg.memory);
        break;
      case 'artifact_update':
        if (msg.artifacts && window.JuneArtifacts) {
          window.JuneArtifacts.applyFromServer(msg.artifacts);
        }
        window.JuneAppStack?.setArtifacts?.(msg.artifacts, { focusId: msg.focusId });
        break;
      case 'chat_saved':
        if (msg.chat) {
          chatsApi().save(msg.chat);
          if (msg.chat.session_id) activeSessionId = msg.chat.session_id;
          renderChatSidebar();
          console.log('[June] chat_saved from server →', msg.chat.title, chatsApi().list().length, 'total');
        }
        break;
      case 'function':
        handleFunction(msg.name);
        break;
      case 'interrupt':
        droppedTurns.add(msg.turnId);
        flushPlayback();
        cancelBrowserTts();
        playTurn = null;
        if (currentAssistantMsg && (msg.turnId == null || msg.turnId === assistantTurnId)) {
          lastAssistantMsg = currentAssistantMsg;
          currentAssistantMsg = null;
          assistantTurnId = null;
          wordIndex = 0;
        }
        break;
      case 'agent_trace':
        window.JuneAgentInspector?.push?.(msg);
        handleAgentActivity(msg);
        updateAppStack(msg);
        break;
      case 'usage_update':
        window.JuneAgentInspector?.pushUsage?.(msg);
        break;
    }
  }

  function updateTtsProviderOptions() {
    if (!ttsProviderSelect) return;
    ttsProviderSelect.innerHTML = '';
    const labels = { elevenlabs: 'ElevenLabs', cartesia: 'Cartesia', browser: 'Browser' };
    for (const p of availableTtsProviders) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = labels[p] || p;
      ttsProviderSelect.appendChild(opt);
    }
    ttsProviderSelect.value = currentTtsProvider;
    syncElevenLabsModelVisibility();
  }

  function updateElevenLabsModelOptions() {
    if (!elevenLabsModelSelect) return;
    elevenLabsModelSelect.innerHTML = '';
    for (const m of availableElevenLabsModels) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      elevenLabsModelSelect.appendChild(opt);
    }
    elevenLabsModelSelect.value = currentElevenLabsModel;
  }

  function syncElevenLabsModelVisibility() {
    if (!elevenLabsModelRow) return;
    const show = currentTtsProvider === 'elevenlabs';
    elevenLabsModelRow.style.display = show ? '' : 'none';
  }

  function handleFunction(name) {
    if (name === 'sleep') {
      // Server sends chat_saved before sleep; stopVoice still persists as fallback.
      stopVoice();
      return;
    }
    if (name === 'pause') {
      pauseVoice();
      return;
    }
    if (name === 'resume') {
      resumeVoice();
    }
  }

  function pauseVoice() {
    if (!running) return;
    paused = true;
    flushPlayback();
    playTurn = null;
    currentAssistantMsg = null;
    assistantTurnId = null;
    wordIndex = 0;
    hideStatus();
    setOrbActive(false);
    window.JuneAppStack?.reset();
  }

  function resumeVoice() {
    if (!running || !paused) return;
    paused = false;
    // User gesture (orb / key) — unlock AudioContext before next TTS arrives.
    if (outCtx?.state === 'suspended') outCtx.resume().catch(() => {});
    showStatus(brainstormPhase === 'capturing' || brainstormPhase === 'wrapup' ? 'brainstorm' : 'listening');
    setOrbActive(true);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resume' }));
    }
  }

  function handleBrainstorm(msg) {
    const prev = brainstormPhase;
    brainstormPhase = msg?.phase || 'off';
    const on = brainstormPhase === 'capturing' || brainstormPhase === 'wrapup';
    appCard?.classList.toggle('is-brainstorm', on);
    if (brainstormStatus) brainstormStatus.hidden = !on;
    if (on) {
      if (statusMode !== 'thinking' && statusMode !== 'speaking') showStatus('brainstorm');
    } else if (statusMode === 'brainstorm') {
      showStatus('listening');
    }
    if (brainstormPhase === 'capturing' && prev === 'off') brainstormDumpMsg = null;
    if (on) clearInterim();
    updateBrainstormDump(msg?.dump || '');
    window.JuneAppStack?.setBrainstorm?.({
      phase: brainstormPhase,
      dump: msg?.dump || '',
      title: msg?.title || '',
      body: msg?.body || '',
    });
  }

  function updateBrainstormDump(dump) {
    const text = String(dump || '').trim();
    if (!text) return;
    if (!brainstormDumpMsg || !brainstormDumpMsg.isConnected) {
      brainstormDumpMsg = addMessage('user', text, false, { persist: false });
      if (brainstormDumpMsg) {
        brainstormDumpMsg.classList.add('msg--brainstorm');
        const role = brainstormDumpMsg.querySelector('.msg-role');
        if (role) role.textContent = 'dump';
      }
      return;
    }
    const textP = brainstormDumpMsg.querySelector('.msg-text');
    if (textP) textP.textContent = text;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function handleState(state) {
    if (state === 'PAUSED') {
      pauseVoice();
      return;
    }
    if (state === 'THINKING') {
      thinkingStart = performance.now();
      showStatus('thinking');
      if (paused) {
        stopOrbLoop();
        setOrbActive(false);
      } else {
        orbState = 'thinking';
        startOrbLoop();
      }
    } else if (state === 'SPEAKING') {
      const elapsed = thinkingStart ? Math.round(performance.now() - thinkingStart) : 0;
      thinkingStart = null;
      if (currentAssistantMsg) {
        const meta = currentAssistantMsg.querySelector('.msg-time');
        if (meta) meta.textContent = `${elapsed}ms`;
      }
      if (paused) {
        hideStatus();
        stopOrbLoop();
        setOrbActive(false);
      } else {
        showStatus('speaking');
        smoothedRms = 0;
        orbState = 'speaking';
        startOrbLoop();
      }
    } else if (state === 'LISTENING') {
      thinkingStart = null;
      if (paused) {
        hideStatus();
        stopOrbLoop();
        setOrbActive(false);
      } else if (brainstormPhase === 'capturing' || brainstormPhase === 'wrapup') {
        showStatus('brainstorm');
        smoothedRms = 0;
        orbState = 'listening';
        startOrbLoop();
      } else {
        showStatus('listening');
        smoothedRms = 0;
        orbState = 'listening';
        startOrbLoop();
      }
    } else {
      stopOrbLoop();
      hideStatus();
    }
  }

  function showStatus(mode) {
    statusMode = mode;
    if (mode === 'thinking') {
      spinner.classList.add('active');
      statusText.textContent = 'thinking...';
    } else if (mode === 'speaking') {
      spinner.classList.remove('active');
      statusText.textContent = '';
    } else if (mode === 'listening') {
      spinner.classList.remove('active');
      statusText.textContent = 'listening';
    } else if (mode === 'brainstorm') {
      spinner.classList.remove('active');
      statusText.textContent = 'brainstorm';
    }
    syncStatusVisibility();
  }

  function hideStatus() {
    statusMode = null;
    spinner.classList.remove('active');
    statusText.textContent = '';
    syncStatusVisibility();
  }

  function syncStatusVisibility() {
    const agentOn = agentActivityList?.classList.contains('active');
    const mainOn = statusMode === 'thinking' || statusMode === 'listening' || statusMode === 'brainstorm'
      || (statusText.textContent && statusMode !== 'speaking');
    if (agentOn || mainOn) chatStatus.classList.add('visible');
    else chatStatus.classList.remove('visible');
  }

  const AGENT_LABELS = {
    memory: 'Memory',
    thinker: 'Thinker',
    snapshot: 'Snapshot',
    main: 'June',
    followup: 'Follow-up',
    brainstorm: 'Brainstorm',
    artifacts: 'Artifacts',
  };

  const TOOL_DESC = {
    list_past_chats: 'Listing past chats',
    get_past_chat: 'Pulling from past chats',
    scan_memory_category: 'Scanning memory',
    get_memory_detail: 'Reading memory detail',
    check_snapshot_hooks: 'Checking topic hooks',
    web_search: 'Searching the web',
    search_mid_beat: 'Still searching…',
    create_note_list: 'Making a list',
    save_artifact: 'Saving to Artifacts',
    list_artifacts: 'Looking through Artifacts',
    get_artifact: 'Opening an artifact',
    copy_to_clipboard: 'Copying to clipboard',
    install_app: 'Downloading Gmail',
    youtube_player_tool: 'Playing on YouTube',
    gmail_agent: 'Looking through mail',
    gmail_list_messages: 'Scanning mail',
    gmail_read_message: 'Reading email',
    gmail_send_email: 'Sending email',
  };

  const AGENT_ORDER = ['main', 'gmail', 'brainstorm', 'artifacts', 'memory', 'thinker', 'snapshot', 'followup'];

  function truncateLabel(s, n = 42) {
    const t = String(s || '').trim();
    if (!t) return '';
    return t.length > n ? `${t.slice(0, n)}…` : t;
  }

  function extractSearchSourcesFromTrace(ev) {
    const d = ev?.detail || {};
    if (Array.isArray(d.sources) && d.sources.length) {
      return d.sources
        .map((s) => ({
          title: String(s?.title || '').slice(0, 80),
          url: String(s?.url || ''),
          domain: String(s?.domain || '').replace(/^www\./i, ''),
        }))
        .filter((s) => s.url || s.domain)
        .slice(0, 6);
    }
    if (typeof d.result === 'string' && d.result.includes('{')) {
      try {
        const parsed = JSON.parse(d.result);
        const list = parsed?.results || [];
        return list
          .map((s) => ({
            title: String(s?.title || '').slice(0, 80),
            url: String(s?.url || ''),
            domain: String(s?.domain || '').replace(/^www\./i, ''),
          }))
          .filter((s) => s.url || s.domain)
          .slice(0, 6);
      } catch {
        return [];
      }
    }
    return [];
  }

  function describeAgentTrace(ev) {
    const agent = ev.agent || '';
    const title = AGENT_LABELS[agent] || agent;
    const meta = agent === 'main' ? 'live' : 'background';
    const d = ev.detail || {};
    let desc = '';
    const sources = ev.name === 'web_search' ? extractSearchSourcesFromTrace(ev) : [];

    if (ev.phase === 'tool') {
      if (ev.name === 'web_search') {
        if (sources.length) {
          const labels = sources.map((s) => s.domain || s.title).filter(Boolean).slice(0, 3);
          desc = labels.length
            ? `Found ${labels.join(', ')}`
            : 'Found sources';
        } else if (d.status === 'searching') {
          desc = 'Searching the web';
        } else if (typeof d.result === 'string') {
          try {
            const parsed = JSON.parse(d.result);
            desc = parsed?.error ? 'Search failed' : 'No sources found';
          } catch {
            desc = TOOL_DESC.web_search;
          }
        } else {
          desc = TOOL_DESC.web_search;
        }
      } else if (ev.name === 'youtube_player_tool') {
        const parsed = safeParseJson(d.result);
        const action = d.action || d.args?.action || parsed?.action || 'play';
        desc = action === 'pause' ? 'Pausing YouTube'
          : action === 'stop' ? 'Stopping YouTube'
          : action === 'resume' ? 'Resuming YouTube'
          : parsed?.replaced || d.replaced ? 'Switching YouTube track'
          : TOOL_DESC.youtube_player_tool;
      } else {
        desc = TOOL_DESC[ev.name] || (ev.name ? `Using ${ev.name}` : 'Running a tool');
      }
    } else if (ev.phase === 'started') {
      if (agent === 'memory') desc = 'Scanning turn for durable facts';
      else if (agent === 'thinker') desc = 'Coaching the next beat';
      else if (agent === 'snapshot') desc = 'Finding topic hooks';
      else if (agent === 'followup') desc = 'Preparing a follow-up';
      else if (agent === 'brainstorm') {
        desc = ev.name === 'format' ? 'Shaping the dump' : 'Listening for dump intent';
      }
      else if (agent === 'main') desc = 'Working…';
      else desc = 'Running…';
    } else if (ev.phase === 'result') {
      if (agent === 'memory') {
        const titles = [
          ...(d.generalInfo || []).map((g) => g.title),
          ...(d.categorized || []).map((c) => c.title),
          ...(d.corrections || []).map((c) => c.title),
        ].filter(Boolean);
        if (d.setName) titles.unshift(`name → ${d.setName}`);
        desc = titles.length
          ? `Saving ${truncateLabel(titles.slice(0, 2).join(', '))}`
          : (d.reasoning === 'nothing new' ? 'Nothing new to store' : 'Memory pass done');
      } else if (agent === 'thinker') {
        desc = d.topic ? `Topic: ${truncateLabel(d.topic)}` : 'Thoughts ready';
      } else if (agent === 'snapshot') {
        desc = d.hasTopic === false
          ? 'No clear topic'
          : (d.topic ? `Hooks for ${truncateLabel(d.topic)}` : 'Snapshot ready');
      } else if (agent === 'followup') {
        desc = 'Follow-up ready';
      } else if (agent === 'brainstorm') {
        desc = ev.name === 'format'
          ? (d.title ? `Draft: ${truncateLabel(d.title)}` : 'Draft ready')
          : (d.action ? `Intent: ${d.action}` : 'Ready');
      } else {
        desc = 'Done';
      }
    } else if (ev.phase === 'scheduled') {
      desc = `Waiting ${d.delayMs ?? '?'}ms`;
    } else if (ev.phase === 'skipped') {
      desc = ev.name || 'Skipped';
    } else if (ev.phase === 'aborted') {
      desc = 'Stopped';
    } else if (ev.phase === 'injected') {
      desc = d.topic ? `Using ${truncateLabel(d.topic)}` : 'Injecting context';
    }

    return { title, meta, desc, sources };
  }

  function renderAgentActivityList() {
    if (!agentActivityList) return;
    const now = Date.now();
    for (const [id, card] of [...agentCards.entries()]) {
      if (card.done && card.hideAt && card.hideAt <= now) agentCards.delete(id);
    }

    // Live agents first, then recent done; keep AGENT_ORDER within each group.
    const entries = [...agentCards.entries()].sort((a, b) => {
      const aLive = a[1].done ? 1 : 0;
      const bLive = b[1].done ? 1 : 0;
      if (aLive !== bLive) return aLive - bLive;
      const ai = AGENT_ORDER.indexOf(a[0]);
      const bi = AGENT_ORDER.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

    const MAX_VISIBLE = 3;
    const visible = entries.slice(0, MAX_VISIBLE);
    const overflow = entries.length - visible.length;

    agentActivityList.innerHTML = '';
    for (const [id, card] of visible) {
      const row = document.createElement('div');
      row.className = `agent-activity${card.done ? ' is-done' : ''}`;
      row.dataset.agent = id;
      row.innerHTML =
        `<div class="agent-dotgrid" aria-hidden="true">` +
        `<span></span><span></span><span></span>` +
        `<span></span><span></span><span></span>` +
        `<span></span><span></span><span></span>` +
        `</div>` +
        `<div class="agent-activity-copy">` +
        `<div class="agent-activity-line">` +
        `<span class="agent-activity-title"></span>` +
        `<span class="agent-activity-meta"></span>` +
        `</div>` +
        `<span class="agent-activity-desc"></span>` +
        `<div class="agent-activity-favicons" hidden></div>` +
        `</div>`;
      row.querySelector('.agent-activity-title').textContent = card.title;
      row.querySelector('.agent-activity-meta').textContent = card.meta;
      row.querySelector('.agent-activity-desc').textContent = card.desc || '';

      const favRow = row.querySelector('.agent-activity-favicons');
      const sources = Array.isArray(card.sources) ? card.sources : [];
      if (favRow && sources.length) {
        favRow.hidden = false;
        for (let i = 0; i < sources.length; i++) {
          const src = sources[i];
          const domain = src.domain || '';
          const a = document.createElement('a');
          a.className = 'agent-activity-favicon';
          a.href = src.url || (domain ? `https://${domain}` : '#');
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = src.title || domain || 'source';
          a.style.animationDelay = `${i * 150}ms`;
          const img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.src = domain
            ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
            : '';
          img.onerror = () => { a.classList.add('is-fallback'); };
          a.appendChild(img);
          favRow.appendChild(a);
        }
      }

      agentActivityList.appendChild(row);
    }

    if (overflow > 0) {
      const more = document.createElement('span');
      more.className = 'agent-activity-more';
      more.textContent = `+${overflow} other`;
      more.title = entries.slice(MAX_VISIBLE).map(([, c]) => c.title).join(', ');
      agentActivityList.appendChild(more);
    }

    const show = entries.length > 0;
    agentActivityList.hidden = !show;
    agentActivityList.classList.toggle('active', show);
    syncStatusVisibility();

    clearTimeout(agentRenderTimer);
    agentRenderTimer = null;
    const nextHide = [...agentCards.values()]
      .filter((c) => c.done && c.hideAt)
      .map((c) => c.hideAt)
      .sort((a, b) => a - b)[0];
    if (nextHide) {
      agentRenderTimer = setTimeout(renderAgentActivityList, Math.max(50, nextHide - Date.now()));
    }
  }

  function safeParseJson(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function youtubeIdFromSource(item) {
    const parse = window.JuneYouTubePlayer?.parseId;
    if (typeof parse !== 'function') return '';
    return parse(item?.url || item?.videoId || '') || '';
  }

  function pickYouTubeSource(sources) {
    const list = Array.isArray(sources) ? sources : [];
    for (const s of list) {
      const videoId = youtubeIdFromSource(s);
      if (!videoId) continue;
      return {
        videoId,
        title: String(s.title || '').slice(0, 140),
      };
    }
    return null;
  }

  function queryLooksLikeYouTubePlay(query) {
    const q = String(query || '').toLowerCase();
    return /site:\s*youtube|youtube\.com/.test(q)
      || /\b(official audio|lyrics|music video)\b/.test(q);
  }

  function extractGmailFromTrace(ev) {
    const d = ev?.detail || {};
    const parsed = typeof d.result === 'string'
      ? safeParseJson(d.result)
      : (d.result && typeof d.result === 'object' ? d.result : {});
    const highlights = Array.isArray(d.highlights)
      ? d.highlights
      : (Array.isArray(parsed?.highlights) ? parsed.highlights : []);
    const messages = Array.isArray(d.messages)
      ? d.messages
      : (Array.isArray(parsed?.messages) ? parsed.messages : []);
    const items = (messages.length ? messages : highlights).map((m) => ({
      id: String(m?.id || ''),
      from: String(m?.from || ''),
      subject: String(m?.subject || m?.title || ''),
      snippet: String(m?.snippet || m?.why || ''),
      unread: Boolean(m?.unread),
      body: String(m?.body || ''),
    })).filter((m) => m.id || m.subject);
    if (parsed?.id && (parsed.body || parsed.subject) && !items.some((m) => m.id === String(parsed.id))) {
      items.unshift({
        id: String(parsed.id),
        from: String(parsed.from || ''),
        subject: String(parsed.subject || ''),
        snippet: String(parsed.snippet || parsed.body || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        body: String(parsed.body || ''),
      });
    }
    return {
      searching: d.status === 'searching',
      error: parsed?.error || d.error || '',
      items,
      focusId: String(d.focusId || parsed?.focusId || parsed?.id || items[0]?.id || ''),
      isRead: ev.name === 'gmail_read_message'
        || ev.name === 'read_mail'
        || parsed?.action === 'read'
        || Boolean(parsed?.body && parsed?.id),
    };
  }

  function isGmailStackTool(name) {
    return name === 'gmail_agent'
      || name === 'gmail_list_messages'
      || name === 'gmail_read_message'
      || name === 'search_mail'
      || name === 'read_mail';
  }

  function applyGmailStack(ev) {
    const AS = window.JuneAppStack;
    if (!AS?.showMail) return false;
    AS.ensureInstalled?.('gmail');
    const mail = extractGmailFromTrace(ev);
    const parsed = typeof ev?.detail?.result === 'string'
      ? safeParseJson(ev.detail.result)
      : (ev?.detail?.result && typeof ev.detail.result === 'object' ? ev.detail.result : ev?.detail || {});
    if (parsed?.need_confirm_send && (parsed.draft || parsed.address || parsed.to)) {
      AS.showSendConfirm?.(parsed.draft || parsed);
      return true;
    }
    if (ev.name === 'gmail_send_confirm' || ev.name === 'gmail_send_email' || ev.name === 'send_mail') {
      return true;
    }
    if (mail.error === 'not_connected' || mail.error === 'gmail_not_configured') {
      AS.showMail({ stayOpen: true });
      return true;
    }
    if (mail.searching) {
      AS.showMail({ searching: true });
      return true;
    }
    if (mail.items.length || mail.focusId) {
      AS.showMail({
        messages: mail.items,
        focusId: mail.focusId,
        openMessage: mail.isRead && Boolean(mail.focusId),
      });
      return true;
    }
    AS.showMail({ searching: true });
    return true;
  }

  /**
   * Drives the voice-panel app-stack cascade (js/app-stack.js) off agent_trace.
   * Keeps the panel open across multi-step tools (scan→detail, searching→sources)
   * and only soft-finishes once — no flash on/off between steps.
   */
  function updateAppStack(ev) {
    const AS = window.JuneAppStack;
    if (!AS || !ev) return;

    // Soft-close when the main turn finishes; hard-reset only on abort.
    if (ev.agent === 'main' && ev.phase === 'result') {
      if (brainstormPhase === 'capturing' || brainstormPhase === 'wrapup') return;
      AS.finish();
      return;
    }
    if (ev.agent === 'main' && ev.phase === 'aborted') {
      if (brainstormPhase === 'capturing' || brainstormPhase === 'wrapup') return;
      AS.reset();
      return;
    }
    if (ev.agent === 'main' && ev.phase === 'started') {
      return;
    }

    if (ev.agent === 'gmail' && (ev.phase === 'tool' || ev.phase === 'result')) {
      applyGmailStack(ev);
      return;
    }
    if (ev.phase !== 'tool') return;

    if (isGmailStackTool(ev.name)) {
      applyGmailStack(ev);
      return;
    }

    // Skip mid-beat / step chatter — not real app activity.
    if (nameIsNoiseTool(ev.name)) return;

    const name = ev.name;
    const d = ev.detail || {};

    if (name === 'save_artifact' || name === 'list_artifacts' || name === 'get_artifact') {
      const parsed = safeParseJson(d.result);
      window.JuneAppStack?.showArtifacts?.({
        focusId: parsed?.id || d.id || '',
        stayOpen: name === 'list_artifacts',
      });
      return;
    }

    if (name === 'youtube_player_tool') {
      const parsed = safeParseJson(d.result);
      const action = d.action || d.args?.action || parsed?.action || 'play';
      if (action === 'pause') {
        AS.pauseYouTube?.();
        return;
      }
      if (action === 'resume') {
        AS.resumeYouTube?.();
        return;
      }
      if (action === 'stop') {
        AS.stopYouTube?.();
        return;
      }
      const videoId = d.videoId || parsed?.videoId;
      if (videoId) {
        AS.playYouTube?.({
          videoId,
          title: d.title || parsed?.title || '',
          thumbnail: d.thumbnail || parsed?.thumbnail || '',
        });
      } else {
        AS.start('youtube');
      }
      return;
    }

    if (name === 'web_search') {
      if (d.status === 'searching') {
        window.JuneYouTubePlayer?.warmup?.();
        AS.start('internet');
        return;
      }
      AS.start('internet');
      if (Array.isArray(d.sources) && d.sources.length) {
        AS.pushCards(d.sources.map((s) => ({
          title: s.title || s.domain || 'Result',
          domain: s.domain || '',
        })));
        const q = d.args?.query || d.query || '';
        if (queryLooksLikeYouTubePlay(q)) {
          const hit = pickYouTubeSource(d.sources);
          if (hit) {
            AS.playYouTube?.({
              videoId: hit.videoId,
              title: hit.title,
            });
            return;
          }
        }
      }
      AS.finish();
      return;
    }

    if (name === 'scan_memory_category' || name === 'get_memory_detail') {
      AS.start('memory');
      const parsed = safeParseJson(d.result);
      if (parsed) {
        if (Array.isArray(parsed.entries) && parsed.entries.length) {
          const letter = (parsed.title || parsed.category || '?').trim().slice(0, 1).toUpperCase();
          AS.setCards(parsed.entries.map((e) => ({ title: e.title, letter })));
        } else if (parsed.found && parsed.title) {
          const contentStr = typeof parsed.content === 'string'
            ? parsed.content
            : (parsed.content && (parsed.content.focus || Object.values(parsed.content)[0])) || '';
          AS.setCards([{
            title: parsed.title,
            sub: truncateLabel(String(contentStr || ''), 60),
            letter: parsed.title.slice(0, 1).toUpperCase(),
          }]);
        }
      }
      // Soft finish — cancelled if another memory tool fires next.
      AS.finish();
      return;
    }

    if (name === 'list_past_chats' || name === 'get_past_chat') {
      AS.start('messages');
      const parsed = safeParseJson(d.result);
      if (parsed) {
        if (Array.isArray(parsed.chats) && parsed.chats.length) {
          AS.setCards(parsed.chats.map((c) => ({ title: c.title || 'Conversation' })));
        } else if (parsed.title) {
          AS.setCards([{ title: parsed.title, sub: truncateLabel(parsed.main_summary || '', 60) }]);
        }
      }
      AS.finish();
    }
  }

  function nameIsNoiseTool(name) {
    return name === 'search_mid_beat'
      || name === 'recall_mid_beat'
      || name === 'step_continue'
      || name === 'step_enrich_kick'
      || name === 'copy_to_clipboard'
      || name === 'create_note_list';
  }

  function handleAgentActivity(ev) {
    if (!agentActivityList || !ev?.agent) return;
    const agent = ev.agent;
    if (!AGENT_LABELS[agent]) return;

    const livePhase = ev.phase === 'started' || ev.phase === 'tool' || ev.phase === 'scheduled';
    const donePhase = ev.phase === 'result' || ev.phase === 'aborted' || ev.phase === 'skipped' || ev.phase === 'injected';
    const { title, meta, desc, sources } = describeAgentTrace(ev);
    const prev = agentCards.get(agent);
    const nextSources = (sources && sources.length)
      ? sources
      : (prev?.sources || []);

    if (livePhase) {
      const hasSources = nextSources.length > 0;
      agentCards.set(agent, {
        title,
        meta,
        desc,
        done: hasSources && ev.name === 'web_search',
        hideAt: hasSources && ev.name === 'web_search' ? Date.now() + 8000 : null,
        sources: nextSources,
      });
    } else if (donePhase) {
      agentCards.set(agent, {
        title,
        meta,
        desc: desc || 'Done',
        done: true,
        hideAt: Date.now() + (nextSources.length ? 8000 : 1800),
        sources: nextSources,
      });
    } else {
      return;
    }

    renderAgentActivityList();
  }

  function attachReplyCards(cards, turnId = null) {
    if (!Array.isArray(cards) || !cards.length) return;
    const key = turnId != null ? String(turnId) : null;
    let host = null;
    if (key) {
      host = chatLog.querySelector(`.msg--assistant[data-turn-id="${key.replace(/"/g, "")}"]`);
    }
    if (!host) host = lastAssistantMsg;
    if (!host) {
      if (key) pendingCardsByTurn.set(key, cards);
      return;
    }
    mountReplyCards(host, cards);
  }

  function mountReplyCards(msgEl, cards) {
    if (!msgEl || !Array.isArray(cards) || !cards.length) return;
    let wrap = msgEl.querySelector('.reply-cards');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'reply-cards';
      msgEl.appendChild(wrap);
    }

    const hasNoteList = cards.some((c) => c.kind === 'note_list');
    if (hasNoteList) {
      wrap.querySelectorAll('.note-card--offer').forEach((el) => el.remove());
    }

    for (const card of cards) {
      if (card.kind === 'source_row') {
        wrap.querySelectorAll('.note-tiles').forEach((el) => el.remove());
        wrap.appendChild(renderSourceRow(card));
      } else if (card.kind === 'list_offer') {
        if (!wrap.querySelector('.note-card--offer') && !wrap.querySelector('.note-card--list')) {
          wrap.appendChild(renderListOffer(card));
        }
      } else if (card.kind === 'note_list') {
        wrap.querySelectorAll('.note-card--list').forEach((el) => el.remove());
        wrap.appendChild(renderNoteList(card));
      } else if (card.kind === 'brainstorm_draft') {
        wrap.querySelectorAll('.note-card--brainstorm').forEach((el) => el.remove());
        wrap.appendChild(renderBrainstormDraft(card));
      } else if (card.kind === 'gmail_send_confirm') {
        wrap.querySelectorAll('.note-card--gmail-confirm').forEach((el) => el.remove());
        wrap.appendChild(renderGmailSendConfirm(card));
      }
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function applyClipboardWrite(text, label = 'clipboard') {
    const value = String(text || '');
    if (!value) {
      showClipboardToast('Nothing to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showClipboardToast(label && label !== 'clipboard' ? `Copied ${label}` : 'Copied to clipboard');
    } catch (err) {
      console.error('[June] clipboard failed', err);
      showClipboardToast('Clipboard blocked — copy manually');
    }
  }

  function showClipboardToast(message) {
    let toast = document.getElementById('juneClipboardToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'juneClipboardToast';
      toast.className = 'clipboard-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(showClipboardToast._timer);
    showClipboardToast._timer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 1800);
  }

  function renderSourceRow(card) {
    const scroller = document.createElement('div');
    scroller.className = 'note-tiles';
    for (const tile of card.tiles || []) {
      scroller.appendChild(renderSourceTile(tile));
    }
    return scroller;
  }

  function renderSourceTile(tile) {
    const el = document.createElement('article');
    el.className = 'note-tile';

    const top = document.createElement('div');
    top.className = 'note-tile-top';

    const fav = document.createElement('div');
    fav.className = 'note-tile-fav';
    if (tile.domain) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(tile.domain)}&sz=64`;
      img.onerror = () => { fav.classList.add('is-fallback'); };
      fav.appendChild(img);
    } else {
      fav.classList.add('is-fallback');
    }
    top.appendChild(fav);

    const copy = document.createElement('div');
    copy.className = 'note-tile-copy';
    const title = document.createElement('div');
    title.className = 'note-tile-title';
    title.textContent = tile.title || tile.domain || 'Source';
    copy.appendChild(title);
    if (tile.subtitle || tile.domain) {
      const sub = document.createElement('div');
      sub.className = 'note-tile-sub';
      sub.textContent = tile.subtitle || tile.domain;
      copy.appendChild(sub);
    }
    top.appendChild(copy);
    el.appendChild(top);

    if (tile.snippet) {
      const snip = document.createElement('p');
      snip.className = 'note-tile-snippet';
      snip.textContent = tile.snippet;
      el.appendChild(snip);
    }

    const actions = document.createElement('div');
    actions.className = 'note-tile-actions';

    if (tile.url) {
      const openBtn = document.createElement('a');
      openBtn.className = 'note-btn note-btn--link';
      openBtn.href = tile.url;
      openBtn.target = '_blank';
      openBtn.rel = 'noopener noreferrer';
      openBtn.textContent = 'Open';
      actions.appendChild(openBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-btn note-btn--copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const text = [tile.title, tile.url].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } catch {
        copyBtn.textContent = 'Failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      }
    });
    actions.appendChild(copyBtn);
    el.appendChild(actions);
    return el;
  }

  function renderListOffer(card) {
    const el = document.createElement('div');
    el.className = 'note-card note-card--offer';

    const title = document.createElement('div');
    title.className = 'note-offer-title';
    title.textContent = card.title || 'Want a clean list?';
    el.appendChild(title);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'note-btn note-btn--primary';
    btn.textContent = card.actionLabel || 'Create list';
    btn.addEventListener('click', () => createFormattedList(el, card.payload || {}));
    el.appendChild(btn);
    return el;
  }

  function renderNoteList(card) {
    const el = document.createElement('div');
    el.className = 'note-card note-card--list';

    const head = document.createElement('div');
    head.className = 'note-list-head';
    const title = document.createElement('div');
    title.className = 'note-list-title';
    title.textContent = card.title || 'List';
    head.appendChild(title);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-btn note-btn--copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(card.markdown || card.body || '');
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } catch {
        copyBtn.textContent = 'Failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      }
    });
    head.appendChild(copyBtn);
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'note-list-body';
    body.appendChild(renderSimpleMarkdown(card.markdown || ''));
    el.appendChild(body);
    return el;
  }

  function renderBrainstormDraft(card) {
    const el = document.createElement('div');
    el.className = 'note-card note-card--brainstorm';

    const head = document.createElement('div');
    head.className = 'note-list-head';
    const title = document.createElement('div');
    title.className = 'note-list-title';
    title.textContent = card.title || 'Draft';
    head.appendChild(title);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-btn note-btn--copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const text = card.clipboardText || card.body || '';
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } catch {
        copyBtn.textContent = 'Failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      }
    });
    head.appendChild(copyBtn);
    el.appendChild(head);

    const body = document.createElement('p');
    body.className = 'note-brainstorm-body';
    body.textContent = card.body || '';
    el.appendChild(body);
    return el;
  }

  function renderGmailSendConfirm(card) {
    const el = document.createElement('div');
    el.className = 'note-card note-card--gmail-confirm';

    const kicker = document.createElement('div');
    kicker.className = 'gmail-confirm-kicker';
    kicker.textContent = 'Sending to';
    el.appendChild(kicker);

    const email = document.createElement('div');
    email.className = 'gmail-confirm-email';
    email.textContent = card.address || card.to || '';
    el.appendChild(email);

    if (card.subject) {
      const sub = document.createElement('div');
      sub.className = 'gmail-confirm-subject';
      sub.textContent = card.subject;
      el.appendChild(sub);
    }

    if (card.body) {
      const body = document.createElement('p');
      body.className = 'gmail-confirm-body';
      body.textContent = card.body;
      el.appendChild(body);
    }

    const hint = document.createElement('div');
    hint.className = 'gmail-confirm-hint';
    hint.textContent = 'Say yes to send, or no to cancel';
    el.appendChild(hint);
    return el;
  }

  function renderSimpleMarkdown(md) {
    const frag = document.createDocumentFragment();
    const lines = String(md || '').split(/\n/);
    let list = null;

    const flushList = () => {
      if (list) {
        frag.appendChild(list);
        list = null;
      }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        flushList();
        continue;
      }
      if (/^#\s+/.test(line)) {
        flushList();
        const h = document.createElement('h4');
        h.textContent = line.replace(/^#\s+/, '');
        frag.appendChild(h);
        continue;
      }
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        if (!list) {
          list = document.createElement('ul');
          list.className = 'note-list-ul';
        }
        const li = document.createElement('li');
        li.appendChild(inlineMd(bullet[1]));
        list.appendChild(li);
        continue;
      }
      flushList();
      const p = document.createElement('p');
      p.appendChild(inlineMd(line));
      frag.appendChild(p);
    }
    flushList();
    return frag;
  }

  function inlineMd(text) {
    const span = document.createElement('span');
    // bold **x** and bare URLs
    const parts = String(text).split(/(\*\*[^*]+\*\*|https?:\/\/\S+)/g);
    for (const part of parts) {
      if (!part) continue;
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        span.appendChild(b);
      } else if (/^https?:\/\//.test(part)) {
        const a = document.createElement('a');
        a.href = part;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = part.replace(/^https?:\/\//, '').replace(/\/$/, '');
        a.className = 'note-inline-link';
        span.appendChild(a);
      } else {
        span.appendChild(document.createTextNode(part));
      }
    }
    return span;
  }

  async function createFormattedList(offerEl, payload) {
    const btn = offerEl.querySelector('.note-btn--primary');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Creating…';
    }
    try {
      const res = await fetch('/api/format-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'format failed');

      const host = offerEl.closest('.msg--assistant') || lastAssistantMsg;
      const listCard = {
        kind: 'note_list',
        title: data.title || 'List',
        markdown: data.markdown || '',
      };
      if (host) {
        offerEl.replaceWith(renderNoteList(listCard));
        chatLog.scrollTop = chatLog.scrollHeight;
        // Sync so voice "put that on my clipboard" can copy this list
        try {
          const sock = window.JuneVoice?.getWs?.();
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({
              type: 'note_list_saved',
              title: listCard.title,
              markdown: listCard.markdown,
            }));
          }
        } catch {}
      }
    } catch (err) {
      console.error('[June] format-list failed', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Try again';
      }
    }
  }

  function setInterim(text) {
    interim.textContent = text;
  }

  function clearInterim() {
    interim.textContent = '';
  }

  let clientHistory = [];
  let sessionStartedAtIso = null;

  function deriveChatTitle(history) {
    const firstUser = history.find((m) => m.role === 'user' && m.content);
    if (!firstUser) return 'Conversation';
    const t = String(firstUser.content).trim().replace(/\s+/g, ' ');
    if (t.length <= 48) return t;
    return t.slice(0, 45).trim() + '…';
  }

  function deriveChatSummary(history) {
    const users = history.filter((m) => m.role === 'user').map((m) => m.content).filter(Boolean);
    if (users.length === 0) return 'Voice conversation with June.';
    if (users.length === 1) return users[0].slice(0, 160);
    return `Talked about: ${users.slice(0, 3).map((u) => u.slice(0, 40)).join(' · ')}`;
  }

  /** Persist current session to localStorage. Runs every turn + on stop/unload. */
  function persistCurrentChatLocally() {
    try {
      const api = chatsApi();
      const hasUser = clientHistory.some((m) => m.role === 'user' && String(m.content || '').trim());
      if (!hasUser) return false;

      const sessionId = activeSessionId
        || (mem.getSessionId && mem.getSessionId())
        || ('local_' + Date.now().toString(36));
      activeSessionId = sessionId;

      const existing = api.get(sessionId);
      const localTitle = deriveChatTitle(clientHistory);
      const localSummary = deriveChatSummary(clientHistory);

      const record = {
        session_id: sessionId,
        title: (existing?.title && existing.title !== 'Conversation') ? existing.title : localTitle,
        start_time: existing?.start_time || sessionStartedAtIso || new Date().toISOString(),
        end_time: new Date().toISOString(),
        main_summary: (existing?.main_summary && existing.main_summary !== 'Voice conversation with June.')
          ? existing.main_summary
          : localSummary,
        session_metrics: {
          total_turns: clientHistory.filter((m) => m.role === 'user').length,
          user_interruptions: existing?.session_metrics?.user_interruptions || 0,
          average_ttft_ms: existing?.session_metrics?.average_ttft_ms ?? null,
        },
        chats: clientHistory.map((m, i) => ({
          turn_id: i + 1,
          role: m.role,
          timestamp: new Date().toISOString(),
          content: m.content,
          metadata: {},
        })),
        extracted_context: existing?.extracted_context || {
          topics_detected: [],
          action_items_generated: false,
        },
      };

      api.save(record);
      renderChatSidebar();
      console.log('[June] saved chat → localStorage[june_saved_chats]', record.title, api.list().length, 'total');
      return true;
    } catch (err) {
      console.error('[June] persistCurrentChatLocally failed:', err);
      return false;
    }
  }

  function addMessage(role, text, animate = false, { persist = true } = {}) {
    if (role === 'user') {
      const norm = text.trim().toLowerCase().replace(/\s+/g, ' ');
      if (norm && norm === lastUserMsgText && Date.now() - lastUserMsgAt < 4000) return null;
      lastUserMsgText = norm;
      lastUserMsgAt = Date.now();
    }

    clientHistory.push({ role, content: text });

    // Save as soon as the user has spoken — don't wait for session end
    if (persist && role === 'user') persistCurrentChatLocally();

    const msg = document.createElement('div');
    msg.className = `msg msg--${role}`;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const roleSpan = document.createElement('span');
    roleSpan.className = 'msg-role';
    roleSpan.textContent = role === 'user' ? 'you' : 'june';
    meta.appendChild(roleSpan);

    if (role === 'assistant') {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'msg-time';
      meta.appendChild(timeSpan);
    }

    const textP = document.createElement('p');
    textP.className = 'msg-text';

    if (animate && role === 'assistant') {
      renderAnimatedWords(textP, text);
    } else {
      textP.textContent = text;
    }

    msg.appendChild(meta);
    msg.appendChild(textP);
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;

    return msg;
  }

  function appendChunkMarker(textEl) {
    const span = document.createElement('span');
    span.className = 'stall-marker';
    span.textContent = 'chunk';
    span.title = 'TTS flush boundary';
    textEl.appendChild(span);
  }

  function appendGapMarker(textEl, seconds) {
    const span = document.createElement('span');
    span.className = 'stall-marker stall-marker--gap';
    const label = Number(seconds).toFixed(1).replace(/\.0$/, '');
    span.textContent = `gap ${label}`;
    span.title = `Spoken pause ${seconds}s`;
    textEl.appendChild(span);
  }

  function appendTextTokens(textEl, text, { trail = false } = {}) {
    const tokens = text.split(/(\s+)/);
    tokens.forEach((token) => {
      if (!token) return;
      const span = document.createElement('span');
      span.className = trail ? 'word word--trail' : 'word';
      span.textContent = token;
      span.style.animationDelay = `${wordIndex * 35}ms`;
      textEl.appendChild(span);
      if (token.trim()) wordIndex++;
    });
  }

  function renderAnimatedWords(container, text) {
    container.innerHTML = '';
    appendTextTokens(container, text);
  }

  function startAssistantMessage(turnId) {
    if (turnId != null && turnId === assistantTurnId && currentAssistantMsg) return;
    if (currentAssistantMsg) lastAssistantMsg = currentAssistantMsg;
    if (turnId != null) assistantTurnId = turnId;
    currentAssistantMsg = addMessage('assistant', '', true);
    if (currentAssistantMsg && turnId != null) {
      currentAssistantMsg.dataset.turnId = String(turnId);
    }
    wordIndex = 0;
  }

  function canAppendContinuation() {
    if (!lastAssistantMsg) return false;
    // If the user (or a newer assistant turn) already landed after that bubble, don't stack.
    let el = lastAssistantMsg.nextElementSibling;
    while (el) {
      if (el.classList?.contains('msg--user') || el.classList?.contains('msg--assistant')) {
        return false;
      }
      el = el.nextElementSibling;
    }
    if (currentAssistantMsg && currentAssistantMsg !== lastAssistantMsg) return false;
    return true;
  }

  function appendAssistantDelta(text, continuation = false, turnId = null, chunkFlush = 0, gapMarkers = null) {
    if (continuation) {
      if (!canAppendContinuation()) return;
      currentAssistantMsg = lastAssistantMsg;
      const textEl = currentAssistantMsg.querySelector('.msg-text');

      const br = document.createElement('br');
      textEl.appendChild(br);
      const br2 = document.createElement('br');
      textEl.appendChild(br2);

      if (text) appendTextTokens(textEl, text, { trail: true });
      for (let i = 0; i < chunkFlush; i++) appendChunkMarker(textEl);
      if (Array.isArray(gapMarkers)) {
        for (const sec of gapMarkers) appendGapMarker(textEl, sec);
      }
      chatLog.scrollTop = chatLog.scrollHeight;
      return;
    }

    if (turnId != null && turnId !== assistantTurnId) {
      startAssistantMessage(turnId);
    } else if (!currentAssistantMsg) {
      startAssistantMessage(turnId);
    }
    const textEl = currentAssistantMsg.querySelector('.msg-text');
    if (text) appendTextTokens(textEl, text);
    for (let i = 0; i < chunkFlush; i++) appendChunkMarker(textEl);
    if (Array.isArray(gapMarkers)) {
      for (const sec of gapMarkers) appendGapMarker(textEl, sec);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function finalizeAssistant(fullText, continuation = false, turnId = null, speakFallback = false, speechSegments = null) {
    if (continuation) {
      if (canAppendContinuation() && fullText) {
        for (let i = clientHistory.length - 1; i >= 0; i--) {
          if (clientHistory[i].role === 'assistant') {
            clientHistory[i].content = `${clientHistory[i].content} ${fullText}`.trim();
            break;
          }
        }
      }
      currentAssistantMsg = null;
      assistantTurnId = null;
      wordIndex = 0;
      if (paused) {
        hideStatus();
        setOrbActive(false);
      }
      return;
    }

    if (turnId != null && assistantTurnId != null && turnId !== assistantTurnId) return;

    if (currentAssistantMsg) {
      if (turnId != null) currentAssistantMsg.dataset.turnId = String(turnId);
      const textEl = currentAssistantMsg.querySelector('.msg-text');
      textEl.querySelectorAll('.word').forEach((el) => {
        el.style.opacity = '1';
        el.style.animation = 'none';
      });
      lastAssistantMsg = currentAssistantMsg;

      for (let i = clientHistory.length - 1; i >= 0; i--) {
        if (clientHistory[i].role === 'assistant' && clientHistory[i].content === '') {
          clientHistory[i].content = fullText;
          break;
        }
      }

      // Attach any cards that arrived early for this turn
      const pending = pendingCardsByTurn.get(String(turnId));
      if (pending) {
        pendingCardsByTurn.delete(String(turnId));
        mountReplyCards(currentAssistantMsg, pending);
      }
    }
    currentAssistantMsg = null;
    assistantTurnId = null;
    wordIndex = 0;

    if (speakFallback && currentTtsProvider === 'browser') {
      const segments = Array.isArray(speechSegments) && speechSegments.length
        ? speechSegments
        : (fullText ? [{ type: 'text', value: fullText }] : null);
      if (segments) enqueueBrowserTts(segments);
    }

    if (paused) {
      hideStatus();
      setOrbActive(false);
    }

    persistCurrentChatLocally();
  }

  let browserTtsUtterance = null;
  let browserTtsTimer = null;
  let browserTtsToken = 0;
  let browserTtsChain = Promise.resolve();

  function speakWithBrowserTts(text) {
    enqueueBrowserTts([{ type: 'text', value: text }]);
  }

  function speakWithBrowserTtsSegments(segments) {
    enqueueBrowserTts(segments);
  }

  /** Queue browser speech after any WebAudio already scheduled — never overlap. */
  function enqueueBrowserTts(segments) {
    if (!('speechSynthesis' in window)) return;
    const list = Array.isArray(segments) ? segments : [];
    if (!list.length) return;

    browserTtsChain = browserTtsChain
      .then(async () => {
        // Wait out streamed PCM first, then a small seam between lines.
        await waitForPlaybackIdle(AUDIO_QUEUE_GAP_SEC);
        if (paused) return;
        await playBrowserTtsSegments(list);
      })
      .catch(() => {});
  }

  function playBrowserTtsSegments(segments) {
    return new Promise((resolve) => {
      const token = ++browserTtsToken;
      let i = 0;

      const finish = () => {
        if (token === browserTtsToken) {
          browserTtsUtterance = null;
          if (browserTtsTimer) {
            clearTimeout(browserTtsTimer);
            browserTtsTimer = null;
          }
        }
        resolve();
      };

      const step = () => {
        if (token !== browserTtsToken) {
          resolve();
          return;
        }
        if (i >= segments.length) {
          finish();
          return;
        }
        const seg = segments[i++];
        if (seg.type === 'gap') {
          const ms = Math.round(Math.max(0.3, Math.min(2, Number(seg.seconds) || 0.3)) * 1000);
          browserTtsTimer = setTimeout(step, ms);
          return;
        }
        const text = String(seg.value || '').trim();
        if (!text) {
          step();
          return;
        }
        browserTtsUtterance = new SpeechSynthesisUtterance(text);
        browserTtsUtterance.rate = 1.0;
        browserTtsUtterance.pitch = 1.0;
        browserTtsUtterance.onend = () => {
          browserTtsUtterance = null;
          step();
        };
        browserTtsUtterance.onerror = () => {
          browserTtsUtterance = null;
          step();
        };
        speechSynthesis.speak(browserTtsUtterance);
      };

      step();
    });
  }

  function cancelBrowserTts() {
    browserTtsToken += 1;
    browserTtsChain = Promise.resolve();
    if (browserTtsTimer) {
      clearTimeout(browserTtsTimer);
      browserTtsTimer = null;
    }
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
    }
    browserTtsUtterance = null;
  }

  let playChain = Promise.resolve();

  function playAudio(buffer) {
    // Serialize scheduling so concurrent resume()/chunks can't scramble nextTime.
    playChain = playChain.then(() => playAudioAsync(buffer)).catch(() => {});
  }

  /** Seconds of audio still queued/playing on the output clock (0 if idle). */
  function playbackRemainingSec() {
    if (!outCtx) return 0;
    return Math.max(0, nextTime - outCtx.currentTime);
  }

  function waitForPlaybackIdle(extraSec = 0) {
    const waitSec = playbackRemainingSec() + Math.max(0, extraSec);
    if (waitSec <= 0.02) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, Math.ceil(waitSec * 1000) + 20));
  }

  async function playAudioAsync(buffer) {
    const turnId = new DataView(buffer).getUint32(0, true);
    if (droppedTurns.has(turnId)) return;
    if (paused || !outCtx) return;
    const pcm = new Float32Array(buffer, 4);
    if (pcm.length === 0) return;

    if (outCtx.state !== 'running') {
      try { await outCtx.resume(); } catch {}
    }
    if (outCtx.state !== 'running') {
      await new Promise((r) => setTimeout(r, 40));
      try { await outCtx.resume(); } catch {}
    }
    if (outCtx.state !== 'running') return;

    const now = outCtx.currentTime;
    if (nextTime < now) nextTime = now + 0.02;

    // Never hard-reset the clock on a new turn — that caused overlap whenever a
    // follow-up (or any second line) arrived while the previous line was still playing.
    // Queue after whatever is already scheduled, with a short seam between turns.
    if (lastScheduledTurn != null && turnId !== lastScheduledTurn) {
      nextTime += AUDIO_QUEUE_GAP_SEC;
    }
    lastScheduledTurn = turnId;
    playTurn = turnId;

    const audioBuffer = outCtx.createBuffer(1, pcm.length, TTS_RATE);
    audioBuffer.copyToChannel(pcm, 0);
    const src = outCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(analyserNode);

    src.start(nextTime);
    nextTime += audioBuffer.duration;

    liveSources.add(src);
    src.onended = () => liveSources.delete(src);
  }

  function flushPlayback() {
    for (const src of liveSources) {
      try { src.onended = null; src.stop(); } catch {}
    }
    liveSources.clear();
    nextTime = 0;
    lastScheduledTurn = null;
    playChain = Promise.resolve();
  }

  function startOrbLoop() {
    if (orbRaf) return;
    function tick() {
      orbRaf = requestAnimationFrame(tick);
      updateOrbScale();
    }
    orbRaf = requestAnimationFrame(tick);
  }

  function stopOrbLoop() {
    if (orbRaf) { cancelAnimationFrame(orbRaf); orbRaf = null; }
    orbState = 'idle';
    smoothedRms = 0;
    userRms = 0;
    if (orb) orb.style.transform = 'scale(1)';
  }

  function updateOrbScale() {
    if (!orb) return;
    if (orbState === 'speaking' && analyserNode && analyserData) {
      analyserNode.getByteTimeDomainData(analyserData);
      let sq = 0;
      for (let i = 0; i < analyserData.length; i++) {
        const v = (analyserData[i] - 128) / 128;
        sq += v * v;
      }
      const rms = Math.sqrt(sq / analyserData.length);
      smoothedRms += (rms - smoothedRms) * 0.3;
      const scale = 1 + Math.min(smoothedRms * 4.0, 0.45);
      orb.style.transform = `scale(${scale.toFixed(4)})`;
    } else if (orbState === 'listening') {
      smoothedRms += (userRms - smoothedRms) * 0.22;
      const scale = 1 + Math.min(smoothedRms * 3.5, 0.40);
      orb.style.transform = `scale(${scale.toFixed(4)})`;
    } else if (orbState === 'thinking') {
      const t = performance.now() / 1000;
      const scale = 1 + Math.sin(t * 1.8) * 0.055;
      orb.style.transform = `scale(${scale.toFixed(4)})`;
    } else {
      orb.style.transform = 'scale(1)';
    }
  }

  function setOrbActive(active) {
    if (pauseStatus) {
      pauseStatus.style.opacity = active ? '0' : '1';
      pauseStatus.style.pointerEvents = active ? 'none' : '';
      pauseStatus.textContent = active ? 'Listening' : 'Paused';
    }
    if (pauseIcon) {
      pauseIcon.style.opacity = active ? '0' : '0.3';
      pauseIcon.style.pointerEvents = active ? 'none' : '';
    }
    if (!active) stopOrbLoop();
  }

  function captureWorkletUrl() {
    const code = `
      class CaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0][0];
          if (ch) this.port.postMessage(new Float32Array(ch));
          return true;
        }
      }
      registerProcessor('capture-processor', CaptureProcessor);
    `;
    return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  }

  function sendText() {
    const text = typeInput.value.trim();
    if (!text) return;
    const capturing = brainstormPhase === 'capturing';
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      startVoice().then(() => {
        ws.send(JSON.stringify({ type: 'text', text }));
        if (!capturing) addMessage('user', text);
        typeInput.value = '';
      }).catch(() => {});
      return;
    }
    ws.send(JSON.stringify({ type: 'text', text }));
    if (!capturing) addMessage('user', text);
    typeInput.value = '';
  }

  orb.addEventListener('click', () => {
    if (running && paused) {
      resumeVoice();
      return;
    }
    if (running) stopVoice();
    else startVoice().catch(() => stopVoice());
  });

  function toggleAgentInspector(e) {
    if (!e.shiftKey || e.key.toLowerCase() !== 'g') return false;
    if (!(e.metaKey || e.ctrlKey)) return false;
    e.preventDefault();
    e.stopPropagation();
    window.JuneAgentInspector?.toggle?.();
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && document.activeElement !== typeInput) {
      if (running && paused) {
        resumeVoice();
        return;
      }
      if (running) stopVoice();
      else startVoice().catch(() => stopVoice());
    }
  });

  // Capture phase so Cmd+Shift+G / Ctrl+Shift+G wins over browser defaults on Mac.
  document.addEventListener('keydown', (e) => {
    if (toggleAgentInspector(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      const stats = mem.getStorageStats();
      console.log('[JuneMemory] Stats:', stats);
      console.log('[JuneMemory] Current memory:', mem.load());
    }
  }, true);

  // Expose minimal API for the inspector to send set_debug over the live socket.
  window.JuneVoice = {
    getWs() { return ws; },
  };

  if (textToggle && typeBar) {
    textToggle.addEventListener('click', () => {
      const isOpen = typeBar.classList.toggle('is-open');
      textToggle.textContent = isOpen ? '< T' : 'T >';
      textToggle.setAttribute('aria-expanded', isOpen);
      if (isOpen) typeInput.focus();
      else typeInput.blur();
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', sendText);
  }

  if (typeInput) {
    typeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendText();
    });
  }

  async function refreshGmailSettings() {
    if (!gmailStatusHint && !gmailConnectLink) return;
    try {
      const res = await fetch('/api/gmail/status');
      const data = await res.json();
      if (!data?.configured) {
        if (gmailStatusHint) gmailStatusHint.textContent = 'Not configured';
        if (gmailConnectLink) gmailConnectLink.hidden = true;
        return;
      }
      if (gmailConnectLink) gmailConnectLink.hidden = false;
      if (data.connected) {
        if (gmailStatusHint) gmailStatusHint.textContent = data.email ? `Connected as ${data.email}` : 'Connected';
        if (gmailConnectLink) gmailConnectLink.textContent = 'Reconnect Gmail';
        window.JuneAppStack?.ensureInstalled?.('gmail');
      } else {
        if (gmailStatusHint) gmailStatusHint.textContent = 'Not connected';
        if (gmailConnectLink) gmailConnectLink.textContent = 'Connect Gmail';
      }
    } catch {
      if (gmailStatusHint) gmailStatusHint.textContent = 'Status unavailable';
    }
  }

  if (settingsWheel && settingsOverlay) {
    settingsWheel.addEventListener('click', () => {
      settingsOverlay.classList.add('visible');
      refreshGmailSettings();
    });
  }

  if (settingsClose && settingsOverlay) {
    settingsClose.addEventListener('click', () => {
      settingsOverlay.classList.remove('visible');
    });
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) {
        settingsOverlay.classList.remove('visible');
      }
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      micMuted = !micMuted;
      muteBtn.classList.toggle('is-muted', micMuted);
      muteBtn.setAttribute('aria-label', micMuted ? 'Unmute microphone' : 'Mute microphone');
      if (micMuted) clearInterim();
    });
  }

  if (ttsProviderSelect) {
    ttsProviderSelect.addEventListener('change', () => {
      const newProvider = ttsProviderSelect.value;
      currentTtsProvider = newProvider;
      localStorage.setItem('june_tts_provider', newProvider);
      syncElevenLabsModelVisibility();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_tts_provider', provider: newProvider }));
      }
    });
  }

  if (elevenLabsModelSelect) {
    updateElevenLabsModelOptions();
    elevenLabsModelSelect.value = currentElevenLabsModel;
    syncElevenLabsModelVisibility();
    elevenLabsModelSelect.addEventListener('change', () => {
      const model = elevenLabsModelSelect.value;
      currentElevenLabsModel = model;
      localStorage.setItem('june_elevenlabs_model', model);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_tts_model', model }));
      }
    });
  }

  async function loadGreeting() {
    currentMemory = mem.load();
    const pastChats = buildPastChatsPayload(6);
    const lastChat = pastChats[0] || null;
    const ctx = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    showStatus('thinking');
    try {
      const res = await fetch('/api/greeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory: currentMemory,
          context: ctx,
          lastChat,
          pastChats,
        }),
      });
      const data = await res.json();
      if (data.text) addMessage('assistant', data.text, true);
    } catch {}
    hideStatus();
  }

  function openChatSidebar() {
    if (!chatSidebar) return;
    renderChatSidebar();
    chatSidebar.classList.add('open');
    chatSidebar.setAttribute('aria-hidden', 'false');
    if (chatSidebarBackdrop) chatSidebarBackdrop.classList.add('visible');
  }

  function closeChatSidebar() {
    if (!chatSidebar) return;
    chatSidebar.classList.remove('open');
    chatSidebar.setAttribute('aria-hidden', 'true');
    if (chatSidebarBackdrop) chatSidebarBackdrop.classList.remove('visible');
  }

  function renderChatSidebar() {
    if (!chatSidebarList) return;
    const api = chatsApi();
    const chats = api.list();
    chatSidebarList.innerHTML = '';
    if (chatSidebarEmpty) {
      chatSidebarEmpty.classList.toggle('visible', chats.length === 0);
    }
    for (const chat of chats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-sidebar-item';
      btn.dataset.sessionId = chat.session_id;

      const title = document.createElement('span');
      title.className = 'chat-sidebar-item-title';
      title.textContent = chat.title || 'Conversation';

      const time = document.createElement('span');
      time.className = 'chat-sidebar-item-time';
      time.textContent = api.formatTime(chat.start_time);

      const summary = document.createElement('span');
      summary.className = 'chat-sidebar-item-summary';
      summary.textContent = chat.main_summary || '';

      btn.appendChild(title);
      btn.appendChild(time);
      if (chat.main_summary) btn.appendChild(summary);
      btn.addEventListener('click', () => loadSavedChat(chat.session_id));
      chatSidebarList.appendChild(btn);
    }
  }

  function loadSavedChat(sessionId) {
    const api = chatsApi();
    const chat = api.get(sessionId);
    if (!chat) return;

    closeChatSidebar();
    chatLog.innerHTML = '';
    clientHistory = [];
    currentAssistantMsg = null;
    lastAssistantMsg = null;
    assistantTurnId = null;
    wordIndex = 0;
    lastUserMsgText = '';
    lastUserMsgAt = 0;
    activeSessionId = chat.session_id;
    sessionStartedAtIso = chat.start_time || new Date().toISOString();

    const turns = Array.isArray(chat.chats) ? chat.chats : [];
    for (const turn of turns) {
      if (!turn?.content) continue;
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      addMessage(role, turn.content, false, { persist: false });
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'init',
        memory: currentMemory,
        context: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        ttsProvider: currentTtsProvider,
        elevenLabsModel: currentElevenLabsModel,
        history: clientHistory,
        pastChats: buildPastChatsPayload(),
        installedApps: window.JuneAppStack?.listInstalled?.() || [],
      artifacts: window.JuneArtifacts?.snapshot?.() || { version: 1, items: [] },
      }));
      window.setTimeout(syncInstalledApps, 600);
    }
  }

  if (historyBtn) historyBtn.addEventListener('click', openChatSidebar);
  if (chatSidebarClose) chatSidebarClose.addEventListener('click', closeChatSidebar);
  if (chatSidebarBackdrop) chatSidebarBackdrop.addEventListener('click', closeChatSidebar);

  window.addEventListener('june-apps-changed', syncInstalledApps);
  window.addEventListener('beforeunload', () => { persistCurrentChatLocally(); });
  window.addEventListener('pagehide', () => { persistCurrentChatLocally(); });

  updateTtsProviderOptions();
  updateElevenLabsModelOptions();
  syncElevenLabsModelVisibility();
  renderChatSidebar();
  loadGreeting();
})();
