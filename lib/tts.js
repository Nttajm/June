import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./states.js";

const CARTESIA_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2026-03-01";
const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_HTTP_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** ElevenLabs voice_settings applied on first chunk (WS) and every HTTP stream. */
const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.28,
  style: 0.1, // exaggeration 10%
  speed: 0.9,
};

/** Models selectable in Settings / .env */
export const ELEVENLABS_MODELS = [
  { id: "eleven_flash_v2_5", label: "Flash v2.5 (realtime)", transport: "ws" },
  { id: "eleven_flash_v2", label: "Flash v2 (realtime)", transport: "ws" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2", transport: "ws" },
  { id: "eleven_v3", label: "Eleven v3 (expressive, higher latency)", transport: "http" },
];

export function normalizeElevenLabsModel(model) {
  const id = String(model || "").trim();
  if (ELEVENLABS_MODELS.some((m) => m.id === id)) return id;
  return config.elevenLabsModel || "eleven_flash_v2_5";
}

export function elevenLabsUsesHttp(model) {
  const meta = ELEVENLABS_MODELS.find((m) => m.id === normalizeElevenLabsModel(model));
  return meta?.transport === "http";
}

export function ttsAvailable(provider = config.ttsProvider) {
  if (provider === "elevenlabs") return Boolean(config.elevenLabsKey);
  if (provider === "cartesia") return Boolean(config.cartesiaKey);
  if (provider === "browser") return true;
  return Boolean(config.cartesiaKey) || Boolean(config.elevenLabsKey);
}

export function getAvailableProviders() {
  const providers = ["browser"];
  if (config.cartesiaKey) providers.unshift("cartesia");
  if (config.elevenLabsKey) providers.unshift("elevenlabs");
  return providers;
}

export function createTTS(provider = config.ttsProvider, { elevenLabsModel } = {}) {
  if (provider === "elevenlabs" && config.elevenLabsKey) {
    return new ElevenLabsTTS(normalizeElevenLabsModel(elevenLabsModel || config.elevenLabsModel));
  }
  if (provider === "cartesia" && config.cartesiaKey) return new CartesiaTTS();
  if (provider === "browser") return null;
  if (config.elevenLabsKey) {
    return new ElevenLabsTTS(normalizeElevenLabsModel(elevenLabsModel || config.elevenLabsModel));
  }
  if (config.cartesiaKey) return new CartesiaTTS();
  return null;
}

/** Debug marker inserted at TTS flush boundaries (display only — never sent to TTS). */
export const CHUNK_MARKER = "{|chunk|}";

const SENTENCE_END = /[.!?][)\u201d"']?(?:\s|$)/;
const ELLIPSIS_BREAK = /(?:\.{2,}|…)(?:\s|$)/;
const CLAUSE_BREAK = /[,;:]\s/;
const CLAUSE_FLUSH_AT = 200;

/** Shared chunk drain — flush at natural speech boundaries only. */
export function drainTtsTextBuffer(buf) {
  const chunks = [];
  let remaining = buf;

  const flushAt = (regex) => {
    let match;
    while ((match = regex.exec(remaining)) !== null) {
      const cutAt = match.index + match[0].length;
      if (cutAt >= remaining.length) break;
      const chunk = remaining.slice(0, cutAt).trim();
      remaining = remaining.slice(cutAt);
      if (chunk) chunks.push(chunk);
    }
  };

  flushAt(SENTENCE_END);
  flushAt(ELLIPSIS_BREAK);

  // Ellipsis is a spoken pause — flush even if this is the end of the
  // current stream so thinking-aloud beats ("ok lemm see here...") start TTS
  // immediately instead of sitting silent until the next LLM round.
  const trailingPause = remaining.match(/^(.*?(\.{2,}|…))\s*$/);
  if (trailingPause && trailingPause[1].trim()) {
    chunks.push(trailingPause[1].trim());
    remaining = "";
  }

  if (remaining.length >= CLAUSE_FLUSH_AT) {
    const cm = CLAUSE_BREAK.exec(remaining);
    if (cm) {
      const cutAt = cm.index + cm[0].length;
      const chunk = remaining.slice(0, cutAt).trim();
      remaining = remaining.slice(cutAt);
      if (chunk) chunks.push(chunk);
    }
  }

  return { chunks, buffer: remaining };
}

export function stripChunkMarkers(text) {
  return text.replace(/\{\|chunk\|\}/g, "");
}

/** Float32 LE silence for gapless PCM playback (zeros = audible pause). */
export function makeSilencePcm(seconds, sampleRate = config.ttsSampleRate) {
  const sec = Math.max(0, Number(seconds) || 0);
  const samples = Math.max(0, Math.floor(sec * sampleRate));
  return Buffer.alloc(samples * 4);
}

/** Pick an auto-gap duration from how the previous beat ended. */
export function autoGapSecondsForBoundary(text) {
  const t = String(text || "").trim();
  if (/\.\.\.$|…$/.test(t)) return 0.7;
  if (/--$/.test(t)) return 0.55;
  if (/[.!]$/.test(t)) return 0.65;
  if (/\?$/.test(t)) return 0.45;
  if (/[,;:]$/.test(t)) return 0.35;
  return 0.5;
}

/** True if this text ends on a natural spoken beat boundary. */
export function endsWithSpeechBeat(text) {
  return /(?:\.\.\.|…|--|[.!?]|[,;:])\s*$/.test(String(text || "").trimEnd());
}

/** Mirror TTS chunking — returns how many chunks flushed (for debug markers). */
export function annotateTtsChunks(gen, freshText) {
  gen.ttsChunkBuffer = (gen.ttsChunkBuffer || "") + freshText;
  const { chunks, buffer } = drainTtsTextBuffer(gen.ttsChunkBuffer);
  gen.ttsChunkBuffer = buffer;
  if (chunks.length) {
    gen.fullChunkText = (gen.fullChunkText || "") + chunks.join(CHUNK_MARKER) + CHUNK_MARKER;
  }
  return chunks.length;
}

export function flushTtsChunkAnnotator(gen) {
  const rest = (gen.ttsChunkBuffer || "").trim();
  gen.ttsChunkBuffer = "";
  return rest;
}

export class CartesiaTTS extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.failed = false;
    this.queue = [];
    this.contextMeta = new Map();
  }

  async connect() {
    if (this.ws || this.failed) return;
    this.ws = new WebSocket(CARTESIA_URL, {
      headers: {
        "X-API-Key": config.cartesiaKey,
        "Cartesia-Version": CARTESIA_VERSION,
      },
    });

    this.ws.on("open", () => {
      this.ready = true;
      for (const msg of this.queue) this.ws.send(msg);
      this.queue = [];
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "chunk" && msg.data) {
        const pcm = Buffer.from(msg.data, "base64");
        this.emit("audio", { contextId: msg.context_id, pcm });
      } else if (msg.type === "done") {
        this.contextMeta.delete(msg.context_id);
        this.emit("done", { contextId: msg.context_id });
      } else if (msg.type === "error") {
        this.emit("error", new Error(msg.error || "Cartesia error"));
      }
    });

    this.ws.on("error", (err) => {
      this.failed = true;
      this.ready = false;
      this.queue = [];
      this.emit("error", err);
    });
    this.ws.on("close", () => {
      this.ready = false;
      this.ws = null;
    });
  }

  #send(obj) {
    if (this.failed) return;
    const data = JSON.stringify(obj);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  speak(contextId) {
    const base = {
      model_id: config.cartesiaModel,
      voice: { mode: "id", id: config.cartesiaVoiceId },
      output_format: {
        container: "raw",
        encoding: "pcm_f32le",
        sample_rate: config.ttsSampleRate,
      },
      context_id: contextId,
    };
    let cancelled = false;
    let buffer = "";
    const meta = { chunkIndex: 0 };
    this.contextMeta.set(contextId, meta);

    return {
      push: (transcript) => {
        if (cancelled || !transcript) return;
        buffer += transcript;

        const { chunks, buffer: rest } = drainTtsTextBuffer(buffer);
        buffer = rest;
        for (const chunk of chunks) {
          meta.chunkIndex++;
          this.#send({ ...base, transcript: chunk, continue: true });
        }
      },
      /** Force-send any buffered text now (so a following gap lands between phrases). */
      forceFlush: () => {
        if (cancelled) return false;
        const rest = buffer.trim();
        buffer = "";
        if (!rest) return false;
        meta.chunkIndex++;
        this.#send({ ...base, transcript: rest, continue: true });
        return true;
      },
      flush: () => false,
      end: () => {
        if (cancelled) return;
        if (buffer.trim()) {
          meta.chunkIndex++;
          this.#send({ ...base, transcript: buffer.trim(), continue: true });
        }
        buffer = "";
        this.#send({ ...base, transcript: "", continue: false });
      },
      cancel: () => {
        cancelled = true;
        buffer = "";
        this.contextMeta.delete(contextId);
        this.#send({ context_id: contextId, cancel: true });
      },
    };
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

function pcm16ToFloat32(pcm16) {
  const samples = pcm16.length / 2;
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    out.writeFloatLE(pcm16.readInt16LE(i * 2) / 32768, i * 4);
  }
  return out;
}

/**
 * ElevenLabs TTS.
 * - Flash / multilingual: multi-context WebSocket (low latency).
 * - eleven_v3: HTTP stream (v3 does not support TTS WebSockets).
 */
export class ElevenLabsTTS extends EventEmitter {
  constructor(modelId = config.elevenLabsModel) {
    super();
    this.modelId = normalizeElevenLabsModel(modelId);
    this.ws = null;
    this.ready = false;
    this.failed = false;
    this.queue = [];
    this.contexts = new Map();
  }

  get usesHttp() {
    return elevenLabsUsesHttp(this.modelId);
  }

  async connect() {
    if (this.usesHttp) {
      this.ready = true;
      this.failed = false;
      console.log(`[tts] ElevenLabs HTTP ready model=${this.modelId}`);
      return;
    }
    if (this.ws || this.failed) return;

    const url =
      `${ELEVENLABS_WS_URL}/${config.elevenLabsVoiceId}/multi-stream-input` +
      `?model_id=${this.modelId}` +
      `&output_format=pcm_${config.ttsSampleRate}` +
      `&inactivity_timeout=180`;

    console.log(`[tts] ElevenLabs WS connecting model=${this.modelId}`);

    this.ws = new WebSocket(url, {
      headers: { "xi-api-key": config.elevenLabsKey },
      maxPayload: 16 * 1024 * 1024,
    });

    this.ws.on("open", () => {
      this.ready = true;
      for (const msg of this.queue) this.ws.send(msg);
      this.queue = [];
    });

    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.error) {
        this.emit("error", new Error(
          typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error),
        ));
        return;
      }

      const ctxId = msg.contextId;
      if (!ctxId) return;
      const ctx = this.contexts.get(ctxId);

      if (msg.audio) {
        if (ctx?.cancelled) return;
        const pcm = pcm16ToFloat32(Buffer.from(msg.audio, "base64"));
        this.emit("audio", { contextId: ctxId, pcm });
      }

      // Docs/guides use is_final; some payloads use isFinal.
      if (msg.is_final || msg.isFinal) {
        this.contexts.delete(ctxId);
        this.emit("done", { contextId: ctxId });
      }
    });

    this.ws.on("error", (err) => {
      this.failed = true;
      this.ready = false;
      this.queue = [];
      this.emit("error", err);
    });

    this.ws.on("close", () => {
      this.ready = false;
      this.ws = null;
      for (const [id, ctx] of this.contexts) {
        if (!ctx.cancelled) this.emit("done", { contextId: id });
      }
      this.contexts.clear();
    });
  }

  #send(obj) {
    if (this.failed || this.usesHttp) return;
    const data = JSON.stringify(obj);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  speak(contextId) {
    const ctx = {
      buffer: "",
      cancelled: false,
      sentFirst: false,
      abort: null,
    };
    this.contexts.set(contextId, ctx);

    if (this.usesHttp) {
      ctx.chain = Promise.resolve();
      const enqueueHttp = (text, { afterSilenceSec = 0, final = false } = {}) => {
        ctx.chain = ctx.chain.then(async () => {
          if (ctx.cancelled) return;
          if (text) await this.#httpStream(contextId, ctx, text, { emitDone: false });
          if (ctx.cancelled) return;
          if (afterSilenceSec > 0) {
            const pcm = makeSilencePcm(afterSilenceSec);
            if (pcm.length) this.emit("audio", { contextId, pcm });
          }
          if (final) {
            this.contexts.delete(contextId);
            if (!ctx.cancelled) this.emit("done", { contextId });
          }
        }).catch((err) => {
          if (!ctx.cancelled) this.emit("error", err);
        });
      };

      return {
        push: (transcript) => {
          if (ctx.cancelled || !transcript) return;
          ctx.buffer += transcript;
        },
        forceFlush: () => {
          if (ctx.cancelled) return false;
          const text = ctx.buffer.trim();
          ctx.buffer = "";
          if (!text) return false;
          enqueueHttp(text, {});
          return true;
        },
        /** Flush buffered text now (before a gap). Optional silence after that audio. */
        flush: ({ afterSilenceSec = 0 } = {}) => {
          if (ctx.cancelled) return false;
          const text = ctx.buffer.trim();
          ctx.buffer = "";
          if (!text && !(afterSilenceSec > 0)) return false;
          enqueueHttp(text, { afterSilenceSec });
          return true;
        },
        end: () => {
          if (ctx.cancelled) return;
          const text = ctx.buffer.trim();
          ctx.buffer = "";
          enqueueHttp(text, { final: true });
        },
        cancel: () => {
          ctx.cancelled = true;
          ctx.buffer = "";
          try { ctx.abort?.abort(); } catch {}
          this.contexts.delete(contextId);
        },
      };
    }

    return {
      push: (transcript) => {
        if (ctx.cancelled || !transcript) return;
        ctx.buffer += transcript;
        this.#drainBuffer(contextId, ctx);
      },
      forceFlush: () => {
        if (ctx.cancelled) return false;
        const rest = ctx.buffer.trim();
        ctx.buffer = "";
        if (!rest) return false;
        this.#sendText(contextId, ctx, rest);
        this.#send({ context_id: contextId, flush: true });
        return true;
      },
      flush: () => false,
      end: () => {
        if (ctx.cancelled) return;
        const rest = ctx.buffer.trim();
        ctx.buffer = "";
        if (rest) this.#sendText(contextId, ctx, rest);
        // flush generates remaining audio; close_context is what emits is_final.
        this.#send({ context_id: contextId, flush: true });
        this.#send({ context_id: contextId, close_context: true });
      },
      cancel: () => {
        ctx.cancelled = true;
        ctx.buffer = "";
        this.contexts.delete(contextId);
        this.#send({ context_id: contextId, close_context: true });
      },
    };
  }

  async #httpStream(contextId, ctx, text, { emitDone = true } = {}) {
    const abort = new AbortController();
    ctx.abort = abort;
    const url =
      `${ELEVENLABS_HTTP_URL}/${config.elevenLabsVoiceId}/stream` +
      `?output_format=pcm_${config.ttsSampleRate}`;

    console.log(`[tts] ElevenLabs HTTP stream model=${this.modelId} chars=${text.length}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsKey,
        "Content-Type": "application/json",
        Accept: "application/octet-stream",
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
        voice_settings: ELEVENLABS_VOICE_SETTINGS,
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!ctx.cancelled && buf.length) {
        this.emit("audio", { contextId, pcm: pcm16ToFloat32(buf) });
      }
      if (emitDone) {
        this.contexts.delete(contextId);
        if (!ctx.cancelled) this.emit("done", { contextId });
      }
      return;
    }

    let leftover = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ctx.cancelled) {
        try { await reader.cancel(); } catch {}
        break;
      }
      const chunk = Buffer.from(value);
      const merged = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const evenLen = merged.length - (merged.length % 2);
      if (evenLen > 0) {
        this.emit("audio", { contextId, pcm: pcm16ToFloat32(merged.subarray(0, evenLen)) });
      }
      leftover = evenLen < merged.length ? merged.subarray(evenLen) : Buffer.alloc(0);
    }

    if (emitDone) {
      this.contexts.delete(contextId);
      if (!ctx.cancelled) this.emit("done", { contextId });
    }
  }

  #drainBuffer(contextId, ctx) {
    const { chunks, buffer } = drainTtsTextBuffer(ctx.buffer);
    ctx.buffer = buffer;
    for (const chunk of chunks) {
      this.#sendText(contextId, ctx, chunk);
      this.#send({ context_id: contextId, flush: true });
    }
  }

  #sendText(contextId, ctx, text) {
    if (!text || ctx.cancelled) return;
    const msg = { text: text + " ", context_id: contextId };
    if (!ctx.sentFirst) {
      ctx.sentFirst = true;
      msg.voice_settings = ELEVENLABS_VOICE_SETTINGS;
    }
    this.#send(msg);
  }

  close() {
    for (const [id, ctx] of this.contexts) {
      ctx.cancelled = true;
      try { ctx.abort?.abort(); } catch {}
      if (!this.usesHttp) this.#send({ context_id: id, close_context: true });
    }
    this.contexts.clear();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.#send({ close_socket: true });
      this.ws.close();
    }
    this.ws = null;
    this.ready = false;
  }
}