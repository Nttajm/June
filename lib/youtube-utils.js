const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

export function parseYouTubeId(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (YT_ID.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return "";
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!YT_HOSTS.has(host)) return "";

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] || "";
    return YT_ID.test(id) ? id : "";
  }

  const fromQuery = url.searchParams.get("v");
  if (fromQuery && YT_ID.test(fromQuery)) return fromQuery;

  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts[0] === "embed"
    || parts[0] === "shorts"
    || parts[0] === "live"
    || parts[0] === "v"
  ) {
    const id = parts[1] || "";
    if (YT_ID.test(id)) return id;
  }

  return "";
}

export function youtubeThumb(videoId, quality = "hqdefault") {
  const id = parseYouTubeId(videoId);
  if (!id) return "";
  const q = String(quality || "hqdefault").replace(/[^\w]/g, "") || "hqdefault";
  return `https://img.youtube.com/vi/${id}/${q}.jpg`;
}

export function youtubeWatchUrl(videoId) {
  const id = parseYouTubeId(videoId);
  return id ? `https://www.youtube.com/watch?v=${id}` : "";
}

export function pickYouTubeFromSources(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  for (const s of list) {
    const videoId = parseYouTubeId(s?.url || s?.videoId || "");
    if (!videoId) continue;
    return {
      videoId,
      url: String(s.url || youtubeWatchUrl(videoId)),
      title: String(s.title || "").slice(0, 140),
    };
  }
  return null;
}

/** True when search results include at least one YouTube watch URL. */
export function searchResultsHaveYouTube(sources = []) {
  return Boolean(pickYouTubeFromSources(sources));
}

/** Build a synthetic youtube_player_tool call from fresh search hits. */
export function buildYouTubePlayFromSearch(sources = [], { title = "" } = {}) {
  const hit = pickYouTubeFromSources(sources);
  if (!hit) return null;
  const displayTitle = String(title || hit.title || "").trim().slice(0, 140);
  return {
    type: "function",
    function: {
      name: "youtube_player_tool",
      arguments: JSON.stringify({
        action: "play",
        video_id: hit.videoId,
        url: hit.url,
        ...(displayTitle ? { title: displayTitle } : {}),
      }),
    },
  };
}
