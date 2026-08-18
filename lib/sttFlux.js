import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./states.js";

const FLUX_URL = "wss://api.deepgram.com/v2/listen";
const MULTI_MODEL = "flux-general-multi";

/** Normalize BCP-47 (e.g. en-GB) to the Flux base code (en). */
function baseLang(code) {
  if (!code || typeof code !== "string") return null;
  const base = code.trim().toLowerCase().split("-")[0];
  return base || null;
}

function normalizeHints(hints) {
  if (!Array.isArray(hints)) return [];
  const out = [];
  for (const h of hints) {
    const code = baseLang(h);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

export class FluxStream extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.preBuffer = [];
    this.closed = false;

    /** @type {string[]} Active language hints (empty = auto-detect). */
    this.activeHints = [];
    /** Locked primary language after a streak of consistent EndOfTurn detections. */
    this.lockedLanguage = null;
    /** Consecutive EndOfTurn count for the same primary language. */
    this.langStreak = { code: null, count: 0 };
  }

  get isMulti() {
    return (config.sttModel || MULTI_MODEL) === MULTI_MODEL;
  }

  connect() {
    const params = new URLSearchParams({
      model: config.sttModel || MULTI_MODEL,
      encoding: "linear16",
      sample_rate: String(config.sttSampleRate),
      eager_eot_threshold: String(config.eagerEotThreshold),
      eot_threshold: String(config.eotThreshold),
      eot_timeout_ms: String(config.eotTimeoutMs),
    });

    // Optional seed hints from env (only valid on flux-general-multi).
    const seedHints = this.isMulti ? normalizeHints(config.sttLanguageHints) : [];
    for (const hint of seedHints) {
      params.append("language_hint", hint);
    }
    this.activeHints = seedHints.slice();
    if (seedHints.length === 1) {
      this.lockedLanguage = seedHints[0];
      this.langStreak = { code: seedHints[0], count: config.sttLanguageLockAfter };
    } else {
      this.lockedLanguage = null;
      this.langStreak = { code: null, count: 0 };
    }

    this.ws = new WebSocket(`${FLUX_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${config.deepgramKey}` },
    });

    this.ws.on("open", () => {
      this.ready = true;
      for (const chunk of this.preBuffer) this.ws.send(chunk);
      this.preBuffer = [];
      this.emit("open");
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "TurnInfo" && msg.event) {
        const languages = Array.isArray(msg.languages)
          ? msg.languages.map(baseLang).filter(Boolean)
          : [];
        this.emit("turn", {
          event: msg.event,
          transcript: msg.transcript || "",
          turnIndex: msg.turn_index,
          endConfidence: msg.end_of_turn_confidence,
          languages,
        });
        // Detect-then-lock: bias STT toward the language the user keeps speaking.
        if (msg.event === "EndOfTurn" && languages.length) {
          this.#onDetectedLanguages(languages);
        }
      } else if (msg.type === "Error") {
        this.emit("error", new Error(msg.description || "Flux error"));
      }
    });

    this.ws.on("error", (err) => this.emit("error", err));
    this.ws.on("close", () => {
      this.ready = false;
      if (!this.closed) this.emit("close");
    });
  }

  /**
   * Mid-stream language hint update (flux-general-multi only).
   * Empty array clears hints and returns to auto-detect.
   */
  setLanguageHints(hints) {
    if (!this.isMulti) return false;
    const next = normalizeHints(hints);
    const same =
      next.length === this.activeHints.length &&
      next.every((h, i) => h === this.activeHints[i]);
    if (same) return false;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    try {
      this.ws.send(JSON.stringify({ type: "Configure", language_hints: next }));
      this.activeHints = next;
      this.emit("language_hints", next);
      return true;
    } catch {
      return false;
    }
  }

  #onDetectedLanguages(languages) {
    if (!this.isMulti) return;
    const primary = languages[0];
    if (!primary) return;

    if (this.langStreak.code === primary) {
      this.langStreak.count += 1;
    } else {
      this.langStreak = { code: primary, count: 1 };
    }

    const need = Math.max(1, config.sttLanguageLockAfter || 2);

    // Same language sustained → lock single-language hint for higher accuracy.
    if (this.langStreak.count >= need && this.lockedLanguage !== primary) {
      if (this.setLanguageHints([primary])) {
        this.lockedLanguage = primary;
        console.log(`[stt] language locked → ${primary} (streak=${this.langStreak.count})`);
      }
      return;
    }

    // Brief dip into another language while locked: don't unlock yet.
    // Sustained switch (same threshold) is handled above when lockedLanguage !== primary.
  }

  sendAudio(chunk) {
    if (this.closed) return;
    if (this.ready && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else {
      this.preBuffer.push(chunk);
    }
  }

  close() {
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* socket already gone */
      }
      this.ws.close();
    }
  }
}
