/**
 * Off-screen YouTube IFrame Player for background audio.
 * Warms the API + empty player on page load so the first track starts fast.
 */
(function () {
  'use strict';

  const API_SRC = 'https://www.youtube.com/iframe_api';
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;

  let player = null;
  let apiPromise = null;
  let readyPromise = null;
  let readyResolve = null;
  let playerReady = false;
  let pendingId = '';
  let currentId = '';
  let onStateCb = null;

  function parseId(input) {
    const raw = String(input || '').trim();
    if (YT_ID.test(raw)) return raw;
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0] || '';
        return YT_ID.test(id) ? id : '';
      }
      const v = url.searchParams.get('v');
      if (v && YT_ID.test(v)) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') && YT_ID.test(parts[1] || '')) {
        return parts[1];
      }
    } catch { /* ignore */ }
    return '';
  }

  function mountEl() {
    let el = document.getElementById('youtubePlayerMount');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'youtubePlayerMount';
    el.className = 'youtube-player-mount';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
  }

  function showMount(el) {
    el.removeAttribute('hidden');
    el.hidden = false;
    el.setAttribute('aria-hidden', 'true');
  }

  function ensureApi() {
    if (window.YT && typeof window.YT.Player === 'function') {
      return Promise.resolve();
    }
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        try { if (typeof prev === 'function') prev(); } catch {}
        resolve();
      };
      if (window.YT && typeof window.YT.Player === 'function') {
        resolve();
        return;
      }
      if (!document.querySelector(`script[src="${API_SRC}"]`)) {
        const s = document.createElement('script');
        s.src = API_SRC;
        s.async = true;
        document.head.appendChild(s);
      }
    });
    return apiPromise;
  }

  function emitState(data) {
    const YT = window.YT;
    const playing = Boolean(
      YT && (data === YT.PlayerState.PLAYING || data === YT.PlayerState.BUFFERING)
    );
    try { onStateCb?.({ playing, data, videoId: currentId || pendingId }); } catch {}
  }

  function playingSame(id) {
    if (!playerReady || !player || !id) return false;
    try {
      const cur = player.getVideoData?.()?.video_id || currentId;
      const st = player.getPlayerState?.();
      const YT = window.YT;
      const active = YT && (
        st === YT.PlayerState.PLAYING
        || st === YT.PlayerState.BUFFERING
        || st === YT.PlayerState.CUED
      );
      return cur === id && active;
    } catch {
      return currentId === id;
    }
  }

  function playNow(target) {
    const p = target || player;
    if (!p) return;
    try { p.playVideo(); } catch {}
    // Retry: browsers sometimes silently ignore playVideo if the iframe
    // hasn't fully initialised or gesture hasn't propagated yet.
    retryPlay(p);
  }

  function retryPlay(p) {
    const attempts = [300, 800, 1500];
    let idx = 0;
    function tick() {
      if (idx >= attempts.length) return;
      const delay = attempts[idx++];
      setTimeout(() => {
        if (!p || !playerReady) return;
        try {
          const st = p.getPlayerState?.();
          const YT = window.YT;
          if (YT && st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) {
            p.playVideo();
            tick();
          }
        } catch {}
      }, delay);
    }
    tick();
  }

  function embedSrc(id, autoplay) {
    const origin = encodeURIComponent(window.location.origin);
    return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=${autoplay ? 1 : 0}&enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=0&disablekb=1&fs=0&origin=${origin}`;
  }

  function injectFastIframe(id) {
    const host = mountEl();
    showMount(host);
    host.innerHTML = '';
    player = null;
    playerReady = false;
    readyPromise = null;
    readyResolve = null;
    const iframe = document.createElement('iframe');
    iframe.id = 'youtubePlayerFrame';
    iframe.setAttribute('width', '320');
    iframe.setAttribute('height', '180');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.src = embedSrc(id, true);
    host.appendChild(iframe);
    currentId = id;
    return iframe;
  }

  function bindPlayer(existing) {
    if (player || !(window.YT && typeof window.YT.Player === 'function')) return;
    const host = mountEl();
    showMount(host);
    let target = existing || document.getElementById('youtubePlayerFrame');
    if (!target) {
      target = document.createElement('div');
      target.id = 'youtubePlayerFrame';
      host.appendChild(target);
    }
    playerReady = false;
    readyPromise = new Promise((resolve) => { readyResolve = resolve; });
    player = new window.YT.Player(target.id || target, {
      width: 320,
      height: 180,
      playerVars: {
        autoplay: pendingId ? 1 : 0,
        controls: 0,
        disablekb: 1,
        enablejsapi: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        origin: window.location.origin,
      },
      events: {
        onReady(ev) {
          playerReady = true;
          try { readyResolve?.(ev.target); } catch {}
          const id = pendingId;
          if (id) {
            try {
              const cur = ev.target.getVideoData?.()?.video_id || currentId;
              if (cur !== id) ev.target.loadVideoById(id);
            } catch {}
            currentId = id;
            playNow(ev.target);
          }
        },
        onStateChange(ev) {
          const YT = window.YT;
          if (YT && ev.data === YT.PlayerState.PLAYING) {
            currentId = pendingId || currentId;
          }
          emitState(ev.data);
        },
        onError() {
          emitState(window.YT?.PlayerState?.UNSTARTED ?? -1);
        },
      },
    });
  }

  async function waitReady() {
    if (playerReady) return true;
    if (!readyPromise) return false;
    try { await readyPromise; } catch {}
    return playerReady;
  }

  async function load(videoId, opts = {}) {
    const id = parseId(videoId);
    if (!id) return false;
    pendingId = id;
    if (typeof opts.onStateChange === 'function') onStateCb = opts.onStateChange;

    if (player && !playerReady) {
      await waitReady();
      if (pendingId !== id) return false;
    }

    if (playerReady && player) {
      if (playingSame(id)) {
        playNow();
        return true;
      }
      try {
        currentId = id;
        player.loadVideoById({ videoId: id, startSeconds: 0 });
        playNow();
        return true;
      } catch {
        player = null;
        playerReady = false;
      }
    }

    // Don't wait for widgetapi — start the embed immediately.
    injectFastIframe(id);
    await ensureApi();
    if (pendingId !== id) return false;
    bindPlayer(document.getElementById('youtubePlayerFrame'));
    const ready = await waitReady();
    if (!ready && pendingId === id && player) {
      // Fallback: widget API may not fire onReady if iframe already autoplayed.
      // Force a playVideo after a short delay.
      setTimeout(() => { try { player?.playVideo?.(); } catch {} }, 500);
    }
    return pendingId === id;
  }

  function warmup() {
    ensureApi().then(() => {
      if (!player) bindPlayer();
    }).catch(() => {});
  }

  function pause() {
    try { player?.pauseVideo?.(); } catch {}
  }

  function resume() {
    playNow();
  }

  function stop() {
    pendingId = '';
    currentId = '';
    try { player?.stopVideo?.(); } catch {}
    emitState(window.YT?.PlayerState?.ENDED ?? 0);
  }

  window.JuneYouTubePlayer = {
    parseId,
    load,
    warmup,
    pause,
    resume,
    stop,
  };

  warmup();
})();
