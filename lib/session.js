import { FluxStream } from "./sttFlux.js";
import {
  createTTS,
  ttsAvailable,
  getAvailableProviders,
  annotateTtsChunks,
  flushTtsChunkAnnotator,
} from "./tts.js";
import { streamReply, streamSnapshotFollowup, llmAvailable } from "./llm.js";
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
  generateId,
  countDryReplyStreak,
  isDryUtterance,
} from "./memory.js";
import { analyzeTurnMemory, analyzeUserIntent, consolidateSessionMemory } from "./memory-ai.js";
import { detectSleepCommand, Fn, detectPauseCommand, detectResumeCommand } from "./functions.js";
import { runThoughtAgent, thoughtAgentAvailable } from "./thought-agent.js";
import { runSnapshotAgent, snapshotAgentAvailable, shouldRefreshSnapshot, detectTopicHooksUsed, isSnapshotTopicActive, pickSuggestedTopicHooks } from "./snapshot-agent.js";

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

    // Idle continuation ("keep talking" off a snapshot hook). Runs ONLY after the
    // main reply finishes and the user stays quiet — never on the main path.
    this.followupTimer = null;
    this.followupLastRunAt = 0;

    this.emittedFinalTurnIndex = -1;
    this.lastCommittedUserText = "";
    this.lastCommittedUserAt = 0;

    this.recentMemoryCallbacks = [];
    this.usedTopicHooks = [];
    
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

  #trackTopicHooks(spoken) {
    const hooks = this.asyncSnapshotCache?.topicHooks;
    if (!hooks?.length) return;

    for (const hit of detectTopicHooksUsed(spoken, hooks)) {
      const exists = this.usedTopicHooks.some(
        (h) => h.toLowerCase() === hit.toLowerCase()
      );
      if (!exists) {
        this.usedTopicHooks.unshift(hit);
      }
    }
    if (this.usedTopicHooks.length > 10) {
      this.usedTopicHooks = this.usedTopicHooks.slice(0, 10);
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
    this.usedTopicHooks = [];
    this.#abortFollowup();
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

  #effectiveThoughtCache(userText = "") {
    const dryReplyStreak = countDryReplyStreak(this.history, userText);
    return mergeThoughtCache(this.asyncThoughtCache, this.memory, {
      recentCallbacks: this.#recentCallbackValues(),
      dryReplyStreak,
    });
  }

  resume() {
    if (!this.paused) return;
    this.#setPaused(false);
    if (this.tts) this.tts.connect();
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
        this.#abortFollowup();
        if (this.state === State.SPEAKING) break;
        if (this.gen) this.#abortGeneration();
        this.#abortThought();
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
        break;

      case FluxEvent.UPDATE:
        if (transcript) {
          this.#abortFollowup();
          this.send({ type: "transcript", role: "user", text: transcript, final: false });
          this.#scheduleThought(transcript);
          if (!isDryUtterance(transcript)) {
            this.#scheduleSnapshot(transcript);
          }
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

  #processUserTurn(userText, { speculative, fromText = false }) {
    this.turnCount++;
    this.#abortFollowup();

    if (detectSleepCommand(userText)) {
      this.#handleSleep(userText);
      return;
    }

    if (!this.paused && detectPauseCommand(userText)) {
      this.#handlePause(userText);
      return;
    }

    if (this.paused && !fromText) {
      if (detectResumeCommand(userText)) {
        this.#setPaused(false);
      } else {
        this.#runIntentInBackground(userText);
        this.#setState(State.PAUSED);
        return;
      }
    }

    this.#beginGeneration(userText, { speculative, keepPaused: fromText && this.paused });
    // Intent detection via LLM is only needed when paused (to catch ambiguous resume commands).
    // For normal turns, local detectPauseCommand already handles this — skip the extra API call.
  }

  #runIntentInBackground(userText) {
    analyzeUserIntent({
      userText,
      memory: this.memory,
      context: this.context,
      history: this.history,
      sessionPaused: this.paused,
    }).then((intent) => {
      if (!intent?.function) return;
      if (intent.function === Fn.RESUME && this.paused) {
        this.#setPaused(false);
        return;
      }
      if (intent.function === Fn.PAUSE && !this.paused && this.gen?.userText === userText) {
        this.#handlePause(userText, { skipHistory: Boolean(this.gen?.committed) });
      }
    }).catch(() => {});
  }

  #handlePause(userText, { skipHistory = false } = {}) {
    if (this.gen) this.#abortGeneration();
    if (!skipHistory) {
      this.history.push({ role: "user", content: userText });
      this.lastCommittedUserText = userText;
      this.lastCommittedUserAt = Date.now();
    }
    this.#setPaused(true);
    this.#syncMemoryToClient(userText, "");
  }

  #handleSleep(userText) {
    if (this.gen) this.#abortGeneration();
    this.history.push({ role: "user", content: userText });
    this.lastCommittedUserText = userText;
    this.lastCommittedUserAt = Date.now();
    this.#setPaused(false);
    this.send({ type: "function", name: Fn.SLEEP, reason: "go to sleep" });
    
    this.#consolidateAndSend();
  }

  #setPaused(next) {
    if (next) this.#abortFollowup();
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
    if (!isDryUtterance(gen.userText)) {
      this.#scheduleSnapshot(gen.userText);
    }

    if (this.asyncSnapshotCache && (this.asyncSnapshotCache.snapshot || this.asyncSnapshotCache.topicHooks?.length)) {
      const preview = this.asyncSnapshotCache.snapshot || this.asyncSnapshotCache.topicHooks?.slice(0, 3).join(", ");
      console.log("[snapshot] using", this.asyncSnapshotCache.topic, "—", String(preview).slice(0, 80));
    }

    for await (const delta of streamReply({
      history: llmHistory,
      userText: gen.userText,
      memory: this.memory,
      context: this.context,
      thoughtCache: this.#effectiveThoughtCache(gen.userText),
      recentCallbacks: this.#recentCallbackValues(),
      signal: gen.abort.signal,
      retrievedMemory: retrieved,
      snapshotCache: this.asyncSnapshotCache,
      usedTopicHooks: this.usedTopicHooks,
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

    const chunkCount = annotateTtsChunks(gen, clean);

    this.send({
      type: "assistant_delta",
      text: clean,
      chunkFlush: chunkCount || undefined,
      turnId: gen.id,
    });

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

    // Don't retry on auth/billing errors — they will never succeed and cause a flood.
    const msg = err.message || "";
    const isFatalTtsError =
      msg.includes("402") ||
      msg.includes("403") ||
      msg.includes("401") ||
      msg.includes("Unauthorized") ||
      msg.includes("Payment");
    if (isFatalTtsError) {
      console.error("[tts] fatal error — not retrying. Check API key, credits, or switch to browser TTS.");
      try { this.tts?.close?.(); } catch {}
      this.tts = null;
    } else {
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
    }

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

    // Remaining TTS buffer text was already sent to the client in incremental
    // deltas — only clear it here for debug annotation, don't re-emit to UI.
    const tail = flushTtsChunkAnnotator(gen);
    if (tail) gen.fullChunkText = (gen.fullChunkText || "") + tail;

    const spoken = gen.fullText || "";

    if (spoken) {
      if (gen.isFollowup) {
        // Continuation tacked onto the previous reply — merge into that turn so
        // history reads as one flowing thought, not two assistant messages.
        const last = this.history[this.history.length - 1];
        if (last && last.role === "assistant") {
          last.content = `${last.content} ${spoken}`.trim();
        } else {
          this.history.push({ role: "assistant", content: spoken });
        }
      } else {
        this.history.push({ role: "assistant", content: spoken });
      }
    }
    this.#trackMemoryCallbacks(spoken);
    this.#trackTopicHooks(spoken);
    const useFallback = speakFallback || (Boolean(gen.ttsCtl) && !gen.ttsHeard);
    this.send({
      type: "assistant_done",
      text: spoken,
      textWithStalls: gen.fullChunkText || spoken,
      turnId: gen.id,
      speakFallback: useFallback,
      continuation: gen.isFollowup || undefined,
    });

    // Follow-ups carry no new user input — skip the memory pass entirely.
    if (!gen.isFollowup) this.#syncMemoryToClient(gen.userText, spoken);

    if (this.gen === gen) {
      this.gen = null;
      this.#setState(this.paused ? State.PAUSED : State.LISTENING);
    }

    // After a real reply, maybe keep talking off a snapshot hook if the user
    // stays quiet. Never chain a follow-up off another follow-up.
    if (!gen.isFollowup && spoken && !this.paused && !gen.keepPaused) {
      this.#scheduleFollowup();
    }
  }

  #syncMemoryToClient(userText, assistantText) {
    // Skip full memory analysis on very short/filler turns — nothing worth storing.
    const wordCount = (userText || "").trim().split(/\s+/).filter(Boolean).length;
    const skipMemory = wordCount <= 2 && isDryUtterance(userText);

    this.asyncThoughtCache = null;

    if (!skipMemory) {
      // Run thought agent immediately in background
      this.#scheduleThought(userText, false, 0);

      // Run memory analysis in background
      analyzeTurnMemory({
        userText,
        assistantText,
        memory: this.memory,
        context: this.context,
        history: this.history,
        sessionPaused: this.paused,
      }).then((analysis) => {
        if (analysis) {
          if (analysis.function === Fn.PAUSE && !this.paused) {
            this.#handlePause(userText, { skipHistory: true });
            return;
          }
          if (analysis.function === Fn.RESUME && this.paused && !this.gen?.keepPaused) {
            this.#setPaused(false);
          }
          this.memory = applyMemoryUpdates(this.memory, analysis);
          this.send({ type: "memory_update", memory: this.memory });
        }
      }).catch(err => {
        console.error('[session] memory analysis failed:', err.message);
      });
    } else {
      this.send({ type: "memory_update", memory: this.memory });
    }
  }

  #consolidateAndSend() {
    const sessionId = this.memory.meta?.currentSessionId;
    const sessionLogs = this.memory.logs.filter(l => l.sessionId === sessionId);
    
    if (sessionLogs.length >= 3 && this.turnCount >= 2) {
      consolidateSessionMemory({
        sessionLogs,
        history: this.history,
        existingSemanticMemory: this.memory.semantic
      }).then((consolidationResult) => {
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
          this.send({ type: "memory_update", memory: this.memory });
        }
      }).catch(err => {
        console.error('[session] consolidation failed:', err.message);
      });
    }
  }

  #abortGeneration() {
    this.#abortFollowup();
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
      dryReplyStreak: countDryReplyStreak(this.history, transcript || ""),
      signal: abort.signal,
    }).then((result) => {
      if (abort.signal.aborted || this.thoughtAbort !== abort) return;
      this.thoughtAbort = null;
      this.thoughtLastRunAt = Date.now();
      const dryStreak = countDryReplyStreak(this.history, transcript || "");
      if (result && result.confidence >= (dryStreak >= 2 ? 0.2 : 0.35)) {
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
      
      if (result) {
        if (result.hasTopic === false) {
          this.asyncSnapshotCache = result;
          console.log("[snapshot] no topic (cached)");
        } else if (result.snapshot || result.topicHooks?.length) {
          const prevTopic = (this.asyncSnapshotCache?.topic || "").toLowerCase();
          const nextTopic = (result.topic || "").toLowerCase();
          if (prevTopic && nextTopic && prevTopic !== nextTopic) {
            this.usedTopicHooks = [];
          }
          this.asyncSnapshotCache = result;
          console.log("[snapshot]", {
            topic: result.topic,
            topicType: result.topicType,
            snapshot: result.snapshot,
            topicHooks: result.topicHooks,
          });
        }
      }
    }).catch(() => {
      if (this.snapshotAbort === abort) this.snapshotAbort = null;
    });
  }

  // ── Idle continuation (snapshot-anchored "keep talking") ─────────────

  #abortFollowup() {
    if (this.followupTimer) {
      clearTimeout(this.followupTimer);
      this.followupTimer = null;
    }
  }

  #scheduleFollowup() {
    if (!config.followupEnabled) return;
    this.#abortFollowup();
    // Cheap pre-check — don't even arm the timer when there's nothing to ride on.
    if (!snapshotAgentAvailable() || !this.asyncSnapshotCache) return;
    if (this.asyncSnapshotCache.hasTopic === false) return;

    this.followupTimer = setTimeout(() => {
      this.followupTimer = null;
      if (this.#shouldFollowup()) this.#beginFollowup();
    }, config.followupDelayMs);
  }

  #shouldFollowup() {
    if (!config.followupEnabled || !snapshotAgentAvailable()) return false;
    // Only when truly idle: not paused, nothing generating, user not mid-turn.
    if (this.paused || this.gen) return false;
    if (this.state !== State.LISTENING) return false;

    const cache = this.asyncSnapshotCache;
    if (!cache || cache.hasTopic === false) return false;
    const hooks = cache.topicHooks?.length ? cache.topicHooks : cache.conversationAngles || [];
    if (hooks.length === 0) return false;

    // Need a fresh hook — never just re-say one we already used.
    if (pickSuggestedTopicHooks(hooks, this.usedTopicHooks, 1).length === 0) return false;

    // Topic has to be what we were actually just on.
    if (!isSnapshotTopicActive(cache, this.lastCommittedUserText, this.history)) return false;

    // Don't pile on when the user has gone cold.
    if (countDryReplyStreak(this.history, this.lastCommittedUserText) >= 2) return false;

    // Spacing + "only sometimes".
    if (Date.now() - this.followupLastRunAt < config.followupRateLimitMs) return false;
    if (Math.random() > config.followupChance) return false;

    return true;
  }

  #beginFollowup() {
    const id = ++this.genSeq;
    const abort = new AbortController();
    const gen = {
      id,
      userText: "",
      speculative: false,
      confirmed: true,
      keepPaused: false,
      abort,
      buffer: "",
      fullText: "",
      rawBuffer: "",
      cleanLen: 0,
      ttsCtl: null,
      llmDone: false,
      speaking: false,
      committed: true,
      isFollowup: true,
    };
    this.gen = gen;
    this.followupLastRunAt = Date.now();
    this.#setState(State.THINKING);
    if (this.tts) gen.ttsCtl = this.tts.speak(`gen-${gen.id}`);

    this.#consumeFollowup(gen).catch(() => {
      if (this.gen === gen) {
        if (gen.ttsCtl) gen.ttsCtl.cancel();
        this.gen = null;
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
      }
    });
  }

  async #consumeFollowup(gen) {
    let collected = "";
    for await (const delta of streamSnapshotFollowup({
      history: this.history,
      memory: this.memory,
      context: this.context,
      snapshotCache: this.asyncSnapshotCache,
      usedTopicHooks: this.usedTopicHooks,
      signal: gen.abort.signal,
    })) {
      if (gen.abort.signal.aborted) return;
      collected += delta;
    }
    if (gen.abort.signal.aborted) return;

    // Buffer fully so we can drop a "SKIP" (or empty) before any audio plays.
    const clean = stripMemoryTags(collected).trim();
    if (!clean || /^skip\b/i.test(clean)) {
      if (gen.ttsCtl) gen.ttsCtl.cancel();
      if (this.gen === gen) {
        this.gen = null;
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
      }
      return;
    }

    gen.fullText = clean;
    gen.cleanLen = clean.length;

    const chunkCount = annotateTtsChunks(gen, clean);
    this.send({
      type: "assistant_delta",
      text: clean,
      continuation: true,
      chunkFlush: chunkCount || undefined,
      turnId: gen.id,
    });

    if (gen.ttsCtl) gen.ttsCtl.push(clean);
    gen.speaking = true;
    this.#setState(State.SPEAKING);

    gen.llmDone = true;
    this.#finishLlmGeneration(gen);
  }

  close() {
    if (this.gen) this.#abortGeneration();
    this.#abortThought();
    this.#abortSnapshot();
    this.#abortFollowup();
    
    this.#consolidateAndSend();
    
    this.stt.close();
    if (this.tts) this.tts.close();
  }
}
