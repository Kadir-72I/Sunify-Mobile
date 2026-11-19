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
    lyricsFetchedDuration: 0,
    lyricsDurationRefetched: false,
    lastLyricIdx: -1,
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

  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';

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

  function normalizeTrackAnalytics(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const source = raw.tracks && typeof raw.tracks === 'object' && !Array.isArray(raw.tracks) ? raw.tracks : raw;
    const out = {};
    Object.entries(source).forEach(([k, val]) => {
      if (k === '__dailyLog') {
        out.__dailyLog = sanitizeDailyLog(val);
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

  function saveLocalData(pushCloud = true, includeStructure = true) {
    if (includeStructure) syncPlaylistMetaIntoStats();
    localStorage.setItem(accountKey('sunify_playlists'), JSON.stringify(state.playlists));
    localStorage.setItem(accountKey('sunify_liked'), JSON.stringify(state.likedTracks));
    localStorage.setItem(accountKey('sunify_listening_stats'), JSON.stringify(state.listeningStats));
    localStorage.setItem(accountKey('sunify_recent_tracks'), JSON.stringify(state.recentTracks.slice(0, 14)));
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
    if (count) count.textContent = `1–4 satır seç (${state.lyricsSelectedLines.length}/4)`;
  }

  function handleLyricLineTap(el, idx) {
    if (state.lyricsCardMode) {
      const pos = state.lyricsSelectedLines.indexOf(idx);
      if (pos >= 0) {
        state.lyricsSelectedLines.splice(pos, 1);
        el.classList.remove('sfx-lyric-selected');
      } else {
        if (state.lyricsSelectedLines.length >= 4) {
          showToast('En fazla 4 satır seçebilirsiniz.');
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
    state.lastLyricIdx = -1;
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
          box.querySelectorAll('.m-lyric-line').forEach((el, idx) => {
            el.onclick = () => handleLyricLineTap(el, idx);
          });
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
    updatePlayerUI();
    applyCoverAdaptiveColor(track?.thumbnail || '').catch(() => {});

    window.SunifyAudioFX?.init(audio);
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
    if (Number(options.startAtSec) > 0) {
      const seekSec = Number(options.startAtSec);
      const applyStart = () => {
        try {
          if (Number.isFinite(audio.duration) && audio.duration > seekSec) audio.currentTime = seekSec;
        } catch {}
      };
      audio.addEventListener('loadedmetadata', applyStart, { once: true });
    }
    if (options.autoPlay !== false) {
      try {
        await audio.play();
      } catch {
        showToast('Ses başlatılıyor...');
      }
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
    if (!tracks || !tracks.length) {
      container.innerHTML = `<div class="m-empty-card">${escapeHtml(opts.emptyText || 'Şarkı bulunamadı.')}</div>`;
      return;
    }
    container.innerHTML = tracks
      .map((t, i) => {
        const playing = state.currentTrack && trackKey(state.currentTrack) === trackKey(t);
        const liked = isLiked(t);
        const playCount = opts.showPlayCount ? Number(t.playCount || t.play_count) || 0 : 0;
        const subText = playCount > 0
          ? `${t.artist || 'Sanatçı'} · ${playCount} dinleme`
          : (t.artist || 'Sanatçı');
        const reorderHtml = opts.reorderMode && opts.playlistId
          ? `<button class="m-row-btn" data-act="move-up" type="button" aria-label="Yukarı"><i class="fa-solid fa-arrow-up"></i></button><button class="m-row-btn" data-act="move-down" type="button" aria-label="Aşağı"><i class="fa-solid fa-arrow-down"></i></button>`
          : '';
        return `
          <div class="m-track-row ${playing ? 'playing' : ''}" data-idx="${i}">
            <img class="m-track-thumb" src="${escapeHtml(t.thumbnail || FALLBACK_ART)}" alt="" loading="lazy" />
            <div class="m-track-meta">
              <div class="m-track-title">${escapeHtml(t.title)}</div>
              <div class="m-track-artist">${escapeHtml(subText)}</div>
            </div>
            <div class="m-track-actions">
              ${reorderHtml}
              <button class="m-row-btn ${liked ? 'liked' : ''}" data-act="like" type="button"><i class="${liked ? 'fa-solid' : 'fa-regular'} fa-heart"></i></button>
              <button class="m-row-btn" data-act="more" type="button"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
          </div>`;
      })
      .join('');

    container.querySelectorAll('.m-track-row').forEach((row) => {
      const idx = Number(row.dataset.idx);
      const track = tracks[idx];
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
        if (dx > 64 && Math.abs(dy) < 28) {
          row.classList.add('swipe-queue-ready');
        } else {
          row.classList.remove('swipe-queue-ready');
        }
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
    });
  }

  function openTrackMenuSheet(track, playlistId = null) {
    openSheet(track.title || 'Şarkı', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-track-list';
      const actions = [
        { icon: 'fa-forward-step', label: 'Sıradaki Çal (Hemen Sonra)', fn: () => { insertPlayNext(track); closeSheet(); } },
        { icon: 'fa-list-ul', label: 'Çalma Sırasına Ekle', fn: () => { state.queue.push(track); showToast('Sıraya eklendi.'); closeSheet(); } },
        { icon: 'fa-folder-plus', label: 'Çalma Listesine Ekle', fn: () => openAddToPlaylistSheet(track) },
        { icon: 'fa-cloud-arrow-down', label: 'Çevrimdışı İndir', fn: () => { saveOffline(track); closeSheet(); } },
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
    if (!opts.silent) showToast('İndiriliyor...');
    try {
      await api('/api/save-track-locally', {
        method: 'POST',
        body: JSON.stringify({
          id: track.id || '',
          title: track.title || '',
          artist: track.artist || '',
          query: `${track.artist || ''} ${track.title || ''}`.trim(),
        }),
      });
      if (!opts.silent) showToast('Çevrimdışı için kaydedildi.');
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

  function renderDailyMixes() {
    const topTracks = getTopListenedTracks(25);
    const similarSeeds = collectSeeds(6);
    const topArtists = collectKnownArtists(6);
    const allKnownArtists = collectKnownArtists(25);
    const mixes = [
      { id: 'mix-1', badge: 'MIX 1', title: 'En çok dinlediklerin', sub: `${topTracks.length} şarkı`, tracks: topTracks, cover: topTracks[0]?.thumbnail || FALLBACK_ART },
      { id: 'mix-2', badge: 'MIX 2', title: 'Sana benzer şarkılar', sub: '25 şarkılık Daily Mix', tracks: null, mode: 'similar', seeds: similarSeeds, cover: state.likedTracks[0]?.thumbnail || FALLBACK_ART },
      { id: 'mix-3', badge: 'MIX 3', title: 'Bugün en çok dinlenenler', sub: 'Sunify topluluğu · bugün', tracks: null, daily: true, cover: FALLBACK_ART },
      { id: 'mix-4', badge: 'MIX 4', title: 'Favori sanatçıların', sub: topArtists.slice(0, 2).join(', ') || 'En çok dinlediklerinden', tracks: null, artists: topArtists, cover: topTracks[1]?.thumbnail || FALLBACK_ART },
      { id: 'mix-5', badge: 'MIX 5', title: 'Yeni keşifler', sub: 'Tarzına uygun yeni keşifler', tracks: null, mode: 'discovery', seeds: similarSeeds, excludeArtists: allKnownArtists, cover: FALLBACK_ART },
    ];

    const el = $('homeDailyMixes');
    el.innerHTML = mixes
      .map(
        (m, i) => `
        <div class="m-card" data-mi="${i}">
          <div class="m-card-cover-wrap">
            <img id="mixImg_${i}" src="${escapeHtml(m.cover)}" alt="" />
            <span class="m-mix-badge">${m.badge}</span>
          </div>
          <div class="m-card-title">${escapeHtml(m.title)}</div>
          <div class="m-card-sub" id="mixSub_${i}">${escapeHtml(m.sub)}</div>
        </div>`
      )
      .join('');

    mixes.forEach(async (m, i) => {
      if (!Array.isArray(m.tracks)) {
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
      }
    });

    el.querySelectorAll('.m-card').forEach((c) => {
      c.onclick = () => {
        const mix = mixes[Number(c.dataset.mi)];
        if (!mix.tracks?.length) return showToast('Bu mix henüz hazırlanıyor.');
        openDetail({ id: mix.id, name: mix.title, subtitle: `${mix.tracks.length} parça`, cover: mix.tracks[0]?.thumbnail || mix.cover, tracks: mix.tracks, readonly: true });
      };
    });
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

  function renderLibrary() {
    const el = $('libraryGrid');
    const reorderBtn = $('libReorderBtn');
    if (reorderBtn) reorderBtn.classList.toggle('primary', state.libReorderMode);
    const cards = [
      { type: 'liked', title: 'Beğenilen Şarkılar', sub: `${state.likedTracks.length} parça`, icon: 'fa-heart', cls: 'liked-grad' },
      { type: 'offline', title: 'İndirilenler', sub: `${state.offlineTracks.length} parça`, icon: 'fa-cloud-arrow-down', cls: 'offline-grad' },
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
          ? `<div class="m-lib-card" data-li="${i}"><img class="m-lib-cover" src="${escapeHtml(c.cover)}" alt="" /><div class="m-card-title">${escapeHtml(c.title)}</div><div class="m-card-sub">${escapeHtml(c.sub)}</div>${reorderHtml}</div>`
          : `<div class="m-lib-card" data-li="${i}"><div class="m-lib-cover ${c.cls}"><i class="fa-solid ${c.icon}"></i></div><div class="m-card-title">${escapeHtml(c.title)}</div><div class="m-card-sub">${escapeHtml(c.sub)}</div></div>`;
      })
      .join('');

    el.querySelectorAll('.m-lib-card').forEach((card) => {
      card.onclick = (e) => {
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
    window.SunifyAudioFX?.init(audio);
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
                <button type="button" class="m-glass-btn" id="jamLeaveBtn" style="flex:1;color:#ff8ea1;"><i class="fa-solid fa-right-from-bracket"></i> Odadan Çık</button>
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

  function openWrappedSheet() {
    openSheet('Sunify Dinleme Özeti', () => {
      const wrap = document.createElement('div');
      wrap.className = 'm-auth-form';
      const topTracks = getTopListenedTracks(5);
      const entries = Object.entries(state.listeningStats || {})
        .filter(([k, v]) => !k.startsWith('__') && v && typeof v === 'object' && v.title)
        .map(([, v]) => v);
      const totalPlays = entries.reduce((s, e) => s + (Number(e.playCount) || 0), 0);
      const totalMinutes = Math.round(entries.reduce((s, e) => s + (Number(e.totalSeconds) || 0), 0) / 60);
      const streak = window.SunifyCards?.computeStreakAndHeatmap(state.listeningStats)?.streakDays || 0;

      wrap.innerHTML = `
        <div class="m-stats-grid">
          <div class="m-stat-card"><div class="m-stat-val">${totalMinutes} dk</div><div class="m-stat-lbl">Toplam Süre</div></div>
          <div class="m-stat-card"><div class="m-stat-val">${totalPlays} · ${streak} gün</div><div class="m-stat-lbl">Tam Dinleme &amp; Seri</div></div>
        </div>
        <div class="m-settings-card" style="padding:12px;">
          <div class="m-card-title" style="font-size:13.5px;"><i class="fa-solid fa-crown"></i> En Çok Dinlenen Parçalar</div>
          ${topTracks.length ? topTracks.map((t, i) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px;"><span><strong>${i + 1}.</strong> ${escapeHtml(t.title)}</span><strong>${t.playCount}</strong></div>`).join('') : '<div class="m-empty-card">Henüz tam dinlenen şarkı yok.</div>'}
        </div>
        <button type="button" class="m-glass-btn primary" id="wrappedShareBtn"><i class="fa-solid fa-share-nodes"></i> Hikaye Kartını Paylaş / Kaydet</button>
      `;

      wrap.querySelector('#wrappedShareBtn').onclick = async () => {
        showToast('Özet kartı oluşturuluyor...');
        try {
          const username = state.auth.user?.user_metadata?.username || state.auth.user?.email?.split('@')[0] || '';
          const url = await window.SunifyCards.generateWrappedCardDataUrl({
            stats: state.listeningStats,
            username,
            coverRgb: state.currentCoverRgb,
            apiBase: API,
          });
          window.SunifyCards.shareOrDownloadCard(url, `sunify-ozet-${Date.now()}.png`, 'Sunify Dinleme Özeti');
        } catch {
          showToast('Özet kartı oluşturulamadı.');
        }
      };
      return wrap;
    });
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

  function renderAll() {
    renderDailyMixes();
    renderContinueRow();
    renderHomeStats();
    renderLibrary();
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
    $('homeOpenWrappedBtn').onclick = () => openWrappedSheet();

    $('miniOpenNowPlaying').onclick = () => {
      $('nowPlayingModal').classList.add('open');
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
    $('npLyricsMinusBtn').onclick = () => {
      state.lyricsOffset = Math.round((state.lyricsOffset - 0.5) * 10) / 10;
      $('npLyricsOffsetVal').textContent = `${state.lyricsOffset >= 0 ? '+' : ''}${state.lyricsOffset.toFixed(1)}s`;
    };
    $('npLyricsPlusBtn').onclick = () => {
      state.lyricsOffset = Math.round((state.lyricsOffset + 0.5) * 10) / 10;
      $('npLyricsOffsetVal').textContent = `${state.lyricsOffset >= 0 ? '+' : ''}${state.lyricsOffset.toFixed(1)}s`;
    };

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
      $('npSeekSlider').value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
      $('npCurrentTime').textContent = fmtTime(cur);
      $('npDuration').textContent = fmtTime(dur);

      if (!audio.paused && nowMs - state.lastNotifPushAt >= 4000) {
        updateNotification();
      }
      window.SunifyAudioFX?.handleTimeUpdate({
        currentTime: cur,
        duration: dur,
        trackKey: curKey,
        isPaused: audio.paused,
        isRepeatOne: state.repeat,
        onCrossfadeTrigger: () => {
          if (state.queue.length > 1) playNext();
        },
      });

      if (state.lyrics.length) {
        const effectiveTime = cur + state.lyricsOffset;
        let activeIdx = -1;
        for (let i = 0; i < state.lyrics.length; i++) {
          if (effectiveTime >= state.lyrics[i].time) activeIdx = i;
        }
        const rows = $('npLyricsBox').querySelectorAll('.m-lyric-line');
        rows.forEach((el, i) => {
          el.classList.toggle('active', i === activeIdx);
          el.classList.toggle('passed', activeIdx >= 0 && i < activeIdx);
          if (i === activeIdx) {
            const lineWords = state.lyrics[i]?.words || [];
            el.querySelectorAll('.m-lyric-word').forEach((wEl, wi) => {
              const w = lineWords[wi];
              wEl.classList.toggle('spoken', Boolean(w && effectiveTime >= w.startTime));
            });
          } else {
            el.querySelectorAll('.m-lyric-word.spoken').forEach((wEl) => wEl.classList.remove('spoken'));
          }
        });
        if (activeIdx >= 0 && activeIdx !== state.lastLyricIdx) {
          state.lastLyricIdx = activeIdx;
          rows[activeIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });
    audio.addEventListener('loadedmetadata', () => {
      const real = Number(audio.duration);
      if (!state.currentTrack || !Number.isFinite(real) || real <= 0 || state.lyricsDurationRefetched) return;
      if (state.lyricsFetchedDuration > 0 && Math.abs(state.lyricsFetchedDuration - real) <= 3) return;
      state.lyricsDurationRefetched = true;
      loadLyricsFor(state.currentTrack, state.lyricsSource);
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
    window.SunifyAudioFX?.attachVisualizer($('npVisualizerCanvas'), { bars: 26 });
    updatePlayerUI();
    renderAll();
    try {
      const ver = bridge?.getAppVersion ? String(bridge.getAppVersion()) : '1.2.1';
      $('settingsVersionText').textContent = `v${ver}`;
    } catch {}
    await initAuth();
    loadOfflineTracks().then(renderLibrary);
    loadRecommendations(false);
    loadDailyChart();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
