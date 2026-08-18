import { FluxStream } from "./sttFlux.js";
import {
  createTTS,
  ttsAvailable,
  getAvailableProviders,
  annotateTtsChunks,
  flushTtsChunkAnnotator,
  normalizeElevenLabsModel,
  ELEVENLABS_MODELS,
  makeSilencePcm,
  autoGapSecondsForBoundary,
  endsWithSpeechBeat,
} from "./tts.js";
import { streamReply, llmAvailable } from "./llm.js";
import { State, FluxEvent, config } from "./states.js";
import { 
  mergeCleanDelta, 
  applyCategoryUpdates, 
  stripMemoryTags,
  stripGapMarkers,
  parseSpeechSegments,
  mergeThoughtCache, 
  detectMemoryCallbacks, 
  normalizeMemory,
  consolidateSession,
  startNewSession,
  countDryReplyStreak,
  isDryUtterance,
  shouldSkipMemoryAnalysis,
  memoryNow,
  generateId,
} from "./memory.js";
import { getCategoryDirectory } from "./memory-store.js";
import { analyzeTurnMemory, analyzeUserIntent, consolidateSessionMemory } from "./memory-ai.js";
import { detectSleepCommand, Fn, detectPauseCommand, detectResumeCommand, detectBrainstormEnterCommand, detectBrainstormExitCommand, stripBrainstormModeCommand } from "./functions.js";
import { runThoughtAgent, thoughtAgentAvailable } from "./thought-agent.js";
import { runSnapshotAgent, snapshotAgentAvailable, shouldRefreshSnapshot, detectTopicHooksUsed } from "./snapshot-agent.js";
import { runBridgeAgent, bridgeAgentAvailable, hasBridgeMaterial } from "./bridge-agent.js";
import { normalizePastChats } from "./thinker-tools.js";
import { buildAgentTrace } from "./debug-trace.js";
import { SessionCostTracker } from "./usage.js";
import { buildSearchReplyCards, shouldOfferNoteList } from "./list-format.js";
import { detectListOfferDecline, detectClientToolIntent, detectInstallOfferDecline, detectYouTubeControlIntent } from "./client-tools.js";
import { detectExplicitGmailIntent, detectGmailSendConfirm, detectGmailSendDecline, sendGmailMessage, normalizeGmailDraft, emptyGmailScan } from "./gmail-tools.js";
import { isGmailConnected, isGmailAppInstalled, markGmailAppInstalled, getLocalAuthUrl } from "./gmail-auth.js";
import { pickYouTubeFromSources, youtubeWatchUrl } from "./youtube-utils.js";
import { detectYouTubePlayIntent } from "./search-tools.js";
import {
  classifyBrainstormTurn,
  formatBrainstormDump,
  mergeFormatHint,
  hintIsClear,
} from "./brainstorm-agent.js";
import { normalizeArtifacts, upsertArtifact } from "./artifact-store.js";

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

    // Idle Bridge — after main reply finishes, maybe weave in a Thinker whisper
    // if the user stays quiet. Prefetch runs in parallel with the silence timer.
    this.bridgeTimer = null;
    this.bridgeArmed = false;
    this.bridgePrefetch = null;
    this.bridgeAbort = null;
    this.bridgeLastRunAt = 0;
    this.bridgeThoughtForPrefetch = null;
    /** User text the armed bridge belongs to — drop if a newer turn lands. */
    this.bridgeArmedForUserText = null;
    /** Main's last spoken line for this armed bridge (shared turn handoff). */
    this.bridgeJustSaid = "";
    this.usedThinkerHooks = [];

    this.emittedFinalTurnIndex = -1;
    this.lastCommittedUserText = "";
    this.lastCommittedUserAt = 0;

    this.recentMemoryCallbacks = [];
    this.usedTopicHooks = [];
    /** Topics the user moved on from / rejected — keep Bridge off them. */
    this.cooledTopics = [];
    /** In-flight turn memory analysis — never awaited on the voice path. */
    this.pendingMemoryJob = null;
    /** Set on close/sleep teardown; memory_update may still best-effort send. */
    this.sessionClosing = false;
    
    this.sessionStartedAt = Date.now();
    this.sessionStartIso = new Date().toISOString();
    this.sessionId = generateId();
    this.turnCount = 0;
    this.userInterruptions = 0;
    this.chatTitle = null;
    this.chatSummaryHint = null;
    this.ttftSamples = [];

    /** When true, emit agent_trace events to the client inspector. */
    this.debugTracing = false;
    /** Per-session OpenAI token/cost accumulator for the debug cost panel. */
    this.costTracker = new SessionCostTracker();
    /** Latest web search context for list/clipboard tools. */
    this.lastSearch = null;
    /** Latest formatted note list markdown. */
    this.lastNote = null;
    /** True after we showed/offered a list until they create one or the offer expires. */
    this.listOfferPending = false;
    /** True after they declined a list offer — skip re-offers for a few turns. */
    this.listOfferDeclined = false;
    this.listOfferDeclinedTurnsLeft = 0;
    /** Latest YouTube video from search or play. */
    this.lastYouTube = null;
    /** Virtual apps on the dock. Gmail persists via tokens / client localStorage. */
    this.artifacts = normalizeArtifacts(null);
    this.lastMail = null;
    this.gmailScan = emptyGmailScan();
    this.installedApps = new Set(["youtube", "artifacts"]);
    if (isGmailAppInstalled()) {
      markGmailAppInstalled();
      this.installedApps.add("gmail");
    }
    /** True after June should have asked to download Gmail until they agree or decline. */
    this.gmailInstallOfferPending = false;
    /** Draft waiting for a last visual + spoken confirm before send. */
    this.pendingGmailSend = null;

    /** Dictation mode — flag, not a session State. Orb stays LISTENING. */
    this.brainstorm = this.#emptyBrainstorm();
    this.brainstormClassifySeq = 0;
    this.brainstormClassifyText = "";
  }

  setDebugTracing(enabled) {
    this.debugTracing = Boolean(enabled);
    if (this.debugTracing) this.#emitUsage();
  }

  setLastNote({ title = "", markdown = "" } = {}) {
    const md = String(markdown || "").trim();
    if (!md) return;
    this.lastNote = {
      title: String(title || "List").slice(0, 120),
      markdown: md.slice(0, 12000),
    };
    this.listOfferPending = false;
    this.listOfferDeclined = false;
    this.listOfferDeclinedTurnsLeft = 0;
  }

  #keepArtifact({ kind = "note", title = "", body = "", source = "save_artifact" } = {}) {
    const result = upsertArtifact(this.artifacts, { kind, title, body, source });
    if (!result.item) return null;
    this.artifacts = result.store;
    this.#emitArtifacts(result.item.id, { silent: this.#brainstormActive() });
    this.#trace({
      agent: "artifacts",
      phase: "result",
      name: "save_artifact",
      detail: { id: result.item.id, kind: result.item.kind, title: result.item.title, source, updated: Boolean(result.updated) },
    });
    return result.item;
  }

  #emitArtifacts(focusId = null, { silent = false } = {}) {
    this.send({
      type: "artifact_update",
      artifacts: this.artifacts,
      focusId: silent ? null : (focusId || null),
    });
  }

  #recordUsage(entry) {
    try {
      this.costTracker.record(entry);
      this.#emitUsage();
    } catch {}
  }

  #emitUsage() {
    if (!this.debugTracing) return;
    try {
      const payload = this.costTracker.toJSON();
      const samples = this.ttftSamples;
      payload.ttft = {
        lastMs: samples.length ? samples[samples.length - 1] : null,
        avgMs: samples.length
          ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
          : null,
        n: samples.length,
      };
      this.send(payload);
    } catch {}
  }

  #trace({ agent, phase, name, detail, durationMs }) {
    // Live strip needs these traces even when the debug inspector is closed.
    const always = name === "web_search"
      || name === "copy_to_clipboard"
      || name === "create_note_list"
      || name === "install_app"
      || name === "youtube_player_tool"
      || name === "save_artifact"
      || name === "list_artifacts"
      || name === "get_artifact"
      || String(name || "").startsWith("gmail_")
      || agent === "gmail"
      || agent === "brainstorm"
      || agent === "artifacts";
    if (!this.debugTracing && !always) return;
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
      this.#markUsedHook(hit, "topic");
    }
  }

  #markUsedHook(hook, kind = "thinker") {
    const value = String(hook || "").trim();
    if (!value) return;
    const list = kind === "topic" ? this.usedTopicHooks : this.usedThinkerHooks;
    const exists = list.some((h) => h.toLowerCase() === value.toLowerCase());
    if (!exists) list.unshift(value);
    if (kind === "topic") {
      this.usedTopicHooks = this.usedTopicHooks.slice(0, 10);
    } else {
      this.usedThinkerHooks = this.usedThinkerHooks.slice(0, 10);
      // Snapshot hooks share the same string when main already covered them.
      this.#markUsedHook(value, "topic");
    }
  }

  /** True when main's spoken line already covered this whisper/hook. */
  #whisperCoveredBySpeech(spoken, whisper) {
    const s = this.#normalizeTranscript(spoken);
    const w = this.#normalizeTranscript(whisper);
    if (!s || !w || w.length < 4) return false;
    if (s.includes(w.slice(0, Math.min(w.length, 28)))) return true;

    const stop = new Set([
      "about", "their", "there", "would", "could", "should", "what", "when",
      "where", "which", "with", "from", "that", "this", "have", "just",
      "like", "your", "they", "them", "been", "were", "will", "into",
      "ask", "asks", "asked", "mention", "check", "maybe", "optional",
      "callback", "natural", "care", "only", "unused", "session",
    ]);
    const tokens = w
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9']/g, ""))
      .filter((t) => t.length >= 4 && !stop.has(t));
    if (!tokens.length) return s.includes(w.slice(0, 8));
    const hits = tokens.filter((t) => s.includes(t));
    if (hits.length >= 2) return true;
    if (tokens.length === 1 && hits.length === 1) return true;
    return hits.length >= Math.ceil(tokens.length * 0.6);
  }

  /**
   * After main speaks, mark Thinker whispers she already used so Bridge only
   * gets leftovers — shared turn ledger between main and follow-up.
   */
  #trackThinkerHooksUsed(spoken, thoughtCache = null) {
    if (!spoken) return;
    const cache = thoughtCache || this.asyncThoughtCache;
    if (!cache) return;

    const candidates = [
      ...(Array.isArray(cache.suggestions) ? cache.suggestions : []),
      ...(Array.isArray(cache.interjections) ? cache.interjections : []),
      ...(Array.isArray(cache.expansionAngles) ? cache.expansionAngles : []),
      cache.memoryBridge,
      cache.juneSelfDrop,
      cache.topic,
    ].filter(Boolean);

    for (const hook of candidates) {
      if (this.#whisperCoveredBySpeech(spoken, hook)) {
        this.#markUsedHook(hook, "thinker");
      }
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
    this.usedThinkerHooks = [];
    this.cooledTopics = [];
    this.chatTitle = null;
    this.chatSummaryHint = null;
    this.sessionStartIso = new Date().toISOString();
    this.sessionStartedAt = Date.now();
    this.userInterruptions = 0;
    this.ttftSamples = [];
    this.sessionClosing = false;
    // Cost stays cumulative for this VoiceSession (one WS connection).
    // Do not reset on init/setMemory — that made totals look per-prompt.
    this.#abortBridge();
    this.#resetBrainstorm({ silent: true });
    this.#scheduleThought(null, true);
  }

  setPastChats(pastChats) {
    this.pastChats = normalizePastChats(pastChats).slice(0, 20);
  }

  setInstalledApps(ids) {
    if (!Array.isArray(ids)) return;
    for (const raw of ids) {
      const id = String(raw || "").trim().toLowerCase();
      if (id) this.installedApps.add(id);
    }
    this.installedApps.add("artifacts");
    if (this.installedApps.has("gmail")) markGmailAppInstalled();
    if (isGmailAppInstalled()) this.installedApps.add("gmail");
  }

  setArtifacts(store) {
    this.artifacts = normalizeArtifacts(store);
  }

  #gmailIsSetup() {
    return this.installedApps.has("gmail") || isGmailAppInstalled() || isGmailConnected();
  }

  #offerGmailSendConfirm(draft) {
    const normalized = normalizeGmailDraft(draft || {});
    if (!normalized.address && !normalized.to) return;
    this.pendingGmailSend = normalized;
    this.lastMail = {
      title: normalized.subject || "Email",
      body: [
        normalized.to ? `To: ${normalized.to}` : "",
        normalized.subject ? `Subject: ${normalized.subject}` : "",
        "",
        normalized.body || "",
      ].filter((line, i, arr) => line || i === arr.length - 1).join("\n").trim(),
    };
    const turnId = this.gen?.id ?? null;
    this.send({
      type: "gmail_send_confirm",
      turnId,
      to: normalized.to,
      address: normalized.address,
      subject: normalized.subject,
      body: normalized.body,
      cc: normalized.cc,
    });
    this.send({
      type: "reply_cards",
      turnId,
      cards: [{
        kind: "gmail_send_confirm",
        to: normalized.to,
        address: normalized.address,
        subject: normalized.subject,
        body: normalized.body,
        cc: normalized.cc,
      }],
    });
    this.#trace({
      agent: "gmail",
      phase: "tool",
      name: "gmail_send_confirm",
      detail: { address: normalized.address, subject: normalized.subject },
    });
  }

  async #finalizeGmailSend() {
    const draft = this.pendingGmailSend;
    if (!draft) return;
    this.pendingGmailSend = null;
    try {
      const result = await sendGmailMessage(draft);
      if (result?.ok) {
        this.send({
          type: "gmail_send_confirm",
          sent: true,
          address: draft.address,
          to: draft.to,
          subject: draft.subject,
        });
        const who = draft.address || draft.to || "them";
        this.#speakCanned(`Sent to ${who}`);
        return;
      }
      this.pendingGmailSend = draft;
      this.#speakCanned("That didn't send. Want me to try again?");
    } catch {
      this.pendingGmailSend = draft;
      this.#speakCanned("That didn't send. Want me to try again?");
    }
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
      gmail: {
        installed: isGmailAppInstalled(),
        connected: isGmailConnected(),
      },
    });
  }

  handleAudio(chunk) {
    this.stt.sendAudio(chunk);
  }

  handleText(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    if (this.#brainstormActive()) {
      if (detectSleepCommand(clean)) {
        this.#exitBrainstorm({ silent: true });
        this.#handleSleep(clean);
        return;
      }
      if (this.gen) this.#abortGeneration();
      if (this.brainstorm.phase === "wrapup") {
        this.send({ type: "transcript", role: "user", text: clean, final: true });
        this.#onBrainstormWrapup(clean);
      } else {
        this.#onBrainstormCapture(clean);
      }
      return;
    }
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
    if (this.#brainstormActive()) {
      this.#onBrainstormTurn({ event, transcript, turnIndex });
      return;
    }

    switch (event) {
      case FluxEvent.START_OF_TURN:
        this.#abortBridge();
        // Follow-ups must yield immediately — otherwise they stack on / block the next reply.
        if (this.gen?.isFollowup || this.gen?.isBrainstorm) {
          this.#abortGeneration();
          this.#abortThought();
          this.#setState(this.paused ? State.PAUSED : State.LISTENING);
          break;
        }
        if (this.state === State.SPEAKING) break;
        if (this.gen) this.#abortGeneration();
        this.#abortThought();
        this.#setState(this.paused ? State.PAUSED : State.LISTENING);
        break;

      case FluxEvent.UPDATE:
        if (transcript) {
          this.#abortBridge();
          // Partial speech while a follow-up is talking = barge-in.
          if (this.gen?.isFollowup || this.gen?.isBrainstorm) this.#abortGeneration();
          this.send({ type: "transcript", role: "user", text: transcript, final: false });
          // Partial transcripts used to re-arm thinker/snapshot every few hundred ms —
          // that was a major token multiplier. Opt in via BACKGROUND_AI_ON_PARTIALS.
          if (config.backgroundAiOnPartials) {
            this.#scheduleThought(transcript);
            if (!isDryUtterance(transcript)) {
              this.#scheduleSnapshot(transcript);
            }
          }
        }
        break;

      case FluxEvent.EAGER_END_OF_TURN:
        // Main TTS still waits for a real end-of-turn; follow-ups do not own the floor.
        if (this.state === State.SPEAKING && !this.gen?.isFollowup && !this.gen?.isBrainstorm) break;
        if (this.gen?.isFollowup || this.gen?.isBrainstorm) this.#abortGeneration();
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
    if (this.#brainstormActive()) return;
    this.turnCount++;
    this.#abortBridge();
    this.#refreshTopicality(userText);

    // List-offer decline / cooldown
    if (detectListOfferDecline(userText, { listOfferPending: this.listOfferPending })) {
      this.listOfferPending = false;
      this.listOfferDeclined = true;
      this.listOfferDeclinedTurnsLeft = 3;
    } else if (detectClientToolIntent(userText, { listOfferPending: this.listOfferPending }) === "list") {
      this.listOfferDeclined = false;
      this.listOfferDeclinedTurnsLeft = 0;
    } else if (this.listOfferDeclinedTurnsLeft > 0) {
      this.listOfferDeclinedTurnsLeft -= 1;
      if (this.listOfferDeclinedTurnsLeft <= 0) this.listOfferDeclined = false;
    }

    if (detectInstallOfferDecline(userText, { gmailInstallOfferPending: this.gmailInstallOfferPending })) {
      this.gmailInstallOfferPending = false;
    } else if (
      detectExplicitGmailIntent(userText)
      && !this.#gmailIsSetup()
    ) {
      this.gmailInstallOfferPending = true;
    }

    if (detectGmailSendDecline(userText, { pending: Boolean(this.pendingGmailSend) })) {
      this.pendingGmailSend = null;
      this.send({ type: "gmail_send_confirm", cancel: true });
      this.#speakCanned("Okay, not sending");
      return;
    } else if (detectGmailSendConfirm(userText, { pending: Boolean(this.pendingGmailSend) })) {
      this.#finalizeGmailSend();
      return;
    }

    if (detectSleepCommand(userText)) {
      this.#handleSleep(userText);
      return;
    }

    if (config.brainstormEnabled && detectBrainstormEnterCommand(userText)) {
      this.#enterBrainstorm(stripBrainstormModeCommand(userText), null, userText);
      return;
    }

    if (!this.paused && detectPauseCommand(userText)) {
      if (!detectYouTubeControlIntent(userText, { lastYouTube: this.lastYouTube })) {
        this.#handlePause(userText);
        return;
      }
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
    if (!config.memoryAiEnabled) return;
    analyzeUserIntent({
      userText,
      memory: this.memory,
      context: this.context,
      history: this.history,
      sessionPaused: this.paused,
      onUsage: (u) => this.#recordUsage(u),
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
    if (next) this.#abortBridge();
    this.paused = next;
    this.#setState(next ? State.PAUSED : State.LISTENING);
    this.send({ type: "function", name: next ? Fn.PAUSE : Fn.RESUME });
  }

  #beginGeneration(userText, { speculative, keepPaused = false }) {
    if (this.#brainstormActive()) return;
    this.gmailScan = emptyGmailScan();
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
      lastSegments: [],
      speechSegments: [],
      pendingSilenceSec: 0,
      silenceApplyMode: null,
      autoGapPendingSec: 0,
      ttsCtl: null,
      llmDone: false,
      speaking: false,
      committed: false,
      searchSources: [],
      searchQuery: "",
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
      artifacts: this.artifacts,
      context: this.context,
      thoughtCache,
      recentCallbacks: this.#recentCallbackValues(),
      signal: gen.abort.signal,
      snapshotCache,
      usedTopicHooks: this.usedTopicHooks,
      pastChats: this.pastChats,
      onTrace: (ev) => this.#trace(ev),
      onUsage: (u) => this.#recordUsage(u),
      promptCacheKey: `june-main-${this.sessionId}`,
      onSearchSources: ({ sources, query }) => {
        if (!Array.isArray(sources) || !sources.length) return;
        gen.searchSources = [...(gen.searchSources || []), ...sources];
        if (query) gen.searchQuery = query;
        this.lastSearch = {
          sources: gen.searchSources,
          query: gen.searchQuery || query || "",
          spoken: "",
        };
        const ytHit = pickYouTubeFromSources(sources);
        if (ytHit) {
          const busy = this.lastYouTube?.status === "playing" || this.lastYouTube?.status === "paused";
          const replacing = detectYouTubePlayIntent(gen.userText);
          if (!busy || replacing) {
            this.lastYouTube = {
              ...ytHit,
              status: busy && replacing ? this.lastYouTube.status : "queued",
            };
          }
        }
        // Only treat as a pending list offer when we'd actually soft-offer one
        if (
          shouldOfferNoteList({
            sources: gen.searchSources,
            query: this.lastSearch.query,
            declinedRecently: this.listOfferDeclined,
          })
        ) {
          this.listOfferPending = true;
        }
      },
      clientHints: {
        listOfferPending: this.listOfferPending,
        listOfferDeclined: this.listOfferDeclined,
        gmailInstalled: this.#gmailIsSetup(),
        gmailConnected: isGmailConnected(),
        gmailInstallOfferPending: this.gmailInstallOfferPending,
        gmailSendPending: Boolean(this.pendingGmailSend),
        gmailSendTo: this.pendingGmailSend?.address || "",
        lastYouTube: this.lastYouTube,
        artifacts: this.artifacts,
        installedApps: [...this.installedApps],
      },
      getClientToolContext: () => ({
        lastSearch: this.lastSearch,
        lastNote: this.lastNote,
        lastYouTube: this.lastYouTube,
        lastBrainstorm: this.brainstorm?.artifact || null,
        lastMail: this.lastMail,
        gmailScan: this.gmailScan,
        artifacts: this.artifacts,
        gmailConnected: isGmailConnected(),
        gmailInstalled: this.#gmailIsSetup(),
        gmailSendConfirmed: false,
        onGmailSendConfirm: (draft) => this.#offerGmailSendConfirm(draft),
        onArtifactSave: (result) => {
          if (result?.store) this.artifacts = result.store;
          if (result?.item?.id) this.#emitArtifacts(result.item.id);
        },
        onArtifactOpen: ({ id } = {}) => {
          if (id) this.#emitArtifacts(id);
        },
        onClipboard: (text, label) => {
          this.send({
            type: "clipboard",
            text,
            label: label || "clipboard",
            turnId: gen.id,
          });
          this.#trace({
            agent: "main",
            phase: "tool",
            name: "copy_to_clipboard",
            detail: { label, chars: String(text || "").length },
          });
        },
        onNoteList: ({ title, markdown }) => {
          this.lastNote = { title, markdown };
          this.listOfferPending = false;
          this.send({
            type: "reply_cards",
            turnId: gen.id,
            cards: [{
              kind: "note_list",
              title: title || "List",
              markdown: markdown || "",
            }],
          });
          this.#keepArtifact({
            kind: "list",
            title: title || "List",
            body: markdown || "",
            source: "note_list",
          });
          this.#trace({
            agent: "main",
            phase: "tool",
            name: "create_note_list",
            detail: { title },
          });
        },
        onAppInstall: ({ appId }) => {
          const id = String(appId || "gmail").trim().toLowerCase() || "gmail";
          const already = this.installedApps.has(id)
            || (id === "gmail" && (isGmailAppInstalled() || isGmailConnected()));
          this.installedApps.add(id);
          this.gmailInstallOfferPending = false;
          if (id === "gmail") markGmailAppInstalled();
          if (already) return;
          this.send({
            type: "app_install",
            appId: id,
            turnId: gen.id,
          });
          this.#trace({
            agent: "main",
            phase: "tool",
            name: "install_app",
            detail: { appId: id },
          });
          if (id === "gmail" && !isGmailConnected()) {
            this.send({
              type: "open_url",
              url: getLocalAuthUrl(),
              appId: id,
              turnId: gen.id,
            });
          }
        },
        onGmailAuth: (url) => {
          this.send({
            type: "open_url",
            url: url || getLocalAuthUrl(),
            appId: "gmail",
            turnId: gen.id,
          });
        },
        onYouTubePlay: ({ videoId, title, thumbnail, replaced } = {}) => {
          const id = String(videoId || "").trim();
          if (!id) return;
          this.lastYouTube = {
            videoId: id,
            title: title || "",
            thumbnail: thumbnail || "",
            url: youtubeWatchUrl(id),
            status: "playing",
          };
          this.send({
            type: "youtube_play",
            videoId: id,
            title: title || "",
            thumbnail: thumbnail || "",
            replaced: Boolean(replaced),
            turnId: gen.id,
          });
          this.#trace({
            agent: "main",
            phase: "tool",
            name: "youtube_player_tool",
            detail: { action: "play", videoId: id, title: title || "", thumbnail: thumbnail || "", replaced: Boolean(replaced) },
          });
        },
        onYouTubeControl: ({ action, videoId, title } = {}) => {
          const verb = action === "pause" || action === "resume" || action === "stop" ? action : "";
          if (!verb) return;
          if (verb === "stop") {
            this.lastYouTube = this.lastYouTube
              ? { ...this.lastYouTube, status: "stopped", playing: false }
              : null;
          } else if (this.lastYouTube) {
            this.lastYouTube = {
              ...this.lastYouTube,
              status: verb === "pause" ? "paused" : "playing",
            };
          }
          this.send({
            type: "youtube_control",
            action: verb,
            videoId: videoId || this.lastYouTube?.videoId || "",
            title: title || this.lastYouTube?.title || "",
            turnId: gen.id,
          });
          this.#trace({
            agent: "main",
            phase: "tool",
            name: "youtube_player_tool",
            detail: { action: verb, videoId: videoId || "", title: title || "" },
          });
        },
      }),
      onToolsStarted: () => {
        // Optional: kick background enrichment while Phase A audio plays.
        // Force-bypass of rate limits is expensive — off unless BACKGROUND_AI_FORCE_ON_TOOLS.
        if (config.backgroundAiForceOnTools) {
          this.#scheduleThought(gen.userText, true, null, { force: true });
          this.#scheduleSnapshot(gen.userText, true, { force: true });
          this.#trace({
            agent: "main",
            phase: "tool",
            name: "step_enrich_kick",
            detail: { userText: gen.userText },
          });
        }
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
        this.#emitUsage();
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
      // Idle watchdog: only finalize if TTS goes quiet (not a wall clock from LLM end).
      this.#armTtsFinalizeWatchdog(gen);
    } else {
      this.#finalize(gen, { speakFallback: !this.tts });
    }
  }

  /** Restart finalize timer from last TTS activity. Avoids cutting mid-utterance. */
  #armTtsFinalizeWatchdog(gen, idleMs = 8000) {
    if (gen.finalized || gen.abort.signal.aborted) return;
    if (gen.ttsFinalizeTimer) clearTimeout(gen.ttsFinalizeTimer);
    gen.ttsFinalizeTimer = setTimeout(() => {
      if (this.gen !== gen || gen.finalized) return;
      console.warn("[tts] finalize watchdog — no audio/done for", idleMs, "ms");
      this.#finalize(gen, { speakFallback: true });
    }, idleMs);
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
    const result = mergeCleanDelta(gen, delta);
    if (!result) return;

    const { text, segments } = result;
    const gapMarkers = segments
      .filter((s) => s.type === "gap")
      .map((s) => s.seconds);

    if (text) {
      gen.fullText = (gen.fullText || "") + text;
      const chunkCount = annotateTtsChunks(gen, text);
      this.send({
        type: "assistant_delta",
        text,
        chunkFlush: chunkCount || undefined,
        gapMarkers: gapMarkers.length ? gapMarkers : undefined,
        turnId: gen.id,
      });
    } else if (gapMarkers.length) {
      this.send({
        type: "assistant_delta",
        text: "",
        gapMarkers,
        turnId: gen.id,
      });
    }

    this.#pushSpeechSegments(gen, segments);

    if (!gen.speaking && (text || segments.length)) {
      gen.speaking = true;
      this.#setState(State.SPEAKING);
    }
  }

  /** Push text to TTS and inject silence PCM for `[gap N]` beats. */
  #pushSpeechSegments(gen, segments) {
    if (!segments?.length) return;
    gen.speechSegments = gen.speechSegments || [];
    for (const seg of segments) {
      if (seg.type === "gap") {
        gen.speechSegments.push(seg);
        this.#queueGap(gen, seg.seconds, { explicit: true });
        continue;
      }
      if (seg.type !== "text" || !seg.value) continue;

      // If prior beat ended on punctuation and the model forgot [gap], insert one.
      if (gen.autoGapPendingSec && !gen.skipNextAutoGap) {
        const sec = gen.autoGapPendingSec;
        gen.autoGapPendingSec = 0;
        gen.speechSegments.push({ type: "gap", seconds: sec });
        this.#queueGap(gen, sec, { explicit: false });
        this.send({
          type: "assistant_delta",
          text: "",
          gapMarkers: [sec],
          turnId: gen.id,
        });
      }
      gen.skipNextAutoGap = false;
      gen.speechSegments.push(seg);

      if (gen.ttsCtl) {
        // After a queued gap, next audio should carry the silence (not prior phrase).
        if (gen.silenceApplyMode === "after-next-text") {
          gen.silenceApplyMode = "on-next-audio";
        }
        gen.ttsCtl.push(seg.value);
      }

      if (endsWithSpeechBeat(seg.value)) {
        gen.autoGapPendingSec = autoGapSecondsForBoundary(seg.value);
      } else {
        gen.autoGapPendingSec = 0;
      }
    }
  }

  /**
   * Queue a spoken pause. forceFlush so prior text doesn't merge with the next
   * phrase; silence attaches to the first audio of the following text (WS) or
   * is embedded after the flushed HTTP part.
   */
  #queueGap(gen, seconds, { explicit = false } = {}) {
    if (!gen || gen.abort.signal.aborted) return;
    const sec = Number(seconds) || 0;
    if (sec <= 0) return;

    gen.ttsCtl?.forceFlush?.();
    const handled = gen.ttsCtl?.flush?.({ afterSilenceSec: sec });
    if (handled) {
      console.log(`[gap] http ${sec.toFixed(2)}s${explicit ? "" : " auto"}`);
      gen.autoGapPendingSec = 0;
      return;
    }

    gen.pendingSilenceSec = (gen.pendingSilenceSec || 0) + sec;
    // Wait until text AFTER this gap is pushed, then prepend silence to that audio.
    gen.silenceApplyMode = "after-next-text";
    gen.autoGapPendingSec = 0;
    console.log(`[gap] queue ${sec.toFixed(2)}s${explicit ? "" : " auto"}`);
  }

  #flushPendingSilence(gen) {
    if (!gen?.pendingSilenceSec) return;
    const pcm = makeSilencePcm(gen.pendingSilenceSec, config.ttsSampleRate);
    gen.pendingSilenceSec = 0;
    gen.silenceApplyMode = null;
    if (!pcm.length || gen.abort.signal.aborted) return;
    gen.ttsHeard = true;
    if (!gen.speaking) {
      gen.speaking = true;
      this.#setState(State.SPEAKING);
    }
    this.sendAudio(gen.id, pcm);
  }

  #onTtsAudio(contextId, pcm) {
    const gen = this.gen;
    if (!gen || gen.abort.signal.aborted) return;
    if (contextId !== `gen-${gen.id}`) return;
    gen.ttsHeard = true;
    // Keep the generation alive while audio is still flowing after the LLM ends.
    if (gen.llmDone) this.#armTtsFinalizeWatchdog(gen);
    else if (gen.ttsFinalizeTimer) {
      clearTimeout(gen.ttsFinalizeTimer);
      gen.ttsFinalizeTimer = null;
    }
    if (!gen.speaking) {
      gen.speaking = true;
      this.#setState(State.SPEAKING);
    }
    let out = pcm;
    // Only prepend once post-gap text has been pushed (avoids silence-before-phrase).
    if (gen.silenceApplyMode === "on-next-audio" && gen.pendingSilenceSec) {
      const silence = makeSilencePcm(gen.pendingSilenceSec, config.ttsSampleRate);
      gen.pendingSilenceSec = 0;
      gen.silenceApplyMode = null;
      out = silence.length ? Buffer.concat([silence, pcm]) : pcm;
      console.log(`[gap] apply ${(silence.length / 4 / config.ttsSampleRate).toFixed(2)}s`);
    }
    this.sendAudio(gen.id, out);
  }

  #onTtsDone(contextId) {
    const gen = this.gen;
    if (!gen || contextId !== `gen-${gen.id}`) return;
    if (!gen.llmDone) return;
    this.#flushPendingSilence(gen);
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
    this.#flushPendingSilence(gen);

    if (spoken && !gen.isBrainstorm) {
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
    if (!gen.isBrainstorm) {
      this.#trackMemoryCallbacks(spoken);
      this.#trackTopicHooks(spoken);
      // Shared turn ledger: mark whispers main already covered BEFORE Bridge arms.
      if (!gen.isFollowup) {
        this.#trackThinkerHooksUsed(spoken, this.asyncThoughtCache);
      }
    }
    const useFallback = speakFallback || (Boolean(gen.ttsCtl) && !gen.ttsHeard);
    this.send({
      type: "assistant_done",
      text: spoken,
      textWithStalls: gen.fullChunkText || spoken,
      speechSegments: gen.speechSegments?.length ? gen.speechSegments : undefined,
      turnId: gen.id,
      speakFallback: useFallback,
      continuation: gen.isFollowup || undefined,
    });

    if (!gen.isFollowup && gen.searchSources?.length) {
      try {
        this.lastSearch = {
          sources: gen.searchSources,
          query: gen.searchQuery || "",
          spoken,
        };
        const offerList = shouldOfferNoteList({
          sources: gen.searchSources,
          query: gen.searchQuery || "",
          declinedRecently: this.listOfferDeclined,
        });
        this.listOfferPending = offerList;
        const cards = buildSearchReplyCards({
          sources: gen.searchSources,
          query: gen.searchQuery || "",
          spoken,
          declinedRecently: this.listOfferDeclined,
        });
        if (cards.length) {
          this.send({
            type: "reply_cards",
            turnId: gen.id,
            cards,
          });
        }
      } catch (err) {
        console.warn("[cards]", err.message);
      }
    }

    // Follow-ups carry no new user input — skip the memory pass entirely.
    // Stash Thinker whispers BEFORE sync clears the cache. Bridge may reuse them
    // only when they still fit this exchange (see #thoughtFitsLatestTurn).
    const bridgeThought = !gen.isFollowup && !gen.isBrainstorm ? this.asyncThoughtCache : null;
    const bridgeAssistantText = spoken;
    if (!gen.isFollowup && !gen.isBrainstorm) this.#syncMemoryToClient(gen.userText, spoken);

    if (this.gen === gen) {
      this.gen = null;
      this.#setState(this.paused ? State.PAUSED : State.LISTENING);
    }

    // After a real reply, maybe weave in a Thinker whisper if the user stays quiet.
    // Never chain a bridge off another bridge.
    if (!gen.isFollowup && !gen.isBrainstorm && spoken && !this.paused && !gen.keepPaused) {
      this.#armBridge({
        thoughtCache: bridgeThought,
        assistantText: bridgeAssistantText,
      });
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
    // Rhythm/thinker may treat a turn as "dry"; memory extraction still runs —
    // industry pattern (Mem0-style): let the memory agent decide what to store.
    const dry = isDryUtterance(userText);
    const skipMemory = !config.memoryAiEnabled || shouldSkipMemoryAnalysis(userText);

    this.asyncThoughtCache = null;
    this.#safeSend({ type: "memory_update", memory: this.memory });

    // Thinker still runs after substantive turns even when memory AI is disabled.
    if (!dry) {
      this.#scheduleThought(userText, false, 0);
    }

    if (!skipMemory) {
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
        onUsage: (u) => this.#recordUsage(u),
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
        name: !config.memoryAiEnabled ? "memory_ai_disabled" : "empty_turn",
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

    const minTurns = Math.max(1, config.consolidateMinTurns || 3);
    if (!config.memoryAiEnabled) {
      this.#trace({
        agent: "memory",
        phase: "skipped",
        name: "memory_ai_disabled",
        detail: { consolidate: true, turnCount: this.turnCount },
      });
      return;
    }

    if (this.turnCount < minTurns) {
      this.#trace({
        agent: "memory",
        phase: "skipped",
        name: "short_session",
        detail: { turnCount: this.turnCount, minTurns },
      });
      return;
    }

    if (historyLen >= 2 && this.turnCount >= 1) {
      consolidateSessionMemory({
        history: this.history,
        memory: this.memory,
        existingDirectory: getCategoryDirectory(this.memory),
        onUsage: (u) => this.#recordUsage(u),
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
    this.#abortBridge();
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
    if (this.#brainstormActive()) return;
    if (!config.thoughtAgentEnabled || !thoughtAgentAvailable()) return;

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
    if (!config.thoughtAgentEnabled || !thoughtAgentAvailable()) return;

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
      onUsage: (u) => this.#recordUsage(u),
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
          result.memoryBridge ||
          result.forceTools ||
          result.recallIntent);
      if (useful) {
        this.asyncThoughtCache = result;
        console.log("[thinker]", {
          topic: result.topic,
          confidence: result.confidence,
          tone: result.tone?.userMood,
          interjections: result.interjections,
          suggestions: result.suggestions,
          forceTools: result.forceTools || false,
          recallIntent: result.recallIntent || null,
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
        // Idle Bridge: start composing once fresh whispers land for the armed turn.
        if (this.bridgeArmed && !this.paused && !this.gen) {
          if (
            this.bridgeArmedForUserText
            && this.lastCommittedUserText !== this.bridgeArmedForUserText
          ) {
            this.#abortBridge({ silent: true });
            this.#trace({ agent: "followup", phase: "skipped", name: "user_moved_on" });
          } else {
            this.bridgeThoughtForPrefetch = result;
            this.#prefetchBridge();
          }
        }
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
        if (this.bridgeArmed && !this.bridgePrefetch?.ready && !this.bridgeAbort) {
          this.bridgePrefetch = {
            ready: true,
            text: null,
            usedHook: "",
            reason: "thinker_not_useful",
          };
        }
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
    if (this.#brainstormActive()) return;
    if (!config.snapshotAgentEnabled || !snapshotAgentAvailable()) return;

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
    if (!config.snapshotAgentEnabled || !snapshotAgentAvailable()) return;

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
      onUsage: (u) => this.#recordUsage(u),
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

  // ── Idle Bridge (Thinker-anchored "keep talking") ────────────────────

  #abortBridge({ silent = false } = {}) {
    this.bridgeArmed = false;
    this.bridgeThoughtForPrefetch = null;
    this.bridgeArmedForUserText = null;
    this.bridgeJustSaid = "";
    if (this.bridgeTimer) {
      clearTimeout(this.bridgeTimer);
      this.bridgeTimer = null;
      if (!silent) this.#trace({ agent: "followup", phase: "aborted", name: "timer_cleared" });
    }
    if (this.bridgeAbort) {
      this.bridgeAbort.abort();
      this.bridgeAbort = null;
    }
    this.bridgePrefetch = null;
  }

  /** Text from the latest exchange + last 2 history turns. */
  #liveFocusText(userText = "", assistantText = "") {
    const parts = [userText, assistantText];
    for (const m of this.history.slice(-2)) {
      parts.push(m?.content || "");
    }
    return this.#normalizeTranscript(parts.join(" "));
  }

  #hookInFocus(hook, focus) {
    const h = this.#normalizeTranscript(hook);
    if (!h || h.length < 4 || !focus) return false;
    const key = h.slice(0, Math.min(14, h.length));
    return focus.includes(key) || (key.length >= 6 && focus.includes(key.slice(0, 8)));
  }

  #isCooledTopic(topic, focus = "") {
    const n = this.#normalizeTranscript(topic);
    if (!n) return false;
    // User re-engaged with it in the live focus — allow it again.
    if (focus && this.#hookInFocus(n, focus)) return false;
    return this.cooledTopics.some((c) => {
      const key = c.slice(0, Math.min(10, c.length));
      return n.includes(key) || c.includes(n.slice(0, Math.min(10, n.length)));
    });
  }

  #coolTopic(topic, reason = "") {
    const n = this.#normalizeTranscript(topic);
    if (!n || n.length < 3) return;
    if (!this.cooledTopics.some((c) => c === n)) {
      this.cooledTopics.unshift(n);
      this.cooledTopics = this.cooledTopics.slice(0, 16);
    }
    if (
      this.asyncSnapshotCache?.topic
      && this.#hookInFocus(this.asyncSnapshotCache.topic, n)
    ) {
      this.asyncSnapshotCache = null;
    }
    if (
      this.asyncThoughtCache?.topic
      && this.#hookInFocus(this.asyncThoughtCache.topic, n)
    ) {
      this.asyncThoughtCache = null;
    }
    this.#trace({
      agent: "followup",
      phase: "skipped",
      name: "topic_cooled",
      detail: { topic: String(topic).slice(0, 80), reason: reason || undefined },
    });
  }

  #userSignalsTopicRejection(userText = "") {
    const t = String(userText || "").trim();
    if (!t) return false;
    return (
      /\b(not (anymore|really|interested)|don'?t care|over it|done with|sick of|bored of|not into|never ?mind|forget (it|that)|moved on|don'?t watch|stop (asking|talking) about)\b/i.test(t)
      || /\b(i'?m )?(done|over|finished) with (that|it|this)\b/i.test(t)
    );
  }

  /**
   * Drop stale Thinker/snapshot caches when the live chat has left that topic.
   * Also cool topics the user explicitly rejected.
   */
  #refreshTopicality(userText = "") {
    const live = this.#liveFocusText(userText, "");
    const said = this.#normalizeTranscript(userText);
    const rejecting = this.#userSignalsTopicRejection(userText);
    // Re-engage: if they bring a cooled topic back up (without rejecting), un-cool it.
    if (said && !rejecting) {
      this.cooledTopics = this.cooledTopics.filter((c) => !this.#hookInFocus(c, said));
    }
    const snapTopic = this.asyncSnapshotCache?.topic;
    const thoughtTopic = this.asyncThoughtCache?.topic;
    if (rejecting) {
      if (snapTopic) this.#coolTopic(snapTopic, "user_rejected");
      if (thoughtTopic) this.#coolTopic(thoughtTopic, "user_rejected");
    } else if (snapTopic && !this.#hookInFocus(snapTopic, live)) {
      // Topic left the last ~2 turns — invalidate so Snapshot/Thinker re-anchor.
      this.asyncSnapshotCache = null;
      if (
        thoughtTopic
        && this.#hookInFocus(thoughtTopic, this.#normalizeTranscript(snapTopic))
      ) {
        this.asyncThoughtCache = null;
      }
    }

    const stillThought = this.asyncThoughtCache?.topic;
    if (stillThought && this.#isCooledTopic(stillThought, live)) {
      this.asyncThoughtCache = null;
    } else if (stillThought && !this.#hookInFocus(stillThought, live)) {
      this.asyncThoughtCache = null;
    }
  }

  /** Snapshot hooks only count when they still match the live conversation. */
  #bridgeSnapshotCache(userText = "") {
    const snap = this.asyncSnapshotCache;
    if (!snap || snap.hasTopic === false) return null;
    const live = this.#liveFocusText(
      userText || this.bridgeArmedForUserText || "",
      ""
    );
    if (!live) return null;
    if (this.#isCooledTopic(snap.topic, live)) return null;
    // Must still be present in the latest exchange / last 2 turns.
    if (!this.#hookInFocus(snap.topic, live)) return null;
    return snap;
  }

  #looksLikeTopicShift(userText = "") {
    const t = String(userText || "").trim();
    if (!t) return false;
    return (
      /^(can you|could you|will you|would you|hey can|ok but|anyway|by the way)\b/i.test(t)
      || /\b(search( the web)?|look(?:\s+it)?\s*up|google|find online|what(?:'s| is| are)|how do|tell me about)\b/i.test(t)
      || this.#userSignalsTopicRejection(t)
    );
  }

  /**
   * Keep idle beats alive only while whispers still match the live chat focus.
   * Old shows/classes that fell out of the last turns are treated as stale.
   */
  #thoughtFitsLatestTurn(thoughtCache, userText = "", assistantText = "") {
    if (!thoughtCache) return false;
    if (this.#userSignalsTopicRejection(userText)) return false;

    const live = this.#liveFocusText(userText, assistantText);
    if (!live) return false;
    if (this.#isCooledTopic(thoughtCache.topic, live)) return false;

    const topic = thoughtCache.topic;
    if (topic && String(topic).trim().length >= 4) {
      if (!this.#hookInFocus(topic, live)) return false;
    }

    const suggestions = [
      ...(Array.isArray(thoughtCache.suggestions) ? thoughtCache.suggestions : []),
      ...(Array.isArray(thoughtCache.interjections) ? thoughtCache.interjections : []),
    ];
    if (suggestions.length) {
      const anyLive = suggestions.some((s) => this.#hookInFocus(s, live));
      // If every suggestion is about something absent from live chat, reject.
      if (!anyLive && topic && !this.#hookInFocus(topic, live)) return false;
      if (!anyLive && !topic) return false;
    }

    if (thoughtCache.memoryBridge && !this.#hookInFocus(thoughtCache.memoryBridge, live)) {
      // Memory callback about a dead thread — strip later; alone it should not pass.
      if (!topic && suggestions.length === 0) return false;
    }

    return true;
  }

  /** Strip cooled / off-focus / already-used whispers so Bridge only gets leftovers. */
  #sanitizeThoughtForBridge(thoughtCache, userText = "", assistantText = "") {
    if (!thoughtCache || !this.#thoughtFitsLatestTurn(thoughtCache, userText, assistantText)) {
      return null;
    }
    const live = this.#liveFocusText(userText, assistantText);
    const used = new Set(
      this.usedThinkerHooks.map((h) => String(h).toLowerCase())
    );
    const keep = (s) => {
      const t = String(s || "").trim();
      if (!t) return false;
      if (used.has(t.toLowerCase())) return false;
      if (this.#isCooledTopic(t, live)) return false;
      // Main already said this beat — not a leftover.
      if (assistantText && this.#whisperCoveredBySpeech(assistantText, t)) return false;
      return this.#hookInFocus(t, live);
    };
    const suggestions = (thoughtCache.suggestions || []).filter(keep);
    const interjections = (thoughtCache.interjections || []).filter(keep);
    const memoryBridge = keep(thoughtCache.memoryBridge) ? thoughtCache.memoryBridge : null;
    const juneSelfDrop = keep(thoughtCache.juneSelfDrop) ? thoughtCache.juneSelfDrop : null;
    const topic = keep(thoughtCache.topic) ? thoughtCache.topic : (suggestions[0] || null);

    if (
      !suggestions.length
      && !interjections.length
      && !memoryBridge
      && !juneSelfDrop
    ) {
      // Topic alone is not enough — Bridge must have a concrete unused beat.
      return null;
    }

    return {
      ...thoughtCache,
      topic: topic || thoughtCache.topic || "",
      suggestions,
      interjections,
      memoryBridge,
      juneSelfDrop,
    };
  }

  #armBridge({ thoughtCache = null, assistantText = "" } = {}) {
    if (this.#brainstormActive()) return;
    if (!config.followupEnabled || !bridgeAgentAvailable()) return;
    this.#abortBridge({ silent: true });

    if (this.paused) return;
    if (Date.now() - this.bridgeLastRunAt < config.followupRateLimitMs) {
      this.#trace({ agent: "followup", phase: "skipped", name: "rate_limit" });
      return;
    }
    const userText = this.lastCommittedUserText || "";
    const dryStreak = countDryReplyStreak(this.history, userText);
    if (dryStreak >= 2) {
      this.#trace({ agent: "followup", phase: "skipped", name: "dry_streak" });
      return;
    }

    // Prefer whispers main just had — only while they still match live focus.
    let material = this.#sanitizeThoughtForBridge(
      thoughtCache || this.asyncThoughtCache,
      userText,
      assistantText
    );
    if ((thoughtCache || this.asyncThoughtCache) && !material) {
      const stale = thoughtCache || this.asyncThoughtCache;
      this.#trace({
        agent: "followup",
        phase: "skipped",
        name: "stale_topic",
        detail: {
          topic: stale?.topic || null,
          userText: String(userText).slice(0, 80),
        },
      });
      // Drop the stale stash so the next Thinker pass can re-anchor.
      if (stale && this.asyncThoughtCache === stale) this.asyncThoughtCache = null;
    }

    const snapshotCache = this.#bridgeSnapshotCache(userText);

    this.bridgeThoughtForPrefetch = material;
    this.bridgeArmed = true;
    this.bridgeArmedForUserText = userText;
    this.bridgeJustSaid = String(assistantText || "").trim();
    this.bridgePrefetch = null;

    this.#trace({
      agent: "followup",
      phase: "scheduled",
      detail: {
        delayMs: config.followupDelayMs,
        hasThought: Boolean(material),
        hasSnapshot: Boolean(snapshotCache?.topic),
        leftovers: material
          ? [
              ...(material.suggestions || []),
              ...(material.interjections || []),
              material.memoryBridge,
              material.juneSelfDrop,
            ].filter(Boolean).slice(0, 4)
          : [],
        justSaid: this.bridgeJustSaid.slice(0, 120),
        doNotAsk: this.usedThinkerHooks.slice(0, 5),
        forUser: String(userText).slice(0, 80),
      },
    });

    if (
      hasBridgeMaterial(material, {
        dryReplyStreak: dryStreak,
        usedThinkerHooks: this.usedThinkerHooks,
        snapshotCache,
        usedTopicHooks: this.usedTopicHooks,
        leftoversOnly: true,
      })
    ) {
      this.#prefetchBridge();
    } else if (config.thoughtAgentEnabled && thoughtAgentAvailable()) {
      // No usable on-topic stash — force a fast thinker pass for this idle beat.
      this.#scheduleThought(userText, true, null, { force: true });
    }

    this.bridgeTimer = setTimeout(() => {
      this.bridgeTimer = null;
      this.#fireBridge().catch(() => {
        this.#trace({ agent: "followup", phase: "aborted", name: "fire_error" });
        this.#abortBridge({ silent: true });
      });
    }, config.followupDelayMs);
  }

  #prefetchBridge() {
    if (!this.bridgeArmed || !config.followupEnabled) return;
    if (this.paused || this.gen) return;
    if (this.bridgePrefetch?.ready || this.bridgeAbort) return;
    if (
      this.bridgeArmedForUserText
      && this.lastCommittedUserText !== this.bridgeArmedForUserText
    ) {
      this.#abortBridge({ silent: true });
      this.#trace({ agent: "followup", phase: "skipped", name: "user_moved_on" });
      return;
    }

    const dryStreak = countDryReplyStreak(this.history, this.lastCommittedUserText);
    const justSaid = this.bridgeJustSaid || "";
    const thoughtCache = this.#sanitizeThoughtForBridge(
      this.bridgeThoughtForPrefetch || this.asyncThoughtCache,
      this.bridgeArmedForUserText || this.lastCommittedUserText || "",
      justSaid
    );
    this.bridgeThoughtForPrefetch = thoughtCache;
    const snapshotCache = this.#bridgeSnapshotCache(this.bridgeArmedForUserText || "");

    if (
      !hasBridgeMaterial(thoughtCache, {
        dryReplyStreak: dryStreak,
        usedThinkerHooks: this.usedThinkerHooks,
        snapshotCache,
        usedTopicHooks: this.usedTopicHooks,
        leftoversOnly: true,
      })
    ) {
      // Thinker may still be in flight — leave prefetch unset so fireBridge can wait.
      if (this.thoughtAbort || this.thoughtDebounceTimer) return;
      this.bridgePrefetch = {
        ready: true,
        text: null,
        usedHook: "",
        reason: "no_material",
      };
      this.#trace({
        agent: "followup",
        phase: "skipped",
        name: "no_material",
      });
      return;
    }

    const abort = new AbortController();
    this.bridgeAbort = abort;
    const startedAt = Date.now();

    this.#trace({
      agent: "followup",
      phase: "started",
      detail: {
        topic: thoughtCache?.topic || snapshotCache?.topic,
        suggestions: thoughtCache?.suggestions?.slice(0, 3),
        interjections: thoughtCache?.interjections?.slice(0, 2),
        memoryBridge: thoughtCache?.memoryBridge || null,
        juneSelfDrop: thoughtCache?.juneSelfDrop || null,
        snapshotTopic: snapshotCache?.topic || null,
        justSaid: justSaid.slice(0, 120),
        doNotAsk: this.usedThinkerHooks.slice(0, 5),
        forUser: String(this.bridgeArmedForUserText || "").slice(0, 80),
      },
    });

    runBridgeAgent({
      history: this.history,
      memory: this.memory,
      thoughtCache,
      snapshotCache,
      usedThinkerHooks: this.usedThinkerHooks,
      usedTopicHooks: this.usedTopicHooks,
      dryReplyStreak: dryStreak,
      justSaid,
      doNotAsk: this.usedThinkerHooks.slice(0, 8),
      signal: abort.signal,
      onUsage: (u) => this.#recordUsage(u),
    })
      .then((result) => {
        if (abort.signal.aborted || this.bridgeAbort !== abort) return;
        this.bridgeAbort = null;
        if (
          this.bridgeArmedForUserText
          && this.lastCommittedUserText !== this.bridgeArmedForUserText
        ) {
          this.#abortBridge({ silent: true });
          this.#trace({ agent: "followup", phase: "skipped", name: "user_moved_on" });
          return;
        }
        const ok = Boolean(result?.continue && result?.text);
        this.bridgePrefetch = {
          ready: true,
          text: ok ? result.text : null,
          usedHook: ok ? result.usedHook || "" : "",
          reason: result?.reason || "",
        };
        if (ok) {
          this.#trace({
            agent: "followup",
            phase: "result",
            durationMs: Date.now() - startedAt,
            detail: {
              text: result.text,
              usedHook: result.usedHook,
              reason: result.reason,
            },
          });
        } else {
          this.#trace({
            agent: "followup",
            phase: "skipped",
            name: "bridge_skip",
            durationMs: Date.now() - startedAt,
            detail: { reason: result?.reason },
          });
        }
      })
      .catch(() => {
        if (this.bridgeAbort === abort) this.bridgeAbort = null;
        this.bridgePrefetch = {
          ready: true,
          text: null,
          usedHook: "",
          reason: "error",
        };
        this.#trace({
          agent: "followup",
          phase: "aborted",
          durationMs: Date.now() - startedAt,
        });
      });
  }

  #canSpeakBridge() {
    if (!config.followupEnabled) return false;
    if (this.#brainstormActive()) return false;
    if (this.paused || this.gen) return false;
    if (this.state !== State.LISTENING) return false;
    if (
      this.bridgeArmedForUserText
      && this.lastCommittedUserText !== this.bridgeArmedForUserText
    ) {
      return false;
    }
    return true;
  }

  async #fireBridge() {
    if (!this.bridgeArmed) return;

    if (!this.#canSpeakBridge()) {
      const movedOn =
        Boolean(this.bridgeArmedForUserText)
        && this.lastCommittedUserText !== this.bridgeArmedForUserText;
      this.#abortBridge({ silent: true });
      this.#trace({
        agent: "followup",
        phase: "skipped",
        name: movedOn ? "user_moved_on" : "not_idle",
      });
      return;
    }

    // Kick prefetch if material already landed but we never started composing.
    if (!this.bridgePrefetch?.ready && !this.bridgeAbort) {
      this.#prefetchBridge();
    }

    if (!this.bridgePrefetch?.ready) {
      // Give in-flight Thinker enough time — empty cache + short grace killed all idle beats.
      const waitingOnThought = Boolean(this.thoughtAbort || this.thoughtDebounceTimer);
      const grace = waitingOnThought
        ? Math.max(config.followupGraceMs || 600, 2400)
        : Math.max(0, config.followupGraceMs || 600);
      const deadline = Date.now() + grace;
      while (Date.now() < deadline) {
        if (!this.bridgeArmed || !this.#canSpeakBridge()) {
          this.#abortBridge({ silent: true });
          return;
        }
        if (!this.bridgePrefetch?.ready && !this.bridgeAbort) {
          this.#prefetchBridge();
        }
        if (this.bridgePrefetch?.ready) break;
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    if (!this.bridgeArmed || !this.#canSpeakBridge()) {
      this.#abortBridge({ silent: true });
      return;
    }

    const prefetch = this.bridgePrefetch;
    const text = prefetch?.ready ? prefetch.text : null;
    const usedHook = prefetch?.usedHook || "";

    this.bridgeArmed = false;
    this.bridgeArmedForUserText = null;
    this.bridgeJustSaid = "";
    this.bridgePrefetch = null;
    if (this.bridgeAbort) {
      this.bridgeAbort.abort();
      this.bridgeAbort = null;
    }

    if (!text) {
      this.#trace({
        agent: "followup",
        phase: "skipped",
        name: "not_ready_or_empty",
        detail: { reason: prefetch?.reason },
      });
      return;
    }

    this.#speakBridge(text, usedHook);
  }

  #speakBridge(text, usedHook = "") {
    const withGaps = stripMemoryTags(String(text || "")).trim();
    const clean = stripGapMarkers(withGaps).trim();
    if (!clean) return;

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
      lastSegments: [],
      speechSegments: [],
      pendingSilenceSec: 0,
      silenceApplyMode: null,
      autoGapPendingSec: 0,
      ttsCtl: null,
      llmDone: false,
      speaking: false,
      committed: true,
      isFollowup: true,
    };
    this.gen = gen;
    this.bridgeLastRunAt = Date.now();

    if (usedHook) this.#markUsedHook(usedHook, "thinker");

    this.#setState(State.THINKING);
    if (this.tts) gen.ttsCtl = this.tts.speak(`gen-${gen.id}`);

    const segments = parseSpeechSegments(withGaps);
    const gapMarkers = segments
      .filter((s) => s.type === "gap")
      .map((s) => s.seconds);

    gen.fullText = clean;
    gen.cleanLen = clean.length;
    gen.lastSegments = segments;

    const chunkCount = annotateTtsChunks(gen, clean);
    this.send({
      type: "assistant_delta",
      text: clean,
      continuation: true,
      chunkFlush: chunkCount || undefined,
      gapMarkers: gapMarkers.length ? gapMarkers : undefined,
      turnId: gen.id,
    });

    this.#pushSpeechSegments(gen, segments);
    gen.speaking = true;
    this.#setState(State.SPEAKING);
    gen.llmDone = true;
    this.#finishLlmGeneration(gen);
  }

  #emptyBrainstorm() {
    return {
      phase: "off",
      dump: "",
      hint: { tone: null, kind: null, audience: null, extra: null },
      artifact: null,
      lastChunk: "",
      enteredFrom: "",
      captureSeq: 0,
      wrapSeq: 0,
      formatAbort: null,
    };
  }

  #brainstormActive() {
    const phase = this.brainstorm?.phase;
    return phase === "capturing" || phase === "wrapup";
  }

  #emitBrainstorm() {
    this.send({
      type: "brainstorm",
      phase: this.brainstorm.phase,
      dump: this.brainstorm.dump || "",
      title: this.brainstorm.artifact?.title || "",
      body: this.brainstorm.artifact?.body || "",
    });
  }

  #resetBrainstorm({ silent = false } = {}) {
    if (this.brainstorm?.formatAbort) {
      try { this.brainstorm.formatAbort.abort(); } catch {}
    }
    this.brainstormClassifySeq += 1;
    this.brainstormClassifyText = "";
    this.brainstorm = this.#emptyBrainstorm();
    if (!silent) this.#emitBrainstorm();
  }

  #enterBrainstorm(remainder, hint, sourceText = "") {
    if (!config.brainstormEnabled) return;
    const uttered = this.gen?.userText || "";
    if (this.gen) this.#abortGeneration();
    this.#abortThought();
    this.#abortSnapshot();
    this.#abortBridge();
    if (this.paused) this.#setPaused(false);
    if (
      uttered
      && this.history.length
      && this.history[this.history.length - 1].role === "user"
      && this.history[this.history.length - 1].content === uttered
    ) {
      this.history.pop();
    }
    this.brainstormClassifySeq += 1;
    this.brainstormClassifyText = "";
    this.brainstorm = this.#emptyBrainstorm();
    this.brainstorm.phase = "capturing";
    this.brainstorm.hint = mergeFormatHint(null, hint);
    this.brainstorm.enteredFrom = this.#normalizeTranscript(sourceText);
    if (remainder) this.#appendDump(remainder);
    else this.#emitBrainstorm();
    this.#setState(State.LISTENING);
  }

  #appendDump(text) {
    const chunk = String(text || "").trim();
    if (!chunk) return;
    if (this.#normalizeTranscript(chunk) === this.#normalizeTranscript(this.brainstorm.lastChunk)) {
      return;
    }
    this.brainstorm.lastChunk = chunk;
    this.brainstorm.dump = this.brainstorm.dump
      ? `${this.brainstorm.dump} ${chunk}`
      : chunk;
    this.#emitBrainstorm();
  }

  #onBrainstormTurn({ event, transcript, turnIndex }) {
    switch (event) {
      case FluxEvent.START_OF_TURN:
        this.#abortBridge();
        if (this.brainstorm.formatAbort) {
          try { this.brainstorm.formatAbort.abort(); } catch {}
          this.brainstorm.formatAbort = null;
        }
        if (this.gen?.isBrainstorm || this.gen?.isFollowup) {
          this.#abortGeneration();
          this.#setState(State.LISTENING);
        }
        break;
      case FluxEvent.UPDATE:
        if (transcript) {
          if (this.gen?.isBrainstorm || this.gen?.isFollowup) this.#abortGeneration();
          this.send({ type: "transcript", role: "user", text: transcript, final: false });
        }
        break;
      case FluxEvent.EAGER_END_OF_TURN:
        break;
      case FluxEvent.TURN_RESUMED:
        this.#setState(State.LISTENING);
        break;
      case FluxEvent.END_OF_TURN:
        if (!transcript) {
          this.#setState(State.LISTENING);
          break;
        }
        if (this.brainstorm.phase === "capturing") {
          this.#onBrainstormCapture(transcript);
        } else {
          this.#emitFinalTranscript(transcript, turnIndex);
          this.#onBrainstormWrapup(transcript);
        }
        this.#setState(State.LISTENING);
        break;
    }
  }

  #onBrainstormCapture(text) {
    const raw = String(text || "").trim();
    if (!raw) return;
    if (detectSleepCommand(raw)) {
      this.#exitBrainstorm({ silent: true });
      this.#handleSleep(raw);
      return;
    }
    if (
      this.brainstorm.enteredFrom
      && this.#normalizeTranscript(raw) === this.brainstorm.enteredFrom
    ) {
      this.brainstorm.enteredFrom = "";
      return;
    }
    if (detectBrainstormExitCommand(raw)) {
      const remainder = stripBrainstormModeCommand(raw);
      if (remainder) this.#appendDump(remainder);
      this.#beginWrapup({ formatNow: hintIsClear(this.brainstorm.hint) });
      return;
    }
    this.#appendDump(raw);
  }

  #beginWrapup({ formatNow = false } = {}) {
    this.brainstorm.phase = "wrapup";
    this.#emitBrainstorm();
    if (formatNow && this.brainstorm.dump) {
      this.#formatBrainstorm({});
      return;
    }
    this.#speakCanned("Want to tweak anything, or should I format this?");
  }

  #onBrainstormWrapup(text) {
    const raw = String(text || "").trim();
    if (!raw) return;
    if (detectSleepCommand(raw)) {
      this.#exitBrainstorm({ silent: true });
      this.#handleSleep(raw);
      return;
    }
    if (detectBrainstormExitCommand(raw)) {
      this.#exitBrainstorm();
      return;
    }
    if (detectBrainstormEnterCommand(raw)) {
      this.brainstorm.phase = "capturing";
      this.brainstorm.artifact = null;
      const remainder = stripBrainstormModeCommand(raw);
      if (remainder) this.#appendDump(remainder);
      else this.#emitBrainstorm();
      return;
    }
    const seq = ++this.brainstorm.wrapSeq;
    const startedAt = Date.now();
    this.#trace({
      agent: "brainstorm",
      phase: "started",
      name: "classify",
      detail: { phase: "wrapup", userText: raw },
    });
    classifyBrainstormTurn({
      text: raw,
      phase: "wrapup",
      dump: this.brainstorm.dump,
      hint: this.brainstorm.hint,
      onUsage: (u) => this.#recordUsage(u),
    }).then((result) => {
      if (seq !== this.brainstorm.wrapSeq) return;
      if (this.brainstorm.phase !== "wrapup") return;
      this.#trace({
        agent: "brainstorm",
        phase: "result",
        name: "classify",
        durationMs: Date.now() - startedAt,
        detail: { action: result?.action || null },
      });
      const action = result?.action || "content";
      this.brainstorm.hint = mergeFormatHint(this.brainstorm.hint, result?.formatHint);
      const remainder = String(result?.remainder || "").trim();
      if (action === "tweak") {
        if (remainder) this.#appendDump(remainder);
        this.brainstorm.phase = "capturing";
        this.brainstorm.artifact = null;
        this.#emitBrainstorm();
        return;
      }
      if (action === "format") {
        if (remainder) this.#appendDump(remainder);
        this.#formatBrainstorm({});
        return;
      }
      if (action === "copy") {
        this.#formatBrainstorm({ then: "copy" });
        return;
      }
      if (action === "speak") {
        this.#formatBrainstorm({ then: "speak" });
        return;
      }
      if (action === "done" || action === "exit") {
        if (this.brainstorm.artifact) this.#exitBrainstorm();
        else if (this.brainstorm.dump) this.#formatBrainstorm({ then: "stay" });
        else this.#exitBrainstorm();
        return;
      }
      if (remainder) this.#appendDump(remainder);
    }).catch(() => {});
  }

  #formatBrainstorm({ then = "offer" } = {}) {
    if (!this.brainstorm.dump) {
      this.#speakCanned("I didn't catch a dump to format.");
      return;
    }
    if (then === "copy" && this.brainstorm.artifact?.clipboardText) {
      this.#copyBrainstormArtifact();
      return;
    }
    if (then === "speak" && this.brainstorm.artifact?.body) {
      this.#speakCanned(this.brainstorm.artifact.body);
      return;
    }
    if (this.brainstorm.formatAbort) {
      try { this.brainstorm.formatAbort.abort(); } catch {}
    }
    const abort = new AbortController();
    this.brainstorm.formatAbort = abort;
    this.#setState(State.THINKING);
    const startedAt = Date.now();
    this.#trace({
      agent: "brainstorm",
      phase: "started",
      name: "format",
      detail: { dumpChars: this.brainstorm.dump.length },
    });
    formatBrainstormDump({
      dump: this.brainstorm.dump,
      hint: this.brainstorm.hint,
      signal: abort.signal,
      onUsage: (u) => this.#recordUsage(u),
    }).then((artifact) => {
      if (abort.signal.aborted || this.brainstorm.formatAbort !== abort) return;
      this.brainstorm.formatAbort = null;
      this.#trace({
        agent: "brainstorm",
        phase: "result",
        name: "format",
        durationMs: Date.now() - startedAt,
        detail: { kind: artifact?.kind || null, title: artifact?.title || null },
      });
      if (!artifact) {
        this.#speakCanned("I couldn't shape that. Want to tweak it, or try formatting again?");
        return;
      }
      this.brainstorm.artifact = artifact;
      this.#keepArtifact({
        kind: artifact.kind || "note",
        title: artifact.title || "Draft",
        body: artifact.clipboardText || artifact.body || "",
        source: "brainstorm",
      });
      this.#emitBrainstorm();
      if (then === "speak") {
        this.#emitBrainstormCard(artifact, this.#speakCanned(artifact.body));
        return;
      }
      if (then === "copy") {
        this.#copyBrainstormArtifact();
        this.#emitBrainstormCard(artifact, this.gen?.id);
        return;
      }
      this.#emitBrainstormCard(artifact, this.#speakCanned("Want this on your clipboard?"));
    }).catch((err) => {
      if (abort.signal.aborted) return;
      this.brainstorm.formatAbort = null;
      this.#setState(State.LISTENING);
      this.send({ type: "error", source: "brainstorm", message: err.message });
    });
  }

  #emitBrainstormCard(artifact, turnId = null) {
    if (!artifact) return;
    this.send({
      type: "reply_cards",
      turnId: turnId ?? this.gen?.id ?? null,
      cards: [{
        kind: "brainstorm_draft",
        title: artifact.title,
        body: artifact.body,
        clipboardText: artifact.clipboardText,
      }],
    });
  }

  #copyBrainstormArtifact() {
    const artifact = this.brainstorm.artifact;
    const text = artifact?.clipboardText || artifact?.body || "";
    if (!text) {
      this.#speakCanned("Nothing to copy yet.");
      return;
    }
    this.send({
      type: "clipboard",
      text,
      label: artifact?.title || artifact?.kind || "draft",
    });
    this.#speakCanned("Copied.");
  }

  #speakCanned(text) {
    const withGaps = String(text || "").trim();
    if (!withGaps) return null;
    if (this.gen) this.#abortGeneration();

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
      lastSegments: [],
      speechSegments: [],
      pendingSilenceSec: 0,
      silenceApplyMode: null,
      autoGapPendingSec: 0,
      ttsCtl: null,
      llmDone: false,
      speaking: false,
      committed: true,
      isFollowup: false,
      isBrainstorm: true,
    };
    this.gen = gen;
    this.#setState(State.THINKING);
    if (this.tts) gen.ttsCtl = this.tts.speak(`gen-${gen.id}`);

    const segments = parseSpeechSegments(withGaps);
    const gapMarkers = segments
      .filter((s) => s.type === "gap")
      .map((s) => s.seconds);

    gen.fullText = withGaps;
    gen.cleanLen = withGaps.length;
    gen.lastSegments = segments;

    const chunkCount = annotateTtsChunks(gen, withGaps);
    this.send({
      type: "assistant_delta",
      text: withGaps,
      chunkFlush: chunkCount || undefined,
      gapMarkers: gapMarkers.length ? gapMarkers : undefined,
      turnId: gen.id,
    });

    this.#pushSpeechSegments(gen, segments);
    gen.speaking = true;
    this.#setState(State.SPEAKING);
    gen.llmDone = true;
    this.#finishLlmGeneration(gen);
    return gen.id;
  }

  #exitBrainstorm({ silent = false } = {}) {
    const dump = this.brainstorm.dump;
    const artifact = this.brainstorm.artifact;
    if (this.brainstorm.formatAbort) {
      try { this.brainstorm.formatAbort.abort(); } catch {}
    }
    if (dump || artifact) {
      const kind = artifact?.kind || "note";
      this.history.push({
        role: "user",
        content: `I brainstormed a ${kind}.`,
      });
      this.history.push({
        role: "assistant",
        content: artifact
          ? `Formatted it as a ${kind}${artifact.title ? ` (“${artifact.title}”)` : ""}.`
          : "Okay — done with that dump.",
      });
    }
    this.#resetBrainstorm({ silent });
    this.#setState(this.paused ? State.PAUSED : State.LISTENING);
  }

  close() {
    // Mark closing but do NOT await pendingMemoryJob — voice teardown stays instant.
    // In-flight analyzeTurnMemory still best-effort #safeSend(memory_update) when it finishes.
    this.sessionClosing = true;
    if (this.gen) this.#abortGeneration();
    this.#abortThought();
    this.#abortSnapshot();
    this.#abortBridge();
    this.#resetBrainstorm({ silent: true });

    this.#consolidateAndSend();

    this.stt.close();
    if (this.tts) this.tts.close();
  }
}
