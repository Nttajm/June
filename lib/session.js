import { FluxStream } from "./sttFlux.js";
import {
  createTTS,
  ttsAvailable,
  getAvailableProviders,
  annotateTtsChunks,
  flushTtsChunkAnnotator,
  normalizeElevenLabsModel,
  ELEVENLABS_MODELS,
} from "./tts.js";
import { streamReply, streamSnapshotFollowup, llmAvailable } from "./llm.js";
import { State, FluxEvent, config } from "./states.js";
import { 
  mergeCleanDelta, 
  applyCategoryUpdates, 
  stripMemoryTags, 
  mergeThoughtCache, 
  detectMemoryCallbacks, 
  normalizeMemory,
  consolidateSession,
  startNewSession,
  countDryReplyStreak,
  isDryUtterance,
  memoryNow,
  generateId,
} from "./memory.js";
import { getCategoryDirectory } from "./memory-store.js";
import { analyzeTurnMemory, analyzeUserIntent, consolidateSessionMemory } from "./memory-ai.js";
import { detectSleepCommand, Fn, detectPauseCommand, detectResumeCommand } from "./functions.js";
import { runThoughtAgent, thoughtAgentAvailable } from "./thought-agent.js";
import { runSnapshotAgent, snapshotAgentAvailable, shouldRefreshSnapshot, detectTopicHooksUsed, isSnapshotTopicActive, pickSuggestedTopicHooks } from "./snapshot-agent.js";
import { normalizePastChats } from "./thinker-tools.js";
import { buildAgentTrace } from "./debug-trace.js";

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
    this.elevenLabsModel = normalizeElevenLabsModel(config.elevenLabsModel);
    this.tts = createTTS(this.ttsProvider, { elevenLabsModel: this.elevenLabsModel });

    this.asyncThoughtCache = null;
    this.thoughtAbort = null;
    this.thoughtDebounceTimer = null;
    this.thoughtLastRunAt = 0;
    this.pastChats = [];

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
    /** In-flight turn memory analysis — never awaited on the voice path. */
    this.pendingMemoryJob = null;
    /** Set on close/sleep teardown; memory_update may still best-effort send. */
    this.sessionClosing = false;
    
    this.sessionStartedAt = Date.now();
    this.sessionStartIso = new Date().toISOString();
    this.turnCount = 0;
    this.userInterruptions = 0;
    this.chatTitle = null;
    this.chatSummaryHint = null;
    this.ttftSamples = [];

    /** When true, emit agent_trace events to the client inspector. */
    this.debugTracing = false;
  }

  setDebugTracing(enabled) {
    this.debugTracing = Boolean(enabled);
  }

  #trace({ agent, phase, name, detail, durationMs }) {
    if (!this.debugTracing) return;
    try {
      this.send(buildAgentTrace({
        agent,
        phase,
        name,
        detail,
        durationMs,
        turnId: this.gen?.id ?? null,
      }));
    } catch {}
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
    this.chatTitle = null;
    this.chatSummaryHint = null;
    this.sessionStartIso = new Date().toISOString();
    this.sessionStartedAt = Date.now();
    this.userInterruptions = 0;
    this.ttftSamples = [];
    this.sessionClosing = false;
    this.#abortFollowup();
    this.#scheduleThought(null, true);
  }

  setPastChats(pastChats) {
    this.pastChats = normalizePastChats(pastChats).slice(0, 20);
  }

  #upsertPastChatIndex(chat) {
    if (!chat?.session_id) return;
    const entry = {
      session_id: chat.session_id,
      title: chat.title || "Conversation",
      main_summary: chat.main_summary || "",
      end_time: chat.end_time || null,
      topics: chat.extracted_context?.topics_detected || [],
      previewTurns: Array.isArray(chat.chats)
        ? chat.chats.slice(-6).map((t) => ({
            role: t.role,
            content: String(t.content || "").slice(0, 180),
          }))
        : [],
    };
    this.pastChats = [
      entry,
      ...this.pastChats.filter((c) => c.session_id !== entry.session_id),
    ].slice(0, 20);
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
    this.tts = createTTS(provider, { elevenLabsModel: this.elevenLabsModel });
    this.#wireTts();
    this.send({
      type: "tts_provider",
      provider: this.ttsProvider,
      elevenLabsModel: this.elevenLabsModel,
    });
  }

  setElevenLabsModel(model) {
    const next = normalizeElevenLabsModel(model);
    const same = next === this.elevenLabsModel;
    this.elevenLabsModel = next;
    if (this.ttsProvider === "elevenlabs") {
      // Always rebuild so switching Flash ↔ v3 swaps WS vs HTTP transport.
      if (!same || !this.tts || this.tts.modelId !== next) {
        if (this.tts) this.tts.close();
        this.tts = createTTS("elevenlabs", { elevenLabsModel: this.elevenLabsModel });
        this.#wireTts();
      }
    }
    console.log(
      `[tts] elevenlabs model=${this.elevenLabsModel}` +
        ` transport=${this.tts?.usesHttp ? "http" : "ws"}`
    );
    this.send({ type: "tts_model", elevenLabsModel: this.elevenLabsModel });
  }

  #wireTts() {
    if (!this.tts) return;
    this.tts.on("audio", ({ contextId, pcm }) => this.#onTtsAudio(contextId, pcm));
    this.tts.on("done", ({ contextId }) => this.#onTtsDone(contextId));
    this.tts.on("error", (e) => this.#onTtsError(e));
    this.tts.connect();
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
      this.#wireTts();
    }

    this.send({
      type: "ready",
      capabilities: { stt: true, llm: llmAvailable(), tts: ttsAvailable(this.ttsProvider) },
      ttsProvider: this.ttsProvider,
      ttsProviders: getAvailableProviders(),
      elevenLabsModel: this.elevenLabsModel,
      elevenLabsModels: ELEVENLABS_MODELS,
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
    // Emit chat_saved BEFORE sleep so the client receives it while the socket is still open.
    this.#emitChatSaved();
    this.send({ type: "function", name: Fn.SLEEP, reason: "go to sleep" });
    // Do not await pendingMemoryJob — consolidation stays async; in-flight analysis may still #safeSend.
    this.sessionClosing = true;
    this.#consolidateAndSend({ skipImmediateChatSave: true });
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
    let llmHistory = [...this.history];
    if (gen.committed && llmHistory.length > 0 && llmHistory[llmHistory.length - 1].role === "user" && llmHistory[llmHistory.length - 1].content === gen.userText) {
      llmHistory.pop();
    }

    // Schedule snapshot refresh in background (never blocks this response)
    if (!isDryUtterance(gen.userText)) {
      this.#scheduleSnapshot(gen.userText);
    }

    const thoughtCache = this.#effectiveThoughtCache(gen.userText);
    const snapshotCache = this.asyncSnapshotCache;

    if (snapshotCache && (snapshotCache.snapshot || snapshotCache.topicHooks?.length)) {
      const preview = snapshotCache.snapshot || snapshotCache.topicHooks?.slice(0, 3).join(", ");
      console.log("[snapshot] using", snapshotCache.topic, "—", String(preview).slice(0, 80));
    }

    this.#trace({
      agent: "main",
      phase: "started",
      detail: {
        userText: gen.userText,
        speculative: gen.speculative,
      },
    });

    if (thoughtCache && (thoughtCache.topic || thoughtCache.interjections?.length || thoughtCache.suggestions?.length)) {
      this.#trace({
        agent: "thinker",
        phase: "injected",
        detail: {
          topic: thoughtCache.topic,
          confidence: thoughtCache.confidence,
          tone: thoughtCache.tone,
          interjections: thoughtCache.interjections,
          suggestions: thoughtCache.suggestions,
          memoryBridge: thoughtCache.memoryBridge,
          juneSelfDrop: thoughtCache.juneSelfDrop,
          reasoning: thoughtCache.reasoning,
        },
      });
    }

    if (snapshotCache && (snapshotCache.snapshot || snapshotCache.topicHooks?.length || snapshotCache.hasTopic === false)) {
      this.#trace({
        agent: "snapshot",
        phase: "injected",
        detail: {
          hasTopic: snapshotCache.hasTopic,
          topic: snapshotCache.topic,
          topicType: snapshotCache.topicType,
          snapshot: snapshotCache.snapshot,
          topicHooks: snapshotCache.topicHooks,
          reasoning: snapshotCache.reasoning,
        },
      });
    }

    const ttftStart = Date.now();
    let firstToken = true;
    const mainStart = Date.now();

    for await (const delta of streamReply({
      history: llmHistory,
      userText: gen.userText,
      memory: this.memory,
      context: this.context,
      thoughtCache,
      recentCallbacks: this.#recentCallbackValues(),
      signal: gen.abort.signal,
      snapshotCache,
      usedTopicHooks: this.usedTopicHooks,
      pastChats: this.pastChats,
      onTrace: (ev) => this.#trace(ev),
      onToolsStarted: () => {
        // Kick background enrichment while Phase A audio plays (bypass rate limits)
        this.#scheduleThought(gen.userText, true, null, { force: true });
        this.#scheduleSnapshot(gen.userText, true, { force: true });
        this.#trace({
          agent: "main",
          phase: "tool",
          name: "step_enrich_kick",
          detail: { userText: gen.userText },
        });
      },
      awaitEnrichment: (budgetMs) => this.#awaitEnrichment(budgetMs),
      getLiveSnapshot: () => this.asyncSnapshotCache,
      getLiveThought: () => this.#effectiveThoughtCache(gen.userText),
    })) {
      if (gen.abort.signal.aborted) {
        this.#trace({ agent: "main", phase: "aborted", durationMs: Date.now() - mainStart });
        return;
      }
      if (firstToken) {
        firstToken = false;
        this.ttftSamples.push(Date.now() - ttftStart);
        if (this.ttftSamples.length > 40) this.ttftSamples.shift();
      }
      if (gen.confirmed) this.#emitDelta(gen, delta);
      else gen.buffer += delta;
    }
    gen.llmDone = true;
    if (gen.abort.signal.aborted) {
      this.#trace({ agent: "main", phase: "aborted", durationMs: Date.now() - mainStart });
      return;
    }

    this.#trace({
      agent: "main",
      phase: "result",
      durationMs: Date.now() - mainStart,
      detail: { chars: (gen.fullText || gen.buffer || "").length },
    });
    
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
    if (gen.ttsFinalizeTimer && !gen.llmDone) {
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
      this.tts = createTTS(this.ttsProvider, { elevenLabsModel: this.elevenLabsModel });
      this.#wireTts();
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

  #safeSend(payload) {
    try {
      this.send(payload);
      return true;
    } catch (err) {
      console.error("[session] send failed:", err.message);
      return false;
    }
  }

  #syncMemoryToClient(userText, assistantText) {
    // Skip full memory analysis only on pure filler — short real answers still update memory.
    const skipMemory = isDryUtterance(userText);

    this.asyncThoughtCache = null;
    this.#safeSend({ type: "memory_update", memory: this.memory });

    if (!skipMemory) {
      // Run thought agent immediately in background
      this.#scheduleThought(userText, false, 0);

      // Run memory analysis in background — NEVER blocks voice loop
      this.#trace({
        agent: "memory",
        phase: "started",
        detail: { userText },
      });
      const memStart = Date.now();
      const job = analyzeTurnMemory({
        userText,
        assistantText,
        memory: this.memory,
        context: this.context,
        history: this.history,
        sessionPaused: this.paused,
        pastChats: this.pastChats,
        onTrace: (ev) => this.#trace(ev),
      }).then((analysis) => {
        if (analysis) {
          this.#trace({
            agent: "memory",
            phase: "result",
            durationMs: Date.now() - memStart,
            detail: {
              function: analysis.function,
              setName: analysis.setName,
              chatTitle: analysis.chatTitle,
              chatSummaryHint: analysis.chatSummaryHint,
              generalInfo: analysis.generalInfo,
              categorized: analysis.categorized,
              corrections: analysis.corrections,
              reasoning: analysis.reasoning,
            },
          });
          if (analysis.function === Fn.PAUSE && !this.paused) {
            this.#handlePause(userText, { skipHistory: true });
            return;
          }
          if (analysis.function === Fn.RESUME && this.paused && !this.gen?.keepPaused) {
            this.#setPaused(false);
          }
          let chatMetaChanged = false;
          if (analysis.chatTitle && analysis.chatTitle !== this.chatTitle) {
            this.chatTitle = analysis.chatTitle;
            chatMetaChanged = true;
          }
          if (analysis.chatSummaryHint && analysis.chatSummaryHint !== this.chatSummaryHint) {
            this.chatSummaryHint = analysis.chatSummaryHint;
            chatMetaChanged = true;
          }
          this.memory = applyCategoryUpdates(this.memory, analysis);
          // Best-effort: still push if socket is alive; never awaited on voice/close.
          this.#safeSend({ type: "memory_update", memory: this.memory });
          if (chatMetaChanged) this.#emitChatSaved();
        } else {
          this.#trace({
            agent: "memory",
            phase: "result",
            durationMs: Date.now() - memStart,
            detail: { empty: true },
          });
        }
      }).catch(err => {
        console.error('[session] memory analysis failed:', err.message);
        this.#trace({
          agent: "memory",
          phase: "aborted",
          name: err.message,
          durationMs: Date.now() - memStart,
        });
      }).finally(() => {
        if (this.pendingMemoryJob === job) this.pendingMemoryJob = null;
      });
      this.pendingMemoryJob = job;
    } else {
      this.#trace({
        agent: "memory",
        phase: "skipped",
        name: "dry_or_short",
        detail: { userText },
      });
    }
  }

  #buildSavedChatRecord(summaryOverride = null) {
    const avgTtft = this.ttftSamples.length
      ? Math.round(this.ttftSamples.reduce((a, b) => a + b, 0) / this.ttftSamples.length)
      : null;

    const chats = this.history.map((m, i) => ({
      turn_id: i + 1,
      role: m.role,
      timestamp: memoryNow(),
      content: m.content,
      metadata: {},
    }));

    const topics = [];
    if (this.asyncSnapshotCache?.topic) topics.push(this.asyncSnapshotCache.topic);

    return {
      session_id: this.memory?.meta?.currentSessionId || generateId(),
      title: this.chatTitle || summaryOverride?.title || "Conversation",
      start_time: this.sessionStartIso,
      end_time: new Date().toISOString(),
      main_summary: summaryOverride?.summary || this.chatSummaryHint || "Voice conversation with June.",
      session_metrics: {
        total_turns: this.turnCount,
        user_interruptions: this.userInterruptions,
        average_ttft_ms: avgTtft,
      },
      chats,
      extracted_context: {
        topics_detected: summaryOverride?.topics || topics,
        action_items_generated: false,
      },
    };
  }

  #emitChatSaved(summaryOverride = null) {
    if (this.history.length < 1) return;
    const hasUser = this.history.some((m) => m.role === "user");
    if (!hasUser) return;
    const chat = this.#buildSavedChatRecord(summaryOverride);
    this.#upsertPastChatIndex(chat);
    this.send({ type: "chat_saved", chat });
  }

  #consolidateAndSend({ skipImmediateChatSave = false } = {}) {
    const historyLen = this.history.length;
    const hasUser = this.history.some((m) => m.role === "user");

    // Always persist the chat immediately (sync) so it survives WS close races.
    if (!skipImmediateChatSave && historyLen >= 1 && hasUser) {
      this.#emitChatSaved();
    }

    if (historyLen >= 2 && this.turnCount >= 1) {
      consolidateSessionMemory({
        history: this.history,
        memory: this.memory,
        existingDirectory: getCategoryDirectory(this.memory),
      }).then((consolidationResult) => {
        if (consolidationResult?.sessionSummary) {
          this.memory = consolidateSession(this.memory, consolidationResult.sessionSummary);
          if (consolidationResult.sessionSummary.title) {
            this.chatTitle = consolidationResult.sessionSummary.title;
          }
        }

        for (const promote of consolidationResult?.promote || []) {
          this.memory = applyCategoryUpdates(this.memory, {
            categorized: [promote],
            generalInfo: promote.category === "general_info"
              ? [{ title: promote.title, content: promote.content }]
              : [],
          });
        }

        this.#safeSend({ type: "memory_update", memory: this.memory });
        // Refresh saved chat with better title/summary if the socket is still open
        this.#emitChatSaved(consolidationResult?.sessionSummary || null);
      }).catch(err => {
        console.error('[session] consolidation failed:', err.message);
      });
    }
  }

  #abortGeneration() {
    this.#abortFollowup();
    const gen = this.gen;
    if (!gen) return;
    if (gen.speaking || gen.confirmed) this.userInterruptions++;
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
      this.#trace({ agent: "thinker", phase: "aborted" });
    }
  }

  #scheduleThought(transcript, immediate = false, extraDelayMs = null, { force = false } = {}) {
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

    this.#trace({
      agent: "thinker",
      phase: "scheduled",
      detail: { delayMs: delay, transcript: transcript || "", force },
    });

    this.thoughtDebounceTimer = setTimeout(() => {
      this.thoughtDebounceTimer = null;
      this.#runThought(transcript, { force });
    }, delay);
  }

  #runThought(transcript, { force = false } = {}) {
    if (!thoughtAgentAvailable()) return;

    const now = Date.now();
    if (!force && now - this.thoughtLastRunAt < config.thoughtRateLimitMs) {
      this.#trace({
        agent: "thinker",
        phase: "skipped",
        name: "rate_limit",
        detail: { waitMs: config.thoughtRateLimitMs - (now - this.thoughtLastRunAt) },
      });
      return;
    }

    if (this.thoughtAbort) this.thoughtAbort.abort();

    const abort = new AbortController();
    this.thoughtAbort = abort;
    const startedAt = Date.now();

    this.#trace({
      agent: "thinker",
      phase: "started",
      detail: { transcript: transcript || "" },
    });

    runThoughtAgent({
      transcript: transcript || "",
      history: this.history,
      memory: this.memory,
      recentCallbacks: this.#recentCallbackValues(),
      dryReplyStreak: countDryReplyStreak(this.history, transcript || ""),
      pastChats: this.pastChats,
      snapshotCache: this.asyncSnapshotCache,
      usedTopicHooks: this.usedTopicHooks,
      signal: abort.signal,
      onTrace: (ev) => this.#trace(ev),
    }).then((result) => {
      if (abort.signal.aborted || this.thoughtAbort !== abort) return;
      this.thoughtAbort = null;
      this.thoughtLastRunAt = Date.now();
      const dryStreak = countDryReplyStreak(this.history, transcript || "");
      const useful =
        result &&
        (result.confidence >= (dryStreak >= 2 ? 0.2 : 0.35) ||
          result.interjections?.length > 0 ||
          result.suggestions?.length > 0 ||
          result.juneSelfDrop ||
          result.memoryBridge);
      if (useful) {
        this.asyncThoughtCache = result;
        console.log("[thinker]", {
          topic: result.topic,
          confidence: result.confidence,
          tone: result.tone?.userMood,
          interjections: result.interjections,
          suggestions: result.suggestions,
        });
        this.#trace({
          agent: "thinker",
          phase: "result",
          durationMs: Date.now() - startedAt,
          detail: {
            cached: true,
            topic: result.topic,
            confidence: result.confidence,
            tone: result.tone,
            interjections: result.interjections,
            suggestions: result.suggestions,
            memoryBridge: result.memoryBridge,
            juneSelfDrop: result.juneSelfDrop,
            reasoning: result.reasoning,
          },
        });
      } else {
        this.#trace({
          agent: "thinker",
          phase: "result",
          durationMs: Date.now() - startedAt,
          detail: {
            cached: false,
            confidence: result?.confidence,
            reasoning: result?.reasoning || "not useful enough to cache",
          },
        });
      }
    }).catch(() => {
      if (this.thoughtAbort === abort) this.thoughtAbort = null;
      this.#trace({
        agent: "thinker",
        phase: "aborted",
        durationMs: Date.now() - startedAt,
      });
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
      this.#trace({ agent: "snapshot", phase: "aborted" });
    }
  }

  #scheduleSnapshot(transcript, immediate = false, { force = false } = {}) {
    if (!snapshotAgentAvailable()) return;

    // Topic-cache check always applies; `force` only bypasses rate-limit in #runSnapshot.
    if (!shouldRefreshSnapshot(this.asyncSnapshotCache, transcript, this.history)) {
      this.#trace({
        agent: "snapshot",
        phase: "skipped",
        name: "cache_fresh",
        detail: { topic: this.asyncSnapshotCache?.topic, immediate },
      });
      return;
    }

    if (this.snapshotDebounceTimer) {
      clearTimeout(this.snapshotDebounceTimer);
      this.snapshotDebounceTimer = null;
    }

    const delay = immediate ? 0 : config.snapshotDebounceMs;

    this.#trace({
      agent: "snapshot",
      phase: "scheduled",
      detail: { delayMs: delay, transcript: transcript || "", immediate, force },
    });

    this.snapshotDebounceTimer = setTimeout(() => {
      this.snapshotDebounceTimer = null;
      this.#runSnapshot(transcript, { force });
    }, delay);
  }

  /**
   * Wait briefly for in-flight snapshot/thinker so Phase B can use fresher caches.
   * Never blocks Phase A speech — only called between tool resolve and Phase B LLM.
   */
  async #awaitEnrichment(budgetMs = 700) {
    const deadline = Date.now() + Math.max(0, budgetMs);
    while (Date.now() < deadline) {
      if (!this.thoughtAbort && !this.snapshotAbort) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    return {
      snapshotCache: this.asyncSnapshotCache,
      thoughtCache: this.#effectiveThoughtCache(this.gen?.userText || ""),
    };
  }

  #runSnapshot(transcript, { force = false } = {}) {
    if (!snapshotAgentAvailable()) return;

    const now = Date.now();
    if (!force && now - this.snapshotLastRunAt < config.snapshotRateLimitMs) {
      this.#trace({
        agent: "snapshot",
        phase: "skipped",
        name: "rate_limit",
        detail: { waitMs: config.snapshotRateLimitMs - (now - this.snapshotLastRunAt) },
      });
      return;
    }

    if (this.snapshotAbort) this.snapshotAbort.abort();

    const abort = new AbortController();
    this.snapshotAbort = abort;
    const startedAt = Date.now();

    this.#trace({
      agent: "snapshot",
      phase: "started",
      detail: { transcript: transcript || "" },
    });

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
          this.#trace({
            agent: "snapshot",
            phase: "result",
            durationMs: Date.now() - startedAt,
            detail: { hasTopic: false, reasoning: result.reasoning },
          });
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
          this.#trace({
            agent: "snapshot",
            phase: "result",
            durationMs: Date.now() - startedAt,
            detail: {
              hasTopic: true,
              topic: result.topic,
              topicType: result.topicType,
              snapshot: result.snapshot,
              topicHooks: result.topicHooks,
              reasoning: result.reasoning,
            },
          });
        } else {
          this.#trace({
            agent: "snapshot",
            phase: "result",
            durationMs: Date.now() - startedAt,
            detail: { empty: true, reasoning: result.reasoning },
          });
        }
      } else {
        this.#trace({
          agent: "snapshot",
          phase: "result",
          durationMs: Date.now() - startedAt,
          detail: { empty: true },
        });
      }
    }).catch(() => {
      if (this.snapshotAbort === abort) this.snapshotAbort = null;
      this.#trace({
        agent: "snapshot",
        phase: "aborted",
        durationMs: Date.now() - startedAt,
      });
    });
  }

  // ── Idle continuation (snapshot-anchored "keep talking") ─────────────

  #abortFollowup({ silent = false } = {}) {
    if (this.followupTimer) {
      clearTimeout(this.followupTimer);
      this.followupTimer = null;
      if (!silent) this.#trace({ agent: "followup", phase: "aborted", name: "timer_cleared" });
    }
  }

  #scheduleFollowup() {
    if (!config.followupEnabled) return;
    this.#abortFollowup({ silent: true });
    // Cheap pre-check — don't even arm the timer when there's nothing to ride on.
    if (!snapshotAgentAvailable() || !this.asyncSnapshotCache) {
      this.#trace({ agent: "followup", phase: "skipped", name: "no_snapshot" });
      return;
    }
    if (this.asyncSnapshotCache.hasTopic === false) {
      this.#trace({ agent: "followup", phase: "skipped", name: "no_topic" });
      return;
    }

    this.#trace({
      agent: "followup",
      phase: "scheduled",
      detail: { delayMs: config.followupDelayMs },
    });

    this.followupTimer = setTimeout(() => {
      this.followupTimer = null;
      if (this.#shouldFollowup()) this.#beginFollowup();
      else {
        this.#trace({
          agent: "followup",
          phase: "skipped",
          name: "should_followup_false",
        });
      }
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

    this.#trace({
      agent: "followup",
      phase: "started",
      detail: {
        topic: this.asyncSnapshotCache?.topic,
        hooks: this.asyncSnapshotCache?.topicHooks?.slice(0, 4),
      },
    });

    this.#consumeFollowup(gen).catch(() => {
      this.#trace({ agent: "followup", phase: "aborted" });
      if (this.gen === gen) {
        if (gen.ttsCtl) gen.ttsCtl.cancel();
        this.gen = null;
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
      }
    });
  }

  async #consumeFollowup(gen) {
    const startedAt = Date.now();
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
      this.#trace({
        agent: "followup",
        phase: "skipped",
        name: "skip_or_empty",
        durationMs: Date.now() - startedAt,
        detail: { raw: collected.slice(0, 80) },
      });
      if (gen.ttsCtl) gen.ttsCtl.cancel();
      if (this.gen === gen) {
        this.gen = null;
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
      }
      return;
    }

    this.#trace({
      agent: "followup",
      phase: "result",
      durationMs: Date.now() - startedAt,
      detail: { text: clean },
    });

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
    // Mark closing but do NOT await pendingMemoryJob — voice teardown stays instant.
    // In-flight analyzeTurnMemory still best-effort #safeSend(memory_update) when it finishes.
    this.sessionClosing = true;
    if (this.gen) this.#abortGeneration();
    this.#abortThought();
    this.#abortSnapshot();
    this.#abortFollowup();
    
    this.#consolidateAndSend();
    
    this.stt.close();
    if (this.tts) this.tts.close();
  }
}
