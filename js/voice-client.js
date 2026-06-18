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
  const muteBtn = document.getElementById('muteBtn');

  const mem = window.JuneMemory;
  let currentMemory = mem.load();
  let currentTtsProvider = localStorage.getItem('june_tts_provider') || 'elevenlabs';
  let availableTtsProviders = ['browser'];

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
    const ctx = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    ws.send(JSON.stringify({ type: 'init', memory: currentMemory, context: ctx, ttsProvider: currentTtsProvider, history: clientHistory }));

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
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'ready':
        if (msg.ttsProviders) {
          availableTtsProviders = msg.ttsProviders;
          updateTtsProviderOptions();
        }
        if (msg.ttsProvider) currentTtsProvider = msg.ttsProvider;
        break;
      case 'tts_provider':
        currentTtsProvider = msg.provider;
        localStorage.setItem('june_tts_provider', msg.provider);
        if (ttsProviderSelect) ttsProviderSelect.value = msg.provider;
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
        appendAssistantDelta(msg.text, msg.continuation, msg.turnId);
        break;
      case 'assistant_done':
        finalizeAssistant(msg.text, msg.continuation, msg.turnId, msg.speakFallback);
        break;
      case 'memory_update':
        currentMemory = mem.applyFromServer(msg.memory);
        break;
      case 'function':
        handleFunction(msg.name);
        break;
      case 'interrupt':
        droppedTurns.add(msg.turnId);
        flushPlayback();
        cancelBrowserTts();
        if (playTurn === msg.turnId) playTurn = null;
        if (currentAssistantMsg && (msg.turnId == null || msg.turnId === assistantTurnId)) {
          lastAssistantMsg = currentAssistantMsg;
          currentAssistantMsg = null;
          assistantTurnId = null;
          wordIndex = 0;
        }
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
  }

  function handleFunction(name) {
    if (name === 'sleep') {
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
    currentAssistantMsg = null;
    assistantTurnId = null;
    wordIndex = 0;
    hideStatus();
    setOrbActive(false);
  }

  function resumeVoice() {
    if (!running || !paused) return;
    paused = false;
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

  function addMessage(role, text, animate = false) {
    if (role === 'user') {
      const norm = text.trim().toLowerCase().replace(/\s+/g, ' ');
      if (norm && norm === lastUserMsgText && Date.now() - lastUserMsgAt < 4000) return null;
      lastUserMsgText = norm;
      lastUserMsgAt = Date.now();
    }

    clientHistory.push({ role, content: text });

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

  function renderAnimatedWords(container, text) {
    container.innerHTML = '';
    const words = text.split(/(\s+)/);
    let delay = 0;
    words.forEach((word) => {
      if (!word) return;
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word;
      span.style.animationDelay = `${delay}ms`;
      container.appendChild(span);
      if (word.trim()) delay += 35;
    });
  }

  function startAssistantMessage(turnId) {
    if (turnId != null && turnId === assistantTurnId && currentAssistantMsg) return;
    if (currentAssistantMsg) lastAssistantMsg = currentAssistantMsg;
    if (turnId != null) assistantTurnId = turnId;
    currentAssistantMsg = addMessage('assistant', '', true);
    wordIndex = 0;
  }

  function appendAssistantDelta(text, continuation = false, turnId = null) {
    if (continuation && lastAssistantMsg) {
      currentAssistantMsg = lastAssistantMsg;
      const textEl = currentAssistantMsg.querySelector('.msg-text');
      
      const br = document.createElement('br');
      textEl.appendChild(br);
      const br2 = document.createElement('br');
      textEl.appendChild(br2);

      const words = text.split(/(\s+)/);
      words.forEach((word) => {
        if (!word) return;
        const span = document.createElement('span');
        span.className = 'word word--trail';
        span.textContent = word;
        span.style.animationDelay = `${wordIndex * 35}ms`;
        textEl.appendChild(span);
        if (word.trim()) wordIndex++;
      });
      chatLog.scrollTop = chatLog.scrollHeight;
      return;
    }

    if (turnId != null && turnId !== assistantTurnId) {
      startAssistantMessage(turnId);
    } else if (!currentAssistantMsg) {
      startAssistantMessage(turnId);
    }
    const textEl = currentAssistantMsg.querySelector('.msg-text');
    const words = text.split(/(\s+)/);
    words.forEach((word) => {
      if (!word) return;
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word;
      span.style.animationDelay = `${wordIndex * 35}ms`;
      textEl.appendChild(span);
      if (word.trim()) wordIndex++;
    });
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function finalizeAssistant(fullText, continuation = false, turnId = null, speakFallback = false) {
    if (continuation && lastAssistantMsg) {
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
    const turnId = new DataView(buffer).getUint32(0, true);
    if (droppedTurns.has(turnId)) return;
    const pcm = new Float32Array(buffer, 4);
    if (pcm.length === 0) return;

    // Re-resume the context if the browser suspended it (autoplay policy, tab
    // losing focus, etc.).  This is safe to call repeatedly — it's a no-op when
    // the context is already running.
    if (outCtx.state === 'suspended') outCtx.resume().catch(() => {});

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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && document.activeElement !== typeInput) {
      if (running && paused) {
        resumeVoice();
        return;
      }
      if (running) stopVoice();
      else startVoice().catch(() => stopVoice());
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      const stats = mem.getStorageStats();
      console.log('[JuneMemory] Stats:', stats);
      console.log('[JuneMemory] Current memory:', mem.load());
    }
  });

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
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_tts_provider', provider: newProvider }));
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

  updateTtsProviderOptions();
  loadGreeting();
})();
