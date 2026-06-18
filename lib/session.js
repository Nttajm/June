import { FluxStream } from "./sttFlux.js";
import { createTTS, ttsAvailable, getAvailableProviders } from "./tts.js";
import { streamReply, llmAvailable } from "./llm.js";
import { State, FluxEvent, config } from "./states.js";
import { 
  mergeCleanDelta, 
  applyMemoryUpdates, 
  stripMemoryTags, 
  mergeThoughtCache, 
  detectMemoryCallbacks, 
  normalizeMemory,
  consolidateSession,
  startNewSession,
  markAccessedEntries,
  retrieveRelevantMemories,
  memoryNow,
  generateId
} from "./memory.js";
import { analyzeTurnMemory, analyzeUserIntent, consolidateSessionMemory } from "./memory-ai.js";
import { detectSleepCommand, Fn } from "./functions.js";
import { runThoughtAgent, thoughtAgentAvailable } from "./thought-agent.js";
import { runSnapshotAgent, snapshotAgentAvailable, shouldRefreshSnapshot } from "./snapshot-agent.js";

export class VoiceSession {
  constructor({ send, sendAudio }) {
    this.send = send;
    this.sendAudio = sendAudio;
    this.state = State.IDLE;
    this.history = [];
    this.memory = normalizeMemory(null);
    this.context = {};
    this.paused = false;
    this.genSeq = 0;
    this.gen = null;
    this.stt = new FluxStream();
    this.ttsProvider = config.ttsProvider;
    this.tts = createTTS(this.ttsProvider);

    this.asyncThoughtCache = null;
    this.thoughtAbort = null;
    this.thoughtDebounceTimer = null;
    this.thoughtLastRunAt = 0;

    // Snapshot agent (async topic context - never blocks main AI)
    this.asyncSnapshotCache = null;
    this.snapshotAbort = null;
    this.snapshotDebounceTimer = null;
    this.snapshotLastRunAt = 0;

    this.emittedFinalTurnIndex = -1;
    this.lastCommittedUserText = "";
    this.lastCommittedUserAt = 0;

    this.recentMemoryCallbacks = [];
    
    this.sessionStartedAt = Date.now();
    this.turnCount = 0;
  }

  #recentCallbackValues() {
    return this.recentMemoryCallbacks.map((c) => c.value);
  }

  #trackMemoryCallbacks(spoken) {
    for (const hit of detectMemoryCallbacks(spoken, this.memory)) {
      const exists = this.recentMemoryCallbacks.some(
        (c) => c.value.toLowerCase() === hit.value.toLowerCase()
      );
      if (!exists) {
        this.recentMemoryCallbacks.unshift({ key: hit.key, value: hit.value, at: Date.now() });
      }
    }
    if (this.recentMemoryCallbacks.length > 6) {
      this.recentMemoryCallbacks = this.recentMemoryCallbacks.slice(0, 6);
    }
  }

  setMemory(memory, context) {
    if (memory) {
      this.memory = normalizeMemory(memory);
      this.memory = startNewSession(this.memory);
    }
    if (context) this.context = context;
    this.asyncThoughtCache = null;
    this.asyncSnapshotCache = null;
    this.#scheduleThought(null, true);
  }

  setHistory(history) {
    if (Array.isArray(history)) {
      this.history = history;
    }
  }

  setTtsProvider(provider) {
    if (provider === this.ttsProvider) return;
    if (this.tts) this.tts.close();
    this.ttsProvider = provider;
    this.tts = createTTS(provider);
    if (this.tts) {
      this.tts.on("audio", ({ contextId, pcm }) => this.#onTtsAudio(contextId, pcm));
      this.tts.on("done", ({ contextId }) => this.#onTtsDone(contextId));
      this.tts.on("error", (e) => this.#onTtsError(e));
      this.tts.connect();
    }
    this.send({ type: "tts_provider", provider: this.ttsProvider });
  }

  #effectiveThoughtCache() {
    return mergeThoughtCache(this.asyncThoughtCache, this.memory, {
      recentCallbacks: this.#recentCallbackValues(),
    });
  }

  resume() {
    if (!this.paused) return;
    this.#setPaused(false);
  }

  start() {
    this.stt.on("open", () => this.#setState(State.LISTENING));
    this.stt.on("turn", (t) => this.#onTurn(t));
    this.stt.on("error", (e) => this.send({ type: "error", source: "stt", message: e.message }));
    this.stt.on("close", () => this.#setState(State.IDLE));
    this.stt.connect();

    if (this.tts) {
      this.tts.on("audio", ({ contextId, pcm }) => this.#onTtsAudio(contextId, pcm));
      this.tts.on("done", ({ contextId }) => this.#onTtsDone(contextId));
      this.tts.on("error", (e) => this.#onTtsError(e));
      this.tts.connect();
    }

    this.send({
      type: "ready",
      capabilities: { stt: true, llm: llmAvailable(), tts: ttsAvailable(this.ttsProvider) },
      ttsProvider: this.ttsProvider,
      ttsProviders: getAvailableProviders(),
    });
  }

  handleAudio(chunk) {
    this.stt.sendAudio(chunk);
  }

  handleText(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    if (this.gen) this.#abortGeneration();
    this.send({ type: "transcript", role: "user", text: clean, final: true });
    this.#processUserTurn(clean, { speculative: false, fromText: true });
  }

  #setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.send({ type: "state", state: next, turnId: this.gen?.id ?? null });
  }

  #onTurn({ event, transcript, turnIndex }) {
    switch (event) {
      case FluxEvent.START_OF_TURN:
        if (this.state === State.SPEAKING) break;
        if (this.gen) this.#abortGeneration();
        this.#abortThought();
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
        break;

      case FluxEvent.UPDATE:
        if (transcript) {
          this.send({ type: "transcript", role: "user", text: transcript, final: false });
          this.#scheduleThought(transcript);
        }
        break;

      case FluxEvent.EAGER_END_OF_TURN:
        if (this.state === State.SPEAKING) break;
        if (transcript && !this.#isRecentDuplicateTurn(transcript)) {
          if (this.gen) this.#abortGeneration();
          this.#processUserTurn(transcript, { speculative: true });
        }
        break;

      case FluxEvent.TURN_RESUMED:
        if (this.gen?.speculative) this.#abortGeneration();
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
        break;

      case FluxEvent.END_OF_TURN:
        this.#emitFinalTranscript(transcript, turnIndex);
        if (this.gen?.speculative && this.gen.userText === transcript) {
          this.#confirmGeneration();
        } else {
          if (this.gen) this.#abortGeneration();
          if (transcript && !this.#isRecentDuplicateTurn(transcript)) {
            this.#processUserTurn(transcript, { speculative: false });
          } else if (!transcript) {
            this.#setState(this.paused ? State.PAUSED : State.LISTENING);
          } else {
            this.#setState(this.paused ? State.PAUSED : State.LISTENING);
          }
        }
        break;
    }
  }

  async #processUserTurn(userText, { speculative, fromText = false }) {
    this.turnCount++;
    
    if (detectSleepCommand(userText)) {
      await this.#handleSleep(userText);
      return;
    }

    const intent = await analyzeUserIntent({
      userText,
      memory: this.memory,
      context: this.context,
      history: this.history,
      sessionPaused: this.paused,
    }).catch(() => null);

    if (this.paused) {
      if (fromText) {
      } else if (intent?.function === Fn.RESUME) {
        this.#setPaused(false);
      } else {
        this.#setState(State.PAUSED);
        return;
      }
    } else if (intent?.function === Fn.PAUSE) {
      await this.#handlePause(userText);
      return;
    }

    this.#beginGeneration(userText, { speculative, keepPaused: fromText && this.paused });
  }

  async #handlePause(userText, { skipHistory = false } = {}) {
    if (this.gen) this.#abortGeneration();
    if (!skipHistory) {
      this.history.push({ role: "user", content: userText });
      this.lastCommittedUserText = userText;
      this.lastCommittedUserAt = Date.now();
    }
    this.#setPaused(true);
    this.#syncMemoryToClient(userText, "").catch(() => {});
  }

  async #handleSleep(userText) {
    if (this.gen) this.#abortGeneration();
    this.history.push({ role: "user", content: userText });
    this.lastCommittedUserText = userText;
    this.lastCommittedUserAt = Date.now();
    this.#setPaused(false);
    this.send({ type: "function", name: Fn.SLEEP, reason: "go to sleep" });
    
    await this.#consolidateAndSend();
  }

  #setPaused(next) {
    this.paused = next;
    this.#setState(next ? State.PAUSED : State.LISTENING);
    this.send({ type: "function", name: next ? Fn.PAUSE : Fn.RESUME });
  }

  #beginGeneration(userText, { speculative, keepPaused = false }) {
    const id = ++this.genSeq;
    const abort = new AbortController();
    const gen = {
      id,
      userText,
      speculative,
      confirmed: !speculative,
      keepPaused,
      abort,
      buffer: "",
      fullText: "",
      rawBuffer: "",
      cleanLen: 0,
      ttsCtl: null,
      llmDone: false,
      speaking: false,
      committed: false,
    };
    this.gen = gen;
    this.#setState(State.THINKING);

    if (gen.confirmed && !gen.keepPaused) this.#openTts(gen);

    this.#consume(gen).catch((err) => {
      if (!abort.signal.aborted) {
        this.send({ type: "error", source: "llm", message: err.message });
      }
    });
  }

  async #consume(gen) {
    const retrieved = retrieveRelevantMemories(this.memory, gen.userText);
    
    let llmHistory = [...this.history];
    if (gen.committed && llmHistory.length > 0 && llmHistory[llmHistory.length - 1].role === "user" && llmHistory[llmHistory.length - 1].content === gen.userText) {
      llmHistory.pop();
    }

    // Schedule snapshot refresh in background (never blocks this response)
    this.#scheduleSnapshot(gen.userText);

    if (this.asyncSnapshotCache?.snapshot) {
      console.log("[snapshot] using", this.asyncSnapshotCache.topic, "—", this.asyncSnapshotCache.snapshot.slice(0, 80) + "...");
    }

    for await (const delta of streamReply({
      history: llmHistory,
      userText: gen.userText,
      memory: this.memory,
      context: this.context,
      thoughtCache: this.#effectiveThoughtCache(),
      recentCallbacks: this.#recentCallbackValues(),
      signal: gen.abort.signal,
      retrievedMemory: retrieved,
      snapshotCache: this.asyncSnapshotCache,
    })) {
      if (gen.abort.signal.aborted) return;
      gen.fullText += delta;
      if (gen.confirmed) this.#emitDelta(gen, delta);
      else gen.buffer += delta;
    }
    gen.llmDone = true;
    if (gen.abort.signal.aborted) return;
    
    if (retrieved.accessedIds.length > 0) {
      this.memory = markAccessedEntries(this.memory, retrieved.accessedIds);
    }
    
    if (gen.confirmed) this.#finishLlmGeneration(gen);
  }

  #finishLlmGeneration(gen) {
    if (gen.finalized || gen.abort.signal.aborted) return;
    if (gen.ttsCtl) {
      gen.ttsCtl.end();
      if (gen.ttsFinalizeTimer) clearTimeout(gen.ttsFinalizeTimer);
      gen.ttsFinalizeTimer = setTimeout(() => {
        if (this.gen !== gen || gen.finalized) return;
        this.#finalize(gen, { speakFallback: true });
      }, 4000);
    } else {
      this.#finalize(gen, { speakFallback: !this.tts });
    }
  }

  #confirmGeneration() {
    const gen = this.gen;
    if (!gen || gen.confirmed) return;
    gen.confirmed = true;
    this.#commitUser(gen);
    if (!gen.keepPaused) this.#openTts(gen);

    if (gen.buffer) {
      this.#emitDelta(gen, gen.buffer);
      gen.buffer = "";
    }
    if (gen.llmDone) {
      this.#finishLlmGeneration(gen);
    }
  }

  #openTts(gen) {
    this.#commitUser(gen);
    if (this.tts) gen.ttsCtl = this.tts.speak(`gen-${gen.id}`);
  }

  #commitUser(gen) {
    if (gen.committed) return;
    gen.committed = true;
    this.history.push({ role: "user", content: gen.userText });
    this.lastCommittedUserText = gen.userText;
    this.lastCommittedUserAt = Date.now();
  }

  #emitDelta(gen, delta) {
    const clean = mergeCleanDelta(gen, delta);
    if (!clean) return;

    gen.fullText = (gen.fullText || "") + clean;

    this.send({ type: "assistant_delta", text: clean, turnId: gen.id });
    
    if (gen.ttsCtl) {
      gen.ttsCtl.push(clean);
    } 
    
    if (!gen.speaking && clean) {
      gen.speaking = true;
      this.#setState(State.SPEAKING);
    }
  }

  #onTtsAudio(contextId, pcm) {
    const gen = this.gen;
    if (!gen || gen.abort.signal.aborted) return;
    if (contextId !== `gen-${gen.id}`) return;
    gen.ttsHeard = true;
    if (gen.ttsFinalizeTimer) {
      clearTimeout(gen.ttsFinalizeTimer);
      gen.ttsFinalizeTimer = null;
    }
    if (!gen.speaking) {
      gen.speaking = true;
      this.#setState(State.SPEAKING);
    }
    this.sendAudio(gen.id, pcm);
  }

  #onTtsDone(contextId) {
    const gen = this.gen;
    if (!gen || contextId !== `gen-${gen.id}`) return;
    if (!gen.llmDone) return;
    this.#finalize(gen);
  }

  #onTtsError(err) {
    console.error("[tts] error:", err.message);
    this.send({ type: "error", source: "tts", message: err.message });

    // Reinitialize TTS for the next turn rather than permanently disabling it
    const dead = this.tts;
    this.tts = createTTS(this.ttsProvider);
    if (this.tts) {
      this.tts.on("audio", ({ contextId, pcm }) => this.#onTtsAudio(contextId, pcm));
      this.tts.on("done", ({ contextId }) => this.#onTtsDone(contextId));
      this.tts.on("error", (e) => this.#onTtsError(e));
      this.tts.connect();
    }
    try { dead?.close?.(); } catch {}

    const gen = this.gen;
    if (gen && gen.ttsCtl && !gen.finalized) {
      gen.ttsCtl.cancel?.();
      gen.ttsCtl = null;
      if (gen.llmDone) this.#finalize(gen, { speakFallback: true });
    }
  }

  #finalize(gen, { speakFallback = false } = {}) {
    if (gen.finalized) return;
    gen.finalized = true;
    if (gen.ttsFinalizeTimer) {
      clearTimeout(gen.ttsFinalizeTimer);
      gen.ttsFinalizeTimer = null;
    }

    const spoken = gen.fullText || "";
    
    if (spoken) this.history.push({ role: "assistant", content: spoken });
    this.#trackMemoryCallbacks(spoken);
    const useFallback = speakFallback || (Boolean(gen.ttsCtl) && !gen.ttsHeard);
    this.send({
      type: "assistant_done",
      text: spoken,
      turnId: gen.id,
      speakFallback: useFallback,
    });

    this.#syncMemoryToClient(gen.userText, spoken);

    if (this.gen === gen) {
      this.gen = null;
      this.#setState(this.paused ? State.PAUSED : State.LISTENING);
    }
  }

  async #syncMemoryToClient(userText, assistantText) {
    try {
      const analysis = await analyzeTurnMemory({
        userText,
        assistantText,
        memory: this.memory,
        context: this.context,
        history: this.history,
        sessionPaused: this.paused,
      });
      if (analysis) {
        if (analysis.function === Fn.PAUSE && !this.paused) {
          await this.#handlePause(userText, { skipHistory: true });
          return;
        }
        if (analysis.function === Fn.RESUME && this.paused && !this.gen?.keepPaused) {
          this.#setPaused(false);
        }
        this.memory = applyMemoryUpdates(this.memory, analysis);
      }
    } catch {}
    this.asyncThoughtCache = null;
    this.#scheduleThought(userText, false, 0);
    this.send({ type: "memory_update", memory: this.memory });
  }

  async #consolidateAndSend() {
    try {
      const sessionId = this.memory.meta?.currentSessionId;
      const sessionLogs = this.memory.logs.filter(l => l.sessionId === sessionId);
      
      if (sessionLogs.length >= 3 && this.turnCount >= 2) {
        const consolidationResult = await consolidateSessionMemory({
          sessionLogs,
          history: this.history,
          existingSemanticMemory: this.memory.semantic
        });
        
        if (consolidationResult) {
          this.memory = consolidateSession(this.memory, consolidationResult.sessionSummary);
          
          for (const promote of consolidationResult.promoteToSemantic || []) {
            const exists = this.memory.semantic.some(
              s => s.subject.toLowerCase() === promote.subject.toLowerCase() &&
                   s.value.toLowerCase() === promote.value.toLowerCase()
            );
            if (!exists) {
              this.memory.semantic.push({
                id: generateId(),
                category: promote.category,
                subject: promote.subject,
                value: promote.value,
                confidence: promote.confidence,
                source: 'consolidated',
                createdAt: memoryNow(),
                updatedAt: memoryNow(),
                accessCount: 1,
                lastAccessedAt: memoryNow()
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[session] consolidation failed:', err.message);
    }
    
    this.send({ type: "memory_update", memory: this.memory });
  }

  #abortGeneration() {
    const gen = this.gen;
    if (!gen) return;
    gen.abort.abort();
    if (gen.ttsCtl) gen.ttsCtl.cancel();
    this.gen = null;
    this.send({ type: "interrupt", turnId: gen.id });
  }

  #normalizeTranscript(text) {
    return (text || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  #isRecentDuplicate(text, lastText, lastAt, windowMs = 4000) {
    const norm = this.#normalizeTranscript(text);
    if (!norm) return true;
    if (norm !== this.#normalizeTranscript(lastText)) return false;
    return Date.now() - lastAt < windowMs;
  }

  #isRecentDuplicateTurn(text) {
    if (!this.lastCommittedUserText) return false;
    return this.#isRecentDuplicate(text, this.lastCommittedUserText, this.lastCommittedUserAt);
  }

  #emitFinalTranscript(text, turnIndex) {
    if (!text) return;
    if (turnIndex !== undefined && turnIndex === this.emittedFinalTurnIndex) return;
    if (this.#isRecentDuplicateTurn(text)) return;
    if (turnIndex !== undefined) this.emittedFinalTurnIndex = turnIndex;
    this.send({ type: "transcript", role: "user", text, final: true });
  }

  #abortThought() {
    if (this.thoughtDebounceTimer) {
      clearTimeout(this.thoughtDebounceTimer);
      this.thoughtDebounceTimer = null;
    }
    if (this.thoughtAbort) {
      this.thoughtAbort.abort();
      this.thoughtAbort = null;
    }
  }

  #scheduleThought(transcript, immediate = false, extraDelayMs = null) {
    if (!thoughtAgentAvailable()) return;

    if (this.thoughtDebounceTimer) {
      clearTimeout(this.thoughtDebounceTimer);
      this.thoughtDebounceTimer = null;
    }

    const delay = immediate
      ? 0
      : extraDelayMs !== null
        ? extraDelayMs
        : config.thoughtDebounceMs;

    this.thoughtDebounceTimer = setTimeout(() => {
      this.thoughtDebounceTimer = null;
      this.#runThought(transcript);
    }, delay);
  }

  #runThought(transcript) {
    if (!thoughtAgentAvailable()) return;

    const now = Date.now();
    if (now - this.thoughtLastRunAt < config.thoughtRateLimitMs) return;

    if (this.thoughtAbort) this.thoughtAbort.abort();

    const abort = new AbortController();
    this.thoughtAbort = abort;

    runThoughtAgent({
      transcript: transcript || "",
      history: this.history,
      memory: this.memory,
      recentCallbacks: this.#recentCallbackValues(),
      signal: abort.signal,
    }).then((result) => {
      if (abort.signal.aborted || this.thoughtAbort !== abort) return;
      this.thoughtAbort = null;
      this.thoughtLastRunAt = Date.now();
      if (result && result.confidence >= 0.35) {
        this.asyncThoughtCache = result;
      }
    }).catch(() => {
      if (this.thoughtAbort === abort) this.thoughtAbort = null;
    });
  }

  // ── Snapshot Agent (async topic context) ────────────────────────────

  #abortSnapshot() {
    if (this.snapshotDebounceTimer) {
      clearTimeout(this.snapshotDebounceTimer);
      this.snapshotDebounceTimer = null;
    }
    if (this.snapshotAbort) {
      this.snapshotAbort.abort();
      this.snapshotAbort = null;
    }
  }

  #scheduleSnapshot(transcript) {
    if (!snapshotAgentAvailable()) return;
    
    // Check if we actually need a new snapshot (topic-based caching)
    if (!shouldRefreshSnapshot(this.asyncSnapshotCache, transcript, this.history)) {
      return;
    }

    if (this.snapshotDebounceTimer) {
      clearTimeout(this.snapshotDebounceTimer);
      this.snapshotDebounceTimer = null;
    }

    this.snapshotDebounceTimer = setTimeout(() => {
      this.snapshotDebounceTimer = null;
      this.#runSnapshot(transcript);
    }, config.snapshotDebounceMs);
  }

  #runSnapshot(transcript) {
    if (!snapshotAgentAvailable()) return;

    const now = Date.now();
    if (now - this.snapshotLastRunAt < config.snapshotRateLimitMs) return;

    if (this.snapshotAbort) this.snapshotAbort.abort();

    const abort = new AbortController();
    this.snapshotAbort = abort;

    runSnapshotAgent({
      transcript: transcript || "",
      history: this.history,
      memory: this.memory,
      signal: abort.signal,
    }).then((result) => {
      if (abort.signal.aborted || this.snapshotAbort !== abort) return;
      this.snapshotAbort = null;
      this.snapshotLastRunAt = Date.now();
      if (result && result.snapshot) {
        this.asyncSnapshotCache = result;
        console.log("[snapshot]", {
          topic: result.topic,
          topicType: result.topicType,
          snapshot: result.snapshot,
          conversationAngles: result.conversationAngles,
        });
      } else {
        console.log("[snapshot] no topic");
      }
    }).catch(() => {
      if (this.snapshotAbort === abort) this.snapshotAbort = null;
    });
  }

  async close() {
    if (this.gen) this.#abortGeneration();
    this.#abortThought();
    this.#abortSnapshot();
    
    await this.#consolidateAndSend();
    
    this.stt.close();
    if (this.tts) this.tts.close();
  }
}
