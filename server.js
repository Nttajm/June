import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./lib/states.js";
import { VoiceSession } from "./lib/session.js";
import { generateGreeting } from "./lib/llm.js";
import { buildMemoryThoughtCache, normalizeMemory, consolidateSession, memoryNow, generateId } from "./lib/memory.js";
import { consolidateSessionMemory, deduplicateMemories, applyDeduplication } from "./lib/memory-ai.js";

const root = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/api/greeting" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { memory, context } = JSON.parse(body || "{}");
        const normalized = normalizeMemory(memory);
        const thoughtCache = buildMemoryThoughtCache(normalized);
        const text = await generateGreeting({ memory: normalized, context, thoughtCache });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/consolidate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { memory, history } = JSON.parse(body || "{}");
        let normalized = normalizeMemory(memory);
        
        const sessionId = normalized.meta?.currentSessionId;
        const sessionLogs = normalized.logs.filter(l => l.sessionId === sessionId);
        
        if (sessionLogs.length >= 3) {
          const consolidationResult = await consolidateSessionMemory({
            sessionLogs,
            history: history || [],
            existingSemanticMemory: normalized.semantic
          });
          
          if (consolidationResult) {
            normalized = consolidateSession(normalized, consolidationResult.sessionSummary);
            
            for (const promote of consolidationResult.promoteToSemantic || []) {
              const exists = normalized.semantic.some(
                s => s.subject.toLowerCase() === promote.subject.toLowerCase() &&
                     s.value.toLowerCase() === promote.value.toLowerCase()
              );
              if (!exists) {
                normalized.semantic.push({
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
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ memory: normalized, consolidated: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/deduplicate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { memory } = JSON.parse(body || "{}");
        let normalized = normalizeMemory(memory);
        
        if (normalized.semantic.length >= 5) {
          const dedupeResult = await deduplicateMemories(normalized.semantic);
          if (dedupeResult?.merges?.length) {
            normalized = applyDeduplication(normalized, dedupeResult);
          }
        }
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ memory: normalized }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/memory/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      schemaVersion: 2,
      limits: {
        maxLogs: 100,
        maxEpisodic: 20,
        maxSemantic: 200
      },
      scoring: {
        keywordRelevance: 0.45,
        freshness: 0.30,
        importance: 0.15,
        accessFrequency: 0.10
      }
    }));
    return;
  }

  let rel = urlPath === "/" ? "/june.html" : urlPath;
  const filePath = path.normalize(path.join(root, rel));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/voice" });

wss.on("connection", (ws) => {
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const sendAudio = (turnId, pcm) => {
    if (ws.readyState !== ws.OPEN) return;
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(turnId >>> 0, 0);
    ws.send(Buffer.concat([header, pcm]), { binary: true });
  };

  const session = new VoiceSession({ send, sendAudio });
  session.start();

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.handleAudio(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "init") {
      session.setMemory(msg.memory, msg.context);
      if (msg.history) session.setHistory(msg.history);
      if (msg.ttsProvider) session.setTtsProvider(msg.ttsProvider);
    }
    else if (msg.type === "text") session.handleText(msg.text);
    else if (msg.type === "resume") session.resume();
    else if (msg.type === "set_tts_provider") session.setTtsProvider(msg.provider);
  });

  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
});

if (!config.deepgramKey) console.warn("[june] DEEPGRAM_API_KEY missing — STT will fail.");
if (!config.openaiKey) console.warn("[june] OPENAI_API_KEY missing — using fallback echo replies.");
if (!config.cartesiaKey && !config.elevenLabsKey) {
  console.warn("[june] No TTS API keys — browser speech synthesis only.");
} else {
  const providers = [];
  if (config.elevenLabsKey) providers.push("ElevenLabs");
  if (config.cartesiaKey) providers.push("Cartesia");
  console.log(`[june] TTS providers available: ${providers.join(", ")}, Browser`);
}

console.log(`[june] Memory system v2 active — tiered storage with smart retrieval`);

server.listen(config.port, () => {
  console.log(`[june] voice agent listening on http://localhost:${config.port}`);
  console.log(`[june] open http://localhost:${config.port}/ and click the orb`);
});
