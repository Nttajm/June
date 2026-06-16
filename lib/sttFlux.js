import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./states.js";

const FLUX_URL = "wss://api.deepgram.com/v2/listen";

export class FluxStream extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.ready = false;
    this.preBuffer = [];
    this.closed = false;
  }

  connect() {
    const params = new URLSearchParams({
      model: "flux-general-en",
      encoding: "linear16",
      sample_rate: String(config.sttSampleRate),
      eager_eot_threshold: String(config.eagerEotThreshold),
      eot_threshold: String(config.eotThreshold),
      eot_timeout_ms: String(config.eotTimeoutMs),
    });

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
        this.emit("turn", {
          event: msg.event,
          transcript: msg.transcript || "",
          turnIndex: msg.turn_index,
          endConfidence: msg.end_of_turn_confidence,
        });
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
