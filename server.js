import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./lib/states.js";
import { VoiceSession } from "./lib/session.js";
import { generateGreeting } from "./lib/llm.js";
import { gmailConfigured, getAuthUrl, exchangeCode, getGmailStatus } from "./lib/gmail-auth.js";
import { listGmailInbox, sendGmailMessage } from "./lib/gmail-tools.js";
import { buildMemoryThoughtCache, normalizeMemory, consolidateSession } from "./lib/memory.js";
import { applyCategoryUpdates, getCategoryDirectory, SCHEMA_VERSION, MAX_SUB_MEMORIES_PER_CATEGORY } from "./lib/memory-store.js";
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

  if (urlPath === "/api/format-list" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { formatNoteList } = await import("./lib/list-format.js");
        const { title, items, spoken, query } = JSON.parse(body || "{}");
        const result = await formatNoteList({ title, items, spoken, query });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          title: result.title,
          markdown: result.markdown,
        }));
      } catch (err) {
        console.error("[format-list]", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/greeting" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { memory, context, lastChat, pastChats } = JSON.parse(body || "{}");
        const normalized = normalizeMemory(memory);
        const thoughtCache = buildMemoryThoughtCache(normalized);
        const text = await generateGreeting({
          memory: normalized,
          context,
          thoughtCache,
          lastChat: lastChat || null,
          pastChats: pastChats || [],
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
      } catch (err) {
        console.error("[greeting]", err.message);
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

        const consolidationResult = await consolidateSessionMemory({
          history: history || [],
          memory: normalized,
          existingDirectory: getCategoryDirectory(normalized),
        });

        if (consolidationResult?.sessionSummary) {
          normalized = consolidateSession(normalized, consolidationResult.sessionSummary);
        }
        for (const promote of consolidationResult?.promote || []) {
          normalized = applyCategoryUpdates(normalized, {
            categorized: [promote],
            generalInfo: promote.category === "general_info"
              ? [{ title: promote.title, content: promote.content }]
              : [],
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          memory: normalized,
          consolidated: Boolean(consolidationResult),
          sessionSummary: consolidationResult?.sessionSummary || null,
        }));
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
        let normalized = normalizeMemory(JSON.parse(body || "{}").memory);
        const dedupeResult = await deduplicateMemories(normalized);
        if (dedupeResult?.merges?.length) {
          normalized = applyDeduplication(normalized, dedupeResult);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ memory: normalized, merges: dedupeResult?.merges?.length || 0 }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/gmail/auth" && req.method === "GET") {
    if (!gmailConfigured()) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Gmail is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.");
      return;
    }
    res.writeHead(302, { Location: getAuthUrl() });
    res.end();
    return;
  }

  if (urlPath === "/api/gmail/callback" && req.method === "GET") {
    const u = new URL(req.url, `http://localhost:${config.port}`);
    const errParam = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    const htmlPage = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.4 system-ui,sans-serif;background:#111;color:#f4f4f5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}</style></head>
<body><main>${body}</main></body></html>`;

    if (errParam || !code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Gmail connect failed", `<p>Gmail connect did not finish.</p><p>You can close this tab and try again from June.</p>`));
      return;
    }

    exchangeCode(code).then(() => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Gmail connected", `<p>Gmail connected. You can close this tab.</p>`));
    }).catch((err) => {
      console.error("[gmail/callback]", err?.message || err);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Gmail connect failed", `<p>Could not finish connecting Gmail. Close this tab and try again.</p>`));
    });
    return;
  }

  if (urlPath === "/api/gmail/status" && req.method === "GET") {
    getGmailStatus().then((status) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "status_failed" }));
    });
    return;
  }

  if (urlPath === "/api/gmail/inbox" && req.method === "GET") {
    const u = new URL(req.url, `http://localhost:${config.port}`);
    const query = u.searchParams.get("q") || u.searchParams.get("query") || "";
    const maxResults = Number(u.searchParams.get("max") || u.searchParams.get("max_results") || 12);
    listGmailInbox({ query, maxResults }).then((payload) => {
      const status = payload.error === "not_connected" || payload.error === "gmail_not_configured" ? 401 : 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    }).catch((err) => {
      console.error("[gmail/inbox]", err?.message || err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "inbox_failed", messages: [] }));
    });
    return;
  }

  if (urlPath === "/api/gmail/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { to, subject, body: text, cc } = JSON.parse(body || "{}");
        const payload = await sendGmailMessage({ to, subject, body: text, cc });
        const status = payload.ok ? 200
          : payload.error === "not_connected" || payload.error === "gmail_not_configured" ? 401
          : 400;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (err) {
        console.error("[gmail/send]", err?.message || err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "send_failed" }));
      }
    });
    return;
  }

  if (urlPath === "/api/memory/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      systemId: "gemma_core_memory",
      limits: {
        maxSubMemoriesPerCategory: MAX_SUB_MEMORIES_PER_CATEGORY,
      },
      retrieval: {
        mode: "two_step_tools",
        tools: ["scan_memory_category", "get_memory_detail"],
        maxToolRounds: 2,
      },
      defaultCategories: ["general_info", "interests", "topic_deep_dives"],
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

wss.on("connection", (ws, req) => {
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
  const remote = req?.socket?.remoteAddress || "";
  const isLocal =
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote.endsWith("127.0.0.1");
  if (isLocal) session.setDebugTracing(true);
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
      if (msg.pastChats) session.setPastChats(msg.pastChats);
      if (msg.installedApps) session.setInstalledApps(msg.installedApps);
      if (msg.artifacts) session.setArtifacts(msg.artifacts);
      // Apply model before provider so ElevenLabs is created on the chosen model.
      if (msg.elevenLabsModel) session.setElevenLabsModel(msg.elevenLabsModel);
      if (msg.ttsProvider) session.setTtsProvider(msg.ttsProvider);
      if (isLocal) session.setDebugTracing(true);
      else if (msg.debug != null) session.setDebugTracing(Boolean(msg.debug));
    }
    else if (msg.type === "installed_apps") {
      if (msg.installedApps) session.setInstalledApps(msg.installedApps);
    }
    else if (msg.type === "text") {
      session.handleText(msg.text);
    }
    else if (msg.type === "resume") session.resume();
    else if (msg.type === "set_tts_provider") session.setTtsProvider(msg.provider);
    else if (msg.type === "set_tts_model") session.setElevenLabsModel(msg.model);
    else if (msg.type === "set_debug") {
      // Localhost keeps tracing on so the client ring-buffer stays warm.
      if (isLocal && !msg.enabled) return;
      session.setDebugTracing(Boolean(msg.enabled));
    }
    else if (msg.type === "note_list_saved") {
      session.setLastNote({ title: msg.title, markdown: msg.markdown });
    }
  });

  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
});

if (!config.deepgramKey) console.warn("[june] DEEPGRAM_API_KEY missing — STT will fail.");
if (!config.llmApiKey) {
  console.warn(
    config.llmProvider === "fireworks"
      ? "[june] FIREWORKS_API_KEY missing — using fallback echo replies. Set LLM_PROVIDER=openai to use OpenAI."
      : "[june] OPENAI_API_KEY missing — using fallback echo replies. Set LLM_PROVIDER=fireworks to use Fireworks."
  );
} else {
  console.log(`[june] LLM ${config.llmProvider} · ${config.openaiModel}`);
}
if (!config.cartesiaKey && !config.elevenLabsKey) {
  console.warn("[june] No TTS API keys — browser speech synthesis only.");
} else {
  const providers = [];
  if (config.elevenLabsKey) providers.push("ElevenLabs");
  if (config.cartesiaKey) providers.push("Cartesia");
  console.log(`[june] TTS providers available: ${providers.join(", ")}, Browser`);
}

console.log(`[june] Memory system v${SCHEMA_VERSION} — category schema + two-step retrieval tools`);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[june] voice agent listening on http://127.0.0.1:${config.port}`);
  console.log(`[june] open http://127.0.0.1:${config.port}/ and click the orb`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[june] port ${config.port} is already in use (often Cursor Simple Browser). Set PORT in .env to a free port.`);
    process.exit(1);
  }
  throw err;
});
