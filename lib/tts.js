import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./states.js";

const CARTESIA_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2026-03-01";
const ELEVENLABS_URL = "wss://api.elevenlabs.io/v1/text-to-speech";

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

export function createTTS(provider = config.ttsProvider) {
  if (provider === "elevenlabs" && config.elevenLabsKey) return new ElevenLabsTTS();
  if (provider === "cartesia" && config.cartesiaKey) return new CartesiaTTS();
  if (provider === "browser") return null;
  if (config.elevenLabsKey) return new ElevenLabsTTS();
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
 * ElevenLabs TTS using the multi-context WebSocket API.
 *
 * A single persistent WebSocket is opened in connect().  Each speak() call
 * creates an independent "context" on that connection so concurrent / back-to-
 * back generations share the same socket and interruptions are handled cleanly
 * via close_context.
 */
export class ElevenLabsTTS extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.failed = false;
    this.queue = [];
    this.contexts = new Map();
  }

  async connect() {
    if (this.ws || this.failed) return;

    const url =
      `${ELEVENLABS_URL}/${config.elevenLabsVoiceId}/multi-stream-input` +
      `?model_id=${config.elevenLabsModel}` +
      `&output_format=pcm_${config.ttsSampleRate}` +
      `&inactivity_timeout=180`;

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

      if (msg.is_final) {
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
    if (this.failed) return;
    const data = JSON.stringify(obj);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  speak(contextId) {
    const ctx = {
      buffer: "",
      cancelled: false,
      sentFirst: false,
    };
    this.contexts.set(contextId, ctx);

    return {
      push: (transcript) => {
        if (ctx.cancelled || !transcript) return;
        ctx.buffer += transcript;
        this.#drainBuffer(contextId, ctx);
      },
      end: () => {
        if (ctx.cancelled) return;
        const rest = ctx.buffer.trim();
        ctx.buffer = "";
        if (rest) this.#sendText(contextId, ctx, rest);
        this.#send({ context_id: contextId, flush: true });
      },
      cancel: () => {
        ctx.cancelled = true;
        ctx.buffer = "";
        this.contexts.delete(contextId);
        this.#send({ context_id: contextId, close_context: true });
      },
    };
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
      msg.voice_settings = { stability: 0.5, similarity_boost: 0.75 };
    }
    this.#send(msg);
  }

  close() {
    for (const [id] of this.contexts) {
      this.#send({ context_id: id, close_context: true });
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
