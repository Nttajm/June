(function () {
  const STT_RATE = 16000;
  const TTS_RATE = 24000;
  const CHUNK_SAMPLES = STT_RATE * 0.08;

  const orb = document.querySelector('.orb');
  const pauseStatus = document.querySelector('.pause-status');
  const pauseIcon = document.querySelector('.pause-icon');
  const chatLog = document.getElementById('chatLog');
  const chatStatus = document.getElementById('chatStatus');
  const spinner = document.getElementById('spinner');
  const statusText = document.getElementById('statusText');
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
  const droppedTurns = new Set();

  let thinkingStart = null;
  let currentAssistantMsg = null;
  let lastAssistantMsg = null;
  let assistantTurnId = null;
  let wordIndex = 0;
  let lastUserMsgText = '';
  let lastUserMsgAt = 0;

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
      debug:
        Boolean(window.JuneAgentInspector?.isOpen?.()) ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1',
    }));
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
        appendAssistantDelta(msg.text, msg.continuation, msg.turnId, msg.chunkFlush);
        break;
      case 'assistant_done':
        finalizeAssistant(msg.text, msg.continuation, msg.turnId, msg.speakFallback);
        break;
      case 'memory_update':
        currentMemory = mem.applyFromServer(msg.memory);
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
  }

  function resumeVoice() {
    if (!running || !paused) return;
    paused = false;
    // User gesture (orb / key) — unlock AudioContext before next TTS arrives.
    if (outCtx?.state === 'suspended') outCtx.resume().catch(() => {});
    showStatus('listening');
    setOrbActive(true);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resume' }));
    }
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
    chatStatus.classList.add('visible');
    if (mode === 'thinking') {
      spinner.classList.add('active');
      statusText.textContent = 'thinking...';
    } else if (mode === 'speaking') {
      spinner.classList.remove('active');
      statusText.textContent = '';
      chatStatus.classList.remove('visible');
    } else if (mode === 'listening') {
      spinner.classList.remove('active');
      statusText.textContent = 'listening';
    }
  }

  function hideStatus() {
    chatStatus.classList.remove('visible');
    spinner.classList.remove('active');
    statusText.textContent = '';
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
    wordIndex = 0;
  }

  function appendAssistantDelta(text, continuation = false, turnId = null, chunkFlush = 0) {
    if (continuation && lastAssistantMsg) {
      currentAssistantMsg = lastAssistantMsg;
      const textEl = currentAssistantMsg.querySelector('.msg-text');

      const br = document.createElement('br');
      textEl.appendChild(br);
      const br2 = document.createElement('br');
      textEl.appendChild(br2);

      appendTextTokens(textEl, text, { trail: true });
      for (let i = 0; i < chunkFlush; i++) appendChunkMarker(textEl);
      chatLog.scrollTop = chatLog.scrollHeight;
      return;
    }

    if (turnId != null && turnId !== assistantTurnId) {
      startAssistantMessage(turnId);
    } else if (!currentAssistantMsg) {
      startAssistantMessage(turnId);
    }
    const textEl = currentAssistantMsg.querySelector('.msg-text');
    appendTextTokens(textEl, text);
    for (let i = 0; i < chunkFlush; i++) appendChunkMarker(textEl);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function finalizeAssistant(fullText, continuation = false, turnId = null, speakFallback = false) {
    if (continuation && lastAssistantMsg) {
      if (fullText) {
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
    }
    currentAssistantMsg = null;
    assistantTurnId = null;
    wordIndex = 0;

    if (speakFallback && fullText && currentTtsProvider === 'browser') {
      speakWithBrowserTts(fullText);
    }

    if (paused) {
      hideStatus();
      setOrbActive(false);
    }

    persistCurrentChatLocally();
  }

  let browserTtsUtterance = null;

  function speakWithBrowserTts(text) {
    if (!('speechSynthesis' in window)) return;
    cancelBrowserTts();
    browserTtsUtterance = new SpeechSynthesisUtterance(text);
    browserTtsUtterance.rate = 1.0;
    browserTtsUtterance.pitch = 1.0;
    browserTtsUtterance.onend = () => { browserTtsUtterance = null; };
    browserTtsUtterance.onerror = () => { browserTtsUtterance = null; };
    speechSynthesis.speak(browserTtsUtterance);
  }

  function cancelBrowserTts() {
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
    }
    browserTtsUtterance = null;
  }

  function playAudio(buffer) {
    void playAudioAsync(buffer);
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
    if (outCtx.state !== 'running') return;

    if (turnId !== playTurn) {
      playTurn = turnId;
      nextTime = 0;
    }

    const audioBuffer = outCtx.createBuffer(1, pcm.length, TTS_RATE);
    audioBuffer.copyToChannel(pcm, 0);
    const src = outCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(analyserNode);

    const now = outCtx.currentTime;
    if (nextTime < now) nextTime = now + 0.02;
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      startVoice().then(() => {
        ws.send(JSON.stringify({ type: 'text', text }));
        addMessage('user', text);
        typeInput.value = '';
      }).catch(() => {});
      return;
    }
    ws.send(JSON.stringify({ type: 'text', text }));
    addMessage('user', text);
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

  if (settingsWheel && settingsOverlay) {
    settingsWheel.addEventListener('click', () => {
      settingsOverlay.classList.add('visible');
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
    const ctx = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    showStatus('thinking');
    try {
      const res = await fetch('/api/greeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memory: currentMemory, context: ctx }),
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
      }));
    }
  }

  if (historyBtn) historyBtn.addEventListener('click', openChatSidebar);
  if (chatSidebarClose) chatSidebarClose.addEventListener('click', closeChatSidebar);
  if (chatSidebarBackdrop) chatSidebarBackdrop.addEventListener('click', closeChatSidebar);

  window.addEventListener('beforeunload', () => { persistCurrentChatLocally(); });
  window.addEventListener('pagehide', () => { persistCurrentChatLocally(); });

  updateTtsProviderOptions();
  updateElevenLabsModelOptions();
  syncElevenLabsModelVisibility();
  renderChatSidebar();
  loadGreeting();
})();
