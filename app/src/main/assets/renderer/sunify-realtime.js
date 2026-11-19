/* sunify-realtime.js — Supabase Realtime Broadcast üzerinden Sunify Connect & Jam Odası */
(function initSunifyRealtimeModule(global) {
  const WS_URL =
    'wss://wkphoyochjczmqdmuazo.supabase.co/realtime/v1/websocket?apikey=sb_publishable_mEBku9YdyAUCUXGy96Y7UQ_erV1j-9L&vsn=1.0.0';

  function getOrCreateDeviceId() {
    let id = '';
    try {
      id = localStorage.getItem('sunify_device_id') || '';
      if (!id) {
        id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem('sunify_device_id', id);
      }
    } catch {
      id = `dev_${Math.random().toString(36).slice(2, 9)}`;
    }
    return id;
  }

  function defaultDeviceName() {
    try {
      const saved = localStorage.getItem('sunify_device_name');
      if (saved) return saved;
    } catch {}
    const isAndroid = Boolean(global.SunifyAndroidBridge) || /android/i.test(navigator.userAgent || '');
    return isAndroid ? 'Sunify Android' : 'Sunify Masaüstü';
  }

  const deviceId = getOrCreateDeviceId();
  let deviceName = defaultDeviceName();
  const platform = Boolean(global.SunifyAndroidBridge) || /android/i.test(navigator.userAgent || '') ? 'android' : 'pc';

  let ws = null;
  let refCounter = 1;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let shouldStayConnected = false;

  let connectTopic = '';
  let connectAdapter = null;
  let connectUserId = '';
  let connectBroadcastTimer = null;
  let connectPruneTimer = null;
  const remoteDevices = new Map();

  let jamTopic = '';
  let jamRoom = null;
  let jamAdapter = null;
  let jamHeartbeatTimer = null;
  let isApplyingRemoteSync = false;

  const listeners = {
    devices: [],
    jam: [],
  };

  function emitDevices() {
    const list = Array.from(remoteDevices.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    listeners.devices.forEach((fn) => {
      try {
        fn(list);
      } catch {}
    });
  }

  function emitJam() {
    const snap = jamRoom ? { ...jamRoom, members: [...(jamRoom.members || [])], queue: [...(jamRoom.queue || [])] } : null;
    listeners.jam.forEach((fn) => {
      try {
        fn(snap);
      } catch {}
    });
  }

  function nextRef() {
    refCounter += 1;
    return String(refCounter);
  }

  function sendPacket(packet) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ ...packet, ref: nextRef() }));
      return true;
    } catch {
      return false;
    }
  }

  function joinTopic(topic) {
    if (!topic) return;
    sendPacket({
      topic,
      event: 'phx_join',
      payload: { config: { broadcast: { self: false, ack: false } } },
    });
  }

  function leaveTopic(topic) {
    if (!topic) return;
    sendPacket({ topic, event: 'phx_leave', payload: {} });
  }

  function sendBroadcast(topic, eventName, payload) {
    if (!topic) return false;
    return sendPacket({
      topic,
      event: 'broadcast',
      payload: { type: 'broadcast', event: eventName, payload },
    });
  }

  function compactTrackForWire(track) {
    if (!track || !track.title) return null;
    return {
      id: String(track.id || '').slice(0, 180),
      title: String(track.title || '').slice(0, 260),
      artist: String(track.artist || '').slice(0, 220),
      thumbnail: String(track.thumbnail || '').startsWith('http') ? String(track.thumbnail).slice(0, 500) : '',
      duration: Number(track.duration) || 0,
      query: String(track.query || `${track.artist || ''} ${track.title || ''}`.trim()).slice(0, 300),
    };
  }

  function ensureSocket() {
    shouldStayConnected = Boolean(connectTopic || jamTopic);
    if (!shouldStayConnected) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try {
      ws = new WebSocket(WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempt = 0;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        sendPacket({ topic: 'phoenix', event: 'heartbeat', payload: {} });
      }, 25000);

      if (connectTopic) {
        joinTopic(connectTopic);
        setTimeout(() => {
          broadcastConnectState();
          sendBroadcast(connectTopic, 'device_ping', { from: deviceId });
        }, 250);
      }
      if (jamTopic && jamRoom) {
        joinTopic(jamTopic);
        setTimeout(() => {
          if (jamRoom && !jamRoom.isHost) {
            sendBroadcast(jamTopic, 'jam_hello', { deviceId, name: jamRoom.memberName || deviceName });
          } else if (jamRoom && jamRoom.isHost) {
            broadcastJamSync();
          }
        }, 250);
      }
    };

    ws.onmessage = (evt) => {
      let msg = null;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (!msg || msg.event !== 'broadcast' || !msg.payload) return;
      const ev = msg.payload.event;
      const data = msg.payload.payload || {};

      if (msg.topic === connectTopic) {
        handleConnectMessage(ev, data);
      } else if (msg.topic === jamTopic) {
        handleJamMessage(ev, data);
      }
    };

    ws.onclose = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      ws = null;
      if (shouldStayConnected) scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer || !shouldStayConnected) return;
    const delay = Math.min(20000, 1500 * Math.pow(1.6, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureSocket();
    }, delay);
  }

  function closeSocketIfIdle() {
    if (connectTopic || jamTopic) return;
    shouldStayConnected = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
  }

  function handleConnectMessage(ev, data) {
    if (ev === 'device_state' && data.deviceId && data.deviceId !== deviceId) {
      remoteDevices.set(data.deviceId, { ...data, lastSeenAt: Date.now() });
      emitDevices();
      return;
    }
    if (ev === 'device_ping' && data.from !== deviceId) {
      broadcastConnectState();
      return;
    }
    if (ev === 'device_command' && data.targetDeviceId === deviceId && connectAdapter) {
      const action = data.action;
      if (action === 'toggle') connectAdapter.togglePlay && connectAdapter.togglePlay();
      else if (action === 'play') connectAdapter.play && connectAdapter.play();
      else if (action === 'pause') connectAdapter.pause && connectAdapter.pause();
      else if (action === 'next') connectAdapter.playNext && connectAdapter.playNext();
      else if (action === 'prev') connectAdapter.playPrev && connectAdapter.playPrev();
      else if (action === 'seek' && typeof data.position === 'number') {
        connectAdapter.seekTo && connectAdapter.seekTo(data.position);
      } else if (action === 'volume' && typeof data.volume === 'number') {
        connectAdapter.setVolume && connectAdapter.setVolume(data.volume);
      } else if (action === 'play_track' && data.track) {
        connectAdapter.playTrackAt && connectAdapter.playTrackAt(data.track, Number(data.currentTime) || 0, data.isPlaying !== false);
      }
      setTimeout(() => broadcastConnectState(), 250);
    }
  }

  function broadcastConnectState() {
    if (!connectTopic || !connectAdapter || typeof connectAdapter.getState !== 'function') return;
    const st = connectAdapter.getState() || {};
    sendBroadcast(connectTopic, 'device_state', {
      deviceId,
      deviceName,
      platform,
      track: compactTrackForWire(st.track),
      isPlaying: Boolean(st.isPlaying),
      currentTime: Number(st.currentTime) || 0,
      duration: Number(st.duration) || 0,
      volume: typeof st.volume === 'number' ? st.volume : 1,
      ts: Date.now(),
    });
  }

  function startConnect(user, adapter) {
    const uid = String(user?.id || user?.email || '').trim();
    if (!uid) {
      stopConnect();
      return;
    }
    connectAdapter = adapter;
    const safeId = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const nextTopic = `realtime:sunify_connect_${safeId}`;
    if (connectTopic === nextTopic && connectUserId === uid) {
      broadcastConnectState();
      return;
    }
    if (connectTopic && connectTopic !== nextTopic) leaveTopic(connectTopic);
    connectUserId = uid;
    connectTopic = nextTopic;
    remoteDevices.clear();
    emitDevices();
    ensureSocket();
    joinTopic(connectTopic);

    if (!connectBroadcastTimer) {
      connectBroadcastTimer = setInterval(() => {
        if (!connectTopic || document.hidden) return;
        const st = connectAdapter?.getState ? connectAdapter.getState() : null;
        if (st && st.track) broadcastConnectState();
      }, 4500);
    }
    if (!connectPruneTimer) {
      connectPruneTimer = setInterval(() => {
        const cutoff = Date.now() - 18000;
        let removed = false;
        remoteDevices.forEach((dev, k) => {
          if ((dev.lastSeenAt || 0) < cutoff) {
            remoteDevices.delete(k);
            removed = true;
          }
        });
        if (removed) emitDevices();
      }, 6000);
    }
  }

  function stopConnect() {
    if (connectBroadcastTimer) {
      clearInterval(connectBroadcastTimer);
      connectBroadcastTimer = null;
    }
    if (connectPruneTimer) {
      clearInterval(connectPruneTimer);
      connectPruneTimer = null;
    }
    if (connectTopic) leaveTopic(connectTopic);
    connectTopic = '';
    connectUserId = '';
    connectAdapter = null;
    remoteDevices.clear();
    emitDevices();
    closeSocketIfIdle();
  }

  function sendCommand(targetDeviceId, action, extra = {}) {
    if (!connectTopic || !targetDeviceId) return false;
    return sendBroadcast(connectTopic, 'device_command', {
      targetDeviceId,
      action,
      ...extra,
    });
  }

  function transferHere(fromDeviceId) {
    const dev = remoteDevices.get(fromDeviceId);
    if (!dev || !dev.track || !connectAdapter) return false;
    const elapsed = dev.isPlaying ? Math.max(0, (Date.now() - (dev.ts || Date.now())) / 1000) : 0;
    const pos = Math.max(0, (Number(dev.currentTime) || 0) + elapsed);
    connectAdapter.playTrackAt && connectAdapter.playTrackAt(dev.track, pos, true);
    sendCommand(fromDeviceId, 'pause');
    return true;
  }

  function transferTo(targetDeviceId) {
    if (!connectAdapter || !targetDeviceId) return false;
    const st = connectAdapter.getState ? connectAdapter.getState() : null;
    if (!st || !st.track) return false;
    const ok = sendCommand(targetDeviceId, 'play_track', {
      track: compactTrackForWire(st.track),
      currentTime: Number(st.currentTime) || 0,
      isPlaying: true,
    });
    if (ok && connectAdapter.pause) connectAdapter.pause();
    return ok;
  }

  /* ---- JAM / ORTAK DİNLEME ODASI ---- */
  function generateJamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'SNF';
    for (let i = 0; i < 3; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  function handleJamMessage(ev, data) {
    if (!jamRoom) return;
    if (ev === 'jam_hello' && jamRoom.isHost) {
      if (data.deviceId && !jamRoom.members.some((m) => m.deviceId === data.deviceId)) {
        jamRoom.members.push({ deviceId: data.deviceId, name: data.name || 'Misafir' });
        emitJam();
      }
      broadcastJamSync();
      return;
    }
    if (ev === 'jam_bye' && data.deviceId) {
      if (data.wasHost && !jamRoom.isHost) {
        leaveJam();
        return;
      }
      jamRoom.members = (jamRoom.members || []).filter((m) => m.deviceId !== data.deviceId);
      emitJam();
      return;
    }
    if (ev === 'jam_queue_add' && jamRoom.isHost && data.track) {
      const clean = compactTrackForWire(data.track);
      if (clean) {
        jamRoom.queue.push(clean);
        if (jamAdapter?.addToQueue) jamAdapter.addToQueue(clean);
        emitJam();
        broadcastJamSync();
      }
      return;
    }
    if (ev === 'jam_sync' && !jamRoom.isHost) {
      jamRoom.hostName = data.hostName || jamRoom.hostName;
      jamRoom.track = data.track || null;
      jamRoom.queue = Array.isArray(data.queue) ? data.queue : [];
      jamRoom.members = Array.isArray(data.members) ? data.members : jamRoom.members;
      emitJam();

      if (!jamAdapter) return;
      const st = jamAdapter.getState ? jamAdapter.getState() : {};
      const curKey = `${st.track?.artist || ''}|${st.track?.title || ''}`.toLowerCase();
      const targetKey = `${data.track?.artist || ''}|${data.track?.title || ''}`.toLowerCase();
      const elapsed = data.isPlaying ? Math.max(0, (Date.now() - (data.ts || Date.now())) / 1000) : 0;
      const targetPos = Math.max(0, (Number(data.currentTime) || 0) + elapsed);

      isApplyingRemoteSync = true;
      try {
        if (data.track && curKey !== targetKey) {
          jamAdapter.playTrackAt && jamAdapter.playTrackAt(data.track, targetPos, Boolean(data.isPlaying));
        } else if (data.track) {
          if (data.isPlaying && !st.isPlaying && jamAdapter.play) jamAdapter.play();
          if (!data.isPlaying && st.isPlaying && jamAdapter.pause) jamAdapter.pause();
          const drift = Math.abs((Number(st.currentTime) || 0) - targetPos);
          if (drift > 2.2 && jamAdapter.seekTo) jamAdapter.seekTo(targetPos);
        }
      } finally {
        setTimeout(() => {
          isApplyingRemoteSync = false;
        }, 450);
      }
    }
  }

  function broadcastJamSync() {
    if (!jamTopic || !jamRoom || !jamRoom.isHost || isApplyingRemoteSync) return;
    const st = jamAdapter?.getState ? jamAdapter.getState() : {};
    jamRoom.track = compactTrackForWire(st.track);
    sendBroadcast(jamTopic, 'jam_sync', {
      hostId: deviceId,
      hostName: jamRoom.memberName || deviceName,
      track: jamRoom.track,
      isPlaying: Boolean(st.isPlaying),
      currentTime: Number(st.currentTime) || 0,
      queue: jamRoom.queue.slice(0, 30),
      members: jamRoom.members,
      ts: Date.now(),
    });
  }

  function createJam(memberName, adapter) {
    leaveJam();
    const code = generateJamCode();
    const label = String(memberName || deviceName).trim() || deviceName;
    jamAdapter = adapter;
    jamTopic = `realtime:sunify_jam_${code}`;
    const st = adapter?.getState ? adapter.getState() : {};
    jamRoom = {
      code,
      isHost: true,
      memberName: label,
      hostName: label,
      track: compactTrackForWire(st.track),
      queue: [],
      members: [{ deviceId, name: `${label} (Ev Sahibi)` }],
    };
    ensureSocket();
    joinTopic(jamTopic);
    jamHeartbeatTimer = setInterval(() => {
      if (jamRoom?.isHost) broadcastJamSync();
    }, 5500);
    emitJam();
    return code;
  }

  function joinJam(code, memberName, adapter) {
    const clean = String(code || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 10);
    if (clean.length < 4) return false;
    leaveJam();
    const label = String(memberName || deviceName).trim() || deviceName;
    jamAdapter = adapter;
    jamTopic = `realtime:sunify_jam_${clean}`;
    jamRoom = {
      code: clean,
      isHost: false,
      memberName: label,
      hostName: 'Ev Sahibi',
      track: null,
      queue: [],
      members: [{ deviceId, name: label }],
    };
    ensureSocket();
    joinTopic(jamTopic);
    setTimeout(() => {
      sendBroadcast(jamTopic, 'jam_hello', { deviceId, name: label });
    }, 300);
    emitJam();
    return true;
  }

  function addJamTrack(track) {
    const clean = compactTrackForWire(track);
    if (!clean || !jamRoom || !jamTopic) return false;
    if (jamRoom.isHost) {
      jamRoom.queue.push(clean);
      if (jamAdapter?.addToQueue) jamAdapter.addToQueue(clean);
      emitJam();
      broadcastJamSync();
    } else {
      sendBroadcast(jamTopic, 'jam_queue_add', { track: clean, from: deviceId });
    }
    return true;
  }

  function leaveJam() {
    if (jamHeartbeatTimer) {
      clearInterval(jamHeartbeatTimer);
      jamHeartbeatTimer = null;
    }
    if (jamTopic) {
      sendBroadcast(jamTopic, 'jam_bye', { deviceId, wasHost: Boolean(jamRoom?.isHost) });
      leaveTopic(jamTopic);
    }
    jamTopic = '';
    jamRoom = null;
    jamAdapter = null;
    emitJam();
    closeSocketIfIdle();
  }

  function notifyLocalPlaybackChanged() {
    if (connectTopic) broadcastConnectState();
    if (jamRoom?.isHost && !isApplyingRemoteSync) broadcastJamSync();
  }

  function setDeviceName(nextName) {
    const clean = String(nextName || '').trim().slice(0, 40);
    if (!clean) return;
    deviceName = clean;
    try {
      localStorage.setItem('sunify_device_name', clean);
    } catch {}
    broadcastConnectState();
  }

  global.SunifyRealtime = {
    getDeviceId: () => deviceId,
    getDeviceName: () => deviceName,
    setDeviceName,
    getPlatform: () => platform,
    startConnect,
    stopConnect,
    getRemoteDevices: () => Array.from(remoteDevices.values()),
    sendCommand,
    transferHere,
    transferTo,
    createJam,
    joinJam,
    addJamTrack,
    leaveJam,
    getJamRoom: () => (jamRoom ? { ...jamRoom } : null),
    notifyLocalPlaybackChanged,
    onDevicesChanged(fn) {
      if (typeof fn === 'function') listeners.devices.push(fn);
    },
    onJamChanged(fn) {
      if (typeof fn === 'function') listeners.jam.push(fn);
    },
  };
})(window);
