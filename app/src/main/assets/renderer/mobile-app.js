/* mobile-app.js — Android Liquid Glass Sunify uygulaması */
(function initSunifyMobileApp() {
  const API = 'http://127.0.0.1:3001';
  const bridge = window.SunifyAndroidBridge || null;
  const FALLBACK_ART =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%237c5cff'/%3E%3Cstop offset='1' stop-color='%23241126'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' fill='url(%23g)'/%3E%3Cpath d='M26 40V22l16-4v18' fill='none' stroke='%23fff' stroke-opacity='.75' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='23' cy='41' r='4' fill='%23fff' fill-opacity='.75'/%3E%3Ccircle cx='39' cy='37' r='4' fill='%23fff' fill-opacity='.75'/%3E%3C/svg%3E";

  const state = {
    playlists: [],
    likedTracks: [],
    listeningStats: { totalPlays: 0, tracks: {}, artists: {}, daily: {} },
    recentTracks: [],
    offlineTracks: [],
    deviceTracks: [],
    abLoop: { a: null, b: null },
    smartCacheRunning: false,
    queue: [],
    queueIndex: -1,
    currentTrack: null,
    isPlaying: false,
    shuffle: false,
    repeat: false,
    mood: 'all',
    searchFilter: 'tracks',
    detailContext: null,
    prevTab: 'home',
    lyrics: [],
    lyricsSource: 'auto',
    lyricsOffset: 0,
    lyricsOffsetIsAuto: false,
    autoLyricsSync: localStorage.getItem('sunify_auto_lyrics_sync') !== 'false',
    lyricsAlignMode: false,
    lyricsDuration: 0,
    lyricsFetchedDuration: 0,
    lyricsDurationRefetched: false,
    lastAutoSyncKey: '',
    lastLyricIdx: -1,
    lyricDomRows: [],
    dailyMixCache: { key: '', fetchedAt: 0, mixes: null, loading: false },
    syncTimer: null,
    syncIncludeStructure: false,
    cloudReady: false,
    lastCloudPullAt: 0,
    lastSyncedAt: 0,
    pendingStructEdit: false,
    listenTimeAccumSec: 0,
    lastTimeUpdateMs: 0,
    coverColorCache: {},
    colorExtractSeq: 0,
    currentCoverRgb: '181, 122, 255',
    lastNotifPushAt: 0,
    libReorderMode: false,
    detailReorderMode: false,
    lyricsTranslated: false,
    lyricsTranslations: [],
    lyricsCardMode: false,
    lyricsSelectedLines: [],
    listenSession: { trackKey: '', track: null, listened: 0, lastCur: 0, skippedForward: false, completed: false },
    auth: { accessToken: '', refreshToken: '', user: null },
    theme: localStorage.getItem('sunify_theme') || 'sunify',
    accent: localStorage.getItem('sunify_accent_mode') || 'auto',
  };

  function createAudioEngine() {
    if (bridge && typeof bridge.hasNativeAudio === 'function' && bridge.hasNativeAudio()) {
      const listeners = new Map();
      let _src = '';
      let _loaded = false;
      let _paused = true;
      let _cur = 0;
      let _dur = 0;
      let _vol = 1;
      let _rate = 1;
      let _keepPitch = true;

      const emit = (type) => {
        const list = listeners.get(type);
        if (!list || !list.length) return;
        const copy = list.slice();
        copy.forEach((entry) => {
          try { entry.fn({ type }); } catch {}
          if (entry.once) {
            const idx = list.indexOf(entry);
            if (idx >= 0) list.splice(idx, 1);
          }
        });
      };

      window.__sunifyNativeAudioEvent = (type, posSec, durSec, paused) => {
        if (Number.isFinite(Number(posSec))) _cur = Math.max(0, Number(posSec));
        if (Number.isFinite(Number(durSec)) && Number(durSec) > 0) _dur = Number(durSec);
        _paused = Boolean(paused);
        emit(String(type || ''));
      };

      return {
        isNative: true,
        get src() { return _src; },
        set src(val) {
          _src = String(val || '');
          _loaded = false;
          _cur = 0;
          _dur = 0;
          _paused = true;
        },
        get paused() { return _paused; },
        get currentTime() { return _cur; },
        set currentTime(sec) {
          const t = Math.max(0, Number(sec) || 0);
          _cur = t;
          try { bridge.nativeAudioSeek(t); } catch {}
        },
        get duration() { return _dur; },
        get volume() { return _vol; },
        set volume(v) {
          _vol = Math.max(0, Math.min(1, Number(v) || 0));
          try { bridge.nativeAudioSetVolume(_vol); } catch {}
        },
        get playbackRate() { return _rate; },
        set playbackRate(r) {
          _rate = Math.max(0.75, Math.min(1.35, Number(r) || 1));
          try { bridge.nativeAudioSetSpeedPitch(_rate, _keepPitch); } catch {}
        },
        get defaultPlaybackRate() { return _rate; },
        set defaultPlaybackRate(r) { _rate = Math.max(0.75, Math.min(1.35, Number(r) || 1)); },
        get preservesPitch() { return _keepPitch; },
        set preservesPitch(k) {
          _keepPitch = Boolean(k);
          try { bridge.nativeAudioSetSpeedPitch(_rate, _keepPitch); } catch {}
        },
        prepareSource(startSec = 0) {
          if (!_src) return;
          _loaded = true;
          _paused = true;
          try { bridge.nativeAudioSetSource(_src, false, Number(startSec) || 0); } catch {}
        },
        play(startSec = 0) {
          if (!_loaded && _src) {
            _loaded = true;
            _paused = false;
            try { bridge.nativeAudioSetSource(_src, true, Number(startSec) || 0); } catch {}
          } else {
            _paused = false;
            try { bridge.nativeAudioPlay(); } catch {}
          }
          return Promise.resolve();
        },
        pause() {
          _paused = true;
          try { bridge.nativeAudioPause(); } catch {}
        },
        addEventListener(type, fn, opts) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push({ fn, once: Boolean(opts && opts.once) });
        },
      };
    }

    const htmlAudio = new Audio();
    htmlAudio.crossOrigin = 'anonymous';
    htmlAudio.preload = 'auto';
    return htmlAudio;
  }

  const audio = createAudioEngine();

  function resolveTrackThumbRaw(track) {
    const raw = String(track?.thumbnail || '').trim();
    if (raw) return raw;
    const tid = String(track?.id || '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(tid)) {
      return `https://i.ytimg.com/vi/${tid}/hqdefault.jpg`;
    }
    return '';
  }

  function thumbUrl(url, size = 128) {
    const raw = String(url || '').trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('http://127.0.0.1:')) return raw || FALLBACK_ART;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return `${API}/api/thumb?url=${encodeURIComponent(raw)}&w=${size}`;
    }
    return raw;
  }

  const coverLookupCache = new Map();
  function attachCoverFallback(imgEl, track) {
    if (!imgEl || !track) return;
    const raw = resolveTrackThumbRaw(track);
    const tid = String(track.id || '').trim();
    const ytFallback = /^[a-zA-Z0-9_-]{11}$/.test(tid) ? `https://i.ytimg.com/vi/${tid}/hqdefault.jpg` : '';
    let step = 0;

    const tryLookup = () => {
      const cacheKey = `${String(track.artist || '').toLowerCase()}|${String(track.title || '').toLowerCase()}`;
      if (!track.title) {
        imgEl.src = FALLBACK_ART;
        return;
      }
      if (coverLookupCache.has(cacheKey)) {
        const cached = coverLookupCache.get(cacheKey);
        imgEl.src = cached || FALLBACK_ART;
        return;
      }
      coverLookupCache.set(cacheKey, '');
      const qs = new URLSearchParams({ artist: track.artist || '', title: track.title || '' });
      fetch(`${API}/api/track-cover?${qs.toString()}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const found = String(d?.thumbnail || '').trim();
          if (found) {
            coverLookupCache.set(cacheKey, found);
            track.thumbnail = found;
            if (imgEl.isConnected) imgEl.src = found;
          } else if (imgEl.isConnected) {
            imgEl.src = FALLBACK_ART;
          }
        })
        .catch(() => {
          if (imgEl.isConnected) imgEl.src = FALLBACK_ART;
        });
    };

    imgEl.onerror = () => {
      step += 1;
      if (step === 1 && raw && imgEl.src !== raw) {
        imgEl.src = raw;
        return;
      }
      if (step === 2 && ytFallback && imgEl.src !== ytFallback) {
        imgEl.src = ytFallback;
        return;
      }
      if (step === 3) {
        tryLookup();
        return;
      }
      imgEl.onerror = null;
      imgEl.src = FALLBACK_ART;
    };

    if (!raw) {
      imgEl.src = FALLBACK_ART;
      tryLookup();
    }
  }

  const $ = (id) => document.getElementById(id);

  function getSecure(key) {
    try {
      const v = bridge?.getSecureAuthValue ? bridge.getSecureAuthValue(key) : null;
      if (v) return String(v);
    } catch {}
    return localStorage.getItem(key) || '';
  }

  function setSecure(key, val) {
    try {
      bridge?.setSecureAuthValue?.(key, String(val || ''));
    } catch {}
    if (val) localStorage.setItem(key, String(val));
    else localStorage.removeItem(key);
  }

  function delSecure(key) {
    try {
      bridge?.deleteSecureAuthValue?.(key);
    } catch {}
    localStorage.removeItem(key);
  }

  function showToast(msg) {
    const el = $('mToast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  }

  function fmtBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function trackKey(t) {
    return String(t?.id || `${t?.artist || ''}__${t?.title || ''}`).toLowerCase();
  }

  function analyticsKey(t) {
    return `${t?.artist || ''} - ${t?.title || ''}`.trim().toLowerCase();
  }

  function activeUserIdentity() {
    const u = state.auth.user;
    if (u?.id) return String(u.id).trim();
    if (u?.email) return String(u.email).trim().toLowerCase();
    return localStorage.getItem('sunify_last_uid') || 'guest';
  }

  function accountKey(key) {
    return `sunify_m_${encodeURIComponent(activeUserIdentity())}_${key}`;
  }

  function isLiked(t) {
    if (!t) return false;
    const k = trackKey(t);
    return state.likedTracks.some((x) => trackKey(x) === k || analyticsKey(x) === analyticsKey(t));
  }

  let refreshPromise = null;
  async function refreshSessionToken() {
    if (!state.auth.refreshToken) return false;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${API}/api/auth/session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...(state.auth.accessToken ? { Authorization: `Bearer ${state.auth.accessToken}` } : {}),
          },
          body: JSON.stringify({ refresh_token: state.auth.refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({}));
        const sess = data.session && typeof data.session === 'object' ? data.session : data;
        if (sess.access_token) {
          state.auth.accessToken = sess.access_token;
          setSecure('sunify_auth_token', sess.access_token);
        }
        if (sess.refresh_token) {
          state.auth.refreshToken = sess.refresh_token;
          setSecure('sunify_refresh_token', sess.refresh_token);
        }
        if (data.user || sess.user) {
          state.auth.user = data.user || sess.user;
          if (state.auth.user?.id) localStorage.setItem('sunify_last_uid', state.auth.user.id);
        }
        return Boolean(state.auth.accessToken);
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  async function api(path, opts = {}, retried = false) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...(opts.headers || {}) };
    if (state.auth.accessToken) headers.Authorization = `Bearer ${state.auth.accessToken}`;
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (res.status === 401 && !retried && !path.startsWith('/api/auth/') && state.auth.refreshToken) {
      const ok = await refreshSessionToken();
      if (ok) return api(path, opts, true);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function mergeEntry(a, b) {
    const cur = a || {};
    const next = b || {};
    const curMs = Date.parse(cur.lastPlayed || '') || 0;
    const nextMs = Date.parse(next.lastPlayed || '') || 0;
    const newer = nextMs >= curMs ? next : cur;
    const daysSet = new Set([
      ...(Array.isArray(cur.days) ? cur.days : []),
      ...(Array.isArray(next.days) ? next.days : []),
    ]);
    return {
      ...cur,
      ...next,
      id: next.id || cur.id || '',
      title: newer.title || cur.title || next.title || '',
      artist: newer.artist || cur.artist || next.artist || '',
      thumbnail: next.thumbnail || cur.thumbnail || '',
      duration: Number(next.duration) || Number(cur.duration) || 0,
      query: next.query || cur.query || `${newer.artist || ''} ${newer.title || ''}`.trim(),
      playCount: Math.max(Number(cur.playCount ?? cur.count) || 0, Number(next.playCount ?? next.count) || 0),
      totalSeconds: Math.max(Number(cur.totalSeconds) || 0, Number(next.totalSeconds) || 0),
      lastPlayed: nextMs >= curMs ? (next.lastPlayed || cur.lastPlayed || '') : (cur.lastPlayed || next.lastPlayed || ''),
      days: [...daysSet],
    };
  }

  function sanitizeDailyLog(rawLog) {
    if (!rawLog || typeof rawLog !== 'object' || Array.isArray(rawLog)) return {};
    const out = {};
    Object.entries(rawLog)
      .filter(([dk]) => /^\d{4}-\d{2}-\d{2}$/.test(dk))
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 90)
      .forEach(([dk, sec]) => {
        const val = Math.max(0, Math.floor(Number(sec) || 0));
        if (val > 0) out[dk] = val;
      });
    return out;
  }

  function sanitizePlaylistMeta(rawMeta) {
    if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) return {};
    const out = {};
    Object.entries(rawMeta)
      .slice(0, 80)
      .forEach(([pid, m]) => {
        if (!m || typeof m !== 'object') return;
        const desc = String(m.description || '').trim().slice(0, 400);
        const cov = String(m.customCover || '').trim();
        const safeCov = /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(cov) && cov.length <= 48000 ? cov : '';
        const order = Number.isFinite(Number(m.order)) ? Number(m.order) : undefined;
        out[String(pid)] = {
          ...(desc ? { description: desc } : {}),
          ...(safeCov ? { customCover: safeCov } : {}),
          ...(order !== undefined ? { order } : {}),
        };
      });
    return out;
  }

  function sanitizeHourLog(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.entries(raw).forEach(([h, sec]) => {
      const hr = Number(h);
      const val = Math.floor(Number(sec) || 0);
      if (Number.isInteger(hr) && hr >= 0 && hr <= 23 && val > 0) {
        out[String(hr)] = Math.min(val, 86400 * 365);
      }
    });
    return out;
  }

  function normalizeTrackAnalytics(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const source = raw.tracks && typeof raw.tracks === 'object' && !Array.isArray(raw.tracks) ? raw.tracks : raw;
    const out = {};
    Object.entries(source).forEach(([k, val]) => {
      if (k === '__dailyLog') {
        out.__dailyLog = sanitizeDailyLog(val);
        return;
      }
      if (k === '__hourLog') {
        out.__hourLog = sanitizeHourLog(val);
        return;
      }
      if (k === '__meta' && val && typeof val === 'object') {
        out.__meta = { dailyGoalMinutes: Math.max(10, Math.min(300, Number(val.dailyGoalMinutes) || 30)) };
        return;
      }
      if (k === '__playlistMeta') {
        out.__playlistMeta = sanitizePlaylistMeta(val);
        return;
      }
      if (!val || typeof val !== 'object' || !val.title) return;
      const key = analyticsKey(val);
      if (!key) return;
      out[key] = out[key] ? mergeEntry(out[key], val) : mergeEntry(null, val);
    });
    return out;
  }

  function mergeTrackAnalytics(localMap, cloudMap) {
    const normLocal = normalizeTrackAnalytics(localMap);
    const normCloud = normalizeTrackAnalytics(cloudMap);
    const merged = { ...normLocal };
    Object.entries(normCloud).forEach(([k, val]) => {
      if (k === '__dailyLog') {
        const nextLog = { ...(merged.__dailyLog || {}) };
        Object.entries(val || {}).forEach(([dk, sec]) => {
          nextLog[dk] = Math.max(Number(nextLog[dk]) || 0, Number(sec) || 0);
        });
        merged.__dailyLog = sanitizeDailyLog(nextLog);
        return;
      }
      if (k === '__hourLog') {
        const nextHours = { ...(merged.__hourLog || {}) };
        Object.entries(val || {}).forEach(([hk, sec]) => {
          nextHours[hk] = Math.max(Number(nextHours[hk]) || 0, Number(sec) || 0);
        });
        merged.__hourLog = sanitizeHourLog(nextHours);
        return;
      }
      if (k === '__meta') {
        merged.__meta = val || merged.__meta;
        return;
      }
      if (k === '__playlistMeta') {
        merged.__playlistMeta = { ...(merged.__playlistMeta || {}), ...(val || {}) };
        return;
      }
      merged[k] = merged[k] ? mergeEntry(merged[k], val) : val;
    });
    return merged;
  }

  function hasHigherStatsThan(a, b) {
    const aNorm = normalizeTrackAnalytics(a);
    const bNorm = normalizeTrackAnalytics(b);
    for (const [k, v] of Object.entries(aNorm)) {
      if (k.startsWith('__')) continue;
      const bv = bNorm[k];
      if (!bv) {
        if ((Number(v.playCount) || 0) > 0 || (Number(v.totalSeconds) || 0) > 0) return true;
      } else if ((Number(v.playCount) || 0) > (Number(bv.playCount) || 0) ||
        (Number(v.totalSeconds) || 0) > (Number(bv.totalSeconds) || 0)) {
        return true;
      }
    }
    return false;
  }

  function rebuildRecentFromAnalytics() {
    const fromStats = Object.entries(state.listeningStats || {})
      .filter(([k, t]) => !k.startsWith('__') && t && t.title && t.lastPlayed)
      .map(([, t]) => t)
      .sort((a, b) => (Date.parse(b.lastPlayed || '') || 0) - (Date.parse(a.lastPlayed || '') || 0))
      .slice(0, 14)
      .map((e) => ({
        title: e.title,
        artist: e.artist || '',
        thumbnail: e.thumbnail || '',
        duration: Number(e.duration) || 0,
        id: e.id || '',
        query: e.query || `${e.artist || ''} ${e.title}`.trim(),
      }));
    state.recentTracks = fromStats;
  }

  function syncPlaylistMetaIntoStats() {
    if (!state.listeningStats || typeof state.listeningStats !== 'object') state.listeningStats = {};
    const pm = {};
    (state.playlists || []).slice(0, 80).forEach((pl, idx) => {
      if (!pl || !pl.id) return;
      const cov = String(pl.cover || '').trim();
      const customCover = /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(cov) && cov.length <= 48000 ? cov : '';
      const desc = String(pl.description || '').trim().slice(0, 400);
      pm[String(pl.id)] = {
        ...(desc ? { description: desc } : {}),
        ...(customCover ? { customCover } : {}),
        order: idx,
      };
    });
    state.listeningStats.__playlistMeta = pm;
  }

  function applyPlaylistMetaToList(playlists, statsObj) {
    const pm = statsObj && typeof statsObj.__playlistMeta === 'object' ? statsObj.__playlistMeta : {};
    const mapped = (Array.isArray(playlists) ? playlists : []).map((pl) => {
      const m = pm[String(pl.id)] || {};
      return {
        ...pl,
        description: m.description || pl.description || '',
        cover: m.customCover || pl.cover || pl.cover_url || '',
        tracks: Array.isArray(pl.tracks) ? pl.tracks : [],
      };
    });
    mapped.sort((a, b) => {
      const oa = pm[String(a.id)]?.order;
      const ob = pm[String(b.id)]?.order;
      if (Number.isFinite(oa) && Number.isFinite(ob)) return oa - ob;
      if (Number.isFinite(oa)) return -1;
      if (Number.isFinite(ob)) return 1;
      return 0;
    });
    return mapped;
  }

  function loadLocalData() {
    const readScoped = (baseKey, fallback) => {
      try {
        const scoped = localStorage.getItem(accountKey(baseKey));
        if (scoped !== null) return JSON.parse(scoped);
        const legacy = localStorage.getItem(baseKey);
        if (legacy !== null) return JSON.parse(legacy);
      } catch {}
      return fallback;
    };
    const pl = readScoped('sunify_playlists', []);
    state.listeningStats = normalizeTrackAnalytics(readScoped('sunify_listening_stats', {}));
    state.playlists = applyPlaylistMetaToList(Array.isArray(pl) ? pl : [], state.listeningStats);
    const liked = readScoped('sunify_liked', []);
    state.likedTracks = Array.isArray(liked) ? liked : [];
    const rec = readScoped('sunify_recent_tracks', []);
    state.recentTracks = Array.isArray(rec) ? rec : [];
    rebuildRecentFromAnalytics();
  }

  let localSaveTimer = null;
  function flushLocalStorageNow() {
    if (localSaveTimer) {
      clearTimeout(localSaveTimer);
      localSaveTimer = null;
    }
    try {
      localStorage.setItem(accountKey('sunify_playlists'), JSON.stringify(state.playlists));
      localStorage.setItem(accountKey('sunify_liked'), JSON.stringify(state.likedTracks));
      localStorage.setItem(accountKey('sunify_listening_stats'), JSON.stringify(state.listeningStats));
      localStorage.setItem(accountKey('sunify_recent_tracks'), JSON.stringify(state.recentTracks.slice(0, 14)));
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && localSaveTimer) flushLocalStorageNow();
  });
  window.addEventListener('pagehide', () => {
    if (localSaveTimer) flushLocalStorageNow();
  });

  function saveLocalData(pushCloud = true, includeStructure = true) {
    if (includeStructure) syncPlaylistMetaIntoStats();
    if (localSaveTimer) clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(flushLocalStorageNow, 250);
    if (includeStructure) state.pendingStructEdit = true;
    if (pushCloud && state.auth.accessToken && state.cloudReady) scheduleCloudPush(includeStructure);
  }

  function compactCloudUrl(url) {
    const s = String(url || '').trim();
    return /^https?:\/\//i.test(s) ? s.slice(0, 1000) : '';
  }

  function compactCloudTrack(t) {
    if (!t || typeof t !== 'object') return null;
    const title = String(t.title || '').trim().slice(0, 300);
    const artist = String(t.artist || '').trim().slice(0, 300);
    return {
      id: String(t.id || '').slice(0, 200),
      title,
      artist,
      thumbnail: compactCloudUrl(t.thumbnail),
      duration: Number(t.duration) || 0,
      query: String(t.query || `${artist} ${title}`.trim()).slice(0, 400),
    };
  }

  function compactCloudPlaylists(list) {
    return (Array.isArray(list) ? list : [])
      .filter((pl) => pl && typeof pl === 'object')
      .map((pl) => {
        const parsedDate = pl.created_at ? new Date(pl.created_at) : null;
        const validCreatedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : undefined;
        return {
          id: String(pl.id || `pl_${Date.now()}`),
          name: String(pl.name || '').trim().slice(0, 200) || 'Çalma Listesi',
          cover: compactCloudUrl(pl.cover || pl.cover_url),
          tracks: (Array.isArray(pl.tracks) ? pl.tracks : []).map(compactCloudTrack).filter(Boolean),
          ...(validCreatedAt ? { created_at: validCreatedAt } : {}),
        };
      });
  }

  function compactCloudStats(stats) {
    const out = {};
    if (stats?.__dailyLog) out.__dailyLog = sanitizeDailyLog(stats.__dailyLog);
    if (stats?.__hourLog) out.__hourLog = sanitizeHourLog(stats.__hourLog);
    if (stats?.__meta) out.__meta = stats.__meta;
    if (stats?.__playlistMeta) out.__playlistMeta = sanitizePlaylistMeta(stats.__playlistMeta);
    const entries = Object.entries(stats || {})
      .filter(([k, v]) => !k.startsWith('__') && v && typeof v === 'object' && v.title)
      .sort((a, b) => (Number(b[1].playCount) || 0) - (Number(a[1].playCount) || 0))
      .slice(0, 1500);
    for (const [k, v] of entries) {
      out[k] = {
        id: String(v.id || '').slice(0, 200),
        title: String(v.title || '').slice(0, 300),
        artist: String(v.artist || '').slice(0, 300),
        thumbnail: compactCloudUrl(v.thumbnail),
        duration: Number(v.duration) || 0,
        query: String(v.query || '').slice(0, 400),
        playCount: Number(v.playCount) || 0,
        totalSeconds: Number(v.totalSeconds) || 0,
        lastPlayed: String(v.lastPlayed || ''),
        days: Array.isArray(v.days) ? v.days.slice(-7) : [],
      };
    }
    return out;
  }

  async function pushCloudDataSafe(includeStructure = true) {
    if (!state.auth.accessToken || !state.cloudReady) return false;
    if (includeStructure) syncPlaylistMetaIntoStats();
    let targetPlaylists = state.playlists;
    let targetLiked = state.likedTracks;
    try {
      if (Date.now() - state.lastCloudPullAt > 15000 || !includeStructure) {
        const latest = await api('/api/sync/pull');
        state.lastCloudPullAt = Date.now();
        const cloudStats = latest.analytics?.listening_stats ?? latest.listeningStats;
        state.listeningStats = mergeTrackAnalytics(state.listeningStats, cloudStats);
        if (!includeStructure && !state.pendingStructEdit) {
          if (Array.isArray(latest.playlists)) {
            targetPlaylists = applyPlaylistMetaToList(latest.playlists, state.listeningStats);
            state.playlists = targetPlaylists;
          }
          const cloudLiked = latest.analytics?.liked_tracks ?? latest.likedTracks;
          if (Array.isArray(cloudLiked)) {
            targetLiked = cloudLiked;
            state.likedTracks = targetLiked;
          }
        }
      }
      await api('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({
          playlists: compactCloudPlaylists(targetPlaylists),
          likedTracks: (Array.isArray(targetLiked) ? targetLiked : []).map(compactCloudTrack).filter(Boolean),
          listeningStats: compactCloudStats(state.listeningStats),
        }),
      });
      state.pendingStructEdit = false;
      state.lastSyncedAt = Date.now();
      saveLocalData(false, false);
      renderAccountSyncTime();
      return true;
    } catch {
      return false;
    }
  }

  function scheduleCloudPush(includeStructure = true) {
    if (includeStructure) state.syncIncludeStructure = true;
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(async () => {
      const inc = state.syncIncludeStructure;
      state.syncIncludeStructure = false;
      await pushCloudDataSafe(inc);
    }, 900);
  }

  async function pullCloudData(showMsg = false, opts = { mergeLocal: true }) {
    if (!state.auth.accessToken) return false;
    try {
      const data = await api('/api/sync/pull');
      state.lastCloudPullAt = Date.now();
      const cloudPlaylists = Array.isArray(data.playlists)
        ? data.playlists.map((p) => ({
            ...p,
            cover: p.cover || p.cover_url || '',
            tracks: Array.isArray(p.tracks) ? p.tracks : [],
          }))
        : [];
      const cloudLiked = data.analytics?.liked_tracks ?? data.likedTracks;
      const cloudStats = data.analytics?.listening_stats ?? data.listeningStats;
      const normCloudStats = normalizeTrackAnalytics(cloudStats);

      const needPushStats = opts.mergeLocal && hasHigherStatsThan(state.listeningStats, normCloudStats);
      state.listeningStats = opts.mergeLocal ? mergeTrackAnalytics(state.listeningStats, normCloudStats) : normCloudStats;

      if (!state.pendingStructEdit) {
        state.playlists = applyPlaylistMetaToList(cloudPlaylists, state.listeningStats);
        if (Array.isArray(cloudLiked)) state.likedTracks = cloudLiked;
      }

      rebuildRecentFromAnalytics();
      state.cloudReady = true;
      state.lastSyncedAt = Date.now();
      saveLocalData(false, false);
      renderAll();
      renderAccountSyncTime();
      loadRecommendations(false);
      startMobileRealtimeConnect();

      if (needPushStats) {
        scheduleCloudPush(false);
      }
      if (showMsg) showToast('Veriler PC ile eşitlendi.');
      return true;
    } catch (e) {
      if (showMsg) showToast(e.message || 'Eşitleme başarısız.');
      return false;
    }
  }

  async function syncNow() {
    if (!state.auth.accessToken) return showToast('Önce giriş yapın.');
    showToast('Eşitleniyor...');
    try {
      await pullCloudData(false, { mergeLocal: true });
      const pushed = await pushCloudDataSafe(true);
      if (!pushed) throw new Error('Buluta gönderilemedi.');
      await pullCloudData(false, { mergeLocal: true });
      showToast('Veriler PC ile eşitlendi.');
    } catch (e) {
      showToast(e.message || 'Eşitleme başarısız.');
    }
  }

  async function initAuth() {
    const token = getSecure('sunify_auth_token');
    const refresh = getSecure('sunify_refresh_token');
    state.auth.accessToken = token;
    state.auth.refreshToken = refresh;
    if (!token) {
      renderAccountUI();
      return;
    }
    try {
      const res = await api('/api/auth/session', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refresh }),
      });
      const sess = res.session && typeof res.session === 'object' ? res.session : res;
      if (sess.access_token) {
        state.auth.accessToken = sess.access_token;
        setSecure('sunify_auth_token', sess.access_token);
      }
      if (sess.refresh_token) {
        state.auth.refreshToken = sess.refresh_token;
        setSecure('sunify_refresh_token', sess.refresh_token);
      }
      const savedEmail = localStorage.getItem('sunify_user_email') || '';
      state.auth.user = res.user || sess.user || (savedEmail ? { email: savedEmail } : { email: 'Sunify Hesabı' });
      if (state.auth.user?.id) localStorage.setItem('sunify_last_uid', state.auth.user.id);
      if (state.auth.user?.email) localStorage.setItem('sunify_user_email', state.auth.user.email);
      loadLocalData();
      renderAll();
      renderAccountUI();
      await pullCloudData(false, { mergeLocal: true });
    } catch {
      state.auth.user = null;
      renderAccountUI();
    }
  }

  function hexToRgb(hex) {
    const clean = String(hex || '').replace('#', '').trim();
    if (clean.length === 3) {
      const r = parseInt(clean[0] + clean[0], 16);
      const g = parseInt(clean[1] + clean[1], 16);
      const b = parseInt(clean[2] + clean[2], 16);
      return Number.isFinite(r + g + b) ? `${r}, ${g}, ${b}` : '181, 122, 255';
    }
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return Number.isFinite(r + g + b) ? `${r}, ${g}, ${b}` : '181, 122, 255';
    }
    return '181, 122, 255';
  }

  function applyAccentVars(hex, rgb, coverUrl = '') {
    const safeHex = hex || '#b57aff';
    const safeRgb = rgb || hexToRgb(safeHex);
    state.currentCoverRgb = safeRgb;
    const root = document.documentElement;
    root.style.setProperty('--accent', safeHex);
    root.style.setProperty('--cover-rgb', safeRgb);
    root.style.setProperty('--cover-glow', `rgba(${safeRgb}, 0.38)`);
    const backdrop = $('npBackdrop');
    if (backdrop) {
      if (coverUrl && coverUrl !== FALLBACK_ART) {
        backdrop.style.backgroundImage = `url("${coverUrl.replace(/"/g, '%22')}")`;
        backdrop.style.opacity = '0.84';
      } else {
        backdrop.style.backgroundImage = 'none';
        backdrop.style.opacity = '0';
      }
    }
    if (state.currentTrack) updateNotification();
  }

  async function applyCoverAdaptiveColor(coverUrl) {
    const url = String(coverUrl || '').trim();
    if (state.accent !== 'auto') {
      const preset = state.accent || '#b57aff';
      applyAccentVars(preset, hexToRgb(preset), url);
      return;
    }

    const seq = ++state.colorExtractSeq;
    if (!url || url === FALLBACK_ART) {
      applyAccentVars('#b57aff', '181, 122, 255', '');
      return;
    }

    const backdrop = $('npBackdrop');
    if (backdrop) {
      backdrop.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
      backdrop.style.opacity = '0.84';
    }

    const cached = state.coverColorCache[url];
    if (cached) {
      applyAccentVars(cached.hex, cached.rgb, url);
      return;
    }

    try {
      const data = await api(`/api/extract-color?url=${encodeURIComponent(url)}`);
      if (seq !== state.colorExtractSeq || state.accent !== 'auto') return;
      const rgb = String(data?.rgb || '181, 122, 255');
      const hex = String(data?.hex || '#b57aff');
      state.coverColorCache[url] = { rgb, hex };
      applyAccentVars(hex, rgb, url);
    } catch {
      if (seq === state.colorExtractSeq && state.accent === 'auto') {
        applyAccentVars('#b57aff', '181, 122, 255', url);
      }
    }
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    document.body.setAttribute('data-theme', state.theme);
    localStorage.setItem('sunify_theme', state.theme);
    localStorage.setItem('sunify_accent_mode', state.accent);
    document.querySelectorAll('#themeSegmented button').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeVal === state.theme);
    });
    document.querySelectorAll('#accentDots button').forEach((b) => {
      b.classList.toggle('active', b.dataset.accent === state.accent);
    });
    applyCoverAdaptiveColor(state.currentTrack?.thumbnail || '').catch(() => {});
  }

  function switchTab(tab) {
    if (['home', 'search', 'library', 'settings'].includes(tab)) state.prevTab = tab;
    document.querySelectorAll('.m-view').forEach((v) => v.classList.remove('active'));
    const viewId =
      tab === 'home'
        ? 'viewHome'
        : tab === 'search'
          ? 'viewSearch'
          : tab === 'library'
            ? 'viewLibrary'
            : tab === 'settings'
              ? 'viewSettings'
              : tab === 'detail'
                ? 'viewDetail'
                : 'viewArtist';
    $(viewId)?.classList.add('active');
    document.querySelectorAll('.m-dock-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === (['detail', 'artist'].includes(tab) ? state.prevTab : tab));
    });
    if (tab === 'settings') refreshStorageStats();
    $('mMain').scrollTop = 0;
  }

  function updateNotification() {
    try {
      if (!bridge?.updatePlaybackNotification || !state.currentTrack) return;
      state.lastNotifPushAt = Date.now();
      const durSec = Number(audio.duration) || Number(state.currentTrack.duration) || 0;
      const posSec = Number(audio.currentTime) || 0;
      bridge.updatePlaybackNotification(
        JSON.stringify({
          title: state.currentTrack.title || 'Sunify',
          artist: state.currentTrack.artist || '',
          thumbnail: state.currentTrack.thumbnail || '',
          isPlaying: state.isPlaying,
          durationMs: durSec > 0 ? Math.round(durSec * 1000) : 0,
          positionMs: posSec > 0 ? Math.round(posSec * 1000) : 0,
          liked: isLiked(state.currentTrack),
          coverRgb: state.currentCoverRgb || '181, 122, 255',
        })
      );
    } catch {}
  }

  function updatePlayerUI() {
    const t = state.currentTrack;
    const art = t?.thumbnail || FALLBACK_ART;
    $('miniCover').src = art;
    $('miniTitle').textContent = t?.title || 'Müzik Çalınmıyor';
    $('miniArtist').textContent = t?.artist || 'Sunify';
    $('npCover').src = art;
    $('npTitle').textContent = t?.title || 'Müzik Çalınmıyor';
    $('npArtist').textContent = t?.artist || 'Sunify';

    const playIcon = state.isPlaying ? 'fa-pause' : 'fa-play';
    $('miniPlayBtn').innerHTML = `<i class="fa-solid ${playIcon}"></i>`;
    $('npPlayBtn').innerHTML = `<i class="fa-solid ${playIcon}"></i>`;

    const liked = isLiked(t);
    $('miniLikeBtn').classList.toggle('liked', liked);
    $('miniLikeBtn').innerHTML = `<i class="${liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i>`;
    $('npLikeBtn').classList.toggle('liked', liked);
    $('npLikeBtn').innerHTML = `<i class="${liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i>`;
    $('npShuffleBtn').classList.toggle('active', state.shuffle);
    $('npRepeatBtn').classList.toggle('active', state.repeat);
    updateNotification();
  }

  function flushListenDuration(forcePush = false) {
    const added = Math.floor(state.listenTimeAccumSec || 0);
    if (added <= 0 || !state.currentTrack?.title) return;
    state.listenTimeAccumSec -= added;
    window.SunifyCards?.recordDailySeconds(state.listeningStats, added);
    if (!state.listeningStats.__hourLog || typeof state.listeningStats.__hourLog !== 'object') {
      state.listeningStats.__hourLog = {};
    }
    const hrKey = String(new Date().getHours());
    state.listeningStats.__hourLog[hrKey] = (Number(state.listeningStats.__hourLog[hrKey]) || 0) + added;
    const k = analyticsKey(state.currentTrack);
    if (!state.listeningStats[k]) return;
    state.listeningStats[k].totalSeconds = (Number(state.listeningStats[k].totalSeconds) || 0) + added;
    saveLocalData(forcePush, false);
    if ($('viewHome')?.classList.contains('active')) renderHomeStats();
  }

  function ensureStatEntry(track) {
    const k = analyticsKey(track);
    const prev = state.listeningStats[k] || {
      id: track.id || '',
      title: track.title,
      artist: track.artist || '',
      thumbnail: track.thumbnail || '',
      duration: Number(track.duration) || 0,
      query: track.query || `${track.artist || ''} ${track.title}`.trim(),
      playCount: 0,
      totalSeconds: 0,
      days: [],
      lastPlayed: '',
    };
    if (!prev.thumbnail && track.thumbnail) prev.thumbnail = track.thumbnail;
    if (track.id && !prev.id) prev.id = track.id;
    if (!prev.query) prev.query = track.query || `${track.artist || ''} ${track.title}`.trim();
    if (!prev.duration && Number(track.duration) > 0) prev.duration = Number(track.duration);
    return { key: k, entry: prev };
  }

  function trackSongStartEvent(track) {
    if (!track?.title) return;
    const { key, entry } = ensureStatEntry(track);
    entry.lastPlayed = new Date().toISOString();
    state.listeningStats[key] = entry;
    rebuildRecentFromAnalytics();
    saveLocalData(true, false);
    renderContinueRow();
  }

  function trackSongCompletedEvent(track) {
    if (!track?.title) return;
    const { key, entry } = ensureStatEntry(track);
    const dayName = new Date().toLocaleDateString('tr-TR', { weekday: 'long' });
    entry.playCount = (Number(entry.playCount) || 0) + 1;
    entry.lastPlayed = new Date().toISOString();
    if (!Array.isArray(entry.days)) entry.days = [];
    if (!entry.days.includes(dayName)) entry.days.push(dayName);
    state.listeningStats[key] = entry;

    rebuildRecentFromAnalytics();
    saveLocalData(true, false);
    renderHomeStats();
    renderDailyMixes();
    api('/api/discover/play', { method: 'POST', body: JSON.stringify({ track }) })
      .then(() => setTimeout(() => loadDailyChart(), 450))
      .catch(() => {});
  }

  function updateLyricCardBar() {
    const bar = $('npLyricsCardBar');
    const count = $('npLyricsCardCount');
    const box = $('npLyricsBox');
    const btn = $('npLyricsCardModeBtn');
    if (btn) btn.classList.toggle('active', state.lyricsCardMode);
    if (box) box.classList.toggle('sfx-lyrics-selecting', state.lyricsCardMode);
    if (bar) bar.hidden = !state.lyricsCardMode;
    if (count) count.textContent = `1–8 satır seç (${state.lyricsSelectedLines.length}/8)`;
  }

  function readMobileLyricOffsets() {
    try { return JSON.parse(localStorage.getItem('sunify_mobile_lyric_offsets') || '{}') || {}; } catch { return {}; }
  }
  function mobileLyricOffsetKey(track) {
    return `${String(track?.artist || '').trim().toLowerCase()}|${String(track?.title || '').trim().toLowerCase()}`;
  }
  function hasStoredMobileLyricOffset(track) {
    if (!track || !track.title) return false;
    return Object.prototype.hasOwnProperty.call(readMobileLyricOffsets(), mobileLyricOffsetKey(track));
  }
  function getStoredMobileLyricOffset(track) {
    const val = Number(readMobileLyricOffsets()[mobileLyricOffsetKey(track)]);
    return Number.isFinite(val) ? val : 0;
  }
  function saveMobileLyricOffset(track, value, remove = false) {
    if (!track || !track.title) return;
    const map = readMobileLyricOffsets();
    const k = mobileLyricOffsetKey(track);
    if (remove) delete map[k];
    else map[k] = Math.max(-45, Math.min(45, Math.round((Number(value) || 0) * 10) / 10));
    const keys = Object.keys(map);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((old) => delete map[old]);
    try { localStorage.setItem('sunify_mobile_lyric_offsets', JSON.stringify(map)); } catch {}
  }

  function setMobileLyricsAlignMode(enabled) {
    state.lyricsAlignMode = Boolean(enabled);
    $('npLyricsAlignBtn')?.classList.toggle('active', state.lyricsAlignMode);
    $('npLyricsBox')?.classList.toggle('lyrics-aligning', state.lyricsAlignMode);
    if ($('npLyricsAlignBar')) $('npLyricsAlignBar').hidden = !state.lyricsAlignMode;
  }

  function syncMobileLyricsDom(cur, forceScroll = false) {
    if (!state.lyrics.length || !state.lyricDomRows.length) return;
    const effectiveTime = (Number(cur) || 0) + state.lyricsOffset;
    let low = 0;
    let high = state.lyrics.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (effectiveTime >= state.lyrics[mid].time) low = mid + 1;
      else high = mid;
    }
    const activeIdx = low - 1;
    const prevIdx = state.lastLyricIdx;

    if (activeIdx !== prevIdx || forceScroll) {
      const start = Math.max(0, Math.min(prevIdx < 0 ? 0 : prevIdx, activeIdx < 0 ? 0 : activeIdx));
      const end = forceScroll
        ? state.lyricDomRows.length - 1
        : Math.min(state.lyricDomRows.length - 1, Math.max(prevIdx, activeIdx));
      for (let i = start; i <= end; i += 1) {
        const row = state.lyricDomRows[i];
        if (!row) continue;
        row.el.classList.toggle('active', i === activeIdx);
        row.el.classList.toggle('passed', activeIdx >= 0 && i < activeIdx);
        if (i !== activeIdx && row.words.length) {
          for (let wi = 0; wi < row.words.length; wi += 1) {
            row.words[wi].classList.remove('spoken');
          }
        }
      }
      state.lastLyricIdx = activeIdx;
      if (activeIdx >= 0) {
        state.lyricDomRows[activeIdx]?.el?.scrollIntoView({ behavior: forceScroll ? 'auto' : 'smooth', block: 'center' });
      }
    }

    if (activeIdx >= 0) {
      const row = state.lyricDomRows[activeIdx];
      const lineWords = state.lyrics[activeIdx]?.words || [];
      if (row && row.words.length) {
        for (let wi = 0; wi < row.words.length; wi += 1) {
          const w = lineWords[wi];
          row.words[wi].classList.toggle('spoken', Boolean(w && effectiveTime >= w.startTime));
        }
      }
    }
  }

  function updateMobileOffsetUi(opts = {}) {
    state.lyricsOffset = Math.max(-45, Math.min(45, Math.round((Number(state.lyricsOffset) || 0) * 10) / 10));
    const valEl = $('npLyricsOffsetVal');
    if (valEl) {
      const fmt = `${state.lyricsOffset >= 0 ? '+' : ''}${state.lyricsOffset.toFixed(1)}s`;
      valEl.textContent = state.lyricsOffsetIsAuto && Math.abs(state.lyricsOffset) >= 0.1 ? `Oto ${fmt}` : fmt;
    }
    if (opts.clearManual) saveMobileLyricOffset(state.currentTrack, 0, true);
    else if (opts.persistManual) saveMobileLyricOffset(state.currentTrack, state.lyricsOffset, false);
    if ($('nowPlayingModal')?.classList.contains('open') && $('npLyricsPanel')?.classList.contains('active')) {
      syncMobileLyricsDom(audio.currentTime || 0, true);
    }
  }

  async function runMobileAutoLyricsSync() {
    if (!state.autoLyricsSync || !state.lyrics.length || !state.currentTrack) return;
    if (hasStoredMobileLyricOffset(state.currentTrack)) return;

    const actualDuration = Number(audio.duration) || Number(state.currentTrack.duration) || 0;
    const firstLyricTime = Number(state.lyrics[0]?.time) || 0;
    const lastLyricTime = Number(state.lyrics[state.lyrics.length - 1]?.time) || 0;
    const videoId = String(state.currentTrack.id || '');
    const key = `${mobileLyricOffsetKey(state.currentTrack)}|${videoId}|${Math.round(actualDuration)}|${Math.round(state.lyricsDuration)}`;
    if (key === state.lastAutoSyncKey) return;
    state.lastAutoSyncKey = key;

    const snapKey = mobileLyricOffsetKey(state.currentTrack);
    try {
      const qs = new URLSearchParams({
        videoId,
        actualDuration: String(actualDuration || 0),
        lyricsDuration: String(state.lyricsDuration || 0),
        firstLyricTime: String(firstLyricTime),
        lastLyricTime: String(lastLyricTime),
        audioOnsetSec: '-1',
      });
      const res = await api(`/api/lyrics-sync-offset?${qs.toString()}`);
      if (!state.currentTrack || mobileLyricOffsetKey(state.currentTrack) !== snapKey) return;
      if (hasStoredMobileLyricOffset(state.currentTrack) || !state.autoLyricsSync) return;
      // Mobil formül: effectiveTime = cur + state.lyricsOffset -> canonical gecikmenin ters işareti!
      state.lyricsOffset = Math.round(-(Number(res.offsetSec) || 0) * 10) / 10;
      state.lyricsOffsetIsAuto = true;
      updateMobileOffsetUi({ persistManual: false });
      if (Math.abs(Number(res.offsetSec) || 0) >= 0.8 && res.reason) {
        const badge = $('npLyricsSourceBadge');
        if (badge && !badge.textContent.includes('· Oto')) badge.textContent = `${badge.textContent} · Oto`;
      }
    } catch {}
  }

  function handleLyricLineTap(el, idx) {
    if (state.lyricsAlignMode) {
      if (el.dataset.time !== undefined) {
        state.lyricsOffset = Math.round((Number(el.dataset.time) - (audio.currentTime || 0)) * 10) / 10;
        state.lyricsOffsetIsAuto = false;
        setMobileLyricsAlignMode(false);
        updateMobileOffsetUi({ persistManual: true });
        showToast(`Sözler hizalandı (${state.lyricsOffset >= 0 ? '+' : ''}${state.lyricsOffset.toFixed(1)}s)`);
      }
      return;
    }
    if (state.lyricsCardMode) {
      const pos = state.lyricsSelectedLines.indexOf(idx);
      if (pos >= 0) {
        state.lyricsSelectedLines.splice(pos, 1);
        el.classList.remove('sfx-lyric-selected');
      } else {
        if (state.lyricsSelectedLines.length >= 8) {
          showToast('En fazla 8 satır seçebilirsiniz.');
          return;
        }
        state.lyricsSelectedLines.push(idx);
        state.lyricsSelectedLines.sort((a, b) => a - b);
        el.classList.add('sfx-lyric-selected');
      }
      updateLyricCardBar();
      return;
    }
    if (el.dataset.time !== undefined) {
      const tm = Math.max(0, Number(el.dataset.time) - state.lyricsOffset);
      if (Number.isFinite(tm)) audio.currentTime = tm;
    }
  }

  function applyMobileTranslationsToDom() {
    const box = $('npLyricsBox');
    if (!box) return;
    box.querySelectorAll('.sfx-lyric-tr').forEach((n) => n.remove());
    if (!state.lyricsTranslated || !state.lyricsTranslations.length) return;
    box.querySelectorAll('.m-lyric-line').forEach((el, idx) => {
      const tr = String(state.lyricsTranslations[idx] || '').trim();
      if (!tr) return;
      const span = document.createElement('span');
      span.className = 'sfx-lyric-tr';
      span.textContent = tr;
      el.appendChild(span);
    });
  }

  async function toggleMobileLyricsTranslate() {
    const box = $('npLyricsBox');
    const btn = $('npLyricsTranslateBtn');
    if (!box) return;
    if (state.lyricsTranslated) {
      state.lyricsTranslated = false;
      btn?.classList.remove('active');
      applyMobileTranslationsToDom();
      return;
    }
    const lineEls = Array.from(box.querySelectorAll('.m-lyric-line'));
    if (!lineEls.length) return showToast('Çevrilecek şarkı sözü yok.');
    const lines = lineEls.map((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.sfx-lyric-tr').forEach((n) => n.remove());
      return String(clone.textContent || '').trim();
    });
    if (state.lyricsTranslations.length === lines.length) {
      state.lyricsTranslated = true;
      btn?.classList.add('active');
      applyMobileTranslationsToDom();
      return;
    }
    if (btn) btn.textContent = '...';
    try {
      const data = await api('/api/translate-lyrics', {
        method: 'POST',
        body: JSON.stringify({ lines, targetLang: 'tr' }),
      });
      state.lyricsTranslations = Array.isArray(data?.translations) ? data.translations : [];
      state.lyricsTranslated = true;
      btn?.classList.add('active');
      applyMobileTranslationsToDom();
    } catch {
      showToast('Çeviri alınamadı.');
    } finally {
      if (btn) btn.textContent = 'TR';
    }
  }

  async function loadLyricsFor(track, sourceOverride = null) {
    if (!track) return;
    const box = $('npLyricsBox');
    const badge = $('npLyricsSourceBadge');
    const source = sourceOverride || state.lyricsSource || 'auto';
    state.lyrics = [];
    state.lyricDomRows = [];
    state.lastLyricIdx = -1;
    state.lyricsDuration = 0;
    state.lastAutoSyncKey = '';
    setMobileLyricsAlignMode(false);
    const hasManual = hasStoredMobileLyricOffset(track);
    state.lyricsOffset = hasManual ? getStoredMobileLyricOffset(track) : 0;
    state.lyricsOffsetIsAuto = false;
    updateMobileOffsetUi({ persistManual: false });
    state.lyricsTranslated = false;
    state.lyricsTranslations = [];
    state.lyricsCardMode = false;
    state.lyricsSelectedLines = [];
    $('npLyricsTranslateBtn')?.classList.remove('active');
    updateLyricCardBar();
    badge.textContent = 'Aranıyor...';
    box.innerHTML = '<div class="m-empty-card">Şarkı sözleri aranıyor...</div>';
    try {
      const dur = Number(audio.duration) || Number(track.duration) || 0;
      state.lyricsFetchedDuration = dur;
      const qs = new URLSearchParams({
        title: track.title || '',
        artist: track.artist || '',
        duration: String(dur),
        source,
      });
      const data = await api(`/api/lyrics?${qs.toString()}`);
      if (!state.currentTrack || trackKey(state.currentTrack) !== trackKey(track)) return;
      state.lyricsDuration = Number(data.lyricsDuration) || 0;
      const rawLyrics = String(data.lyrics || '').trim();
      badge.textContent = data.source || 'Bulunamadı';
      if (!rawLyrics) {
        box.innerHTML = '<div class="m-empty-card">Bu şarkı için söz bulunamadı. Yukarıdan farklı bir kaynak seçebilirsiniz.</div>';
        return;
      }

      const hasTimestamps = Boolean(data.synced) || /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(rawLyrics);
      if (hasTimestamps && window.SunifyLyricsTiming?.parseLRCWithWordTiming) {
        const parsed = window.SunifyLyricsTiming.parseLRCWithWordTiming(rawLyrics, dur);
        if (parsed.length) {
          state.lyrics = parsed;
          box.innerHTML = parsed
            .map((line, i) => {
              const wordsHtml = (line.words || [])
                .map((w, wi) => `<span class="m-lyric-word" data-wi="${wi}">${escapeHtml(w.word)}</span>`)
                .join(' ');
              return `<div class="m-lyric-line" data-idx="${i}" data-time="${line.time}">${wordsHtml || escapeHtml(line.text)}</div>`;
            })
            .join('');
          state.lyricDomRows = Array.from(box.querySelectorAll('.m-lyric-line')).map((el, idx) => {
            el.onclick = () => handleLyricLineTap(el, idx);
            return { el, words: Array.from(el.querySelectorAll('.m-lyric-word')) };
          });
          syncMobileLyricsDom(audio.currentTime || 0, true);
          runMobileAutoLyricsSync();
          return;
        }
      }

      box.innerHTML = rawLyrics
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l, i) => `<div class="m-lyric-line active plain-sync" data-idx="${i}">${escapeHtml(l)}</div>`)
        .join('');
      box.querySelectorAll('.m-lyric-line').forEach((el, idx) => {
        el.onclick = () => handleLyricLineTap(el, idx);
      });
    } catch {
      badge.textContent = 'Hata';
      box.innerHTML = '<div class="m-empty-card">Şarkı sözleri yüklenemedi.</div>';
    }
  }

  async function playTrack(track, queueList = null, index = 0, options = {}) {
    if (!track) return;
    flushListenDuration(false);
    state.listenTimeAccumSec = 0;
    state.lastTimeUpdateMs = 0;
    state.lyricsDurationRefetched = false;
    state.lyricsFetchedDuration = 0;
    if (Array.isArray(queueList) && queueList.length) {
      state.queue = queueList.slice();
      state.queueIndex = Math.max(0, index);
    } else if (!state.queue.length || trackKey(state.queue[state.queueIndex]) !== trackKey(track)) {
      state.queue = [track];
      state.queueIndex = 0;
    }
    state.currentTrack = track;
    state.isPlaying = options.autoPlay !== false;
    state.listenSession = {
      trackKey: analyticsKey(track),
      track,
      listened: 0,
      lastCur: 0,
      skippedForward: false,
      completed: false,
    };
    state.abLoop = { a: null, b: null };
    updateAbLoopBtn();
    updatePlayerUI();
    applyCoverAdaptiveColor(track?.thumbnail || '').catch(() => {});

    window.SunifyAudioFX?.initIfNeeded?.(audio);
    window.SunifyAudioFX?.resume();

    const streamUrl = track.localUrl
      ? `${API}${track.localUrl}`
      : `${API}/api/audio-stream?${new URLSearchParams({
          id: track.id || '',
          q: `${track.artist || ''} ${track.title || ''}`.trim(),
          title: track.title || '',
          artist: track.artist || '',
        }).toString()}`;

    audio.src = streamUrl;
    window.SunifyAudioFX?.reapplyToAudio();
    window.SunifyAudioFX?.fadeInForNewTrack();
    const startSec = Number(options.startAtSec) > 0 ? Number(options.startAtSec) : 0;
    if (startSec > 0 && !audio.isNative) {
      const applyStart = () => {
        try {
          if (Number.isFinite(audio.duration) && audio.duration > startSec) audio.currentTime = startSec;
        } catch {}
      };
      audio.addEventListener('loadedmetadata', applyStart, { once: true });
    }
    if (options.autoPlay !== false) {
      try {
        await audio.play(startSec);
      } catch {
        showToast('Ses başlatılıyor...');
      }
    } else if (audio.prepareSource) {
      audio.prepareSource(startSec);
    }
    window.SunifyRealtime?.notifyLocalPlaybackChanged();
    trackSongStartEvent(track);
    loadLyricsFor(track);
  }

  function playNext() {
    if (!state.queue.length) return;
    if (state.repeat) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    let nextIdx = state.queueIndex + 1;
    if (state.shuffle && state.queue.length > 1) {
      nextIdx = Math.floor(Math.random() * state.queue.length);
    }
    if (nextIdx >= state.queue.length) nextIdx = 0;
    state.queueIndex = nextIdx;
    playTrack(state.queue[nextIdx], state.queue, nextIdx);
  }

  function playPrev() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      window.SunifyRealtime?.notifyLocalPlaybackChanged();
      updateNotification();
      return;
    }
    if (!state.queue.length) return;
    let prevIdx = state.queueIndex - 1;
    if (prevIdx < 0) prevIdx = state.queue.length - 1;
    state.queueIndex = prevIdx;
    playTrack(state.queue[prevIdx], state.queue, prevIdx);
  }

  function togglePlay() {
    if (!state.currentTrack) return;
    if (audio.paused) {
      window.SunifyAudioFX?.resume();
      audio.play().catch(() => {});
      state.isPlaying = true;
    } else {
      audio.pause();
      state.isPlaying = false;
    }
    updatePlayerUI();
    window.SunifyRealtime?.notifyLocalPlaybackChanged();
  }

  function toggleLike(track) {
    if (!track) return;
    const k = trackKey(track);
    const idx = state.likedTracks.findIndex((x) => trackKey(x) === k);
    if (idx >= 0) {
      state.likedTracks.splice(idx, 1);
      showToast('Beğenilerden kaldırıldı.');
    } else {
      state.likedTracks.unshift(track);
      showToast('Beğenilen şarkılara eklendi.');
    }
    saveLocalData(true);
    updatePlayerUI();
    renderAll();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/\u00a0/g, ' ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function insertPlayNext(track) {
    if (!track) return;
    if (!Array.isArray(state.queue) || !state.queue.length) {
      state.queue = [track];
      state.queueIndex = 0;
    } else {
      const insertAt = Math.min(state.queue.length, Math.max(0, state.queueIndex + 1));
      state.queue.splice(insertAt, 0, track);
    }
    showToast(`“${track.title || 'Şarkı'}” sıradaki çal olarak eklendi.`);
  }

  function renderTrackRows(container, tracks, opts = {}) {
    if (!container) return;
    if (container._batchObserver) {
      try { container._batchObserver.disconnect(); } catch {}
      container._batchObserver = null;
    }
    if (!tracks || !tracks.length) {
      container.innerHTML = `<div class="m-empty-card">${escapeHtml(opts.emptyText || 'Şarkı bulunamadı.')}</div>`;
      return;
    }

    container.innerHTML = '';
    const BATCH_SIZE = 30;
    let renderedCount = 0;

    const bindRow = (row, idx, track) => {
      let sx = 0;
      let sy = 0;
      let swiped = false;
      row.addEventListener('touchstart', (e) => {
        const pt = e.touches && e.touches[0];
        if (!pt) return;
        sx = pt.clientX;
        sy = pt.clientY;
        swiped = false;
      }, { passive: true });
      row.addEventListener('touchmove', (e) => {
        const pt = e.touches && e.touches[0];
        if (!pt || !sx) return;
        const dx = pt.clientX - sx;
        const dy = pt.clientY - sy;
        if (dx > 64 && Math.abs(dy) < 28) row.classList.add('swipe-queue-ready');
        else row.classList.remove('swipe-queue-ready');
      }, { passive: true });
      row.addEventListener('touchend', (e) => {
        const pt = e.changedTouches && e.changedTouches[0];
        row.classList.remove('swipe-queue-ready');
        if (!pt || !sx) return;
        const dx = pt.clientX - sx;
        const dy = pt.clientY - sy;
        sx = 0;
        if (dx > 68 && Math.abs(dy) < 30) {
          swiped = true;
          insertPlayNext(track);
        }
      }, { passive: true });

      row.onclick = (e) => {
        if (swiped) {
          swiped = false;
          return;
        }
        const btn = e.target.closest('button[data-act]');
        if (btn) {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'like') toggleLike(track);
          else if (act === 'move-up' || act === 'move-down') {
            const pl = state.playlists.find((p) => p.id === opts.playlistId);
            if (!pl || !Array.isArray(pl.tracks)) return;
            const targetIdx = act === 'move-up' ? idx - 1 : idx + 1;
            if (targetIdx < 0 || targetIdx >= pl.tracks.length) return;
            const [moved] = pl.tracks.splice(idx, 1);
            pl.tracks.splice(targetIdx, 0, moved);
            saveLocalData(true, true);
            openDetail(pl);
          } else {
            openTrackMenuSheet(track, opts.playlistId);
          }
          return;
        }
        playTrack(track, tracks, idx);
      };
    };

    const appendNextBatch = () => {
      const end = Math.min(tracks.length, renderedCount + BATCH_SIZE);
      if (renderedCount >= end) return;
      const frag = document.createDocumentFragment();
      for (let i = renderedCount; i < end; i += 1) {
        const t = tracks[i];
        const playing = state.currentTrack && trackKey(state.currentTrack) === trackKey(t);
        const liked = isLiked(t);
        const playCount = opts.showPlayCount ? Number(t.playCount || t.play_count) || 0 : 0;
        const subText = playCount > 0
          ? `${t.artist || 'Sanatçı'} · ${playCount} dinleme`
          : (t.artist || 'Sanatçı');
        const reorderHtml = opts.reorderMode && opts.playlistId
          ? '<button class="m-row-btn" data-act="move-up" type="button" aria-label="Yukarı"><i class="fa-solid fa-arrow-up"></i></button><button class="m-row-btn" data-act="move-down" type="button" aria-label="Aşağı"><i class="fa-solid fa-arrow-down"></i></button>'
          : '';
        const row = document.createElement('div');
        row.className = `m-track-row ${playing ? 'playing' : ''}`;
        row.dataset.idx = String(i);
        const rawThumb = resolveTrackThumbRaw(t);
        row.innerHTML = `
          <img class="m-track-thumb" src="${escapeHtml(thumbUrl(rawThumb, 128))}" alt="" loading="lazy" decoding="async" />
          <div class="m-track-meta">
            <div class="m-track-title">${escapeHtml(t.title)}</div>
            <div class="m-track-artist">${escapeHtml(subText)}</div>
          </div>
          <div class="m-track-actions">
            ${reorderHtml}
            <button class="m-row-btn ${liked ? 'liked' : ''}" data-act="like" type="button"><i class="${liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i></button>
            <button class="m-row-btn" data-act="more" type="button"><i class="fa-solid fa-ellipsis-vertical"></i></button>
          </div>`;
        attachCoverFallback(row.querySelector('.m-track-thumb'), t);
        bindRow(row, i, t);
        frag.appendChild(row);
      }
      renderedCount = end;
      const oldSentinel = container.querySelector('.m-list-sentinel');
      if (oldSentinel) container.insertBefore(frag, oldSentinel);
      else container.appendChild(frag);
      if (renderedCount >= tracks.length && oldSentinel) {
        oldSentinel.remove();
        if (container._batchObserver) {
          try { container._batchObserver.disconnect(); } catch {}
          container._batchObserver = null;
        }
      }
    };

    appendNextBatch();
    if (renderedCount < tracks.length && typeof IntersectionObserver !== 'undefined') {
      const sentinel = document.createElement('div');
      sentinel.className = 'm-list-sentinel';
      sentinel.style.height = '1px';
      container.appendChild(sentinel);
      const obs = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) appendNextBatch();
      }, { rootMargin: '260px' });
      obs.observe(sentinel);
      container._batchObserver = obs;
    } else {
      while (renderedCount < tracks.length) appendNextBatch();
    }
  }

  function openTrackMenuSheet(track, playlistId = null) {
    openSheet(track.title || 'Şarkı', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-track-list';
      const actions = [
        { icon: 'fa-forward-step', label: 'Sıradaki Çal (Hemen Sonra)', fn: () => { insertPlayNext(track); closeSheet(); } },
        { icon: 'fa-list-ul', label: 'Çalma Sırasına Ekle', fn: () => { state.queue.push(track); showToast('Sıraya eklendi.'); closeSheet(); } },
        { icon: 'fa-folder-plus', label: 'Çalma Listesine Ekle', fn: () => openAddToPlaylistSheet(track) },
        { icon: 'fa-cloud-arrow-down', label: 'MP3 Olarak İndir (İndirilenler)', fn: () => { saveOffline(track); closeSheet(); } },
        { icon: 'fa-scissors', label: 'MP3 Kes / Zil Sesi Yap', fn: () => openMp3TrimmerSheet(track) },
        { icon: 'fa-qrcode', label: 'QR Kod ile Paylaş', fn: () => openQrShareSheet('track', track) },
      ];
      if (window.SunifyRealtime?.getJamRoom()) {
        actions.splice(1, 0, {
          icon: 'fa-tower-broadcast',
          label: 'Jam Sırasına Ekle',
          fn: () => {
            window.SunifyRealtime.addJamTrack(track);
            showToast('Jam sırasına eklendi.');
            closeSheet();
          },
        });
      }
      if (playlistId) {
        actions.push({
          icon: 'fa-trash-can',
          label: 'Listeden Çıkar',
          fn: () => {
            const pl = state.playlists.find((p) => p.id === playlistId);
            if (pl) {
              pl.tracks = (pl.tracks || []).filter((x) => trackKey(x) !== trackKey(track));
              saveLocalData(true);
              if (state.detailContext?.id === playlistId) openDetail(pl);
            }
            closeSheet();
          },
        });
      }
      wrap.innerHTML = actions
        .map((a, i) => `<button class="m-glass-btn" data-ai="${i}" type="button"><i class="fa-solid ${a.icon}"></i> ${escapeHtml(a.label)}</button>`)
        .join('');
      wrap.querySelectorAll('button').forEach((b) => {
        b.onclick = () => actions[Number(b.dataset.ai)].fn();
      });
      return wrap;
    });
  }

  function openAddToPlaylistSheet(track) {
    openSheet('Çalma Listesine Ekle', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-track-list';
      if (!state.playlists.length) {
        wrap.innerHTML = '<div class="m-empty-card">Henüz çalma listen yok. Kitaplık sekmesinden oluşturabilirsin.</div>';
        return wrap;
      }
      wrap.innerHTML = state.playlists
        .map((pl, i) => `<button class="m-glass-btn" data-pi="${i}" type="button"><i class="fa-solid fa-music"></i> ${escapeHtml(pl.name)}</button>`)
        .join('');
      wrap.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          const pl = state.playlists[Number(b.dataset.pi)];
          if (!pl.tracks) pl.tracks = [];
          if (!pl.tracks.some((x) => trackKey(x) === trackKey(track))) {
            pl.tracks.push(track);
            saveLocalData(true);
            showToast(`${pl.name} listesine eklendi.`);
          } else {
            showToast('Bu şarkı zaten listede.');
          }
          closeSheet();
        };
      });
      return wrap;
    });
  }

  async function saveOffline(track, opts = {}) {
    if (!track) return false;
    if (localStorage.getItem('sunify_wifi_only_dl') === 'true' && bridge?.isWifiConnected && !bridge.isWifiConnected()) {
      if (!opts.silent) showToast("Yalnızca Wi-Fi'da indirme açık.");
      return false;
    }
    if (!opts.silent) showToast('MP3 hazırlanıp indiriliyor...');
    try {
      const res = await api('/api/save-track-locally', {
        method: 'POST',
        body: JSON.stringify({
          id: track.id || '',
          title: track.title || '',
          artist: track.artist || '',
          thumbnail: track.thumbnail || '',
          query: `${track.artist || ''} ${track.title || ''}`.trim(),
        }),
      });
      if (!opts.silent) {
        showToast(res?.displayPath ? `${res.displayPath} konumuna MP3 kaydedildi.` : 'İndirilenler/Sunify klasörüne MP3 kaydedildi.');
      }
      if (!opts.skipReload) loadOfflineTracks();
      return true;
    } catch (e) {
      if (!opts.silent) showToast(e.message || 'İndirilemedi.');
      return false;
    }
  }

  async function loadOfflineTracks() {
    try {
      const data = await api('/api/local-downloads');
      state.offlineTracks = Array.isArray(data.tracks) ? data.tracks : [];
    } catch {
      state.offlineTracks = [];
    }
  }

  function getTopListenedTracks(limit = 25) {
    return Object.values(state.listeningStats || {})
      .filter((t) => t && t.title && (Number(t.playCount) || 0) > 0)
      .sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0))
      .slice(0, limit);
  }

  function collectSeeds(limit = 6) {
    const pool = [...getTopListenedTracks(12), ...state.likedTracks.slice(0, 12), ...state.recentTracks.slice(0, 10)];
    const seen = new Set();
    const seeds = [];
    for (const t of pool) {
      if (!t?.title) continue;
      const k = trackKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      seeds.push({ id: t.id || '', title: t.title, artist: t.artist || '' });
      if (seeds.length >= limit) break;
    }
    return seeds;
  }

  function collectKnownArtists(limit = 25) {
    const counts = new Map();
    Object.values(state.listeningStats || {}).forEach((t) => {
      const a = String(t?.artist || '').split(',')[0].trim();
      if (a) counts.set(a, (counts.get(a) || 0) + (Number(t.playCount) || 1));
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name);
  }

  function renderDailyMixes(allowRemoteFetch = true) {
    const topTracks = getTopListenedTracks(25);
    const similarSeeds = collectSeeds(6);
    const topArtists = collectKnownArtists(6);
    const allKnownArtists = collectKnownArtists(25);
    const cacheKey = `${similarSeeds.map((s) => s.title).join('|')}__${topArtists.join('|')}`;
    const cacheFresh = state.dailyMixCache.mixes
      && state.dailyMixCache.key === cacheKey
      && Date.now() - state.dailyMixCache.fetchedAt < 5 * 60 * 1000;

    const mixes = cacheFresh
      ? state.dailyMixCache.mixes.map((m, idx) => (idx === 0
        ? { ...m, tracks: topTracks, sub: `${topTracks.length} şarkı`, cover: topTracks[0]?.thumbnail || FALLBACK_ART }
        : m))
      : [
          { id: 'mix-1', badge: 'MIX 1', title: 'En çok dinlediklerin', sub: `${topTracks.length} şarkı`, tracks: topTracks, cover: topTracks[0]?.thumbnail || FALLBACK_ART },
          { id: 'mix-2', badge: 'MIX 2', title: 'Sana benzer şarkılar', sub: '25 şarkılık Daily Mix', tracks: null, mode: 'similar', seeds: similarSeeds, cover: state.likedTracks[0]?.thumbnail || FALLBACK_ART },
          { id: 'mix-3', badge: 'MIX 3', title: 'Bugün en çok dinlenenler', sub: 'Sunify topluluğu · bugün', tracks: null, daily: true, cover: FALLBACK_ART },
          { id: 'mix-4', badge: 'MIX 4', title: 'Favori sanatçıların', sub: topArtists.slice(0, 2).join(', ') || 'En çok dinlediklerinden', tracks: null, artists: topArtists, cover: topTracks[1]?.thumbnail || FALLBACK_ART },
          { id: 'mix-5', badge: 'MIX 5', title: 'Yeni keşifler', sub: 'Tarzına uygun yeni keşifler', tracks: null, mode: 'discovery', seeds: similarSeeds, excludeArtists: allKnownArtists, cover: FALLBACK_ART },
        ];

    const el = $('homeDailyMixes');
    el.innerHTML = mixes
      .map((m, i) => {
        const displaySub = Array.isArray(m.tracks) && i > 0 && m.tracks.length
          ? `${m.tracks.length} şarkı · ${[...new Set(m.tracks.map((t) => t.artist).filter(Boolean))].slice(0, 3).join(', ') || m.sub}`
          : m.sub;
        const displayCover = (Array.isArray(m.tracks) && m.tracks[0]?.thumbnail) || m.cover;
        return `
        <div class="m-card" data-mi="${i}">
          <div class="m-card-cover-wrap">
            <img id="mixImg_${i}" src="${escapeHtml(displayCover)}" alt="" />
            <span class="m-mix-badge">${m.badge}</span>
          </div>
          <div class="m-card-title">${escapeHtml(m.title)}</div>
          <div class="m-card-sub" id="mixSub_${i}">${escapeHtml(displaySub)}</div>
        </div>`;
      })
      .join('');

    el.querySelectorAll('.m-card').forEach((c) => {
      c.onclick = () => {
        const mix = mixes[Number(c.dataset.mi)];
        if (!mix.tracks?.length) return showToast('Bu mix henüz hazırlanıyor.');
        openDetail({ id: mix.id, name: mix.title, subtitle: `${mix.tracks.length} parça`, cover: mix.tracks[0]?.thumbnail || mix.cover, tracks: mix.tracks, readonly: true });
      };
    });

    if (!allowRemoteFetch || cacheFresh || state.dailyMixCache.loading) return;
    state.dailyMixCache.loading = true;

    (async () => {
      try {
        for (let i = 0; i < mixes.length; i += 1) {
          const m = mixes[i];
          if (Array.isArray(m.tracks)) continue;
          try {
            let data;
            if (m.daily) {
              data = await api('/api/discover/daily-top?limit=25');
              if (!Array.isArray(data?.tracks) || !data.tracks.length) {
                data = await api('/api/discover/top?limit=25');
              }
            } else if (m.artists?.length) {
              data = await api(`/api/daily-mix/artist-tracks?artists=${encodeURIComponent(JSON.stringify(m.artists))}`);
            } else if (m.seeds?.length) {
              const qs = new URLSearchParams({ seeds: JSON.stringify(m.seeds), mode: m.mode || 'similar' });
              if (m.excludeArtists?.length) qs.set('excludeArtists', JSON.stringify(m.excludeArtists));
              data = await api(`/api/recommendations?${qs.toString()}`);
            }
            m.tracks = (data?.tracks || []).slice(0, 25);
            if (m.tracks[0]?.thumbnail && $(`mixImg_${i}`)) $(`mixImg_${i}`).src = m.tracks[0].thumbnail;
            const artists = [...new Set(m.tracks.map((t) => t.artist).filter(Boolean))].slice(0, 3).join(', ');
            if ($(`mixSub_${i}`)) $(`mixSub_${i}`).textContent = m.tracks.length ? `${m.tracks.length} şarkı · ${artists || m.sub}` : 'Henüz yeterli veri yok';
          } catch {
            m.tracks = [];
          }
          await new Promise((r) => setTimeout(r, 350));
        }
        state.dailyMixCache = { key: cacheKey, fetchedAt: Date.now(), mixes, loading: false };
      } finally {
        state.dailyMixCache.loading = false;
      }
    })();
  }

  function renderContinueRow() {
    const el = $('homeContinueRow');
    const items = state.recentTracks.slice(0, 12);
    if (!items.length) {
      el.innerHTML = '<div class="m-empty-card" style="width:100%">Dinlediğin şarkılar burada görünecek.</div>';
      return;
    }
    el.innerHTML = items
      .map(
        (t, i) => `
        <div class="m-card" data-ci="${i}">
          <div class="m-card-cover-wrap">
            <img src="${escapeHtml(t.thumbnail || FALLBACK_ART)}" alt="" />
          </div>
          <div class="m-card-title">${escapeHtml(t.title)}</div>
          <div class="m-card-sub">${escapeHtml(t.artist || '')}</div>
        </div>`
      )
      .join('');
    el.querySelectorAll('.m-card').forEach((c) => {
      c.onclick = () => {
        const idx = Number(c.dataset.ci);
        playTrack(items[idx], items, idx);
      };
    });
  }

  function renderHomeStats() {
    const el = $('homeStatsGrid');
    const rows = Object.values(state.listeningStats || {}).filter((t) => t && (Number(t.playCount) || 0) > 0);
    const totalPlays = rows.reduce((sum, item) => sum + (Number(item.playCount) || 0), 0);
    const totalMinutes = Math.round(rows.reduce((sum, item) => sum + (Number(item.totalSeconds) || 0), 0) / 60);
    const artistMap = new Map();
    rows.forEach((item) => {
      const a = String(item.artist || 'Bilinmeyen').trim() || 'Bilinmeyen';
      artistMap.set(a, (artistMap.get(a) || 0) + (Number(item.playCount) || 0));
    });
    const topArtist = [...artistMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Henüz yok';
    const topTrack = getTopListenedTracks(1)[0]?.title || 'Henüz yok';
    const cards = [
      { val: totalPlays.toLocaleString('tr-TR'), lbl: 'Toplam çalma' },
      { val: `${totalMinutes} dk`, lbl: 'Dinleme süresi' },
      { val: topArtist, lbl: 'En çok dinlenen sanatçı' },
      { val: topTrack, lbl: 'En çok dinlenen parça' },
    ];
    el.innerHTML = cards
      .map((c) => `<div class="m-stat-card"><div class="m-stat-val">${escapeHtml(c.val)}</div><div class="m-stat-lbl">${escapeHtml(c.lbl)}</div></div>`)
      .join('');

    window.SunifyCards?.renderHeatmapWidget($('homeHeatmapBox'), state.listeningStats, {
      onGoalChange: (m) => {
        if (!state.listeningStats || typeof state.listeningStats !== 'object') state.listeningStats = {};
        state.listeningStats.__meta = { dailyGoalMinutes: m };
        saveLocalData(true, false);
        renderHomeStats();
      },
    });
  }

  async function loadRecommendations(force = false) {
    const el = $('homeRecsList');
    el.innerHTML = '<div class="m-empty-card">Öneriler hazırlanıyor...</div>';
    try {
      const seeds = collectSeeds(6);
      const qs = new URLSearchParams({
        mode: state.mood,
        seeds: JSON.stringify(seeds),
        excludeArtists: JSON.stringify(state.mood === 'discover' ? collectKnownArtists(20) : []),
        refresh: force ? '1' : '0',
      });
      const data = await api(`/api/recommendations?${qs.toString()}`);
      renderTrackRows(el, (data.tracks || []).slice(0, 6), { emptyText: 'Dinleme geçmişin oluşunca öneriler burada görünecek.' });
    } catch {
      el.innerHTML = '<div class="m-empty-card">Öneriler şu an yüklenemedi.</div>';
    }
  }

  async function loadDailyChart() {
    const el = $('homeDailyChartList');
    try {
      let data = await api('/api/discover/top?limit=10');
      if (!Array.isArray(data?.tracks) || !data.tracks.length) {
        data = await api('/api/discover/daily-top?limit=10');
      }
      renderTrackRows(el, (data.tracks || []).slice(0, 6), {
        showPlayCount: true,
        emptyText: 'Henüz ortak dinleme kaydı yok.',
      });
    } catch {
      el.innerHTML = '<div class="m-empty-card">En çok dinlenenler yüklenemedi.</div>';
    }
  }

  async function loadDeviceMusic(askPermissionIfNeeded = false) {
    if (bridge && typeof bridge.hasDeviceMusicPermission === 'function' && !bridge.hasDeviceMusicPermission()) {
      if (askPermissionIfNeeded && typeof bridge.requestDeviceMusicPermission === 'function') {
        window.__sunifyOnAudioPermResult = (granted) => {
          if (granted) {
            loadDeviceMusic(false).then(() => {
              renderLibrary();
              openDetail({
                id: 'device-music',
                name: 'Cihazdaki Müzikler',
                subtitle: `${state.deviceTracks.length} parça`,
                cover: state.deviceTracks[0]?.thumbnail || FALLBACK_ART,
                tracks: state.deviceTracks,
                readonly: true,
              });
            });
          } else {
            showToast('Cihaz müzikleri için depolama izni gerekli.');
          }
        };
        bridge.requestDeviceMusicPermission();
      }
      return [];
    }
    try {
      const data = await api('/api/device-music');
      state.deviceTracks = Array.isArray(data.tracks) ? data.tracks : [];
    } catch {
      state.deviceTracks = [];
    }
    return state.deviceTracks;
  }

  function renderLibrary() {
    const el = $('libraryGrid');
    const reorderBtn = $('libReorderBtn');
    if (reorderBtn) reorderBtn.classList.toggle('primary', state.libReorderMode);
    const cards = [
      { type: 'liked', title: 'Beğenilen Şarkılar', sub: `${state.likedTracks.length} parça`, icon: 'fa-heart', cls: 'liked-grad' },
      { type: 'offline', title: 'İndirilenler', sub: `${state.offlineTracks.length} parça`, icon: 'fa-cloud-arrow-down', cls: 'offline-grad' },
      { type: 'device', title: 'Cihazdaki Müzikler', sub: state.deviceTracks.length ? `${state.deviceTracks.length} yerel dosya` : 'Taramak için dokun', icon: 'fa-mobile-screen-button', cls: 'offline-grad' },
      ...state.playlists.map((pl, plIndex) => ({
        type: 'playlist',
        pl,
        plIndex,
        title: pl.name,
        sub: pl.description ? pl.description : `${(pl.tracks || []).length} parça`,
        cover: pl.cover || pl.tracks?.[0]?.thumbnail || FALLBACK_ART,
      })),
    ];
    el.innerHTML = cards
      .map((c, i) => {
        const reorderHtml = state.libReorderMode && c.type === 'playlist'
          ? `<div class="sfx-reorder-controls" style="justify-content:center;margin-top:4px;"><button class="m-row-btn" data-plmove="-1" data-pidx="${c.plIndex}" type="button" aria-label="Yukarı"><i class="fa-solid fa-arrow-left"></i></button><button class="m-row-btn" data-plmove="1" data-pidx="${c.plIndex}" type="button" aria-label="Aşağı"><i class="fa-solid fa-arrow-right"></i></button></div>`
          : '';
        return c.cover
          ? `<div class="m-lib-card" data-li="${i}"><img class="m-lib-cover" src="${escapeHtml(thumbUrl(c.cover, 240))}" alt="" loading="lazy" decoding="async" /><div class="m-card-title">${escapeHtml(c.title)}</div><div class="m-card-sub">${escapeHtml(c.sub)}</div>${reorderHtml}</div>`
          : `<div class="m-lib-card" data-li="${i}"><div class="m-lib-cover ${c.cls}"><i class="fa-solid ${c.icon}"></i></div><div class="m-card-title">${escapeHtml(c.title)}</div><div class="m-card-sub">${escapeHtml(c.sub)}</div></div>`;
      })
      .join('');

    el.querySelectorAll('.m-lib-card').forEach((card) => {
      card.onclick = async (e) => {
        const moveBtn = e.target.closest('button[data-plmove]');
        if (moveBtn) {
          e.stopPropagation();
          const pidx = Number(moveBtn.dataset.pidx);
          const dir = Number(moveBtn.dataset.plmove);
          const next = pidx + dir;
          if (next < 0 || next >= state.playlists.length) return;
          const [moved] = state.playlists.splice(pidx, 1);
          state.playlists.splice(next, 0, moved);
          saveLocalData(true, true);
          renderLibrary();
          return;
        }
        const item = cards[Number(card.dataset.li)];
        if (item.type === 'liked') {
          openDetail({ id: 'liked', name: 'Beğenilen Şarkılar', subtitle: item.sub, cover: state.likedTracks[0]?.thumbnail || FALLBACK_ART, tracks: state.likedTracks, readonly: true });
        } else if (item.type === 'offline') {
          openDetail({ id: 'offline', name: 'İndirilenler', subtitle: item.sub, cover: FALLBACK_ART, tracks: state.offlineTracks, readonly: true });
        } else if (item.type === 'device') {
          const list = await loadDeviceMusic(true);
          if (list.length || !bridge?.hasDeviceMusicPermission || bridge.hasDeviceMusicPermission()) {
            renderLibrary();
            openDetail({ id: 'device-music', name: 'Cihazdaki Müzikler', subtitle: `${list.length} parça`, cover: list[0]?.thumbnail || FALLBACK_ART, tracks: list, readonly: true });
          }
        } else {
          openDetail(item.pl);
        }
      };
    });
  }

  async function hydratePlaylistCovers(ctx) {
    const tracks = ctx?.tracks || [];
    if (!tracks.length) return;
    const coverToMatch = ctx.cover || ctx.cover_url || '';
    const targets = [];
    tracks.forEach((t, idx) => {
      const th = String(t?.thumbnail || '');
      const needsCover = !th || th === coverToMatch || th.includes('mosaic.scdn.co') || th.startsWith('data:image/svg');
      if (needsCover && (t.title || t.artist)) targets.push({ idx, t });
    });
    if (!targets.length) return;

    let changed = false;
    const batchSize = 4;
    for (let i = 0; i < targets.length; i += batchSize) {
      if (state.detailContext?.id !== ctx.id) break;
      const batch = targets.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async ({ idx, t }) => {
          try {
            const qs = new URLSearchParams({ artist: t.artist || '', title: t.title || '' });
            const res = await api(`/api/track-cover?${qs.toString()}`);
            if (res.thumbnail) {
              t.thumbnail = res.thumbnail;
              changed = true;
              if (state.detailContext?.id === ctx.id && !$('detailFilterInput')?.value.trim()) {
                const img = $('detailTrackList')?.querySelector(`.m-track-row[data-idx="${idx}"] img.m-track-thumb`);
                if (img) img.src = res.thumbnail;
              }
            }
          } catch {}
        })
      );
    }
    if (changed && !ctx.readonly) {
      saveLocalData(true, true);
      renderLibrary();
    }
  }

  function openDetail(ctx) {
    if (state.detailContext?.id !== ctx.id) state.detailReorderMode = false;
    state.detailContext = ctx;
    const tracks = ctx.tracks || [];
    $('detailCover').src = ctx.cover || tracks[0]?.thumbnail || FALLBACK_ART;
    $('detailTitle').textContent = ctx.name || 'Liste';
    const descEl = $('detailDesc');
    if (descEl) {
      const desc = String(ctx.description || '').trim();
      descEl.textContent = desc;
      descEl.hidden = !desc;
    }
    $('detailSub').textContent = ctx.subtitle || `${tracks.length} parça`;
    $('detailReorderBtn').hidden = Boolean(ctx.readonly);
    $('detailReorderBtn').classList.toggle('primary', state.detailReorderMode);
    $('detailRenameBtn').hidden = Boolean(ctx.readonly);
    $('detailDeleteBtn').hidden = Boolean(ctx.readonly);
    $('detailSaveBtn').hidden = !ctx.canSave;
    $('detailFilterInput').value = '';
    renderTrackRows($('detailTrackList'), tracks, {
      playlistId: ctx.readonly ? null : ctx.id,
      reorderMode: !ctx.readonly && state.detailReorderMode,
    });
    switchTab('detail');
    hydratePlaylistCovers(ctx);
  }

  async function runSearch(query) {
    const q = query.trim();
    const out = $('searchResultsList');
    if (!q) {
      out.innerHTML = '<div class="m-empty-card">Aramak istediğin şarkı veya sanatçıyı yaz.</div>';
      return;
    }
    out.innerHTML = '<div class="m-empty-card">Aranıyor...</div>';
    try {
      if (state.searchFilter === 'tracks') {
        const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
        renderTrackRows(out, data.results || []);
      } else if (state.searchFilter === 'artists') {
        const data = await api(`/api/artists/search?q=${encodeURIComponent(q)}`);
        const artists = data.artists || [];
        if (!artists.length) {
          out.innerHTML = '<div class="m-empty-card">Sanatçı bulunamadı.</div>';
          return;
        }
        out.innerHTML = artists
          .map(
            (a, i) => `
            <div class="m-track-row" data-ai="${i}">
              <img class="m-track-thumb" src="${escapeHtml(a.picture || FALLBACK_ART)}" alt="" />
              <div class="m-track-meta">
                <div class="m-track-title">${escapeHtml(a.name)}</div>
                <div class="m-track-artist">Sanatçı</div>
              </div>
              <i class="fa-solid fa-chevron-right"></i>
            </div>`
          )
          .join('');
        out.querySelectorAll('.m-track-row').forEach((r) => {
          r.onclick = () => openArtist(artists[Number(r.dataset.ai)].id);
        });
      } else {
        const data = await api(`/api/search/playlists?q=${encodeURIComponent(q)}`);
        const pls = data.playlists || [];
        if (!pls.length) {
          out.innerHTML = '<div class="m-empty-card">Çalma listesi bulunamadı.</div>';
          return;
        }
        out.innerHTML = pls
          .map(
            (p, i) => `
            <div class="m-track-row" data-pi="${i}">
              <img class="m-track-thumb" src="${escapeHtml(p.cover || FALLBACK_ART)}" alt="" />
              <div class="m-track-meta">
                <div class="m-track-title">${escapeHtml(p.name)}</div>
                <div class="m-track-artist">${escapeHtml(p.author || 'YouTube')}</div>
              </div>
              <i class="fa-solid fa-chevron-right"></i>
            </div>`
          )
          .join('');
        out.querySelectorAll('.m-track-row').forEach((r) => {
          r.onclick = async () => {
            const p = pls[Number(r.dataset.pi)];
            try {
              const imp = await api('/api/import-playlist', { method: 'POST', body: JSON.stringify({ url: p.url }) });
              openDetail({ id: `imp_${Date.now()}`, name: imp.name || p.name, cover: imp.cover || p.cover, tracks: imp.tracks || [], readonly: true, canSave: true });
            } catch (e) {
              showToast(e.message || 'Liste açılamadı.');
            }
          };
        });
      }
    } catch (e) {
      out.innerHTML = `<div class="m-empty-card">${escapeHtml(e.message || 'Arama başarısız.')}</div>`;
    }
  }

  async function openArtist(id) {
    switchTab('artist');
    $('artistHero').innerHTML = '<div class="m-empty-card">Sanatçı yükleniyor...</div>';
    $('artistTracksList').innerHTML = '';
    try {
      const data = await api(`/api/artists/${encodeURIComponent(id)}`);
      $('artistHero').innerHTML = `
        <img class="m-detail-cover" src="${escapeHtml(data.picture || FALLBACK_ART)}" alt="" />
        <h1 class="m-detail-title">${escapeHtml(data.name || 'Sanatçı')}</h1>
        <p class="m-detail-sub">${(data.topTracks || []).length} popüler parça</p>`;
      renderTrackRows($('artistTracksList'), data.topTracks || []);
    } catch {
      $('artistHero').innerHTML = '<div class="m-empty-card">Sanatçı bilgisi yüklenemedi.</div>';
    }
  }

  function renderAccountSyncTime() {
    const el = $('settingsSyncTime');
    if (!el) return;
    if (!state.lastSyncedAt) {
      el.textContent = 'Eşitlenmeye hazır';
      return;
    }
    const d = new Date(state.lastSyncedAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    el.textContent = `Son eşitleme: ${hh}:${mm}`;
  }

  function renderAccountUI() {
    const user = state.auth.user;
    const label = user?.user_metadata?.username || user?.email?.split('@')[0] || 'Giriş Yap';
    $('mTopAccountLabel').textContent = label;

    const body = $('settingsAccountBody');
    if (user) {
      body.innerHTML = `
        <div class="m-setting-row">
          <div>
            <div class="m-row-label">${escapeHtml(user.user_metadata?.username || 'Sunify Kullanıcısı')}</div>
            <div class="m-row-sub">${escapeHtml(user.email || '')}</div>
            <div class="m-row-sub" id="settingsSyncTime">Eşitlenmeye hazır</div>
          </div>
          <button class="m-glass-btn" id="syncNowBtn" type="button"><i class="fa-solid fa-rotate"></i> Eşitle</button>
        </div>
        <button class="m-glass-btn" id="logoutBtn" type="button" style="color:#ff8ea1"><i class="fa-solid fa-right-from-bracket"></i> Çıkış Yap</button>`;
      renderAccountSyncTime();
      $('syncNowBtn').onclick = () => syncNow();
      $('logoutBtn').onclick = () => {
        delSecure('sunify_auth_token');
        delSecure('sunify_refresh_token');
        localStorage.removeItem('sunify_last_uid');
        localStorage.removeItem('sunify_user_email');
        state.auth = { accessToken: '', refreshToken: '', user: null };
        state.cloudReady = false;
        state.pendingStructEdit = false;
        state.lastSyncedAt = 0;
        window.SunifyRealtime?.stopConnect();
        window.SunifyRealtime?.leaveJam();
        loadLocalData();
        renderAll();
        renderAccountUI();
        showToast('Çıkış yapıldı.');
      };
    } else {
      body.innerHTML = `
        <div class="m-auth-form">
          <input class="m-input" id="authEmail" type="email" placeholder="E-posta" />
          <input class="m-input" id="authPass" type="password" placeholder="Şifre" />
          <div style="display:flex;gap:8px;">
            <button class="m-glass-btn primary" id="authLoginBtn" type="button" style="flex:1">Giriş Yap</button>
            <button class="m-glass-btn" id="authRegBtn" type="button" style="flex:1">Kayıt Ol</button>
          </div>
        </div>`;
      $('authLoginBtn').onclick = () => doAuth('login');
      $('authRegBtn').onclick = () => doAuth('register');
    }
  }

  async function doAuth(mode) {
    const email = $('authEmail')?.value.trim() || '';
    const password = $('authPass')?.value || '';
    if (!email || !password) return showToast('E-posta ve şifre girin.');
    try {
      const payload = mode === 'register' ? { username: email.split('@')[0], email, password } : { email, password };
      const res = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) });
      const sess = res.session && typeof res.session === 'object' ? res.session : res;
      if (sess.access_token) {
        state.auth.accessToken = sess.access_token;
        state.auth.refreshToken = sess.refresh_token || '';
        state.auth.user = res.user || sess.user || { email };
        setSecure('sunify_auth_token', sess.access_token);
        if (sess.refresh_token) setSecure('sunify_refresh_token', sess.refresh_token);
        if (state.auth.user?.id) localStorage.setItem('sunify_last_uid', state.auth.user.id);
        localStorage.setItem('sunify_user_email', state.auth.user?.email || email);
        state.cloudReady = false;
        state.pendingStructEdit = false;
        loadLocalData();
        renderAccountUI();
        await pullCloudData(true, { mergeLocal: false });
      } else {
        showToast(res.message || 'E-posta doğrulaması gerekebilir.');
      }
    } catch (e) {
      showToast(e.message || 'Giriş başarısız.');
    }
  }

  async function refreshStorageStats() {
    try {
      const s = await api('/api/storage/stats');
      $('settingsCacheSize').textContent = fmtBytes(s.audioCacheBytes);
      $('settingsDownloadsSize').textContent = fmtBytes(s.downloadsBytes);
    } catch {}
  }

  function openSheet(title, buildFn) {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody');
    body.innerHTML = '';
    body.appendChild(buildFn());
    $('sheetBackdrop').hidden = false;
  }

  function closeSheet() {
    mobileConnectSheetRefresh = null;
    $('sheetBackdrop').hidden = true;
  }

  function openQueueSheet() {
    openSheet(`Çalma Sırası (${state.queue.length})`, () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-track-list';
      renderTrackRows(wrap, state.queue);
      return wrap;
    });
  }

  function getRealtimeHostAdapter() {
    return {
      getState: () => ({
        track: state.currentTrack,
        isPlaying: !audio.paused && Boolean(state.currentTrack),
        currentTime: Number(audio.currentTime) || 0,
        duration: Number(audio.duration) || Number(state.currentTrack?.duration) || 0,
        volume: Number(audio.volume) || 1,
      }),
      playTrackAt: (track, startAtSec = 0, autoPlay = true) => {
        if (!track) return;
        playTrack(track, [track], 0, { startAtSec, autoPlay });
      },
      togglePlay: () => togglePlay(),
      play: () => {
        if (!state.currentTrack) return;
        window.SunifyAudioFX?.resume();
        audio.play().catch(() => {});
        state.isPlaying = true;
        updatePlayerUI();
        window.SunifyRealtime?.notifyLocalPlaybackChanged();
      },
      pause: () => {
        audio.pause();
        state.isPlaying = false;
        updatePlayerUI();
        window.SunifyRealtime?.notifyLocalPlaybackChanged();
      },
      playNext: () => playNext(),
      playPrev: () => playPrev(),
      seekTo: (sec) => {
        const tm = Math.max(0, Number(sec) || 0);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.min(audio.duration, tm);
          updateNotification();
        }
      },
      setVolume: (vol) => {
        audio.volume = Math.max(0, Math.min(1, Number(vol) || 1));
      },
      addToQueue: (track) => {
        if (track) state.queue.push(track);
      },
    };
  }

  function startMobileRealtimeConnect() {
    if (!state.auth.user || !window.SunifyRealtime) return;
    window.SunifyRealtime.startConnect(state.auth.user, getRealtimeHostAdapter());
  }

  function updateSleepBadge(remSec, mode) {
    const badge = $('npSleepBadge');
    const btn = $('npSleepBtn');
    if (!badge) return;
    if (!mode) {
      badge.hidden = true;
      badge.textContent = '';
      btn?.classList.remove('primary');
      return;
    }
    badge.hidden = false;
    btn?.classList.add('primary');
    if (mode === 'end_of_track') {
      badge.textContent = ' · Parça sonu';
    } else {
      badge.textContent = ` · ${fmtTime(remSec)}`;
    }
  }

  function openAudioFxSheet(initialTab = 'eq') {
    window.SunifyAudioFX?.initIfNeeded?.(audio);
    window.SunifyAudioFX?.resume();
    let activeTab = initialTab;

    openSheet('Ses, Efekt & Uyku', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';

      const render = () => {
        const fx = window.SunifyAudioFX?.getState() || {
          eqBands: new Array(10).fill(0),
          reverb: 0,
          normalization: false,
          rate: 1,
          preservesPitch: true,
          crossfadeSeconds: 0,
          sleepMode: null,
          sleepRemainingSec: 0,
        };
        const bandsMeta = window.SunifyAudioFX?.getBandsMeta() || [];
        const eqLabels = {
          flat: 'Düz',
          bass: 'Bass',
          vocal: 'Vokal',
          acoustic: 'Akustik',
          night: 'Gece',
          electronic: 'Elektronik',
          treble: 'Tiz',
        };
        const isEqPreset = (pKey) => {
          const vals = window.SunifyAudioFX?.EQ_PRESETS?.[pKey];
          return Boolean(vals && vals.every((v, idx) => Math.abs((fx.eqBands[idx] || 0) - v) < 0.05));
        };

        wrap.innerHTML = `
          <div class="sfx-tabs">
            <button type="button" class="sfx-tab-btn ${activeTab === 'eq' ? 'active' : ''}" data-fx-tab="eq">Ekolayzer</button>
            <button type="button" class="sfx-tab-btn ${activeTab === 'speed' ? 'active' : ''}" data-fx-tab="speed">Hız &amp; Efekt</button>
            <button type="button" class="sfx-tab-btn ${activeTab === 'sleep' ? 'active' : ''}" data-fx-tab="sleep">Geçiş &amp; Uyku</button>
          </div>
          <div class="sfx-fx-pane ${activeTab === 'eq' ? 'active' : ''}" data-fx-pane="eq">
            <div class="sfx-preset-grid">
              ${Object.keys(eqLabels).map((pk) => `<button type="button" class="sfx-pill-btn ${isEqPreset(pk) ? 'active' : ''}" data-eq-p="${pk}">${eqLabels[pk]}</button>`).join('')}
            </div>
            <div class="sfx-toggle-row">
              <span>Ses Normalizasyonu</span>
              <label class="m-switch"><input type="checkbox" id="fxNormChk" ${fx.normalization ? 'checked' : ''} /><span class="m-switch-slider"></span></label>
            </div>
            ${bandsMeta.map((b) => `
              <label class="sfx-slider-row">
                <span>${b.label}</span>
                <input type="range" min="-12" max="12" step="0.5" value="${b.gain}" data-eq-b="${b.index}" />
                <output>${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB</output>
              </label>`).join('')}
          </div>
          <div class="sfx-fx-pane ${activeTab === 'speed' ? 'active' : ''}" data-fx-pane="speed">
            <div class="sfx-preset-grid">
              <button type="button" class="sfx-pill-btn ${Math.abs(fx.rate - 1) < 0.02 && fx.reverb < 0.02 ? 'active' : ''}" data-mood-p="normal">Normal</button>
              <button type="button" class="sfx-pill-btn ${fx.rate <= 0.88 && !fx.preservesPitch ? 'active' : ''}" data-mood-p="slowed">Slowed + Reverb</button>
              <button type="button" class="sfx-pill-btn ${fx.rate >= 1.18 && !fx.preservesPitch ? 'active' : ''}" data-mood-p="nightcore">Nightcore</button>
              <button type="button" class="sfx-pill-btn ${Math.abs(fx.rate - 0.9) < 0.03 && fx.preservesPitch ? 'active' : ''}" data-mood-p="chill">Chill</button>
            </div>
            <label class="sfx-slider-row">
              <span>Hız</span>
              <input type="range" id="fxRateRange" min="0.75" max="1.35" step="0.01" value="${fx.rate.toFixed(2)}" />
              <output id="fxRateOut">${fx.rate.toFixed(2)}x</output>
            </label>
            <div class="sfx-toggle-row">
              <span>Perdeyi Koru (Pitch Lock)</span>
              <label class="m-switch"><input type="checkbox" id="fxPitchChk" ${fx.preservesPitch ? 'checked' : ''} /><span class="m-switch-slider"></span></label>
            </div>
            <label class="sfx-slider-row">
              <span>Reverb</span>
              <input type="range" id="fxReverbRange" min="0" max="1" step="0.02" value="${fx.reverb.toFixed(2)}" />
              <output id="fxReverbOut">${Math.round(fx.reverb * 100)}%</output>
            </label>
          </div>
          <div class="sfx-fx-pane ${activeTab === 'sleep' ? 'active' : ''}" data-fx-pane="sleep">
            <label class="sfx-slider-row">
              <span>Crossfade</span>
              <input type="range" id="fxCrossfadeRange" min="0" max="10" step="1" value="${fx.crossfadeSeconds}" />
              <output id="fxCrossfadeOut">${fx.crossfadeSeconds} sn</output>
            </label>
            <div style="font-size:12px;font-weight:700;opacity:0.82;margin-top:4px;">Uyku Zamanlayıcısı</div>
            <div class="sfx-preset-grid">
              <button type="button" class="sfx-pill-btn ${fx.sleepMode === '15m' ? 'active' : ''}" data-sleep="15">15 dk</button>
              <button type="button" class="sfx-pill-btn ${fx.sleepMode === '30m' ? 'active' : ''}" data-sleep="30">30 dk</button>
              <button type="button" class="sfx-pill-btn ${fx.sleepMode === '45m' ? 'active' : ''}" data-sleep="45">45 dk</button>
              <button type="button" class="sfx-pill-btn ${fx.sleepMode === '60m' ? 'active' : ''}" data-sleep="60">1 saat</button>
              <button type="button" class="sfx-pill-btn ${fx.sleepMode === 'end_of_track' ? 'active' : ''}" data-sleep="end_of_track">Şarkı Bitince</button>
              ${fx.sleepMode ? '<button type="button" class="sfx-pill-btn" data-sleep="cancel" style="color:#ff8ea1;">İptal Et</button>' : ''}
            </div>
          </div>`;

        wrap.querySelectorAll('[data-fx-tab]').forEach((b) => {
          b.onclick = () => {
            activeTab = b.dataset.fxTab;
            render();
          };
        });
        wrap.querySelectorAll('[data-eq-p]').forEach((b) => {
          b.onclick = () => {
            window.SunifyAudioFX?.applyEqPreset(b.dataset.eqP);
            render();
          };
        });
        wrap.querySelectorAll('[data-eq-b]').forEach((sl) => {
          sl.oninput = () => {
            const val = Number(sl.value);
            window.SunifyAudioFX?.setEqBand(Number(sl.dataset.eqB), val);
            const out = sl.parentElement?.querySelector('output');
            if (out) out.textContent = `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`;
          };
        });
        const normChk = wrap.querySelector('#fxNormChk');
        if (normChk) normChk.onchange = () => window.SunifyAudioFX?.setNormalization(normChk.checked);

        wrap.querySelectorAll('[data-mood-p]').forEach((b) => {
          b.onclick = () => {
            window.SunifyAudioFX?.applyMoodPreset(b.dataset.moodP);
            render();
          };
        });
        const rateSl = wrap.querySelector('#fxRateRange');
        const pitchChk = wrap.querySelector('#fxPitchChk');
        if (rateSl) {
          rateSl.oninput = () => {
            const val = Number(rateSl.value);
            window.SunifyAudioFX?.setSpeedPitch(val, pitchChk?.checked !== false);
            const out = wrap.querySelector('#fxRateOut');
            if (out) out.textContent = `${val.toFixed(2)}x`;
          };
        }
        if (pitchChk) {
          pitchChk.onchange = () => {
            window.SunifyAudioFX?.setSpeedPitch(Number(rateSl?.value || 1), pitchChk.checked);
          };
        }
        const revSl = wrap.querySelector('#fxReverbRange');
        if (revSl) {
          revSl.oninput = () => {
            const val = Number(revSl.value);
            window.SunifyAudioFX?.setReverb(val);
            const out = wrap.querySelector('#fxReverbOut');
            if (out) out.textContent = `${Math.round(val * 100)}%`;
          };
        }
        const cfSl = wrap.querySelector('#fxCrossfadeRange');
        if (cfSl) {
          cfSl.oninput = () => {
            const val = Number(cfSl.value);
            window.SunifyAudioFX?.setCrossfade(val);
            const out = wrap.querySelector('#fxCrossfadeOut');
            if (out) out.textContent = `${val} sn`;
          };
        }
        wrap.querySelectorAll('[data-sleep]').forEach((b) => {
          b.onclick = () => {
            const m = b.dataset.sleep;
            if (m === 'cancel') {
              window.SunifyAudioFX?.cancelSleepTimer();
              updateSleepBadge(0, null);
              showToast('Uyku zamanlayıcısı iptal edildi.');
            } else {
              window.SunifyAudioFX?.startSleepTimer(m === 'end_of_track' ? 'end_of_track' : Number(m), {
                onTick: (rem, mode) => updateSleepBadge(rem, mode),
                onComplete: () => {
                  state.isPlaying = false;
                  updateSleepBadge(0, null);
                  updatePlayerUI();
                  showToast('Uyku zamanlayıcısı çalmayı durdurdu.');
                },
              });
              showToast(m === 'end_of_track' ? 'Şarkı bitince durdurulacak.' : `${m} dakikalık uyku zamanlayıcısı ayarlandı.`);
            }
            render();
          };
        });
      };

      render();
      return wrap;
    });
  }

  let mobileConnectSheetRefresh = null;

  function openConnectJamSheet(initialTab = 'connect') {
    let activeTab = initialTab;
    openSheet('Sunify Connect & Jam', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';

      const render = () => {
        const devices = window.SunifyRealtime?.getRemoteDevices() || [];
        const jam = window.SunifyRealtime?.getJamRoom();
        const myName = window.SunifyRealtime?.getDeviceName() || 'Sunify Android';
        const userName = state.auth.user?.user_metadata?.username || state.auth.user?.email?.split('@')[0] || 'Misafir';

        wrap.innerHTML = `
          <div class="sfx-tabs">
            <button type="button" class="sfx-tab-btn ${activeTab === 'connect' ? 'active' : ''}" data-cj-tab="connect">Cihazlar (${devices.length})</button>
            <button type="button" class="sfx-tab-btn ${activeTab === 'jam' ? 'active' : ''}" data-cj-tab="jam">Jam Odası</button>
          </div>
          ${activeTab === 'connect' ? `
            <div style="font-size:12px;opacity:0.78;">Bu cihaz: <strong>${escapeHtml(myName)}</strong>${state.auth.user ? '' : ' (Cihazlar arası kontrol için giriş yap)'}</div>
            ${!devices.length ? '<div class="m-empty-card">Aynı hesapla açık başka Sunify cihazı bekleniyor (PC veya Android).</div>' : devices.map((d) => `
              <div class="sfx-device-card">
                <div class="sfx-device-top">
                  <div class="sfx-device-title"><span class="sfx-live-dot"></span><i class="fa-solid ${d.platform === 'pc' ? 'fa-desktop' : 'fa-mobile-screen'}"></i> ${escapeHtml(d.deviceName || 'Sunify Cihazı')}</div>
                  <span style="font-size:11px;opacity:0.72;">${d.isPlaying ? 'Çalıyor' : 'Duraklatıldı'}</span>
                </div>
                <div class="sfx-device-sub">${escapeHtml(d.track?.title ? `${d.track.title} · ${d.track.artist || ''}` : 'Müzik seçili değil')}</div>
                <div class="sfx-device-actions">
                  <button type="button" class="m-glass-btn" data-rc-cmd="prev" data-rc-id="${escapeHtml(d.deviceId)}"><i class="fa-solid fa-backward-step"></i></button>
                  <button type="button" class="m-glass-btn primary" data-rc-cmd="toggle" data-rc-id="${escapeHtml(d.deviceId)}"><i class="fa-solid ${d.isPlaying ? 'fa-pause' : 'fa-play'}"></i></button>
                  <button type="button" class="m-glass-btn" data-rc-cmd="next" data-rc-id="${escapeHtml(d.deviceId)}"><i class="fa-solid fa-forward-step"></i></button>
                  <button type="button" class="m-glass-btn" data-rc-here="${escapeHtml(d.deviceId)}">Telefona Al</button>
                  <button type="button" class="m-glass-btn" data-rc-to="${escapeHtml(d.deviceId)}">Cihaza Aktar</button>
                </div>
                <label class="sfx-slider-row">
                  <span>Ses</span>
                  <input type="range" min="0" max="1" step="0.02" value="${Number(d.volume ?? 1).toFixed(2)}" data-rc-vol="${escapeHtml(d.deviceId)}" />
                  <output>${Math.round(Number(d.volume ?? 1) * 100)}%</output>
                </label>
              </div>`).join('')}
          ` : `
            ${jam ? `
              <div class="sfx-jam-code">${escapeHtml(jam.code)}</div>
              <div style="font-size:12.5px;text-align:center;opacity:0.84;">${jam.isHost ? 'Ev sahibi sensin' : `Ev sahibi: ${escapeHtml(jam.hostName)}`} · ${(jam.members || []).length} katılımcı</div>
              <div style="display:flex;gap:8px;">
                <button type="button" class="m-glass-btn" id="jamCopyCodeBtn" style="flex:1;"><i class="fa-solid fa-copy"></i> Kodu Kopyala</button>
                <button type="button" class="m-glass-btn" id="jamQrCodeBtn" style="flex:1;"><i class="fa-solid fa-qrcode"></i> QR Paylaş</button>
                <button type="button" class="m-glass-btn" id="jamLeaveBtn" style="flex:1;color:#ff8ea1;"><i class="fa-solid fa-right-from-bracket"></i> Çık</button>
              </div>
              ${state.currentTrack ? '<button type="button" class="m-glass-btn primary" id="jamAddCurBtn"><i class="fa-solid fa-plus"></i> Çalan Şarkıyı Jam Sırasına Ekle</button>' : ''}
              <div style="font-size:12px;font-weight:700;opacity:0.8;">Katılımcılar: ${(jam.members || []).map((m) => escapeHtml(m.name)).join(', ')}</div>
            ` : `
              <button type="button" class="m-glass-btn primary" id="jamCreateBtn"><i class="fa-solid fa-radio"></i> Yeni Jam Odası Başlat</button>
              <div style="display:flex;gap:8px;margin-top:4px;">
                <input class="m-input" id="jamJoinInput" placeholder="Oda kodu (örn. SNF4K9)" maxlength="10" style="text-transform:uppercase;flex:1;" />
                <button type="button" class="m-glass-btn" id="jamJoinBtn">Katıl</button>
              </div>
            `}
          `}`;

        wrap.querySelectorAll('[data-cj-tab]').forEach((b) => {
          b.onclick = () => {
            activeTab = b.dataset.cjTab;
            render();
          };
        });
        wrap.querySelectorAll('[data-rc-cmd]').forEach((b) => {
          b.onclick = () => {
            window.SunifyRealtime?.sendCommand(b.dataset.rcId, b.dataset.rcCmd);
            showToast('Komut gönderildi.');
          };
        });
        wrap.querySelectorAll('[data-rc-here]').forEach((b) => {
          b.onclick = () => {
            if (window.SunifyRealtime?.transferHere(b.dataset.rcHere)) {
              closeSheet();
              showToast('Çalma telefona aktarıldı.');
            }
          };
        });
        wrap.querySelectorAll('[data-rc-to]').forEach((b) => {
          b.onclick = () => {
            if (window.SunifyRealtime?.transferTo(b.dataset.rcTo)) {
              showToast('Diğer cihaza aktarıldı.');
            } else {
              showToast('Önce bu cihazda bir şarkı başlatın.');
            }
          };
        });
        wrap.querySelectorAll('[data-rc-vol]').forEach((sl) => {
          sl.onchange = () => {
            window.SunifyRealtime?.sendCommand(sl.dataset.rcVol, 'volume', { volume: Number(sl.value) });
          };
        });
        const crBtn = wrap.querySelector('#jamCreateBtn');
        if (crBtn) {
          crBtn.onclick = () => {
            const code = window.SunifyRealtime?.createJam(userName, getRealtimeHostAdapter());
            if (code) showToast(`Jam Odası açıldı: ${code}`);
            render();
          };
        }
        const jnBtn = wrap.querySelector('#jamJoinBtn');
        if (jnBtn) {
          jnBtn.onclick = () => {
            const code = wrap.querySelector('#jamJoinInput')?.value.trim();
            if (!window.SunifyRealtime?.joinJam(code, userName, getRealtimeHostAdapter())) {
              showToast('Geçerli bir oda kodu girin.');
              return;
            }
            showToast('Jam Odasına katılındı!');
            render();
          };
        }
        const cpBtn = wrap.querySelector('#jamCopyCodeBtn');
        if (cpBtn && jam) {
          cpBtn.onclick = () => {
            navigator.clipboard?.writeText(jam.code).catch(() => {});
            showToast(`Kopyalandı: ${jam.code}`);
          };
        }
        const qrBtn = wrap.querySelector('#jamQrCodeBtn');
        if (qrBtn && jam) {
          qrBtn.onclick = () => openQrShareSheet('jam', { code: jam.code });
        }
        const lvBtn = wrap.querySelector('#jamLeaveBtn');
        if (lvBtn) {
          lvBtn.onclick = () => {
            window.SunifyRealtime?.leaveJam();
            render();
          };
        }
        const addCur = wrap.querySelector('#jamAddCurBtn');
        if (addCur) {
          addCur.onclick = () => {
            window.SunifyRealtime?.addJamTrack(state.currentTrack);
            showToast('Jam sırasına eklendi.');
          };
        }
      };

      mobileConnectSheetRefresh = render;
      render();
      return wrap;
    });
  }

  function updateAbLoopBtn() {
    const btn = $('npAbLoopBtn');
    if (!btn) return;
    const { a, b } = state.abLoop;
    const active = a !== null || b !== null;
    btn.classList.toggle('primary', active);
    btn.innerHTML = a !== null && b !== null
      ? `<i class="fa-solid fa-arrows-left-right-to-line"></i> ${fmtTime(a)}–${fmtTime(b)}`
      : a !== null
        ? `<i class="fa-solid fa-arrows-left-right-to-line"></i> A:${fmtTime(a)}`
        : '<i class="fa-solid fa-arrows-left-right-to-line"></i> A–B';
  }

  function openAbLoopSheet() {
    if (!state.currentTrack) return showToast('Önce bir şarkı çalın.');
    openSheet('Nakarat / A–B Döngü', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';
      const render = () => {
        const { a, b } = state.abLoop;
        wrap.innerHTML = `
          <div class="m-empty-card" style="text-align:left;">
            <strong>A Noktası:</strong> ${a !== null ? fmtTime(a) : 'Ayarlanmadı'}<br/>
            <strong>B Noktası:</strong> ${b !== null ? fmtTime(b) : 'Ayarlanmadı'}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="m-glass-btn primary" id="abSetA" type="button" style="flex:1;">A Noktası (Şimdi)</button>
            <button class="m-glass-btn primary" id="abSetB" type="button" style="flex:1;">B Noktası (Şimdi)</button>
          </div>
          <button class="m-glass-btn" id="abClear" type="button">Döngüyü Kapat</button>
        `;
        wrap.querySelector('#abSetA').onclick = () => {
          state.abLoop.a = Math.max(0, audio.currentTime || 0);
          if (state.abLoop.b !== null && state.abLoop.b <= state.abLoop.a + 1) state.abLoop.b = null;
          updateAbLoopBtn();
          render();
          showToast(`A noktası: ${fmtTime(state.abLoop.a)}`);
        };
        wrap.querySelector('#abSetB').onclick = () => {
          const cur = Math.max(1, audio.currentTime || 0);
          if (state.abLoop.a === null) state.abLoop.a = Math.max(0, cur - 15);
          if (cur <= state.abLoop.a + 1) return showToast('B noktası A noktasından sonra olmalı.');
          state.abLoop.b = cur;
          audio.currentTime = state.abLoop.a;
          updateAbLoopBtn();
          render();
          showToast(`A–B döngü aktif: ${fmtTime(state.abLoop.a)} – ${fmtTime(state.abLoop.b)}`);
        };
        wrap.querySelector('#abClear').onclick = () => {
          state.abLoop = { a: null, b: null };
          updateAbLoopBtn();
          closeSheet();
          showToast('A–B döngüsü kapatıldı.');
        };
      };
      render();
      return wrap;
    });
  }

  function openQrShareSheet(type, payload = {}) {
    if (!window.SunifyQR) return showToast('QR modülü hazır değil.');
    const url = window.SunifyQR.buildShareUrl(type, payload);
    const titleText = type === 'jam'
      ? `Jam Odası: ${payload.code || ''}`
      : (payload.title || payload.name || 'Sunify Paylaşım');
    openSheet('QR Kod ile Paylaş', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';
      wrap.style.alignItems = 'center';
      wrap.innerHTML = `
        <div style="background:#fff;padding:14px;border-radius:20px;box-shadow:0 10px 30px rgba(0,0,0,0.35);">
          <canvas id="qrShareCanvas"></canvas>
        </div>
        <strong style="text-align:center;">${escapeHtml(titleText)}</strong>
        <div class="m-row-sub" style="text-align:center;word-break:break-all;">${escapeHtml(url)}</div>
        <div style="display:flex;gap:8px;width:100%;">
          <button class="m-glass-btn primary" id="qrShareImgBtn" type="button" style="flex:1;"><i class="fa-solid fa-share-nodes"></i> QR Paylaş</button>
          <button class="m-glass-btn" id="qrCopyLinkBtn" type="button" style="flex:1;"><i class="fa-solid fa-copy"></i> Bağlantıyı Kopyala</button>
        </div>
      `;
      const canvas = wrap.querySelector('#qrShareCanvas');
      const dataUrl = window.SunifyQR.drawQrToCanvas(canvas, url, { size: 240 });
      wrap.querySelector('#qrShareImgBtn').onclick = () => {
        window.SunifyCards?.shareOrDownloadCard(dataUrl, `sunify-qr-${Date.now()}.png`, titleText);
      };
      wrap.querySelector('#qrCopyLinkBtn').onclick = async () => {
        try {
          await navigator.clipboard.writeText(url);
          showToast('Sunify bağlantısı kopyalandı.');
        } catch {
          showToast(url);
        }
      };
      return wrap;
    });
  }

  function openMp3TrimmerSheet(track) {
    const target = track || state.currentTrack;
    if (!target) return showToast('Önce bir şarkı seçin.');
    const dur = Math.max(20, Math.floor(Number(audio.duration) || Number(target.duration) || 180));
    const initStart = Math.min(Math.max(0, Math.floor(audio.currentTime || 0)), Math.max(0, dur - 15));
    const initEnd = Math.min(dur, initStart + 25);

    openSheet('MP3 Kesici & Zil Sesi', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';
      wrap.innerHTML = `
        <div class="m-row-label">${escapeHtml(target.title || '')} · ${escapeHtml(target.artist || '')}</div>
        <div class="m-setting-row"><span>Başlangıç</span><strong id="trimStartLbl">${fmtTime(initStart)}</strong></div>
        <input type="range" id="trimStartSlider" min="0" max="${Math.max(1, dur - 5)}" value="${initStart}" />
        <div class="m-setting-row"><span>Bitiş</span><strong id="trimEndLbl">${fmtTime(initEnd)}</strong></div>
        <input type="range" id="trimEndSlider" min="5" max="${dur}" value="${initEnd}" />
        <div class="m-row-sub" id="trimLenHint">Kesit süresi: ${initEnd - initStart} sn</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="m-glass-btn primary" id="trimSaveBtn" type="button" style="flex:1;"><i class="fa-solid fa-scissors"></i> Kes &amp; Kaydet</button>
          <button class="m-glass-btn" id="trimShareBtn" type="button" style="flex:1;"><i class="fa-solid fa-share-nodes"></i> Kes &amp; Paylaş</button>
        </div>
        <button class="m-glass-btn" id="trimRingtoneBtn" type="button"><i class="fa-solid fa-bell"></i> Kes &amp; Telefon Zil Sesi Yap</button>
      `;

      const sEl = wrap.querySelector('#trimStartSlider');
      const eEl = wrap.querySelector('#trimEndSlider');
      const syncLabels = () => {
        let sv = Number(sEl.value) || 0;
        let ev = Number(eEl.value) || sv + 15;
        if (ev <= sv + 2) {
          ev = Math.min(dur, sv + 5);
          eEl.value = String(ev);
        }
        wrap.querySelector('#trimStartLbl').textContent = fmtTime(sv);
        wrap.querySelector('#trimEndLbl').textContent = fmtTime(ev);
        wrap.querySelector('#trimLenHint').textContent = `Kesit süresi: ${ev - sv} sn`;
      };
      sEl.oninput = syncLabels;
      eEl.oninput = syncLabels;

      const runTrim = async (mode) => {
        const startSec = Number(sEl.value) || 0;
        const endSec = Math.max(startSec + 3, Number(eEl.value) || startSec + 20);
        showToast('MP3 kesiliyor, lütfen bekleyin...');
        try {
          const res = await api('/api/trim-mp3', {
            method: 'POST',
            body: JSON.stringify({
              id: target.id || '',
              title: target.title || '',
              artist: target.artist || '',
              localUrl: target.localUrl || '',
              query: `${target.artist || ''} ${target.title || ''}`.trim(),
              startSec,
              endSec,
              saveToDownloads: mode !== 'ringtone',
            }),
          });
          if (mode === 'share' && bridge?.shareFilePath) {
            bridge.shareFilePath(res.cachePath, 'audio/mpeg', `${target.title} Klip`);
            showToast('Ses klibi paylaşıma hazır.');
          } else if (mode === 'ringtone' && bridge?.setAsRingtone) {
            const st = bridge.setAsRingtone(res.cachePath, `${target.title || 'Sunify'} Zil Sesi`);
            if (st === 'ok') showToast('Telefon zil sesi olarak ayarlandı!');
            else if (st === 'need_permission') showToast('Ayarlardan "Sistem ayarlarını değiştir" iznini açıp tekrar dokunun.');
            else showToast('Zil sesi ayarlanamadı.');
          } else {
            showToast(`${res.displayPath || 'İndirilenler/Sunify/Klipler'} klasörüne kaydedildi.`);
          }
        } catch (err) {
          showToast(err.message || 'MP3 kesilemedi.');
        }
      };

      wrap.querySelector('#trimSaveBtn').onclick = () => runTrim('save');
      wrap.querySelector('#trimShareBtn').onclick = () => runTrim('share');
      wrap.querySelector('#trimRingtoneBtn').onclick = () => runTrim('ringtone');
      return wrap;
    });
  }

  let storyProgressTimer = null;
  let storyProgressEl = null;

  function hideStoryProgressOverlay() {
    if (storyProgressTimer) {
      clearInterval(storyProgressTimer);
      storyProgressTimer = null;
    }
    if (storyProgressEl) {
      storyProgressEl.remove();
      storyProgressEl = null;
    }
  }

  function showStoryProgressOverlay(titleText) {
    hideStoryProgressOverlay();
    const el = document.createElement('div');
    el.className = 'm-story-progress-backdrop';
    el.innerHTML = `
      <div class="m-story-progress-card">
        <div class="m-story-ring-wrap">
          <div class="m-story-ring-glow"></div>
          <div class="m-story-ring"></div>
          <div class="m-story-pct" id="storyProgPct">2%</div>
        </div>
        <div class="m-story-title">${escapeHtml(titleText || 'Story Videosu Oluşturuluyor')}</div>
        <div class="m-story-stage" id="storyProgStage">Hazırlanıyor...</div>
        <div class="m-story-bar"><div class="m-story-bar-fill" id="storyProgBar"></div></div>
        <div class="m-story-hint">HD 9:16 video işleniyor, lütfen uygulamadan ayrılma</div>
      </div>
    `;
    document.body.appendChild(el);
    storyProgressEl = el;

    let lastPct = 2;
    const poll = async () => {
      if (!storyProgressEl) return;
      try {
        const res = await fetch(`${API}/api/story/progress`);
        if (!res.ok) return;
        const data = await res.json();
        const pct = Math.max(lastPct, Math.min(100, Number(data.percent) || 0));
        lastPct = pct;
        const pctEl = storyProgressEl.querySelector('#storyProgPct');
        const stEl = storyProgressEl.querySelector('#storyProgStage');
        const barEl = storyProgressEl.querySelector('#storyProgBar');
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (stEl && data.stage) stEl.textContent = data.stage;
        if (barEl) barEl.style.width = `${Math.max(4, pct)}%`;
      } catch {}
    };
    poll();
    storyProgressTimer = setInterval(poll, 350);
  }

  function computeWrappedInsights(statsObj) {
    const weekdayNames = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
    const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
    const weekdaySec = [0, 0, 0, 0, 0, 0, 0];
    const monthSec = new Map();
    const hourSec = new Array(24).fill(0);

    const dailyLog = statsObj?.__dailyLog && typeof statsObj.__dailyLog === 'object' ? statsObj.__dailyLog : {};
    Object.entries(dailyLog).forEach(([dayKey, secRaw]) => {
      const sec = Number(secRaw) || 0;
      if (sec <= 0) return;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
      if (!m) return;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
      if (Number.isNaN(d.getTime())) return;
      const wdIdx = (d.getDay() + 6) % 7;
      weekdaySec[wdIdx] += sec;
      const ymKey = `${m[1]}-${m[2]}`;
      monthSec.set(ymKey, (monthSec.get(ymKey) || 0) + sec);
    });

    const hourLog = statsObj?.__hourLog && typeof statsObj.__hourLog === 'object' ? statsObj.__hourLog : {};
    Object.entries(hourLog).forEach(([hKey, secRaw]) => {
      const h = Number(hKey);
      const sec = Number(secRaw) || 0;
      if (Number.isInteger(h) && h >= 0 && h <= 23 && sec > 0) {
        hourSec[h] += sec;
      }
    });

    const entries = Object.entries(statsObj || {})
      .filter(([k, v]) => !k.startsWith('__') && v && typeof v === 'object' && v.title)
      .map(([, v]) => v);

    const uniqueTracks = entries.filter((e) => (Number(e.playCount) || 0) > 0 || (Number(e.totalSeconds) || 0) > 0).length;
    const artistSet = new Set();
    entries.forEach((e) => {
      if (e.artist && ((Number(e.playCount) || 0) > 0 || (Number(e.totalSeconds) || 0) > 0)) {
        artistSet.add(String(e.artist).trim().toLowerCase());
      }
    });
    const uniqueArtists = artistSet.size;

    const hasDailyData = weekdaySec.some((v) => v > 0);
    const hasHourData = hourSec.some((v) => v > 0);
    if (!hasDailyData || !hasHourData) {
      entries.forEach((e) => {
        const weight = Math.max(60, Number(e.totalSeconds) || (Number(e.playCount) || 1) * 180);
        if (e.lastPlayed) {
          const dt = new Date(e.lastPlayed);
          if (!Number.isNaN(dt.getTime())) {
            if (!hasDailyData) {
              const wdIdx = (dt.getDay() + 6) % 7;
              weekdaySec[wdIdx] += weight;
              const ymKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
              monthSec.set(ymKey, (monthSec.get(ymKey) || 0) + weight);
            }
            if (!hasHourData) {
              hourSec[dt.getHours()] += weight;
            }
          }
        }
      });
    }

    const weekdayMinutes = weekdaySec.map((s) => Math.round(s / 60));
    let peakWdIdx = 4;
    let peakWdVal = -1;
    weekdayMinutes.forEach((v, i) => {
      if (v > peakWdVal) {
        peakWdVal = v;
        peakWdIdx = i;
      }
    });
    const peakWeekday = weekdayNames[peakWdIdx] || 'Cuma';

    const topMonths = [...monthSec.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([ymKey, sec]) => {
        const parts = ymKey.split('-');
        const yr = parts[0] || '';
        const moIdx = Math.max(0, Math.min(11, (Number(parts[1]) || 1) - 1));
        return { label: `${monthNames[moIdx]} ${yr}`.trim(), minutes: Math.max(1, Math.round(sec / 60)) };
      });
    if (!topMonths.length) {
      const now = new Date();
      topMonths.push({ label: `${monthNames[now.getMonth()]} ${now.getFullYear()}`, minutes: 1 });
    }

    let peakHour = new Date().getHours();
    let peakHourVal = -1;
    hourSec.forEach((v, h) => {
      if (v > peakHourVal) {
        peakHourVal = v;
        peakHour = h;
      }
    });
    const endHr = (peakHour + 3) % 24;
    const pad2 = (n) => String(n).padStart(2, '0');
    const peakHourLabel = `${pad2(peakHour)}:00 – ${pad2(endHr)}:00`;
    let peakHourMood = 'Akşam Keyfi';
    if (peakHour >= 5 && peakHour < 12) peakHourMood = 'Sabah Enerjisi';
    else if (peakHour >= 12 && peakHour < 17) peakHourMood = 'Öğle Ritmi';
    else if (peakHour >= 17 && peakHour < 22) peakHourMood = 'Akşam Keyfi';
    else peakHourMood = 'Gece Kuşu';

    return {
      weekdayMinutes,
      peakWeekday,
      topMonths,
      peakHour,
      peakHourLabel,
      peakHourMood,
      uniqueTracks,
      uniqueArtists,
    };
  }

  function openLyricClipStorySheet() {
    const track = state.currentTrack;
    if (!track) return showToast('Önce bir şarkı çalın.');
    const dur = Math.max(20, Math.floor(Number(audio.duration) || Number(track.duration) || 180));
    const initStart = Math.min(Math.max(0, Math.floor(audio.currentTime || 0)), Math.max(0, dur - 15));
    const initEnd = Math.min(dur, initStart + 20);

    openSheet('Sözlü Story Videosu Oluştur (9:16)', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';
      wrap.innerHTML = `
        <div class="m-row-sub">İstediğin aralığı veya tüm şarkıyı seç — sinematik arka plan, canlı spektrum ve senkronize kayan sözlerle HD (.mp4) video oluştur.</div>
        <div class="m-setting-row"><span>Başlangıç</span><strong id="clipStartLbl">${fmtTime(initStart)}</strong></div>
        <input type="range" id="clipStartSlider" min="0" max="${Math.max(1, dur - 5)}" value="${initStart}" />
        <div class="m-setting-row"><span>Bitiş (Sınırsız · Tüm Şarkı)</span><strong id="clipEndLbl">${fmtTime(initEnd)}</strong></div>
        <input type="range" id="clipEndSlider" min="5" max="${dur}" value="${initEnd}" />
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="m-glass-btn" id="clipUseCurStart" type="button" style="flex:1;">Başlangıcı Şimdi Yap</button>
          <button class="m-glass-btn" id="clipUseCurEnd" type="button" style="flex:1;">Bitişi Şimdi Yap</button>
          <button class="m-glass-btn" id="clipFullTrackBtn" type="button" style="flex:1 1 100%;"><i class="fa-solid fa-expand"></i> Tüm Şarkıyı Seç (0:00 – ${fmtTime(dur)})</button>
        </div>
        <div class="m-row-sub" id="clipLenLbl">Video süresi: ${fmtTime(initEnd - initStart)} · ${state.lyrics.length ? `${state.lyrics.length} senkron söz satırı hazır` : 'Söz bulunamadı (kapak + spektrum modu)'}</div>
        <button class="m-glass-btn primary" id="clipGenerateBtn" type="button"><i class="fa-solid fa-clapperboard"></i> Story Videosu Oluştur &amp; Paylaş</button>
      `;

      const sEl = wrap.querySelector('#clipStartSlider');
      const eEl = wrap.querySelector('#clipEndSlider');
      const syncClip = () => {
        const sv = Number(sEl.value) || 0;
        let ev = Number(eEl.value) || sv + 15;
        if (ev < sv + 5) ev = Math.min(dur, sv + 5);
        if (ev > dur) ev = dur;
        eEl.value = String(ev);
        wrap.querySelector('#clipStartLbl').textContent = fmtTime(sv);
        wrap.querySelector('#clipEndLbl').textContent = fmtTime(ev);
        wrap.querySelector('#clipLenLbl').textContent = `Video süresi: ${fmtTime(ev - sv)} · ${state.lyrics.length ? `${state.lyrics.length} senkron söz satırı hazır` : 'Kapak + spektrum modu'}`;
      };
      sEl.oninput = syncClip;
      eEl.oninput = syncClip;
      wrap.querySelector('#clipUseCurStart').onclick = () => {
        sEl.value = String(Math.floor(audio.currentTime || 0));
        syncClip();
      };
      wrap.querySelector('#clipUseCurEnd').onclick = () => {
        eEl.value = String(Math.floor(audio.currentTime || 0));
        syncClip();
      };
      wrap.querySelector('#clipFullTrackBtn').onclick = () => {
        sEl.value = '0';
        eEl.value = String(dur);
        syncClip();
      };

      wrap.querySelector('#clipGenerateBtn').onclick = async () => {
        const btn = wrap.querySelector('#clipGenerateBtn');
        const startSec = Number(sEl.value) || 0;
        const endSec = Math.min(dur, Math.max(startSec + 5, Number(eEl.value) || startSec + 20));
        btn.disabled = true;
        showStoryProgressOverlay('Sözlü Story Videosu');
        try {
          const res = await api('/api/story/lyric-clip-video', {
            method: 'POST',
            body: JSON.stringify({
              id: track.id || '',
              title: track.title || '',
              artist: track.artist || '',
              thumbnail: track.thumbnail || '',
              coverRgb: state.currentCoverRgb,
              startSec,
              endSec,
              lyricsOffset: state.lyricsOffset || 0,
              lyrics: (state.lyrics || []).map((l) => ({ time: l.time, text: l.text })),
            }),
          });
          hideStoryProgressOverlay();
          showToast(`Galeriye kaydedildi: ${res.displayPath}`);
          if (bridge?.shareFilePath && res.cachePath) {
            bridge.shareFilePath(res.cachePath, 'video/mp4', `${track.title} Story Videosu`);
          }
          closeSheet();
        } catch (err) {
          hideStoryProgressOverlay();
          showToast(err.message || 'Story videosu oluşturulamadı.');
        } finally {
          hideStoryProgressOverlay();
          btn.disabled = false;
        }
      };
      return wrap;
    });
  }

  async function checkAppUpdates(manual = false) {
    const statusEl = $('settingsUpdateStatus');
    if (manual && statusEl) statusEl.textContent = 'Kontrol ediliyor...';
    try {
      const data = await api('/api/updates/latest');
      if (data.updateAvailable && data.apkUrl) {
        if (statusEl) statusEl.textContent = `Yeni sürüm mevcut: v${data.latestVersion}`;
        openSheet(`Yeni Güncelleme: v${data.latestVersion}`, () => {
          const wrap = document.createElement('div');
          wrap.className = 'm-auth-form';
          wrap.innerHTML = `
            <div class="m-empty-card" style="text-align:left;white-space:pre-line;">${escapeHtml(data.notes || 'Performans ve yeni özellik iyileştirmeleri.')}</div>
            <button class="m-glass-btn primary" id="doInstallUpdateBtn" type="button"><i class="fa-solid fa-download"></i> İndir ve Kur (v${escapeHtml(data.latestVersion)})</button>
          `;
          wrap.querySelector('#doInstallUpdateBtn').onclick = () => {
            if (bridge?.installUpdateApk) {
              bridge.installUpdateApk(data.apkUrl);
              showToast('Yeni APK indiriliyor, bitince kurulum ekranı açılacak...');
              closeSheet();
            } else if (data.htmlUrl) {
              window.open(data.htmlUrl, '_blank');
            }
          };
          return wrap;
        });
      } else {
        if (statusEl) statusEl.textContent = `Güncel (v${data.currentVersion || '1.2.1'})`;
        if (manual) showToast('Uygulama güncel!');
      }
    } catch {
      if (statusEl) statusEl.textContent = 'Kontrol edilemedi';
      if (manual) showToast('Güncelleme sunucusuna ulaşılamadı.');
    }
  }

  async function runSmartOfflineCache() {
    if (state.smartCacheRunning) return;
    if (localStorage.getItem('sunify_smart_cache') !== 'true') return;
    if (bridge?.isWifiConnected && !bridge.isWifiConnected()) return;
    const existing = new Set((state.offlineTracks || []).map((t) => trackKey(t)));
    const topTargets = getTopListenedTracks(15).filter((t) => t && t.title && !existing.has(trackKey(t))).slice(0, 5);
    if (!topTargets.length) return;
    state.smartCacheRunning = true;
    try {
      for (let i = 0; i < topTargets.length; i += 1) {
        if (localStorage.getItem('sunify_smart_cache') !== 'true') break;
        if (bridge?.isWifiConnected && !bridge.isWifiConnected()) break;
        await saveOffline(topTargets[i], { silent: true, skipReload: true });
        await new Promise((r) => setTimeout(r, 2000));
      }
      await loadOfflineTracks();
      renderLibrary();
    } finally {
      state.smartCacheRunning = false;
    }
  }

  async function handleDeepLink(rawUrl) {
    try {
      const u = new URL(String(rawUrl || ''));
      const type = u.searchParams.get('type') || '';
      if (type === 'jam') {
        const code = u.searchParams.get('code') || '';
        const uname = state.auth.user?.user_metadata?.username || state.auth.user?.email?.split('@')[0] || 'Misafir';
        if (code && window.SunifyRealtime?.joinJam) {
          window.SunifyRealtime.joinJam(code, uname, getRealtimeHostAdapter());
          showToast(`Jam odasına katılındı: ${code}`);
        }
      } else if (type === 'track') {
        const id = u.searchParams.get('id') || '';
        const title = u.searchParams.get('title') || '';
        const artist = u.searchParams.get('artist') || '';
        if (title || id) {
          playTrack({ id, title: title || 'Paylaşılan Şarkı', artist, query: `${artist} ${title}`.trim() });
          showToast(`Paylaşılan şarkı açıldı: ${title}`);
        }
      }
    } catch {}
  }

  function openWrappedSheet() {
    const existing = document.getElementById('sunifyWrappedStoryOverlay');
    if (existing) existing.remove();

    const topTracks = getTopListenedTracks(5);
    const entries = Object.entries(state.listeningStats || {})
      .filter(([k, v]) => !k.startsWith('__') && v && typeof v === 'object' && v.title)
      .map(([, v]) => v);
    const totalPlays = entries.reduce((s, e) => s + (Number(e.playCount) || 0), 0);
    const totalMinutes = Math.round(entries.reduce((s, e) => s + (Number(e.totalSeconds) || 0), 0) / 60);
    const totalHours = Math.max(1, Math.round(totalMinutes / 60));
    const streak = window.SunifyCards?.computeStreakAndHeatmap(state.listeningStats)?.streakDays || 0;

    const artistCounts = new Map();
    entries.forEach((e) => {
      const c = Number(e.playCount) || 0;
      if (c > 0 && e.artist) artistCounts.set(e.artist, (artistCounts.get(e.artist) || 0) + c);
    });
    const topArtists = [...artistCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const insights = computeWrappedInsights(state.listeningStats);
    const username = state.auth.user?.user_metadata?.username || state.auth.user?.email?.split('@')[0] || 'Sunify Dinleyicisi';
    const yearNow = new Date().getFullYear();

    // Realistic Spotify Wrapped percentile & persona
    const topPercentile = totalMinutes >= 15000 ? 1 : totalMinutes >= 6000 ? 3 : totalMinutes >= 2500 ? 7 : totalMinutes >= 800 ? 15 : 28;
    const fanPercentile = (topArtists[0]?.count || 0) >= 40 ? '0,5' : (topArtists[0]?.count || 0) >= 20 ? '1' : (topArtists[0]?.count || 0) >= 10 ? '3' : '5';

    let personaTitle = 'Vibe Mimarı';
    let personaDesc = 'Her anın duygusunu yakalayan, çalma listeleriyle ortama ruh katan dinleyici.';
    if (insights.peakHour >= 22 || insights.peakHour <= 4) {
      personaTitle = 'Gece Melodisi Tutkunu';
      personaDesc = 'Şehir uyurken kulaklığın en yüksek ritimde çalışır. Gece saatleri senin gerçek sahnen.';
    } else if (totalMinutes >= 1200) {
      personaTitle = 'Durdurulamaz Müzik Aşığı';
      personaDesc = 'Müziği bir arka plan sesi değil, gününün ana motoru olarak yaşıyorsun.';
    } else if (streak >= 7) {
      personaTitle = 'Sadık Ritim Yolcusu';
      personaDesc = 'Günün nasıl geçerse geçsin ritmi hiç bırakmadın. İstikrarlı dinleme serinle fark yarattın.';
    } else if (insights.uniqueArtists >= 12) {
      personaTitle = 'Türler Arası Kaşif';
      personaDesc = 'Tek bir kalıba sığmıyorsun; sürekli yeni sanatçılar ve taze tınılar keşfediyorsun.';
    }

    const totalArtistPlays = Math.max(1, topArtists.reduce((s, a) => s + a.count, 0));
    const maxDayMin = Math.max(1, ...insights.weekdayMinutes);
    const maxMonthMin = Math.max(1, ...insights.topMonths.map((m) => m.minutes));
    const dayLabels = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
    const firstTrack = topTracks[0] || null;
    const firstThumb = firstTrack ? thumbUrl(resolveTrackThumbRaw(firstTrack), 320) : FALLBACK_ART;

    const cardThemes = [
      { id: 'black', bg: '#121212', fg: '#ffffff', accent: '#1ed760', sub: 'rgba(255,255,255,0.72)' },
      { id: 'lime', bg: '#d2e798', fg: '#121212', accent: '#121212', sub: 'rgba(18,18,18,0.72)' },
      { id: 'pink', bg: '#ff4d8d', fg: '#121212', accent: '#121212', sub: 'rgba(18,18,18,0.75)' },
      { id: 'purple', bg: '#7d3cff', fg: '#ffffff', accent: '#ffe600', sub: 'rgba(255,255,255,0.78)' },
    ];
    let selectedThemeIdx = 0;

    const slides = [
      {
        bg: '#121212',
        fg: '#ffffff',
        decor: `
          <div class="m-wrapped-blob" style="width:280px;height:280px;top:-60px;right:-70px;background:#1ed760;opacity:0.45;"></div>
          <div class="m-wrapped-blob" style="width:260px;height:260px;bottom:-50px;left:-60px;background:#ff4d8d;opacity:0.42;animation-delay:-2.5s;"></div>
          <div class="m-wrapped-stripe" style="width:360px;height:44px;top:24%;left:-60px;background:#7d3cff;transform:rotate(-18deg);"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker" style="color:#1ed760;">${yearNow} ÖZETİN HAZIR</div>
          <div class="m-wrapped-hero">Sunify<br/>Wrapped</div>
          <div class="m-wrapped-sub">Bu yıl kulaklığından geçen her ritmi, her zirve anını senin için bir araya getirdik.</div>
          <div class="m-wrapped-pill" style="background:#1ed760;color:#121212;margin-top:24px;"><i class="fa-solid fa-headphones"></i> ${escapeHtml(username)}</div>
        `,
      },
      {
        bg: '#ff4d8d',
        fg: '#121212',
        decor: `
          <div class="m-wrapped-blob" style="width:240px;height:240px;top:-40px;left:-60px;background:#ffe600;opacity:0.5;"></div>
          <div class="m-wrapped-stripe" style="width:420px;height:52px;bottom:14%;right:-90px;background:#121212;transform:rotate(-14deg);"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker">BU YIL MÜZİĞE DOYDUN</div>
          <div class="m-wrapped-giant" style="margin:12px 0 6px;">${totalMinutes.toLocaleString('tr-TR')}</div>
          <div class="m-wrapped-hero" style="font-size:32px;margin:0 0 14px;">dakika dinledin</div>
          <div class="m-wrapped-sub">Bu tam <strong>${totalHours} saat</strong> kesintisiz müzik demek.<br/>Yıl boyunca <strong>${insights.uniqueTracks} farklı parça</strong> ve <strong>${insights.uniqueArtists} sanatçı</strong> keşfettin.</div>
          <div class="m-wrapped-pill" style="background:#121212;color:#ffe600;margin-top:22px;"><i class="fa-solid fa-fire"></i> En aktif %${topPercentile} dinleyici dilimindesin</div>
        `,
      },
      {
        bg: '#d2e798',
        fg: '#121212',
        decor: `
          <div class="m-wrapped-blob" style="width:240px;height:240px;bottom:-50px;right:-40px;background:#1ed760;opacity:0.55;"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker">DİNLEME EVRİMİN</div>
          <div class="m-wrapped-hero" style="font-size:36px;">Zirve Yaptığın Aylar</div>
          <div class="m-wrapped-sub">En yoğun müzik dönemin <strong>${escapeHtml(insights.topMonths[0]?.label || 'Bu Ay')}</strong> oldu.</div>
          <div class="m-wrapped-hbar-wrap">
            ${insights.topMonths.map((m, i) => `
              <div style="animation:wrapSlideUp 0.45s cubic-bezier(0.22,1,0.36,1) ${0.08 * i}s both;">
                <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:800;">
                  <span>${escapeHtml(m.label)}</span>
                  <span>${m.minutes} dk</span>
                </div>
                <div class="m-wrapped-hbar-track">
                  <div class="m-wrapped-hbar-fill" style="width:${Math.max(12, Math.round((m.minutes / maxMonthMin) * 100))}%;background:${i === 0 ? '#121212' : 'rgba(18,18,18,0.52)'};animation-delay:${0.1 * i}s;"></div>
                </div>
              </div>
            `).join('')}
          </div>
        `,
      },
      {
        bg: '#7d3cff',
        fg: '#ffffff',
        decor: `
          <div class="m-wrapped-blob" style="width:240px;height:240px;top:-40px;right:-50px;background:#ff4d8d;opacity:0.45;"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker" style="color:#ffe600;">HAFTALIK RİTMİN &amp; SAATİN</div>
          <div class="m-wrapped-hero" style="font-size:34px;">En Aktif Günün: ${escapeHtml(insights.peakWeekday)}</div>
          <div class="m-wrapped-days-chart">
            ${insights.weekdayMinutes.map((mins, idx) => {
              const isPeak = dayLabels[idx] && insights.peakWeekday.toLowerCase().startsWith(dayLabels[idx].toLowerCase().slice(0, 2));
              const hPct = Math.max(14, Math.round((mins / maxDayMin) * 100));
              return `
                <div class="m-wrapped-day-col">
                  <div class="m-wrapped-day-bar" style="height:${hPct}%;background:${isPeak ? '#ffe600' : 'rgba(255,255,255,0.45)'};animation-delay:${idx * 0.06}s;"></div>
                  <div class="m-wrapped-day-lbl" style="color:${isPeak ? '#ffe600' : '#fff'};">${dayLabels[idx]}</div>
                </div>`;
            }).join('')}
          </div>
          <div class="m-wrapped-pill" style="background:#ffe600;color:#121212;margin-top:8px;"><i class="fa-solid fa-clock"></i> ${escapeHtml(insights.peakHourLabel)} · ${escapeHtml(insights.peakHourMood)}</div>
        `,
      },
      {
        bg: '#1ed760',
        fg: '#121212',
        decor: `
          <div class="m-wrapped-stripe" style="width:420px;height:48px;top:16%;right:-100px;background:#121212;transform:rotate(-20deg);"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker">#1 NUMARALI ŞARKIN</div>
          <div class="m-wrapped-sub" style="font-weight:800;">Bir şarkı vardı ki elinden bırakamadın...</div>
          <div class="m-wrapped-cover-frame"><img src="${escapeHtml(firstThumb)}" alt="" /></div>
          <div class="m-wrapped-hero" style="font-size:32px;margin:0 0 6px;">${escapeHtml(firstTrack?.title || 'Henüz parça yok')}</div>
          <div class="m-wrapped-sub" style="font-weight:800;">${escapeHtml(firstTrack?.artist || '')}</div>
          <div class="m-wrapped-pill" style="background:#121212;color:#1ed760;margin-top:16px;"><i class="fa-solid fa-repeat"></i> Tam ${firstTrack?.playCount || 0} kez baştan sona dinledin</div>
        `,
      },
      {
        bg: '#ff6b2b',
        fg: '#121212',
        decor: `
          <div class="m-wrapped-blob" style="width:240px;height:240px;bottom:-60px;left:-40px;background:#ffe600;opacity:0.45;"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker">${yearNow} LİSTEN</div>
          <div class="m-wrapped-hero" style="font-size:34px;margin-bottom:6px;">En Çok Dinlenen 5 Şarkın</div>
          <div class="m-wrapped-list">
            ${topTracks.length ? topTracks.map((t, i) => `
              <div class="m-wrapped-row" style="background:rgba(18,18,18,0.14);animation-delay:${i * 0.08}s;">
                <div class="m-wrapped-rank">${i + 1}</div>
                <img class="m-wrapped-mini-art" src="${escapeHtml(thumbUrl(resolveTrackThumbRaw(t), 128))}" alt="" />
                <div class="m-wrapped-row-meta">
                  <div class="m-wrapped-row-title">${escapeHtml(t.title)}</div>
                  <div class="m-wrapped-row-sub">${escapeHtml(t.artist || '')} · ${t.playCount || 0} dinleme</div>
                </div>
              </div>
            `).join('') : '<div class="m-wrapped-sub">Henüz tam dinlenen şarkı yok.</div>'}
          </div>
        `,
      },
      {
        bg: '#2d46b9',
        fg: '#ffffff',
        decor: `
          <div class="m-wrapped-blob" style="width:250px;height:250px;top:-40px;right:-60px;background:#ff99e5;opacity:0.42;"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker" style="color:#ff99e5;">FAVORİ SANATÇILARIN</div>
          <div class="m-wrapped-hero" style="font-size:34px;">${escapeHtml(topArtists[0]?.name || 'Sanatçıların')}</div>
          <div class="m-wrapped-pill" style="background:#ff99e5;color:#121212;margin-bottom:12px;"><i class="fa-solid fa-crown"></i> En sıkı %${fanPercentile} hayranları arasındasın</div>
          <div class="m-wrapped-hbar-wrap">
            ${topArtists.map((a, i) => {
              const pct = Math.max(8, Math.round((a.count / totalArtistPlays) * 100));
              return `
                <div style="animation:wrapSlideUp 0.45s cubic-bezier(0.22,1,0.36,1) ${i * 0.08}s both;">
                  <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:800;">
                    <span>${i + 1}. ${escapeHtml(a.name)}</span>
                    <span>${a.count} çalma (%${pct})</span>
                  </div>
                  <div class="m-wrapped-hbar-track" style="background:rgba(255,255,255,0.2);">
                    <div class="m-wrapped-hbar-fill" style="width:${pct}%;background:${i === 0 ? '#ff99e5' : '#ffffff'};animation-delay:${i * 0.08}s;"></div>
                  </div>
                </div>`;
            }).join('')}
          </div>
        `,
      },
      {
        bg: '#121212',
        fg: '#ffffff',
        decor: `
          <div class="m-wrapped-blob" style="width:300px;height:300px;top:12%;left:-70px;background:#7d3cff;opacity:0.52;"></div>
          <div class="m-wrapped-blob" style="width:280px;height:280px;bottom:8%;right:-60px;background:#1ed760;opacity:0.46;animation-delay:-3s;"></div>
          <div class="m-wrapped-blob" style="width:220px;height:220px;top:42%;right:15%;background:#ff4d8d;opacity:0.4;animation-delay:-1.5s;"></div>
        `,
        html: () => `
          <div class="m-wrapped-kicker" style="color:#1ed760;">SES AURAN &amp; KİŞİLİĞİN</div>
          <div class="m-wrapped-hero" style="font-size:40px;margin:10px 0 14px;">${escapeHtml(personaTitle)}</div>
          <div class="m-wrapped-sub">${escapeHtml(personaDesc)}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:22px;">
            <div class="m-wrapped-pill" style="background:rgba(255,255,255,0.14);color:#fff;"><i class="fa-solid fa-fire" style="color:#ff6b2b;"></i> ${streak} Günlük Seri</div>
            <div class="m-wrapped-pill" style="background:rgba(255,255,255,0.14);color:#fff;"><i class="fa-solid fa-bolt" style="color:#ffe600;"></i> ${totalPlays} Tam Dinleme</div>
          </div>
        `,
      },
      {
        bg: '#0b0b12',
        fg: '#ffffff',
        decor: `
          <div class="m-wrapped-blob" style="width:260px;height:260px;top:-40px;left:-40px;background:#1ed760;opacity:0.32;"></div>
          <div class="m-wrapped-blob" style="width:260px;height:260px;bottom:-40px;right:-40px;background:#7d3cff;opacity:0.35;"></div>
        `,
        html: () => {
          const th = cardThemes[selectedThemeIdx] || cardThemes[0];
          return `
            <div class="m-wrapped-master" id="wrappedMasterCard" style="background:${th.bg};color:${th.fg};border:1px solid rgba(255,255,255,0.14);">
              <div class="m-wrapped-master-top">
                <img class="m-wrapped-master-art" src="${escapeHtml(firstThumb)}" alt="" />
                <div style="min-width:0;">
                  <div style="font-size:11px;font-weight:900;letter-spacing:0.12em;color:${th.accent};">SUNIFY WRAPPED ${yearNow}</div>
                  <div style="font-size:20px;font-weight:900;line-height:1.1;margin-top:3px;">${escapeHtml(username)}</div>
                  <div style="font-size:12px;font-weight:700;color:${th.sub};margin-top:3px;">${escapeHtml(personaTitle)}</div>
                </div>
              </div>
              <div class="m-wrapped-master-cols">
                <div>
                  <div class="m-wrapped-master-col-h">En İyi Sanatçılar</div>
                  ${topArtists.slice(0, 5).map((a, i) => `<div class="m-wrapped-master-item">${i + 1} ${escapeHtml(a.name)}</div>`).join('') || '<div class="m-wrapped-master-item">—</div>'}
                </div>
                <div>
                  <div class="m-wrapped-master-col-h">En İyi Şarkılar</div>
                  ${topTracks.slice(0, 5).map((t, i) => `<div class="m-wrapped-master-item">${i + 1} ${escapeHtml(t.title)}</div>`).join('') || '<div class="m-wrapped-master-item">—</div>'}
                </div>
              </div>
              <div class="m-wrapped-master-stats">
                <div>
                  <div class="m-wrapped-master-col-h">Dinlenen Dakika</div>
                  <div style="font-size:22px;font-weight:900;color:${th.accent};">${totalMinutes.toLocaleString('tr-TR')}</div>
                </div>
                <div>
                  <div class="m-wrapped-master-col-h">Zirve Zaman</div>
                  <div style="font-size:13px;font-weight:800;">${escapeHtml(insights.peakWeekday)} · ${escapeHtml(insights.peakHourMood)}</div>
                </div>
              </div>
            </div>
            <div class="m-wrapped-theme-dots" id="wrappedThemeDots">
              ${cardThemes.map((t, idx) => `<button type="button" class="m-wrapped-theme-dot ${idx === selectedThemeIdx ? 'active' : ''}" data-ti="${idx}" style="background:${t.bg};" aria-label="Tema"></button>`).join('')}
            </div>
            <div class="m-wrapped-actions">
              <button type="button" class="m-wrapped-cta primary" id="wrappedExportVideoBtn"><i class="fa-solid fa-clapperboard"></i> 36 sn Story Videosu Oluştur &amp; Paylaş (.mp4)</button>
              <button type="button" class="m-wrapped-cta secondary" id="wrappedExportPngBtn"><i class="fa-solid fa-image"></i> Özet Kartını Paylaş (PNG)</button>
            </div>
          `;
        },
      },
    ];

    const overlay = document.createElement('div');
    overlay.id = 'sunifyWrappedStoryOverlay';
    overlay.className = 'm-wrapped-overlay';
    overlay.innerHTML = `
      <div class="m-wrapped-bg-decor" id="wrappedDecor"></div>
      <div class="m-wrapped-topbar">
        <div class="m-wrapped-segs" id="wrappedSegs">
          ${slides.map((_, i) => `<div class="m-wrapped-seg" data-si="${i}"><div class="m-wrapped-seg-fill"></div></div>`).join('')}
        </div>
        <div class="m-wrapped-head">
          <div class="m-wrapped-brand"><span class="m-wrapped-brand-dot"></span> SUNIFY WRAPPED ${yearNow}</div>
          <div class="m-wrapped-head-btns">
            <button type="button" class="m-wrapped-icon-btn" id="wrappedMuteBtn" aria-label="Ses"><i class="fa-solid fa-volume-high"></i></button>
            <button type="button" class="m-wrapped-icon-btn" id="wrappedCloseBtn" aria-label="Kapat"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>
      </div>
      <div class="m-wrapped-stage" id="wrappedStage"></div>
    `;
    document.body.appendChild(overlay);

    let curIdx = 0;
    let paused = false;
    let elapsedMs = 0;
    const SLIDE_MS = 5800;
    let rafId = null;
    let lastTick = performance.now();
    let mutedByWrapped = false;

    const cleanup = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (mutedByWrapped) {
        audio.muted = false;
        mutedByWrapped = false;
      }
      overlay.remove();
    };

    const renderSlide = (idx) => {
      curIdx = Math.max(0, Math.min(slides.length - 1, idx));
      elapsedMs = 0;
      lastTick = performance.now();
      const s = slides[curIdx];
      overlay.style.background = s.bg;
      overlay.style.color = s.fg;
      const decorEl = overlay.querySelector('#wrappedDecor');
      const stageEl = overlay.querySelector('#wrappedStage');
      if (decorEl) decorEl.innerHTML = s.decor;
      if (stageEl) stageEl.innerHTML = s.html();

      overlay.querySelectorAll('.m-wrapped-seg').forEach((seg, i) => {
        seg.classList.toggle('done', i < curIdx);
        const fill = seg.querySelector('.m-wrapped-seg-fill');
        if (fill) fill.style.width = i < curIdx ? '100%' : '0%';
      });

      if (curIdx === slides.length - 1) {
        paused = true;
        const lastFill = overlay.querySelector(`.m-wrapped-seg[data-si="${curIdx}"] .m-wrapped-seg-fill`);
        if (lastFill) lastFill.style.width = '100%';

        overlay.querySelectorAll('#wrappedThemeDots .m-wrapped-theme-dot').forEach((dot) => {
          dot.onclick = (ev) => {
            ev.stopPropagation();
            selectedThemeIdx = Number(dot.dataset.ti) || 0;
            renderSlide(curIdx);
          };
        });

        const vidBtn = overlay.querySelector('#wrappedExportVideoBtn');
        if (vidBtn) {
          vidBtn.onclick = async (ev) => {
            ev.stopPropagation();
            vidBtn.disabled = true;
            showStoryProgressOverlay('Sunify Wrapped Videosu');
            try {
              const res = await api('/api/story/wrapped-video', {
                method: 'POST',
                body: JSON.stringify({
                  username,
                  coverRgb: state.currentCoverRgb,
                  totalMinutes,
                  totalPlays,
                  streakDays: streak,
                  uniqueTracks: insights.uniqueTracks,
                  uniqueArtists: insights.uniqueArtists,
                  weekdayMinutes: insights.weekdayMinutes,
                  peakWeekday: insights.peakWeekday,
                  topMonths: insights.topMonths,
                  peakHour: insights.peakHour,
                  peakHourLabel: insights.peakHourLabel,
                  peakHourMood: insights.peakHourMood,
                  topPercentile,
                  fanPercentile,
                  personaTitle,
                  personaDesc,
                  topTracks,
                  topArtists,
                }),
              });
              hideStoryProgressOverlay();
              showToast(`Galeriye kaydedildi: ${res.displayPath}`);
              if (bridge?.shareFilePath && res.cachePath) {
                bridge.shareFilePath(res.cachePath, 'video/mp4', 'Sunify Wrapped Videosu');
              }
            } catch (err) {
              hideStoryProgressOverlay();
              showToast(err.message || 'Özet videosu oluşturulamadı.');
            } finally {
              hideStoryProgressOverlay();
              vidBtn.disabled = false;
            }
          };
        }

        const pngBtn = overlay.querySelector('#wrappedExportPngBtn');
        if (pngBtn) {
          pngBtn.onclick = async (ev) => {
            ev.stopPropagation();
            showToast('Özet kartı oluşturuluyor...');
            try {
              const url = await window.SunifyCards.generateWrappedCardDataUrl({
                stats: state.listeningStats,
                username,
                coverRgb: state.currentCoverRgb,
                apiBase: API,
              });
              window.SunifyCards.shareOrDownloadCard(url, `sunify-wrapped-${Date.now()}.png`, 'Sunify Wrapped');
            } catch {
              showToast('Özet kartı oluşturulamadı.');
            }
          };
        }
      } else {
        paused = false;
      }
    };

    const tick = (now) => {
      const dt = now - lastTick;
      lastTick = now;
      if (!paused && curIdx < slides.length - 1) {
        elapsedMs += dt;
        const pct = Math.min(100, (elapsedMs / SLIDE_MS) * 100);
        const fill = overlay.querySelector(`.m-wrapped-seg[data-si="${curIdx}"] .m-wrapped-seg-fill`);
        if (fill) fill.style.width = `${pct}%`;
        if (elapsedMs >= SLIDE_MS) {
          renderSlide(curIdx + 1);
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    overlay.querySelector('#wrappedCloseBtn').onclick = (ev) => {
      ev.stopPropagation();
      cleanup();
    };

    const muteBtn = overlay.querySelector('#wrappedMuteBtn');
    muteBtn.onclick = (ev) => {
      ev.stopPropagation();
      mutedByWrapped = !mutedByWrapped;
      audio.muted = mutedByWrapped;
      muteBtn.innerHTML = `<i class="fa-solid ${mutedByWrapped ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
    };

    // Tap left/right to navigate slides (ignore clicks on buttons)
    let pressStart = 0;
    overlay.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      pressStart = Date.now();
      paused = true;
    });
    overlay.addEventListener('pointerup', (ev) => {
      if (ev.target.closest('button')) return;
      const held = Date.now() - pressStart;
      if (curIdx < slides.length - 1) paused = false;
      if (held < 260) {
        const x = ev.clientX;
        if (x < window.innerWidth * 0.34) {
          renderSlide(Math.max(0, curIdx - 1));
        } else if (curIdx < slides.length - 1) {
          renderSlide(curIdx + 1);
        }
      }
    });

    // Auto-start #1 track if nothing is playing
    if (firstTrack && audio.paused) {
      playTrack(firstTrack, topTracks, 0);
    }

    renderSlide(0);
    rafId = requestAnimationFrame(tick);
  }

  function openEditPlaylistSheet(ctx) {
    if (!ctx || ctx.readonly) return;
    let draftCover = ctx.cover || '';
    openSheet('Listeyi Düzenle', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';
      wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;">
          <img id="editPlCoverPrev" class="sfx-pl-cover-preview" src="${escapeHtml(draftCover || ctx.tracks?.[0]?.thumbnail || FALLBACK_ART)}" alt="" />
          <div style="display:flex;flex-direction:column;gap:6px;flex:1;">
            <label class="m-glass-btn" style="text-align:center;">
              <i class="fa-solid fa-image"></i> Galeriden Kapak Seç
              <input type="file" id="editPlCoverFile" accept="image/*" hidden />
            </label>
            <button class="m-glass-btn" id="editPlCoverClear" type="button">Özel Kapağı Kaldır</button>
          </div>
        </div>
        <input class="m-input" id="editPlNameInput" value="${escapeHtml(ctx.name || '')}" placeholder="Çalma listesi adı" />
        <textarea class="m-input" id="editPlDescInput" rows="3" style="height:auto;padding:10px 12px;resize:vertical;" placeholder="Açıklama (isteğe bağlı)">${escapeHtml(ctx.description || '')}</textarea>
        <button class="m-glass-btn primary" id="editPlSaveOk" type="button">Kaydet</button>`;

      const fileInput = wrap.querySelector('#editPlCoverFile');
      fileInput.onchange = async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
          draftCover = await window.SunifyCards.resizeImageFileToDataUrl(f, 192, 0.7);
          wrap.querySelector('#editPlCoverPrev').src = draftCover;
        } catch {
          showToast('Görsel yüklenemedi.');
        }
      };
      wrap.querySelector('#editPlCoverClear').onclick = () => {
        draftCover = '';
        wrap.querySelector('#editPlCoverPrev').src = ctx.tracks?.[0]?.thumbnail || FALLBACK_ART;
      };
      wrap.querySelector('#editPlSaveOk').onclick = () => {
        const nextName = wrap.querySelector('#editPlNameInput').value.trim();
        const nextDesc = wrap.querySelector('#editPlDescInput').value.trim().slice(0, 400);
        if (!nextName) return;
        const pl = state.playlists.find((p) => p.id === ctx.id);
        if (pl) {
          pl.name = nextName;
          pl.description = nextDesc;
          pl.cover = draftCover;
        }
        ctx.name = nextName;
        ctx.description = nextDesc;
        ctx.cover = draftCover;
        $('detailTitle').textContent = nextName;
        $('detailCover').src = draftCover || ctx.tracks?.[0]?.thumbnail || FALLBACK_ART;
        const descEl = $('detailDesc');
        if (descEl) {
          descEl.textContent = nextDesc;
          descEl.hidden = !nextDesc;
        }
        saveLocalData(true, true);
        renderLibrary();
        closeSheet();
        showToast('Liste güncellendi.');
      };
      return wrap;
    });
  }

  async function downloadAllPlaylistTracks(ctx) {
    const tracks = ctx?.tracks || [];
    if (!tracks.length) return showToast('İndirilecek şarkı yok.');
    if (localStorage.getItem('sunify_wifi_only_dl') === 'true' && bridge?.isWifiConnected && !bridge.isWifiConnected()) {
      return showToast("Yalnızca Wi-Fi'da indirme açık.");
    }
    const existingKeys = new Set((state.offlineTracks || []).map((x) => trackKey(x)));
    const targets = tracks.filter((t) => !existingKeys.has(trackKey(t)));
    if (!targets.length) return showToast('Bu listedeki tüm şarkılar zaten indirildi.');

    let done = 0;
    for (let i = 0; i < targets.length; i += 1) {
      showToast(`İndiriliyor (${i + 1}/${targets.length}): ${targets[i].title || ''}`);
      const ok = await saveOffline(targets[i], { silent: true, skipReload: true });
      if (ok) done += 1;
    }
    await loadOfflineTracks();
    renderLibrary();
    showToast(`${done}/${targets.length} şarkı çevrimdışı kaydedildi.`);
  }

  function renderAll(opts = {}) {
    renderDailyMixes(!opts.deferMixFetch);
    renderContinueRow();
    renderHomeStats();
    renderLibrary();
  }

  function syncNowPlayingModalNow() {
    const dur = audio.duration || state.currentTrack?.duration || 0;
    const cur = audio.currentTime || 0;
    $('npSeekSlider').value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
    $('npCurrentTime').textContent = fmtTime(cur);
    $('npDuration').textContent = fmtTime(dur);
    if ($('npLyricsPanel')?.classList.contains('active')) {
      syncMobileLyricsDom(cur, true);
    }
  }

  function bindEvents() {
    document.querySelectorAll('.m-dock-btn').forEach((b) => {
      b.onclick = () => switchTab(b.dataset.tab);
    });
    $('mTopAccountBtn').onclick = () => switchTab('settings');
    $('mBrandBtn').onclick = () => switchTab('home');
    $('mTopConnectBtn').onclick = () => openConnectJamSheet('connect');
    $('npConnectBtn').onclick = () => openConnectJamSheet('connect');
    $('npAudioFxBtn').onclick = () => openAudioFxSheet('eq');
    $('settingsOpenAudioFxBtn').onclick = () => openAudioFxSheet('eq');
    $('npSleepBtn').onclick = () => openAudioFxSheet('sleep');
    if ($('npAbLoopBtn')) $('npAbLoopBtn').onclick = () => openAbLoopSheet();
    if ($('npStoryClipBtn')) $('npStoryClipBtn').onclick = () => openLyricClipStorySheet();
    if ($('npLyricsClipVideoBtn')) $('npLyricsClipVideoBtn').onclick = () => openLyricClipStorySheet();
    if ($('npTrimBtn')) $('npTrimBtn').onclick = () => openMp3TrimmerSheet(state.currentTrack);
    if ($('npQrShareBtn')) $('npQrShareBtn').onclick = () => state.currentTrack && openQrShareSheet('track', state.currentTrack);
    if ($('checkUpdatesBtn')) $('checkUpdatesBtn').onclick = () => checkAppUpdates(true);
    $('homeOpenWrappedBtn').onclick = () => openWrappedSheet();

    $('miniOpenNowPlaying').onclick = () => {
      $('nowPlayingModal').classList.add('open');
      syncNowPlayingModalNow();
      window.SunifyAudioFX?.startVisualizerLoop();
    };
    $('npCloseBtn').onclick = () => $('nowPlayingModal').classList.remove('open');
    $('npQueueBtn').onclick = openQueueSheet;

    const miniEl = $('miniPlayer');
    if (miniEl) {
      let msx = 0;
      let msy = 0;
      miniEl.addEventListener('touchstart', (e) => {
        const pt = e.touches && e.touches[0];
        if (!pt) return;
        msx = pt.clientX;
        msy = pt.clientY;
      }, { passive: true });
      miniEl.addEventListener('touchend', (e) => {
        const pt = e.changedTouches && e.changedTouches[0];
        if (!pt || !msx) return;
        const dx = pt.clientX - msx;
        const dy = pt.clientY - msy;
        msx = 0;
        msy = 0;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 55) {
          if (dx < 0) playNext();
          else playPrev();
        } else if (dy < -55 && Math.abs(dy) > Math.abs(dx)) {
          $('nowPlayingModal').classList.add('open');
          syncNowPlayingModalNow();
          window.SunifyAudioFX?.startVisualizerLoop();
        }
      }, { passive: true });
    }

    document.querySelectorAll('.m-np-tab').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.m-np-tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        $('npCoverPanel').classList.toggle('active', t.dataset.npTab === 'cover');
        $('npLyricsPanel').classList.toggle('active', t.dataset.npTab === 'lyrics');
        if (t.dataset.npTab === 'lyrics') {
          syncMobileLyricsDom(audio.currentTime || 0, true);
        } else {
          window.SunifyAudioFX?.startVisualizerLoop();
        }
      };
    });

    $('miniPlayBtn').onclick = $('npPlayBtn').onclick = togglePlay;
    $('miniNextBtn').onclick = $('npNextBtn').onclick = playNext;
    $('npPrevBtn').onclick = playPrev;
    $('miniLikeBtn').onclick = $('npLikeBtn').onclick = () => toggleLike(state.currentTrack);
    $('npShuffleBtn').onclick = () => { state.shuffle = !state.shuffle; updatePlayerUI(); };
    $('npRepeatBtn').onclick = () => { state.repeat = !state.repeat; updatePlayerUI(); };
    $('npSaveOfflineBtn').onclick = () => saveOffline(state.currentTrack);
    $('npAddToPlaylistBtn').onclick = () => state.currentTrack && openAddToPlaylistSheet(state.currentTrack);
    $('npLyricsTranslateBtn').onclick = () => toggleMobileLyricsTranslate();
    $('npLyricsCardModeBtn').onclick = () => {
      state.lyricsCardMode = !state.lyricsCardMode;
      state.lyricsSelectedLines = [];
      $('npLyricsBox')?.querySelectorAll('.sfx-lyric-selected').forEach((el) => el.classList.remove('sfx-lyric-selected'));
      updateLyricCardBar();
    };
    $('npLyricsCardCancelBtn').onclick = () => {
      state.lyricsCardMode = false;
      state.lyricsSelectedLines = [];
      $('npLyricsBox')?.querySelectorAll('.sfx-lyric-selected').forEach((el) => el.classList.remove('sfx-lyric-selected'));
      updateLyricCardBar();
    };
    $('npLyricsCardShareBtn').onclick = async () => {
      if (!state.lyricsSelectedLines.length) return showToast('Önce 1–4 söz satırı seçin.');
      const allLines = Array.from($('npLyricsBox')?.querySelectorAll('.m-lyric-line') || []);
      const lines = [];
      const translations = [];
      state.lyricsSelectedLines.forEach((idx) => {
        const el = allLines[idx];
        if (!el) return;
        const trEl = el.querySelector('.sfx-lyric-tr');
        const trText = trEl ? trEl.textContent : String(state.lyricsTranslations[idx] || '');
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.sfx-lyric-tr').forEach((n) => n.remove());
        const txt = String(clone.textContent || '').trim();
        if (txt) {
          lines.push(txt);
          translations.push(state.lyricsTranslated ? trText : '');
        }
      });
      if (!lines.length) return;
      showToast('Söz kartı hazırlanıyor...');
      try {
        const url = await window.SunifyCards.generateLyricCardDataUrl({
          track: state.currentTrack,
          lines,
          translations,
          coverRgb: state.currentCoverRgb,
          apiBase: API,
        });
        window.SunifyCards.shareOrDownloadCard(url, `sunify-soz-${Date.now()}.png`, state.currentTrack?.title || 'Sunify Söz Kartı');
      } catch {
        showToast('Söz kartı oluşturulamadı.');
      }
      state.lyricsCardMode = false;
      state.lyricsSelectedLines = [];
      allLines.forEach((el) => el.classList.remove('sfx-lyric-selected'));
      updateLyricCardBar();
    };
    $('npLyricsSourceSelect').onchange = (e) => {
      state.lyricsSource = e.target.value;
      if (state.currentTrack) loadLyricsFor(state.currentTrack, state.lyricsSource);
    };
    const autoSyncBtn = $('npLyricsAutoSyncBtn');
    if (autoSyncBtn) {
      autoSyncBtn.classList.toggle('active', state.autoLyricsSync);
      autoSyncBtn.onclick = () => {
        state.autoLyricsSync = !state.autoLyricsSync;
        try { localStorage.setItem('sunify_auto_lyrics_sync', String(state.autoLyricsSync)); } catch {}
        autoSyncBtn.classList.toggle('active', state.autoLyricsSync);
        if (state.autoLyricsSync) {
          state.lastAutoSyncKey = '';
          saveMobileLyricOffset(state.currentTrack, 0, true);
          showToast('Otomatik söz senkronu açıldı.');
          runMobileAutoLyricsSync();
        } else {
          state.lyricsOffsetIsAuto = false;
          updateMobileOffsetUi({ persistManual: false });
          showToast('Otomatik söz senkronu kapatıldı.');
        }
      };
    }
    if ($('npLyricsAlignBtn')) {
      $('npLyricsAlignBtn').onclick = () => {
        if (!state.lyrics.length) return showToast('Hizalanacak senkron söz yok.');
        setMobileLyricsAlignMode(!state.lyricsAlignMode);
      };
    }
    if ($('npLyricsAlignCancelBtn')) {
      $('npLyricsAlignCancelBtn').onclick = () => setMobileLyricsAlignMode(false);
    }
    $('npLyricsMinusBtn').onclick = () => {
      state.lyricsOffset = Math.round((state.lyricsOffset - 0.5) * 10) / 10;
      state.lyricsOffsetIsAuto = false;
      updateMobileOffsetUi({ persistManual: true });
    };
    $('npLyricsPlusBtn').onclick = () => {
      state.lyricsOffset = Math.round((state.lyricsOffset + 0.5) * 10) / 10;
      state.lyricsOffsetIsAuto = false;
      updateMobileOffsetUi({ persistManual: true });
    };
    if ($('npLyricsOffsetVal')) {
      $('npLyricsOffsetVal').onclick = () => {
        state.lyricsOffset = 0;
        state.lyricsOffsetIsAuto = false;
        state.lastAutoSyncKey = '';
        updateMobileOffsetUi({ clearManual: true });
        if (state.autoLyricsSync) runMobileAutoLyricsSync();
        showToast('Söz gecikmesi sıfırlandı.');
      };
    }

    $('npSeekSlider').oninput = (e) => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const curBefore = audio.currentTime || 0;
        const targetTime = (Number(e.target.value) / 1000) * audio.duration;
        if (targetTime - curBefore > 6 && state.listenSession) {
          state.listenSession.skippedForward = true;
        }
        audio.currentTime = targetTime;
      }
    };

    audio.addEventListener('timeupdate', () => {
      const dur = audio.duration || state.currentTrack?.duration || 0;
      const cur = audio.currentTime || 0;
      const nowMs = Date.now();
      const rawDt = !audio.paused && state.lastTimeUpdateMs > 0 ? Math.max(0, (nowMs - state.lastTimeUpdateMs) / 1000) : 0;
      const curKey = state.currentTrack?.title ? analyticsKey(state.currentTrack) : '';
      const sess = state.listenSession;
      let playedSec = Math.min(2.0, rawDt);

      if (curKey && sess && sess.trackKey === curKey) {
        const curDelta = cur - (Number(sess.lastCur) || 0);
        if (curDelta > 6 && curDelta > rawDt + 4) {
          sess.skippedForward = true;
        }
        if (!audio.paused) {
          playedSec = curDelta > 0 && !sess.skippedForward
            ? Math.min(curDelta, Math.max(rawDt + 0.5, 2.0))
            : Math.min(2.0, rawDt);
          sess.listened += playedSec;
        }
        sess.lastCur = cur;
      }

      if (!audio.paused && playedSec > 0) {
        state.listenTimeAccumSec += playedSec;
        if (state.listenTimeAccumSec >= 15) flushListenDuration(true);
      }
      state.lastTimeUpdateMs = audio.paused ? 0 : nowMs;
      const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
      $('miniProgressFill').style.width = `${pct}%`;

      const npOpen = $('nowPlayingModal')?.classList.contains('open');
      if (npOpen) {
        $('npSeekSlider').value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
        $('npCurrentTime').textContent = fmtTime(cur);
        $('npDuration').textContent = fmtTime(dur);
      }

      if (state.abLoop.a !== null && state.abLoop.b !== null && !audio.paused && cur >= state.abLoop.b) {
        audio.currentTime = state.abLoop.a;
        return;
      }

      if (!audio.paused && nowMs - state.lastNotifPushAt >= 4000) {
        updateNotification();
      }
      window.SunifyAudioFX?.handleTimeUpdate({
        currentTime: cur,
        duration: dur,
        trackKey: curKey,
        isPaused: audio.paused,
        isRepeatOne: state.repeat,
        onPrewarmNext: () => {
          if (state.queue.length > 1) {
            const nextTrack = state.queue[(state.queueIndex + 1) % state.queue.length];
            if (nextTrack && !nextTrack.localUrl) {
              api('/api/audio-prefetch', {
                method: 'POST',
                body: JSON.stringify({
                  id: nextTrack.id || '',
                  title: nextTrack.title || '',
                  artist: nextTrack.artist || '',
                  query: `${nextTrack.artist || ''} ${nextTrack.title || ''}`.trim(),
                }),
              }).catch(() => {});
            }
          }
        },
        onCrossfadeTrigger: () => {
          if (state.queue.length > 1) playNext();
        },
      });

      if (npOpen && state.lyrics.length && $('npLyricsPanel')?.classList.contains('active')) {
        syncMobileLyricsDom(cur, false);
      }
    });
    audio.addEventListener('loadedmetadata', () => {
      const real = Number(audio.duration);
      if (!state.currentTrack || !Number.isFinite(real) || real <= 0) return;
      if (!state.lyricsDurationRefetched && (state.lyricsFetchedDuration <= 0 || Math.abs(state.lyricsFetchedDuration - real) > 3)) {
        state.lyricsDurationRefetched = true;
        loadLyricsFor(state.currentTrack, state.lyricsSource);
        return;
      }
      runMobileAutoLyricsSync();
    });
    audio.addEventListener('ended', () => {
      const endedTrack = state.currentTrack;
      const sess = state.listenSession;
      const endedDuration = Number(audio.duration) || Number(endedTrack?.duration) || 0;
      const needed = endedDuration > 0 ? Math.max(endedDuration * 0.95, endedDuration - 4) : 0;
      if (
        endedTrack?.title &&
        sess &&
        sess.trackKey === analyticsKey(endedTrack) &&
        !sess.completed &&
        !sess.skippedForward &&
        endedDuration > 0 &&
        sess.listened >= needed
      ) {
        sess.completed = true;
        trackSongCompletedEvent(endedTrack);
      }
      flushListenDuration(true);
      if (window.SunifyAudioFX?.notifyTrackEnded()) {
        state.isPlaying = false;
        updatePlayerUI();
        window.SunifyRealtime?.notifyLocalPlaybackChanged();
        return;
      }
      if (state.repeat && state.listenSession && state.currentTrack) {
        state.listenSession = {
          trackKey: analyticsKey(state.currentTrack),
          track: state.currentTrack,
          listened: 0,
          lastCur: 0,
          skippedForward: false,
          completed: false,
        };
      }
      playNext();
    });
    audio.addEventListener('seeked', () => {
      updateNotification();
      window.SunifyRealtime?.notifyLocalPlaybackChanged();
    });
    audio.addEventListener('play', () => {
      state.isPlaying = true;
      state.lastTimeUpdateMs = Date.now();
      updatePlayerUI();
      window.SunifyAudioFX?.startVisualizerLoop();
      window.SunifyRealtime?.notifyLocalPlaybackChanged();
    });
    audio.addEventListener('pause', () => {
      state.isPlaying = false;
      state.lastTimeUpdateMs = 0;
      flushListenDuration(true);
      updatePlayerUI();
      window.SunifyRealtime?.notifyLocalPlaybackChanged();
    });

    const maybeAutoPull = () => {
      if (document.visibilityState === 'visible' && state.auth.accessToken && Date.now() - state.lastCloudPullAt > 15000) {
        pullCloudData(false, { mergeLocal: true });
      }
    };
    document.addEventListener('visibilitychange', maybeAutoPull);
    window.addEventListener('focus', maybeAutoPull);
    setInterval(maybeAutoPull, 60000);

    document.querySelectorAll('#homeMoodChips .m-chip[data-mode]').forEach((c) => {
      c.onclick = () => {
        document.querySelectorAll('#homeMoodChips .m-chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        state.mood = c.dataset.mode;
        loadRecommendations(true);
      };
    });
    $('homeRefreshRecsBtn').onclick = () => loadRecommendations(true);
    $('homeRadioBtn').onclick = () => {
      state.mood = 'discover';
      loadRecommendations(true);
    };

    let searchT = null;
    $('searchInput').oninput = (e) => {
      $('searchClearBtn').hidden = !e.target.value;
      clearTimeout(searchT);
      searchT = setTimeout(() => runSearch(e.target.value), 350);
    };
    $('searchClearBtn').onclick = () => {
      $('searchInput').value = '';
      $('searchClearBtn').hidden = true;
      runSearch('');
    };
    document.querySelectorAll('#searchFilterChips .m-chip').forEach((c) => {
      c.onclick = () => {
        document.querySelectorAll('#searchFilterChips .m-chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        state.searchFilter = c.dataset.filter;
        runSearch($('searchInput').value);
      };
    });

    $('detailBackBtn').onclick = () => switchTab(state.prevTab);
    $('artistBackBtn').onclick = () => switchTab(state.prevTab);
    $('detailPlayAllBtn').onclick = () => {
      const tracks = state.detailContext?.tracks || [];
      if (tracks.length) playTrack(tracks[0], tracks, 0);
    };
    $('detailShuffleBtn').onclick = () => {
      const tracks = (state.detailContext?.tracks || []).slice().sort(() => Math.random() - 0.5);
      if (tracks.length) playTrack(tracks[0], tracks, 0);
    };
    $('detailQueueBtn').onclick = () => {
      const tracks = state.detailContext?.tracks || [];
      state.queue.push(...tracks);
      showToast(`${tracks.length} şarkı sıraya eklendi.`);
    };
    $('detailDownloadAllBtn').onclick = () => downloadAllPlaylistTracks(state.detailContext);
    $('detailReorderBtn').onclick = () => {
      if (!state.detailContext || state.detailContext.readonly) return;
      state.detailReorderMode = !state.detailReorderMode;
      openDetail(state.detailContext);
    };
    $('detailRenameBtn').onclick = () => openEditPlaylistSheet(state.detailContext);
    $('libReorderBtn').onclick = () => {
      state.libReorderMode = !state.libReorderMode;
      renderLibrary();
    };
    $('detailDeleteBtn').onclick = () => {
      const id = state.detailContext?.id;
      state.playlists = state.playlists.filter((p) => p.id !== id);
      saveLocalData(true);
      renderLibrary();
      switchTab('library');
      showToast('Çalma listesi silindi.');
    };
    $('detailSaveBtn').onclick = () => {
      const ctx = state.detailContext;
      if (!ctx) return;
      state.playlists.unshift({ id: `pl_${Date.now()}`, name: ctx.name, cover: ctx.cover, tracks: ctx.tracks || [] });
      saveLocalData(true);
      renderLibrary();
      $('detailSaveBtn').hidden = true;
      showToast('Kitaplığa eklendi.');
    };
    $('detailFilterInput').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      const tracks = (state.detailContext?.tracks || []).filter(
        (t) => !q || String(t.title || '').toLowerCase().includes(q) || String(t.artist || '').toLowerCase().includes(q)
      );
      renderTrackRows($('detailTrackList'), tracks, { playlistId: state.detailContext?.readonly ? null : state.detailContext?.id });
    };

    $('libNewPlaylistBtn').onclick = () => {
      openSheet('Yeni Çalma Listesi', () => {
        const wrap = document.createElement('div');
        wrap.className = 'm-auth-form';
        wrap.innerHTML = `<input class="m-input" id="newPlName" placeholder="Liste adı" /><button class="m-glass-btn primary" id="createPlOk" type="button">Oluştur</button>`;
        wrap.querySelector('#createPlOk').onclick = () => {
          const name = wrap.querySelector('#newPlName').value.trim();
          if (!name) return;
          state.playlists.unshift({ id: `pl_${Date.now()}`, name, tracks: [] });
          saveLocalData(true);
          renderLibrary();
          closeSheet();
        };
        return wrap;
      });
    };

    $('libImportPlaylistBtn').onclick = () => {
      openSheet('URL ile Liste İçe Aktar', () => {
        const wrap = document.createElement('div');
        wrap.className = 'm-auth-form';
        wrap.innerHTML = `<input class="m-input" id="impPlUrl" placeholder="YouTube / Spotify playlist bağlantısı" /><button class="m-glass-btn primary" id="impPlOk" type="button">İçe Aktar</button>`;
        wrap.querySelector('#impPlOk').onclick = async () => {
          const url = wrap.querySelector('#impPlUrl').value.trim();
          if (!url) return;
          showToast('İçe aktarılıyor...');
          try {
            const imp = await api('/api/import-playlist', { method: 'POST', body: JSON.stringify({ url }) });
            state.playlists.unshift({ id: `pl_${Date.now()}`, name: imp.name || 'İçe Aktarılan Liste', cover: imp.cover || imp.thumbnail || '', tracks: imp.tracks || [] });
            saveLocalData(true);
            renderLibrary();
            closeSheet();
            showToast('Liste eklendi.');
          } catch (e) {
            showToast(e.message || 'İçe aktarılamadı.');
          }
        };
        return wrap;
      });
    };

    document.querySelectorAll('#themeSegmented button').forEach((b) => {
      b.onclick = () => {
        state.theme = b.dataset.themeVal;
        applyTheme();
      };
    });
    document.querySelectorAll('#accentDots button').forEach((b) => {
      b.onclick = () => {
        state.accent = b.dataset.accent;
        applyTheme();
      };
    });
    $('clearCacheBtn').onclick = async () => {
      try {
        await api('/api/audio-cache/clear', { method: 'POST' });
        refreshStorageStats();
        showToast('Önbellek temizlendi.');
      } catch {}
    };

    const visToggle = $('settingMobileVisualizer');
    if (visToggle) {
      visToggle.onchange = () => {
        window.SunifyAudioFX?.setVisualizerEnabled(visToggle.checked);
      };
    }
    const wifiToggle = $('settingWifiOnlyDl');
    if (wifiToggle) {
      wifiToggle.onchange = () => {
        localStorage.setItem('sunify_wifi_only_dl', String(wifiToggle.checked));
        showToast(wifiToggle.checked ? "Yalnızca Wi-Fi'da indirme açıldı." : 'Tüm ağlarda indirmeye izin verildi.');
      };
    }
    const smartCacheToggle = $('settingSmartCache');
    if (smartCacheToggle) {
      smartCacheToggle.onchange = () => {
        localStorage.setItem('sunify_smart_cache', String(smartCacheToggle.checked));
        showToast(smartCacheToggle.checked ? "Akıllı Wi-Fi çevrimdışı önbellek açıldı." : 'Akıllı çevrimdışı önbellek kapatıldı.');
        if (smartCacheToggle.checked) runSmartOfflineCache();
      };
    }

    $('sheetCloseBtn').onclick = closeSheet;
    $('sheetBackdrop').onclick = (e) => {
      if (e.target === $('sheetBackdrop')) closeSheet();
    };

    const updateConnectIndicators = () => {
      const hasActive = Boolean(
        (window.SunifyRealtime?.getRemoteDevices() || []).length || window.SunifyRealtime?.getJamRoom()
      );
      $('mTopConnectBtn')?.classList.toggle('sfx-connect-active', hasActive);
      $('npConnectBtn')?.classList.toggle('sfx-connect-active', hasActive);
      if (typeof mobileConnectSheetRefresh === 'function') mobileConnectSheetRefresh();
    };
    window.SunifyRealtime?.onDevicesChanged(updateConnectIndicators);
    window.SunifyRealtime?.onJamChanged(updateConnectIndicators);

    window.__sunifyOnDeepLink = handleDeepLink;

    window.__sunifyOnAndroidMediaAction = (action) => {
      if (action === 'toggle') togglePlay();
      else if (action === 'play') {
        if (state.currentTrack && audio.paused) togglePlay();
      } else if (action === 'pause') {
        if (!audio.paused) togglePlay();
      } else if (action === 'next') playNext();
      else if (action === 'prev' || action === 'previous') playPrev();
      else if (action === 'like') toggleLike(state.currentTrack);
      else if (String(action || '').startsWith('seek:')) {
        const ms = Number(String(action).slice(5));
        if (Number.isFinite(ms) && Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.max(0, Math.min(audio.duration, ms / 1000));
          updateNotification();
        }
      }
    };
  }

  async function boot() {
    applyTheme();
    loadLocalData();
    bindEvents();
    const visEl = $('settingMobileVisualizer');
    if (visEl) visEl.checked = window.SunifyAudioFX ? window.SunifyAudioFX.getState().visualizerEnabled : true;
    const wifiEl = $('settingWifiOnlyDl');
    if (wifiEl) wifiEl.checked = localStorage.getItem('sunify_wifi_only_dl') === 'true';
    const smartEl = $('settingSmartCache');
    if (smartEl) smartEl.checked = localStorage.getItem('sunify_smart_cache') === 'true';
    window.SunifyAudioFX?.attachVisualizer($('npVisualizerCanvas'), { bars: 26 });
    updatePlayerUI();
    renderAll({ deferMixFetch: true });
    try {
      const ver = bridge?.getAppVersion ? String(bridge.getAppVersion()) : '1.2.1';
      $('settingsVersionText').textContent = `v${ver}`;
    } catch {}
    await initAuth();
    loadOfflineTracks().then(renderLibrary);
    if (bridge?.hasDeviceMusicPermission?.()) {
      loadDeviceMusic(false).then(renderLibrary);
    }
    loadDailyChart();
    setTimeout(() => loadRecommendations(false), 300);
    setTimeout(() => renderDailyMixes(true), 800);
    setTimeout(() => checkAppUpdates(false), 4500);
    setTimeout(() => runSmartOfflineCache(), 8000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
