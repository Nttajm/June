/**
 * Bottom DevTools-style Agent Inspector (Ctrl/Cmd+Shift+G).
 * Consumes agent_trace events and shows live agent/tool activity.
 */
(function () {
  const MAX_EVENTS = 200;
  const AGENTS = ["main", "thinker", "snapshot", "memory", "followup"];

  const events = [];
  let open = false;
  let agentFilter = "all";
  let stickToBottom = true;
  /** @type {Record<string, boolean>} */
  const live = Object.fromEntries(AGENTS.map((a) => [a, false]));

  const panel = document.getElementById("agentInspector");
  const timeline = document.getElementById("agentInspectorTimeline");
  const pillsEl = document.getElementById("agentInspectorPills");
  const filterEl = document.getElementById("agentInspectorFilter");
  const stallCb = document.getElementById("agentInspectorStalls");
  const clearBtn = document.getElementById("agentInspectorClear");
  const copyBtn = document.getElementById("agentInspectorCopy");
  const closeBtn = document.getElementById("agentInspectorClose");

  if (!panel || !timeline) {
    console.warn("[June] Agent Inspector markup missing");
    return;
  }

  function sendDebug(enabled) {
    const ws = window.JuneVoice?.getWs?.();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_debug", enabled: Boolean(enabled) }));
    }
  }

  function isOpen() {
    return open;
  }

  function push(ev) {
    if (!ev || ev.type !== "agent_trace") return;
    events.push(ev);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    updateLive(ev);
    if (open) {
      if (passesFilter(ev)) appendRow(ev);
      updatePills();
      if (stickToBottom) scrollToBottom();
    }
  }

  function setOpen(next) {
    open = Boolean(next);
    document.body.classList.toggle("agent-inspector-open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    sendDebug(open);
    if (open) {
      renderAll();
      if (stickToBottom) scrollToBottom();
    }
  }

  function toggle() {
    setOpen(!open);
  }

  function updateLive(ev) {
    const agent = ev.agent;
    if (!AGENTS.includes(agent)) return;
    if (ev.phase === "started" || ev.phase === "tool") live[agent] = true;
    if (ev.phase === "result" || ev.phase === "aborted" || ev.phase === "skipped") {
      live[agent] = false;
    }
  }

  function passesFilter(ev) {
    return agentFilter === "all" || ev.agent === agentFilter;
  }

  function formatTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function summarize(ev) {
    const d = ev.detail || {};
    if (ev.phase === "tool") {
      return `${ev.name || "tool"}(${compact(d.args)}) → ${compact(d.result)}`;
    }
    if (ev.phase === "result") {
      if (ev.agent === "thinker") {
        return `${d.topic || "—"} · conf ${d.confidence ?? "?"} · ${d.reasoning || ""}`;
      }
      if (ev.agent === "snapshot") {
        return d.hasTopic === false
          ? `no topic · ${d.reasoning || ""}`
          : `${d.topic || "—"} · ${d.reasoning || ""}`;
      }
      if (ev.agent === "memory") {
        const n =
          (d.categorized?.length || 0) +
          (d.generalInfo?.length || 0) +
          (d.corrections?.length || 0);
        return `${n} writes · ${d.reasoning || ""}`;
      }
      if (ev.agent === "followup") return compact(d.text) || "done";
      if (ev.agent === "main") return `${d.chars ?? "?"} chars`;
    }
    if (ev.phase === "injected") {
      return ev.agent === "thinker"
        ? `cache → ${d.topic || "whispers"}`
        : `cache → ${d.topic || "hooks"}`;
    }
    if (ev.phase === "skipped") return ev.name || "skipped";
    if (ev.phase === "scheduled") return `in ${d.delayMs ?? "?"}ms`;
    if (ev.phase === "started") return compact(d.userText || d.transcript) || "running";
    if (ev.phase === "aborted") return ev.name || "aborted";
    return ev.name || ev.phase;
  }

  function compact(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.length > 90 ? v.slice(0, 90) + "…" : v;
    try {
      const s = JSON.stringify(v);
      return s.length > 90 ? s.slice(0, 90) + "…" : s;
    } catch {
      return String(v).slice(0, 90);
    }
  }

  function appendRow(ev) {
    const row = document.createElement("div");
    row.className = `ai-row ai-row--${ev.agent} ai-row--${ev.phase}`;
    row.dataset.agent = ev.agent;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "ai-row-head";
    head.innerHTML =
      `<span class="ai-ts">${escapeHtml(formatTime(ev.ts))}</span>` +
      `<span class="ai-badge ai-badge--${escapeHtml(ev.agent)}">${escapeHtml(ev.agent)}</span>` +
      `<span class="ai-phase">${escapeHtml(ev.phase)}</span>` +
      (ev.durationMs != null
        ? `<span class="ai-dur">${Math.round(ev.durationMs)}ms</span>`
        : "") +
      `<span class="ai-sum">${escapeHtml(summarize(ev))}</span>`;

    const detail = document.createElement("pre");
    detail.className = "ai-row-detail";
    detail.hidden = true;
    try {
      detail.textContent = JSON.stringify(
        {
          turnId: ev.turnId,
          name: ev.name,
          durationMs: ev.durationMs,
          detail: ev.detail,
        },
        null,
        2
      );
    } catch {
      detail.textContent = String(ev.detail || "");
    }

    head.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      row.classList.toggle("is-open", !detail.hidden);
    });

    row.appendChild(head);
    row.appendChild(detail);
    timeline.appendChild(row);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderAll() {
    timeline.innerHTML = "";
    for (const ev of events) {
      if (passesFilter(ev)) appendRow(ev);
    }
    updatePills();
  }

  function updatePills() {
    if (!pillsEl) return;
    pillsEl.querySelectorAll("[data-agent]").forEach((el) => {
      const a = el.getAttribute("data-agent");
      el.classList.toggle("is-live", Boolean(live[a]));
    });
  }

  function scrollToBottom() {
    timeline.scrollTop = timeline.scrollHeight;
  }

  function clear() {
    events.length = 0;
    AGENTS.forEach((a) => { live[a] = false; });
    timeline.innerHTML = "";
    updatePills();
  }

  /** Full dump shaped for pasting into chat / debugging. */
  function buildExportObject() {
    const byAgent = Object.fromEntries(AGENTS.map((a) => [a, []]));
    const flat = events.map((ev) => ({
      ts: ev.ts,
      time: formatTime(ev.ts),
      turnId: ev.turnId ?? null,
      agent: ev.agent,
      phase: ev.phase,
      name: ev.name || null,
      durationMs: ev.durationMs ?? null,
      detail: ev.detail ?? null,
    }));
    for (const row of flat) {
      if (byAgent[row.agent]) byAgent[row.agent].push(row);
      else {
        if (!byAgent.other) byAgent.other = [];
        byAgent.other.push(row);
      }
    }
    return {
      exportedAt: new Date().toISOString(),
      eventCount: flat.length,
      filter: agentFilter,
      agents: AGENTS.slice(),
      byAgent,
      events: flat,
    };
  }

  async function copyAll() {
    const payload = buildExportObject();
    const text = JSON.stringify(payload, null, 2);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (copyBtn) {
      const prev = copyBtn.textContent;
      copyBtn.textContent = ok ? `Copied (${payload.eventCount})` : "Copy failed";
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = prev;
        copyBtn.disabled = false;
      }, 1600);
    }
    return ok;
  }

  timeline.addEventListener("scroll", () => {
    const dist = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    stickToBottom = dist < 48;
  });

  if (filterEl) {
    filterEl.addEventListener("change", () => {
      agentFilter = filterEl.value || "all";
      renderAll();
    });
  }

  if (stallCb) {
    stallCb.checked = document.body.classList.contains("show-stalls");
    stallCb.addEventListener("change", () => {
      document.body.classList.toggle("show-stalls", stallCb.checked);
    });
  }

  if (copyBtn) copyBtn.addEventListener("click", () => { copyAll(); });
  if (clearBtn) clearBtn.addEventListener("click", clear);
  if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));

  // Build live pills if empty
  if (pillsEl && !pillsEl.children.length) {
    for (const a of AGENTS) {
      const pill = document.createElement("span");
      pill.className = "ai-pill";
      pill.dataset.agent = a;
      pill.textContent = a;
      pillsEl.appendChild(pill);
    }
  }

  window.JuneAgentInspector = {
    push,
    toggle,
    setOpen,
    isOpen,
    sendDebug,
    copyAll,
    buildExportObject,
    /** Re-send set_debug after reconnect if panel still open */
    onWsReady() {
      if (open) sendDebug(true);
    },
  };
})();
