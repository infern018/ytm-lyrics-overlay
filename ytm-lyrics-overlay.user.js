// ==UserScript==
// @name         YTM Fullscreen Synced Lyrics
// @namespace    https://github.com/infern018/ytm-lyrics-overlay
// @version      1.0.0
// @description  Fullscreen, time-synced, auto-scrolling lyrics overlay for the YouTube Music web player
// @author       infern018
// @homepageURL  https://github.com/infern018/ytm-lyrics-overlay
// @supportURL   https://github.com/infern018/ytm-lyrics-overlay/issues
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttprequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @connect      lrclib.net
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/infern018/ytm-lyrics-overlay/main/ytm-lyrics-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/infern018/ytm-lyrics-overlay/main/ytm-lyrics-overlay.user.js
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = true; // flip to true for verbose console logging during development
  const LRCLIB_BASE = 'https://lrclib.net/api';
  const SCROLL_RESUME_DELAY = 1500; // ms of no manual scrolling before snapping back
  const AUTO_SCROLL_GUARD = 700; // ms to ignore scroll events caused by our own scrollIntoView
  const SYNC_LEAD_SECONDS = 0.3; // nudge the active-line lookup slightly ahead to offset perceived lag

  const BASE_FONT_SIZE = 26; // px, at scale = 1
  const ACTIVE_LINE_RATIO = 38 / 26; // active line stays this much bigger than inactive
  const FONT_SCALE_MIN = 0.7;
  const FONT_SCALE_MAX = 1.8;
  const FONT_SCALE_STEP = 0.1;
  const FONT_SCALE_STORAGE_KEY = 'ytm-lyrics-font-scale';
  const FULLSCREEN_STORAGE_KEY = 'ytm-lyrics-fullscreen';

  let currentTrackKey = null;
  let lyricsLines = null; // [{time, text}] or null
  let plainLyricsText = null; // string fallback
  let activeLineIndex = -1;
  let overlayEl = null;
  let lyricsBodyEl = null;
  let statusEl = null;
  let videoEl = null;
  let rafId = null;
  // YTM plays gapless auto-transitions by appending the next track into the
  // *same* underlying media timeline — currentTime does NOT reset to 0 at
  // the track boundary, it just keeps climbing from wherever the previous
  // track ended. So "time within the current track" is NOT videoEl.currentTime,
  // it's videoEl.currentTime - trackStartOffset, where trackStartOffset is
  // whatever currentTime happened to be at the moment this track was detected.
  // (On a manual skip the media reloads and currentTime is already ~0, so
  // trackStartOffset ends up ~0 too and this is a no-op in that case.)
  let trackStartOffset = 0;
  let autoScrollingUntil = 0;
  let scrollResumeTimer = null;
  let fontScale = loadFontScale();
  let isFullscreen = false; // fullscreen toggle disabled for now — buggy, revisit later
  // let isFullscreen = loadFullscreenPref();
  let fullscreenBtn = null;
  const lyricsCache = new Map(); // trackKey -> { synced, plain }

  function log(...args) {
    if (DEBUG) console.log('[ytm-lyrics]', ...args);
  }

  function warn(...args) {
    if (DEBUG) console.warn('[ytm-lyrics]', ...args);
  }

  function loadFontScale() {
    try {
      const stored = parseFloat(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
      if (!isNaN(stored) && stored >= FONT_SCALE_MIN && stored <= FONT_SCALE_MAX) return stored;
    } catch (e) { }
    return 1;
  }

  function saveFontScale(scale) {
    try {
      localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(scale));
    } catch (e) { }
  }

  function loadFullscreenPref() {
    try {
      return localStorage.getItem(FULLSCREEN_STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function saveFullscreenPref(value) {
    try {
      localStorage.setItem(FULLSCREEN_STORAGE_KEY, value ? '1' : '0');
    } catch (e) { }
  }

  // ---------- GM xmlhttprequest helper (supports both legacy and GM.* APIs) ----------
  const gmRequest =
    (typeof GM !== 'undefined' && GM.xmlHttpRequest) ||
    (typeof GM_xmlhttprequest !== 'undefined' && GM_xmlhttprequest);

  function gmGet(url) {
    if (!gmRequest) {
      return Promise.reject(new Error('No GM xmlHttpRequest API available'));
    }
    return new Promise((resolve, reject) => {
      gmRequest({
        method: 'GET',
        url,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
        timeout: 10000,
      });
    });
  }

  // ---------- LRC parsing ----------
  function parseLRC(lrcText) {
    const lineRe = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;
    const lines = [];
    for (const rawLine of lrcText.split('\n')) {
      const matches = [...rawLine.matchAll(lineRe)];
      if (matches.length === 0) continue;
      const text = rawLine.replace(lineRe, '').trim();
      for (const m of matches) {
        const minutes = parseInt(m[1], 10);
        const seconds = parseFloat(m[2]);
        const time = minutes * 60 + seconds;
        lines.push({ time, text });
      }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines.filter((l) => l.text.length > 0 || true); // keep blank lines for spacing
  }

  // ---------- Fetching lyrics ----------
  async function fetchLyrics(title, artist, duration) {
    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist,
    });
    if (duration) params.set('duration', String(Math.round(duration)));

    // 1. Try exact /get match
    try {
      const url = `${LRCLIB_BASE}/get?${params.toString()}`;
      log('GET', url);
      const text = await gmGet(url);
      log('/get response:', text.slice(0, 500));
      const data = JSON.parse(text);
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        return {
          synced: data.syncedLyrics ? parseLRC(data.syncedLyrics) : null,
          plain: data.plainLyrics || null,
        };
      }
    } catch (e) {
      warn('/get failed:', e);
    }

    // 2. Fallback: /search, pick best candidate
    try {
      const searchParams = new URLSearchParams({
        track_name: title,
        artist_name: artist,
      });
      const url = `${LRCLIB_BASE}/search?${searchParams.toString()}`;
      log('GET', url);
      const text = await gmGet(url);
      log('/search response:', text.slice(0, 500));
      const results = JSON.parse(text);
      if (Array.isArray(results) && results.length > 0) {
        const withSync = results.find((r) => r.syncedLyrics);
        if (withSync) {
          return { synced: parseLRC(withSync.syncedLyrics), plain: withSync.plainLyrics || null };
        }
        const withPlain = results.find((r) => r.plainLyrics);
        if (withPlain) {
          return { synced: null, plain: withPlain.plainLyrics };
        }
      }
    } catch (e) {
      warn('/search failed:', e);
    }

    log('no lyrics found for', title, artist);
    return { synced: null, plain: null };
  }

  // ---------- Reading YTM page state ----------
  let warnedMissingTitleSelector = false;

  function getCurrentTrackInfo() {
    const titleEl = document.querySelector('.title.ytmusic-player-bar');
    const bylineEl = document.querySelector('.byline.ytmusic-player-bar');
    if (!titleEl && !warnedMissingTitleSelector) {
      warnedMissingTitleSelector = true;
      console.warn('[ytm-lyrics] could not find track title element — YTM may have changed its page structure; selectors need updating');
    }
    const title = titleEl ? titleEl.textContent.trim() : '';
    let artist = '';
    if (bylineEl) {
      // byline is usually "Artist • Album • Year" - take first segment
      artist = bylineEl.textContent.split('•')[0].trim();
    }
    return { title, artist };
  }

  function getVideoEl() {
    return document.querySelector('video');
  }

  // ---------- Overlay UI ----------
  function createOverlay() {
    GM_addStyle(`
      #ytm-lyrics-overlay {
        position: fixed;
        left: 0;
        right: 0;
        z-index: 9999;
        background: rgba(10, 10, 10, 0.97);
        display: none;
        flex-direction: column;
        align-items: center;
        color: #fff;
        font-family: "YouTube Sans", Roboto, Arial, sans-serif;
      }
      #ytm-lyrics-overlay.visible {
        display: flex;
      }
      #ytm-lyrics-overlay.fullscreen {
        top: 0 !important;
        bottom: 0 !important;
        z-index: 2147483647;
      }
      #ytm-lyrics-close {
        position: absolute;
        top: 16px;
        right: 24px;
        font-size: 24px;
        cursor: pointer;
        color: #aaa;
        background: none;
        border: none;
        line-height: 1;
        z-index: 1;
      }
      #ytm-lyrics-close:hover {
        color: #fff;
      }
      #ytm-lyrics-font-controls {
        position: absolute;
        top: 16px;
        left: 24px;
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 1;
      }
      .ytm-lyrics-font-btn {
        cursor: pointer;
        color: #aaa;
        background: none;
        border: 1px solid #555;
        border-radius: 14px;
        line-height: 1;
        font-size: 15px;
        font-weight: 700;
        padding: 6px 11px;
      }
      .ytm-lyrics-font-btn:hover {
        color: #fff;
        border-color: #fff;
      }
      #ytm-lyrics-status {
        flex: 0 0 auto;
        color: #999;
        font-size: 16px;
        padding: 16px 0 4px;
      }
      #ytm-lyrics-body {
        flex: 1 1 auto;
        min-height: 0;
        width: 100%;
        max-width: 980px;
        overflow-y: scroll;
        text-align: center;
        scroll-behavior: smooth;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      #ytm-lyrics-body::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
      }
      .ytm-lyrics-line {
        font-size: var(--ytm-lyrics-font-size, 26px);
        line-height: 1.6;
        color: #666;
        font-weight: 500;
        padding: 12px 0;
        border-radius: 6px;
        transition: color 0.25s ease, font-size 0.25s ease, transform 0.25s ease, background-color 0.15s ease;
      }
      .ytm-lyrics-line.active {
        color: #fff;
        font-size: var(--ytm-lyrics-active-font-size, 38px);
        font-weight: 700;
      }
      .ytm-lyrics-plain {
        font-size: var(--ytm-lyrics-font-size, 26px);
        line-height: 1.8;
        color: #ddd;
        white-space: pre-wrap;
      }
      #ytm-lyrics-toggle-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 8px;
        cursor: pointer;
        color: #ccc;
        font-size: 13px;
        font-weight: 600;
        border: 1px solid #555;
        border-radius: 16px;
        padding: 4px 12px;
        background: transparent;
        user-select: none;
      }
      #ytm-lyrics-toggle-btn:hover {
        color: #fff;
        border-color: #fff;
      }
    `);

    overlayEl = document.createElement('div');
    overlayEl.id = 'ytm-lyrics-overlay';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'ytm-lyrics-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', hideOverlay);
    overlayEl.appendChild(closeBtn);

    const fontControls = document.createElement('div');
    fontControls.id = 'ytm-lyrics-font-controls';

    const smallerBtn = document.createElement('button');
    smallerBtn.className = 'ytm-lyrics-font-btn';
    smallerBtn.textContent = 'A−';
    smallerBtn.title = 'Decrease lyrics size';
    smallerBtn.addEventListener('click', () => adjustFontScale(-FONT_SCALE_STEP));
    fontControls.appendChild(smallerBtn);

    const biggerBtn = document.createElement('button');
    biggerBtn.className = 'ytm-lyrics-font-btn';
    biggerBtn.textContent = 'A+';
    biggerBtn.title = 'Increase lyrics size';
    biggerBtn.addEventListener('click', () => adjustFontScale(FONT_SCALE_STEP));
    fontControls.appendChild(biggerBtn);

    // Fullscreen toggle disabled for now — buggy, revisit later.
    // fullscreenBtn = document.createElement('button');
    // fullscreenBtn.className = 'ytm-lyrics-font-btn';
    // fullscreenBtn.title = 'Toggle fullscreen lyrics';
    // fontControls.appendChild(fullscreenBtn);
    // fullscreenBtn.addEventListener('click', () => setFullscreen(!isFullscreen));

    overlayEl.appendChild(fontControls);

    statusEl = document.createElement('div');
    statusEl.id = 'ytm-lyrics-status';
    overlayEl.appendChild(statusEl);

    lyricsBodyEl = document.createElement('div');
    lyricsBodyEl.id = 'ytm-lyrics-body';
    overlayEl.appendChild(lyricsBodyEl);

    document.body.appendChild(overlayEl);

    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) hideOverlay();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlayEl.classList.contains('visible')) hideOverlay();
    });

    lyricsBodyEl.addEventListener('scroll', onLyricsScroll);

    applyFontScale();
    updateFullscreenBtnLabel();
  }

  function updateFullscreenBtnLabel() {
    if (!fullscreenBtn) return;
    fullscreenBtn.textContent = isFullscreen ? '⤡' : '⛶';
  }

  function setFullscreen(value) {
    isFullscreen = value;
    saveFullscreenPref(isFullscreen);
    overlayEl.classList.toggle('fullscreen', isFullscreen);
    updateFullscreenBtnLabel();
    positionOverlay();
    if (lyricsLines) {
      applyCenteringPadding();
      scrollToActiveLine(true);
    }
    // Re-measure once more after layout settles — switching modes can briefly
    // return a stale nav/player-bar rect on the frame of the class toggle, and
    // the panel's height (used for centering padding) may not be final yet.
    requestAnimationFrame(() => {
      positionOverlay();
      if (lyricsLines) {
        applyCenteringPadding();
        scrollToActiveLine(true);
      }
    });
  }

  function applyFontScale() {
    if (!overlayEl) return;
    const baseSize = Math.round(BASE_FONT_SIZE * fontScale);
    const activeSize = Math.round(baseSize * ACTIVE_LINE_RATIO);
    overlayEl.style.setProperty('--ytm-lyrics-font-size', `${baseSize}px`);
    overlayEl.style.setProperty('--ytm-lyrics-active-font-size', `${activeSize}px`);
  }

  function adjustFontScale(delta) {
    const next = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round((fontScale + delta) * 100) / 100));
    if (next === fontScale) return;
    fontScale = next;
    saveFontScale(fontScale);
    applyFontScale();
    if (lyricsLines) applyCenteringPadding();
  }

  function positionOverlay() {
    if (!overlayEl) return;
    if (isFullscreen) {
      overlayEl.style.top = '0px';
      overlayEl.style.bottom = '0px';
      return;
    }
    const nav = document.querySelector('ytmusic-nav-bar') || document.querySelector('#nav-bar-background');
    const playerBar = document.querySelector('ytmusic-player-bar');
    const topEdge = nav ? nav.getBoundingClientRect().bottom : 64;
    // The player bar's progress/scrubber thumb renders slightly above the
    // bar's own bounding-box top (its hit area overflows upward), so leave
    // an extra buffer or our overlay's bottom edge clips the scrubber handle.
    const SCRUBBER_BUFFER = 7;
    const bottomEdge = playerBar
      ? window.innerHeight - playerBar.getBoundingClientRect().top + SCRUBBER_BUFFER
      : 72;
    overlayEl.style.top = `${Math.max(0, Math.round(topEdge))}px`;
    overlayEl.style.bottom = `${Math.max(0, Math.round(bottomEdge))}px`;
  }

  function onResize() {
    positionOverlay();
    if (lyricsLines) {
      applyCenteringPadding();
      scrollToActiveLine(true);
    }
  }

  function showOverlay() {
    overlayEl.classList.toggle('fullscreen', isFullscreen);
    updateFullscreenBtnLabel();
    positionOverlay();
    overlayEl.classList.add('visible');
    startSyncLoop();
    if (lyricsLines) applyCenteringPadding();
    window.addEventListener('resize', onResize);
  }

  function hideOverlay() {
    overlayEl.classList.remove('visible');
    stopSyncLoop();
    window.removeEventListener('resize', onResize);
    if (scrollResumeTimer) {
      clearTimeout(scrollResumeTimer);
      scrollResumeTimer = null;
    }
  }

  function renderStatus(text) {
    statusEl.textContent = text;
    statusEl.style.display = text ? 'block' : 'none';
  }

  // Pads the top/bottom of the scrollable lyrics list by half the visible
  // panel height, so the first and last lines can still scroll to center.
  function applyCenteringPadding() {
    const halfHeight = Math.round(lyricsBodyEl.clientHeight / 2);
    lyricsBodyEl.style.paddingTop = `${halfHeight}px`;
    lyricsBodyEl.style.paddingBottom = `${halfHeight}px`;
  }

  function renderSyncedLyrics(lines) {
    lyricsBodyEl.replaceChildren();
    activeLineIndex = -1;
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'ytm-lyrics-line';
      div.textContent = line.text || ' ';
      lyricsBodyEl.appendChild(div);
    }
    applyCenteringPadding();
    // New track: scroll position carried over from the previous track's
    // lyrics otherwise leaves the view stuck wherever it last was.
    lyricsBodyEl.scrollTop = 0;
  }

  function renderPlainLyrics(text) {
    lyricsBodyEl.replaceChildren();
    lyricsBodyEl.style.paddingTop = '';
    lyricsBodyEl.style.paddingBottom = '';
    lyricsBodyEl.scrollTop = 0;
    const div = document.createElement('div');
    div.className = 'ytm-lyrics-plain';
    div.textContent = text;
    lyricsBodyEl.appendChild(div);
  }

  // ---------- Manual-scroll detection: snap back to the active line ----------
  function onLyricsScroll() {
    if (Date.now() < autoScrollingUntil) return; // ignore our own programmatic scroll
    if (scrollResumeTimer) clearTimeout(scrollResumeTimer);
    scrollResumeTimer = setTimeout(() => {
      scrollResumeTimer = null;
      scrollToActiveLine();
    }, SCROLL_RESUME_DELAY);
  }

  function scrollToActiveLine(instant) {
    if (activeLineIndex < 0) return;
    const children = lyricsBodyEl.children;
    const activeEl = children[activeLineIndex];
    if (!activeEl) return;
    autoScrollingUntil = Date.now() + AUTO_SCROLL_GUARD;
    activeEl.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
  }

  // ---------- Sync loop ----------
  function startSyncLoop() {
    stopSyncLoop();
    const tick = () => {
      if (!videoEl || !videoEl.isConnected) videoEl = getVideoEl();
      if (videoEl && lyricsLines && lyricsLines.length > 0) {
        updateActiveLine(videoEl.currentTime - trackStartOffset + SYNC_LEAD_SECONDS);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopSyncLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function updateActiveLine(currentTime) {
    let idx = -1;
    for (let i = 0; i < lyricsLines.length; i++) {
      if (lyricsLines[i].time <= currentTime) {
        idx = i;
      } else {
        break;
      }
    }
    if (idx !== activeLineIndex) {
      log('ACTIVE LINE CHANGE', { fromIdx: activeLineIndex, toIdx: idx, currentTime, lineText: idx >= 0 ? lyricsLines[idx].text : null });
      const children = lyricsBodyEl.children;
      if (activeLineIndex >= 0 && children[activeLineIndex]) {
        children[activeLineIndex].classList.remove('active');
      }
      if (idx >= 0 && children[idx]) {
        children[idx].classList.add('active');
        autoScrollingUntil = Date.now() + AUTO_SCROLL_GUARD;
        children[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      activeLineIndex = idx;
    }
  }

  // ---------- Track change detection + loading ----------
  async function loadLyricsForCurrentTrack() {
    const { title, artist } = getCurrentTrackInfo();
    log('detected track:', JSON.stringify({ title, artist }));
    if (!title) return;

    const trackKey = `${title}::${artist}`;
    if (trackKey === currentTrackKey) return;
    currentTrackKey = trackKey;

    lyricsLines = null;
    plainLyricsText = null;
    activeLineIndex = -1;
    lyricsBodyEl.replaceChildren();
    // YTM may swap in a new <video> element on track change — re-query it so
    // the sync loop doesn't keep acting on the old track's (now-detached) video.
    videoEl = getVideoEl();
    // Gapless auto-transitions keep playing on the SAME media timeline, so
    // currentTime does not reset to 0 for the new track — it's wherever the
    // previous track happened to end. Record that as the offset so lyric
    // lookups use "time within this track" rather than raw currentTime.
    trackStartOffset = videoEl ? videoEl.currentTime : 0;
    log('TRACK SWITCH START', {
      currentTime: videoEl ? videoEl.currentTime : null,
      trackStartOffset,
    });

    let synced, plain;
    const cached = lyricsCache.get(trackKey);
    if (cached) {
      log('using cached lyrics for', trackKey);
      ({ synced, plain } = cached);
    } else {
      renderStatus('Loading lyrics…');

      const duration = videoEl ? videoEl.duration : 0;

      ({ synced, plain } = await fetchLyrics(title, artist, duration));
      lyricsCache.set(trackKey, { synced, plain });

      // If track changed again while we were fetching, discard this result.
      const { title: nowTitle, artist: nowArtist } = getCurrentTrackInfo();
      if (`${nowTitle}::${nowArtist}` !== trackKey) return;
    }

    if (synced && synced.length > 0) {
      lyricsLines = synced;
      renderStatus('');
      renderSyncedLyrics(synced);
    } else if (plain) {
      plainLyricsText = plain;
      renderStatus('No synced lyrics available — showing plain lyrics');
      renderPlainLyrics(plain);
    } else {
      renderStatus('No lyrics found for this track');
    }
  }

  function observeTrackChanges() {
    const target = document.querySelector('ytmusic-player-bar') || document.body;
    const observer = new MutationObserver(() => {
      loadLyricsForCurrentTrack();
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    // Also catch the initial load
    loadLyricsForCurrentTrack();
  }

  // ---------- Toggle button injection ----------
  function injectToggleButton() {
    const tryInject = () => {
      if (document.getElementById('ytm-lyrics-toggle-btn')) return true;
      const bar = document.querySelector('ytmusic-player-bar .middle-controls-buttons')
        || document.querySelector('ytmusic-player-bar .right-controls')
        || document.querySelector('ytmusic-player-bar');
      if (!bar) return false;

      const btn = document.createElement('button');
      btn.id = 'ytm-lyrics-toggle-btn';
      btn.textContent = 'LYRICS';
      btn.addEventListener('click', () => {
        if (overlayEl && overlayEl.classList.contains('visible')) {
          hideOverlay();
        } else {
          openLyricsOverlay();
        }
      });
      bar.appendChild(btn);
      return true;
    };

    if (tryInject()) return;
    const observer = new MutationObserver(() => {
      if (tryInject()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function openLyricsOverlay() {
    if (!overlayEl) createOverlay();
    showOverlay();
    loadLyricsForCurrentTrack();
  }

  // ---------- Keyboard shortcut: "L" toggles the lyrics overlay ----------
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function registerKeyboardShortcut() {
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() !== 'l') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      if (overlayEl && overlayEl.classList.contains('visible')) {
        hideOverlay();
      } else {
        openLyricsOverlay();
      }
    });
  }

  // ---------- Init ----------
  function init() {
    createOverlay();
    injectToggleButton();
    observeTrackChanges();
    registerKeyboardShortcut();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 1000);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
  }
})();
