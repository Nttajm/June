import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./states.js";

const CARTESIA_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2026-03-01";
const ELEVENLABS_URL = "wss://api.elevenlabs.io/v1/text-to-speech";

export const STALL_MARKER = "{-gap:";

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

export function stripStallMarkers(text) {
  return text.replace(/\{-gap:[\d.]+\-\}/g, '');
}

function stallSilenceBuffer(seconds) {
  const samples = Math.floor(config.ttsSampleRate * seconds);
  return Buffer.alloc(samples * 4);
}

function prependStallGap(pcm, seconds) {
  return Buffer.concat([stallSilenceBuffer(seconds), pcm]);
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
        let pcm = Buffer.from(msg.data, "base64");
        const meta = this.contextMeta.get(msg.context_id);
        if (meta?.gapBeforeNext > 0) {
          pcm = prependStallGap(pcm, meta.gapBeforeNext);
          meta.gapBeforeNext = 0;
        }
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
    const meta = { chunkIndex: 0, gapBeforeNext: 0 };
    this.contextMeta.set(contextId, meta);

    return {
      push: (transcript) => {
        if (cancelled || !transcript) return;
        buffer += transcript;
        
        const regex = /(\{-gap:[\d.]+\-\})/;
        let match;
        while ((match = regex.exec(buffer)) !== null) {
          const chunk = buffer.slice(0, match.index).trim();
          const tag = match[1];
          buffer = buffer.slice(match.index + tag.length);
          
          if (chunk) {
            meta.chunkIndex++;
            this.#send({ ...base, transcript: chunk, continue: true });
          }
          
          const gapMatch = tag.match(/[\d.]+/);
          if (gapMatch) {
            const gapSeconds = parseFloat(gapMatch[0]);
            if (!isNaN(gapSeconds) && meta.chunkIndex > 0) {
              meta.gapBeforeNext = (meta.gapBeforeNext || 0) + gapSeconds;
            }
          }
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

export class ElevenLabsTTS extends EventEmitter {
  constructor() {
    super();
    this.activeContexts = new Map();
  }

  async connect() {}

  speak(contextId) {
    const wsUrl = `${ELEVENLABS_URL}/${config.elevenLabsVoiceId}/stream-input?model_id=${config.elevenLabsModel}&output_format=pcm_24000`;
    
    const ws = new WebSocket(wsUrl, {
      headers: { "xi-api-key": config.elevenLabsKey },
    });

    const ctx = {
      ws,
      ready: false,
      queue: [],
      cancelled: false,
      buffer: "",
      chunkIndex: 0,
      gapBeforeNext: 0,
    };
    this.activeContexts.set(contextId, ctx);

    ws.on("open", () => {
      ctx.ready = true;
      ws.send(JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        generation_config: { chunk_length_schedule: [50] },
      }));
      for (const text of ctx.queue) {
        if (text === null) {
          ws.send(JSON.stringify({ text: "" }));
        } else {
          this.#sendChunk(ctx, text);
        }
      }
      ctx.queue = [];
    });

    ws.on("message", (raw) => {
      if (ctx.cancelled) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.error) {
        this.emit("error", new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
        this.#cleanup(contextId);
        return;
      }
      if (msg.audio) {
        let pcmBuffer = Buffer.from(msg.audio, "base64");
        let floats = this.#pcm16ToFloat32(pcmBuffer);
        if (ctx.gapBeforeNext > 0) {
          floats = prependStallGap(floats, ctx.gapBeforeNext);
          ctx.gapBeforeNext = 0;
        }
        this.emit("audio", { contextId, pcm: floats });
      }
      if (msg.isFinal) {
        this.emit("done", { contextId });
        this.#cleanup(contextId);
      }
    });

    ws.on("error", (err) => {
      this.emit("error", err);
      this.#cleanup(contextId);
    });

    ws.on("close", () => {
      if (!ctx.cancelled) this.emit("done", { contextId });
      this.#cleanup(contextId);
    });

    return {
      push: (transcript) => {
        if (ctx.cancelled || !transcript) return;
        ctx.buffer += transcript;
        
        const regex = /(\{-gap:[\d.]+\-\})/;
        let match;
        while ((match = regex.exec(ctx.buffer)) !== null) {
          const chunk = ctx.buffer.slice(0, match.index).trim();
          const tag = match[1];
          ctx.buffer = ctx.buffer.slice(match.index + tag.length);
          
          if (chunk) {
            if (ctx.ready && ctx.ws?.readyState === WebSocket.OPEN) {
              this.#sendChunk(ctx, chunk);
            } else {
              ctx.queue.push(chunk);
            }
          }
          
          const gapMatch = tag.match(/[\d.]+/);
          if (gapMatch) {
            const gapSeconds = parseFloat(gapMatch[0]);
            if (!isNaN(gapSeconds) && ctx.chunkIndex > 0) {
              ctx.gapBeforeNext = (ctx.gapBeforeNext || 0) + gapSeconds;
            }
          }
        }
      },
      end: () => {
        if (ctx.cancelled) return;
        if (ctx.buffer.trim()) {
          if (ctx.ready && ctx.ws?.readyState === WebSocket.OPEN) {
            this.#sendChunk(ctx, ctx.buffer.trim());
          } else {
            ctx.queue.push(ctx.buffer.trim());
          }
        }
        ctx.buffer = "";
        if (ctx.ready && ctx.ws?.readyState === WebSocket.OPEN) {
          ctx.ws.send(JSON.stringify({ text: "" }));
        } else {
          // Push a special marker or just modify sendChunk logic
          // Actually, we can push an object to distinguish, but queue currently holds strings.
          // Let's push a special symbol or handle "" properly.
          ctx.queue.push(null);
        }
      },
      cancel: () => {
        ctx.cancelled = true;
        this.#cleanup(contextId);
      },
    };
  }

  #sendChunk(ctx, text) {
    if (!text || ctx.cancelled) return;
    ctx.chunkIndex++;
    ctx.ws.send(JSON.stringify({ text: text + " ", flush: true }));
  }

  #pcm16ToFloat32(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const floatBuffer = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) {
      const int16 = pcm16Buffer.readInt16LE(i * 2);
      const float32 = int16 / 32768;
      floatBuffer.writeFloatLE(float32, i * 4);
    }
    return floatBuffer;
  }

  #cleanup(contextId) {
    const ctx = this.activeContexts.get(contextId);
    if (!ctx) return;
    if (ctx.ws?.readyState === WebSocket.OPEN) ctx.ws.close();
    this.activeContexts.delete(contextId);
  }

  close() {
    for (const [contextId] of this.activeContexts) {
      this.#cleanup(contextId);
    }
  }
}
