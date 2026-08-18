/**
 * Bottom DevTools-style Agent Inspector (Ctrl/Cmd+Shift+G).
 * Consumes agent_trace events and shows live agent/tool activity + session cost.
 */
(function () {
  const MAX_EVENTS = 200;
  const AGENTS = ["main", "thinker", "snapshot", "memory", "followup", "brainstorm", "artifacts"];

  const events = [];
  let open = false;
  let agentFilter = "all";
  let stickToBottom = true;
  /** @type {Record<string, boolean>} */
  const live = Object.fromEntries(AGENTS.map((a) => [a, false]));
  /** @type {object|null} */
  let usageSnapshot = null;

  const panel = document.getElementById("agentInspector");
  const timeline = document.getElementById("agentInspectorTimeline");
  const pillsEl = document.getElementById("agentInspectorPills");
  const filterEl = document.getElementById("agentInspectorFilter");
  const stallCb = document.getElementById("agentInspectorStalls");
  const clearBtn = document.getElementById("agentInspectorClear");
  const copyBtn = document.getElementById("agentInspectorCopy");
  const closeBtn = document.getElementById("agentInspectorClose");
  const costUsdEl = document.getElementById("agentInspectorCostUsd");
  const costTokensEl = document.getElementById("agentInspectorCostTokens");
  const costCacheEl = document.getElementById("agentInspectorCostCache");
  const costBreakdownEl = document.getElementById("agentInspectorCostBreakdown");
  const costSourceEl = document.getElementById("agentInspectorCostSource");

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

  function pushUsage(msg) {
    if (!msg || msg.type !== "usage_update") return;
    usageSnapshot = msg;
    if (open) renderCost();
  }

  function formatUsd(n) {
    const v = Number(n) || 0;
    if (v >= 1) return `$${v.toFixed(4)}`;
    if (v >= 0.01) return `$${v.toFixed(5)}`;
    return `$${v.toFixed(6)}`;
  }

  function formatTok(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString();
  }

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function renderCost() {
    if (!costUsdEl || !costTokensEl) return;
    const totals = usageSnapshot?.totals || {
      usd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
      calls: 0,
    };
    costUsdEl.textContent = formatUsd(totals.usd);
    const elapsed = usageSnapshot?.elapsedMs != null
      ? ` · ${formatElapsed(usageSnapshot.elapsedMs)}`
      : "";
    const cached = Number(totals.cachedTokens) || 0;
    const uncached = totals.uncachedTokens != null
      ? Number(totals.uncachedTokens)
      : Math.max(0, (Number(totals.inputTokens) || 0) - cached);
    costTokensEl.textContent =
      `${formatTok(totals.totalTokens)} tok` +
      ` · in ${formatTok(totals.inputTokens)} / out ${formatTok(totals.outputTokens)}` +
      ` · ${totals.calls || 0} calls` +
      elapsed;

    if (costCacheEl) {
      const hitPct = (Number(totals.inputTokens) || 0) > 0
        ? Math.round((cached / totals.inputTokens) * 100)
        : 0;
      const last = usageSnapshot?.lastCall;
      const lastUncached = last?.uncachedTokens != null
        ? formatTok(last.uncachedTokens)
        : null;
      const lastCached = last?.cachedTokens != null ? formatTok(last.cachedTokens) : null;
      const ttft = usageSnapshot?.ttft || {};
      const ttftBits = [];
      if (ttft.lastMs != null) ttftBits.push(`last ${Math.round(ttft.lastMs)}ms`);
      if (ttft.avgMs != null) ttftBits.push(`avg ${Math.round(ttft.avgMs)}ms`);
      const lastLine = lastUncached != null
        ? ` · last turn ${lastUncached} uncached` + (lastCached != null ? ` / ${lastCached} cached` : "")
        : "";
      costCacheEl.textContent =
        `cache ${formatTok(cached)} / ${formatTok(uncached)} uncached (${hitPct}%)` +
        lastLine +
        (ttftBits.length ? ` · TTFT ${ttftBits.join(" · ")}` : " · TTFT —");
    }

    if (costBreakdownEl) {
      costBreakdownEl.innerHTML = "";
      const byAgent = usageSnapshot?.byAgent || {};
      const agents = Object.keys(byAgent).sort((a, b) => (byAgent[b].usd || 0) - (byAgent[a].usd || 0));
      for (const agent of agents) {
        const b = byAgent[agent];
        const chip = document.createElement("span");
        chip.className = "ai-cost-chip";
        chip.title = `${agent} this session: ${formatTok(b.inputTokens)} in (${formatTok(b.cachedTokens || 0)} cached / ${formatTok(b.uncachedTokens != null ? b.uncachedTokens : Math.max(0, (b.inputTokens || 0) - (b.cachedTokens || 0)))} uncached) / ${formatTok(b.outputTokens)} out · ${b.calls || 0} calls`;
        chip.innerHTML =
          `${escapeHtml(agent)} <strong>${formatUsd(b.usd)}</strong>` +
          ` · ${formatTok(b.totalTokens)}`;
        costBreakdownEl.appendChild(chip);
      }
      const byModel = usageSnapshot?.byModel || {};
      const models = Object.keys(byModel);
      for (const model of models) {
        const b = byModel[model];
        const chip = document.createElement("span");
        chip.className = "ai-cost-chip";
        const rates = b.rates
          ? `$${b.rates.input}/$${b.rates.output} per 1M`
          : "rates unknown";
        chip.title = `${model} this session · ${rates}`;
        chip.innerHTML =
          `<strong>${escapeHtml(model)}</strong> ${formatUsd(b.usd)}` +
          (b.ratesKnown === false ? " ≈" : "");
        costBreakdownEl.appendChild(chip);
      }
    }

    if (costSourceEl) {
      const configured = usageSnapshot?.configuredModels;
      let configLine = "";
      if (configured) {
        const bits = ["main", "memory", "thinker", "snapshot", "followup"]
          .filter((role) => configured[role]?.model)
          .map((role) => {
            const c = configured[role];
            const r = c.rates || {};
            return `${role}=${c.modelKey || c.model} ($${r.input}/$${r.output})`;
          });
        if (bits.length) configLine = ` · active: ${bits.join(" · ")}`;
      }
      const src = usageSnapshot?.pricingSource
        || "LLM list prices: Fireworks Nemotron Ultra $0.60/$2.40 · gpt-oss-20b $0.07/$0.30 · OpenAI gpt-4.1 $2/$8 per 1M";
      const unknown = usageSnapshot?.unknownModels?.length
        ? ` · unknown model(s) priced as gpt-4o-mini: ${usageSnapshot.unknownModels.join(", ")}`
        : "";
      costSourceEl.textContent = `Session cumulative · ${src}${configLine}${unknown}`;
      costSourceEl.title = costSourceEl.textContent;
    }
  }

  function setOpen(next) {
    open = Boolean(next);
    document.body.classList.toggle("agent-inspector-open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    sendDebug(open);
    if (open) {
      renderAll();
      renderCost();
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
    if (
      ev.phase === "result"
      || ev.phase === "aborted"
      || ev.phase === "skipped"
      || ev.phase === "injected"
    ) {
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
      if (ev.agent === "brainstorm") {
        return ev.name === "format"
          ? compact(d.title || d.kind) || "draft"
          : compact(d.action) || "classified";
      }
      if (ev.agent === "artifacts") return compact(d.title || d.kind) || "saved";
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
    // Cost is session-scoped on the server — keep the last snapshot visible.
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
      usage: usageSnapshot,
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

  renderCost();

  window.JuneAgentInspector = {
    push,
    pushUsage,
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
