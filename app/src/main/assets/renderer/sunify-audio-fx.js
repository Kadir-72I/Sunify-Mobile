/* sunify-audio-fx.js — Ortak 10 bant EQ, reverb, normalizasyon, crossfade, uyku zamanlayıcısı ve canlı görselleştirici */
(function initSunifyAudioFXModule(global) {
  const isMobileEnv = Boolean(global.SunifyAndroidBridge)
    || /Android|Mobile/i.test((global.navigator && global.navigator.userAgent) || '');
  const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_LABELS = ['32Hz', '64Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '16kHz'];
  const EQ_PRESETS = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [6.5, 5.5, 4, 2, 0.5, 0, -0.5, 0, 1, 1.5],
    vocal: [-2.5, -2, -1, 0.5, 3, 4.5, 4, 2.5, 1, 0],
    acoustic: [2.5, 2, 1, 0, 1.5, 2, 2.5, 3, 2, 1.5],
    night: [3, 2, 0.5, -1, -1.5, 0, 1, 1.5, -1, -2],
    electronic: [5, 4, 1.5, 0, -1, 1.5, 1, 2.5, 4, 4.5],
    treble: [-2, -1.5, -1, 0, 0.5, 1.5, 3, 4.5, 5.5, 6],
  };

  const MOOD_PRESETS = {
    normal: { rate: 1.0, preservesPitch: true, reverb: 0 },
    slowed: { rate: 0.84, preservesPitch: false, reverb: 0.36 },
    nightcore: { rate: 1.22, preservesPitch: false, reverb: 0.08 },
    chill: { rate: 0.9, preservesPitch: true, reverb: 0.16 },
  };

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, Number(val) || 0));
  }

  function loadInitialEqBands() {
    try {
      const saved10 = JSON.parse(localStorage.getItem('sunify_fx_eq_10') || 'null');
      if (Array.isArray(saved10) && saved10.length === 10) {
        return saved10.map((v) => clamp(v, -12, 12));
      }
      const saved5 = JSON.parse(localStorage.getItem('sunify_equalizer_gains') || 'null');
      if (Array.isArray(saved5) && saved5.length === 5) {
        const s = saved5.map((v) => clamp(v, -12, 12));
        return [s[0], s[0], (s[0] + s[1]) / 2, s[1], (s[1] + s[2]) / 2, s[2], (s[2] + s[3]) / 2, s[3], (s[3] + s[4]) / 2, s[4]];
      }
    } catch {}
    return [...EQ_PRESETS.flat];
  }

  let audioEl = null;
  let audioCtx = null;
  let mediaSource = null;
  let filters = [];
  let compressor = null;
  let convolver = null;
  let dryGain = null;
  let wetGain = null;
  let masterGain = null;
  let analyser = null;
  let freqData = null;
  let timeData = null;
  let initFailed = false;
  let convolverConnected = false;
  let convolverBufferReady = false;
  let nativeFadeTimer = null;
  let lastVisDrawMs = 0;
  let cachedThemeRgb = '181, 122, 255';
  let cachedThemeAt = 0;

  const state = {
    eqBands: loadInitialEqBands(),
    reverb: clamp(localStorage.getItem('sunify_fx_reverb') || 0, 0, 1),
    normalization: localStorage.getItem('sunify_fx_norm') === 'true',
    rate: clamp(localStorage.getItem('sunify_fx_rate') || 1, 0.75, 1.35),
    preservesPitch: localStorage.getItem('sunify_fx_preserves_pitch') !== 'false',
    crossfadeSeconds: clamp(localStorage.getItem('sunify_fx_crossfade') || 0, 0, 10),
    visualizerEnabled: localStorage.getItem('sunify_fx_visualizer') !== 'false',
    sleepMode: null,
    sleepRemainingSec: 0,
  };

  function hasActiveDsp() {
    if (state.reverb > 0.005 || state.normalization) return true;
    return state.eqBands.some((g) => Math.abs(Number(g) || 0) > 0.05);
  }

  let crossfadeTriggeredKey = '';
  let prewarmedKey = '';
  let sleepInterval = null;
  let sleepEndMs = 0;
  let sleepCallbacks = {};

  const visualizers = [];
  let visRafId = 0;
  let visPhase = 0;

  function createImpulseResponse(ctx, durationSec = 2.0, decay = 2.8) {
    const rate = ctx.sampleRate || 44100;
    const length = Math.floor(rate * durationSec);
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function applyCompressorSettings() {
    if (!compressor || !audioCtx) return;
    const now = audioCtx.currentTime;
    if (state.normalization) {
      compressor.threshold.setTargetAtTime(-18, now, 0.03);
      compressor.knee.setTargetAtTime(24, now, 0.03);
      compressor.ratio.setTargetAtTime(6, now, 0.03);
      compressor.attack.setTargetAtTime(0.005, now, 0.03);
      compressor.release.setTargetAtTime(0.18, now, 0.03);
    } else {
      compressor.threshold.setTargetAtTime(0, now, 0.03);
      compressor.knee.setTargetAtTime(0, now, 0.03);
      compressor.ratio.setTargetAtTime(1, now, 0.03);
    }
  }

  function applyReverbMix() {
    if (!dryGain || !wetGain || !audioCtx) return;
    const now = audioCtx.currentTime;
    const r = clamp(state.reverb, 0, 1);
    if (r <= 0.005) {
      dryGain.gain.setTargetAtTime(1, now, 0.04);
      wetGain.gain.setTargetAtTime(0, now, 0.04);
      if (convolverConnected && compressor && convolver) {
        try {
          compressor.disconnect(convolver);
          convolver.disconnect(wetGain);
        } catch {}
        convolverConnected = false;
      }
      return;
    }

    if (!convolver) convolver = audioCtx.createConvolver();
    if (!convolverBufferReady) {
      convolver.buffer = createImpulseResponse(audioCtx, isMobileEnv ? 1.1 : 2.0, 2.8);
      convolverBufferReady = true;
    }
    if (!convolverConnected && compressor) {
      try {
        compressor.connect(convolver);
        convolver.connect(wetGain);
        convolverConnected = true;
      } catch {}
    }
    dryGain.gain.setTargetAtTime(1 - r * 0.42, now, 0.04);
    wetGain.gain.setTargetAtTime(r * 0.72, now, 0.04);
  }

  function init(element) {
    if (element) audioEl = element;
    if (mediaSource || initFailed || !audioEl) return Boolean(mediaSource);
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) {
      initFailed = true;
      return false;
    }
    try {
      try {
        audioCtx = new Ctx({ latencyHint: 'playback' });
      } catch {
        audioCtx = new Ctx();
      }
      mediaSource = audioCtx.createMediaElementSource(audioEl);
      filters = EQ_FREQUENCIES.map((freq, index) => {
        const f = audioCtx.createBiquadFilter();
        f.type = index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.1;
        f.gain.value = state.eqBands[index] || 0;
        return f;
      });
      compressor = audioCtx.createDynamicsCompressor();
      applyCompressorSettings();

      dryGain = audioCtx.createGain();
      wetGain = audioCtx.createGain();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.82;
      freqData = new Uint8Array(analyser.frequencyBinCount);

      mediaSource.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i += 1) {
        filters[i].connect(filters[i + 1]);
      }
      filters[filters.length - 1].connect(compressor);
      compressor.connect(dryGain);
      dryGain.connect(masterGain);
      wetGain.connect(masterGain);
      masterGain.connect(analyser);
      analyser.connect(audioCtx.destination);
      applyReverbMix();

      const savedOutput = localStorage.getItem('sunify_audio_output_id') || 'default';
      if (savedOutput !== 'default' && typeof audioCtx.setSinkId === 'function') {
        audioCtx.setSinkId(savedOutput).catch(() => {});
      }
      reapplyToAudio();
      startVisualizerLoop();
      return true;
    } catch {
      initFailed = true;
      return false;
    }
  }

  function initIfNeeded(element) {
    if (element) audioEl = element;
    reapplyToAudio();
    if (!audioEl) return false;
    if (mediaSource) return true;
    if (!isMobileEnv || hasActiveDsp()) {
      return init(audioEl);
    }
    return false;
  }

  async function resume() {
    if (audioEl && !mediaSource && (!isMobileEnv || hasActiveDsp())) {
      init(audioEl);
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch {}
    }
    startVisualizerLoop();
  }

  function reapplyToAudio() {
    if (!audioEl) return;
    const rate = clamp(state.rate, 0.75, 1.35);
    const keepPitch = Boolean(state.preservesPitch);
    try {
      audioEl.defaultPlaybackRate = rate;
      audioEl.playbackRate = rate;
      if ('preservesPitch' in audioEl) audioEl.preservesPitch = keepPitch;
      if ('webkitPreservesPitch' in audioEl) audioEl.webkitPreservesPitch = keepPitch;
      if ('mozPreservesPitch' in audioEl) audioEl.mozPreservesPitch = keepPitch;
    } catch {}
  }

  function setEqBands(bands) {
    if (!Array.isArray(bands)) return;
    if (bands.length === 5) {
      const s = bands.map((v) => clamp(v, -12, 12));
      state.eqBands = [s[0], s[0], (s[0] + s[1]) / 2, s[1], (s[1] + s[2]) / 2, s[2], (s[2] + s[3]) / 2, s[3], (s[3] + s[4]) / 2, s[4]];
    } else if (bands.length >= 10) {
      state.eqBands = bands.slice(0, 10).map((v) => clamp(v, -12, 12));
    }
    try {
      localStorage.setItem('sunify_fx_eq_10', JSON.stringify(state.eqBands));
    } catch {}
    if (audioEl && !mediaSource && hasActiveDsp()) {
      init(audioEl);
      resume();
    }
    if (filters.length && audioCtx) {
      const now = audioCtx.currentTime;
      filters.forEach((f, idx) => f.gain.setTargetAtTime(state.eqBands[idx] || 0, now, 0.035));
    }
  }

  function setEqBand(index, gainDb) {
    if (index < 0 || index >= 10) return;
    const next = [...state.eqBands];
    next[index] = clamp(gainDb, -12, 12);
    setEqBands(next);
  }

  function applyEqPreset(name) {
    const preset = EQ_PRESETS[name];
    if (!preset) return;
    setEqBands(preset);
  }

  function setReverb(amount) {
    state.reverb = clamp(amount, 0, 1);
    try {
      localStorage.setItem('sunify_fx_reverb', String(state.reverb));
    } catch {}
    if (audioEl && !mediaSource && hasActiveDsp()) {
      init(audioEl);
      resume();
    }
    applyReverbMix();
  }

  function setNormalization(enabled) {
    state.normalization = Boolean(enabled);
    try {
      localStorage.setItem('sunify_fx_norm', String(state.normalization));
    } catch {}
    if (audioEl && !mediaSource && hasActiveDsp()) {
      init(audioEl);
      resume();
    }
    applyCompressorSettings();
  }

  function setSpeedPitch(rate, preservesPitch) {
    state.rate = clamp(rate, 0.75, 1.35);
    if (typeof preservesPitch === 'boolean') state.preservesPitch = preservesPitch;
    try {
      localStorage.setItem('sunify_fx_rate', String(state.rate));
      localStorage.setItem('sunify_fx_preserves_pitch', String(state.preservesPitch));
    } catch {}
    reapplyToAudio();
  }

  function applyMoodPreset(name) {
    const p = MOOD_PRESETS[name];
    if (!p) return;
    setSpeedPitch(p.rate, p.preservesPitch);
    setReverb(p.reverb);
  }

  function setCrossfade(seconds) {
    state.crossfadeSeconds = Math.round(clamp(seconds, 0, 10));
    try {
      localStorage.setItem('sunify_fx_crossfade', String(state.crossfadeSeconds));
    } catch {}
  }

  function setVisualizerEnabled(enabled) {
    state.visualizerEnabled = Boolean(enabled);
    try {
      localStorage.setItem('sunify_fx_visualizer', String(state.visualizerEnabled));
    } catch {}
    if (!state.visualizerEnabled) {
      visualizers.forEach((v) => {
        const ctx2d = v.canvas.getContext('2d');
        if (ctx2d) ctx2d.clearRect(0, 0, v.canvas.width, v.canvas.height);
      });
    } else {
      startVisualizerLoop();
    }
  }

  function rampNativeVolume(from, to, durationSec) {
    if (nativeFadeTimer) {
      clearInterval(nativeFadeTimer);
      nativeFadeTimer = null;
    }
    if (!audioEl) return;
    const startVal = clamp(from, 0, 1);
    const endVal = clamp(to, 0, 1);
    const ms = Math.max(0, Math.round((Number(durationSec) || 0) * 1000));
    if (ms < 60) {
      try { audioEl.volume = endVal; } catch {}
      return;
    }
    const startAt = Date.now();
    try { audioEl.volume = startVal; } catch {}
    nativeFadeTimer = setInterval(() => {
      if (!audioEl) {
        clearInterval(nativeFadeTimer);
        nativeFadeTimer = null;
        return;
      }
      const t = Math.min(1, (Date.now() - startAt) / ms);
      try { audioEl.volume = clamp(startVal + (endVal - startVal) * t, 0, 1); } catch {}
      if (t >= 1) {
        clearInterval(nativeFadeTimer);
        nativeFadeTimer = null;
      }
    }, 50);
  }

  function resetMasterGain(smoothSec = 0) {
    if (!masterGain || !audioCtx) {
      if (isMobileEnv && audioEl) rampNativeVolume(audioEl.volume, 1, smoothSec);
      return;
    }
    const now = audioCtx.currentTime;
    try {
      masterGain.gain.cancelScheduledValues(now);
      if (smoothSec > 0.05) {
        masterGain.gain.setValueAtTime(Math.max(0.06, masterGain.gain.value), now);
        masterGain.gain.linearRampToValueAtTime(1.0, now + smoothSec);
      } else {
        masterGain.gain.setValueAtTime(1.0, now);
      }
    } catch {}
  }

  function fadeInForNewTrack() {
    crossfadeTriggeredKey = '';
    prewarmedKey = '';
    if (state.crossfadeSeconds > 0) {
      const dur = Math.min(2.2, Math.max(0.45, state.crossfadeSeconds * 0.65));
      if (masterGain && audioCtx) {
        const now = audioCtx.currentTime;
        try {
          masterGain.gain.cancelScheduledValues(now);
          masterGain.gain.setValueAtTime(0.06, now);
          masterGain.gain.linearRampToValueAtTime(1.0, now + dur);
        } catch {}
      } else if (isMobileEnv && audioEl) {
        rampNativeVolume(0.08, 1.0, dur);
      }
    } else {
      resetMasterGain(0);
    }
  }

  function handleTimeUpdate(info) {
    if (!info) return;
    const cur = Number(info.currentTime) || 0;
    const dur = Number(info.duration) || 0;
    const trackKey = String(info.trackKey || '');
    if (!dur || dur <= 0 || info.isPaused) return;
    const remaining = dur - cur;

    if (dur > 20 && remaining <= 14 && remaining > 0.5 && prewarmedKey !== trackKey) {
      prewarmedKey = trackKey;
      if (typeof info.onPrewarmNext === 'function') info.onPrewarmNext();
    }

    const cf = state.crossfadeSeconds;
    if (cf > 0 && !info.isRepeatOne && dur > cf + 6 && remaining > 0.15 && remaining <= cf && crossfadeTriggeredKey !== trackKey) {
      crossfadeTriggeredKey = trackKey;
      const fadeDur = Math.max(0.5, cf * 0.72);
      if (masterGain && audioCtx) {
        const now = audioCtx.currentTime;
        try {
          masterGain.gain.cancelScheduledValues(now);
          masterGain.gain.setValueAtTime(masterGain.gain.value || 1, now);
          masterGain.gain.linearRampToValueAtTime(0.06, now + fadeDur);
        } catch {}
      } else if (isMobileEnv && audioEl) {
        rampNativeVolume(audioEl.volume, 0.06, fadeDur);
      }
      if (typeof info.onCrossfadeTrigger === 'function') {
        info.onCrossfadeTrigger();
      }
    }
  }

  function cancelSleepTimer() {
    if (sleepInterval) {
      clearInterval(sleepInterval);
      sleepInterval = null;
    }
    sleepEndMs = 0;
    state.sleepMode = null;
    state.sleepRemainingSec = 0;
    if (!audioEl || audioEl.paused === false) {
      if (masterGain && audioCtx) resetMasterGain(0.25);
      else if (isMobileEnv && audioEl) rampNativeVolume(audioEl.volume, 1, 0.25);
    }
    if (typeof sleepCallbacks.onTick === 'function') {
      sleepCallbacks.onTick(0, null);
    }
  }

  function startSleepTimer(mode, callbacks = {}) {
    cancelSleepTimer();
    sleepCallbacks = callbacks || {};
    if (mode === 'end_of_track') {
      state.sleepMode = 'end_of_track';
      state.sleepRemainingSec = -1;
      if (typeof sleepCallbacks.onTick === 'function') {
        sleepCallbacks.onTick(-1, 'end_of_track');
      }
      return;
    }
    const mins = clamp(mode, 1, 240);
    state.sleepMode = `${mins}m`;
    sleepEndMs = Date.now() + mins * 60000;
    state.sleepRemainingSec = Math.ceil((sleepEndMs - Date.now()) / 1000);
    if (typeof sleepCallbacks.onTick === 'function') {
      sleepCallbacks.onTick(state.sleepRemainingSec, state.sleepMode);
    }
    sleepInterval = setInterval(() => {
      const rem = Math.max(0, Math.ceil((sleepEndMs - Date.now()) / 1000));
      state.sleepRemainingSec = rem;
      if (rem <= 8 && rem > 0 && audioEl && !audioEl.paused) {
        if (masterGain && audioCtx) {
          try {
            masterGain.gain.setTargetAtTime(Math.max(0.04, rem / 8), audioCtx.currentTime, 0.25);
          } catch {}
        } else if (isMobileEnv) {
          try {
            audioEl.volume = clamp(rem / 8, 0.05, 1);
          } catch {}
        }
      }
      if (typeof sleepCallbacks.onTick === 'function') {
        sleepCallbacks.onTick(rem, state.sleepMode);
      }
      if (rem <= 0) {
        clearInterval(sleepInterval);
        sleepInterval = null;
        sleepEndMs = 0;
        const doneCb = sleepCallbacks.onComplete;
        state.sleepMode = null;
        state.sleepRemainingSec = 0;
        if (audioEl && !audioEl.paused) {
          try {
            audioEl.pause();
          } catch {}
        }
        resetMasterGain(0);
        if (typeof sleepCallbacks.onTick === 'function') sleepCallbacks.onTick(0, null);
        if (typeof doneCb === 'function') doneCb();
      }
    }, 1000);
  }

  function notifyTrackEnded() {
    if (state.sleepMode === 'end_of_track') {
      const doneCb = sleepCallbacks.onComplete;
      cancelSleepTimer();
      if (audioEl && !audioEl.paused) {
        try {
          audioEl.pause();
        } catch {}
      }
      if (typeof doneCb === 'function') doneCb();
      return true;
    }
    return false;
  }

  function readThemeRgb(nowMs) {
    if (nowMs - cachedThemeAt < 600) return cachedThemeRgb;
    cachedThemeAt = nowMs;
    try {
      const styles = getComputedStyle(document.documentElement);
      const raw = styles.getPropertyValue('--cover-rgb').trim();
      if (raw && /^\d+,\s*\d+,\s*\d+$/.test(raw)) {
        cachedThemeRgb = raw;
        return raw;
      }
      const accentRgb = styles.getPropertyValue('--cover-accent-rgb').trim();
      if (accentRgb && /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(accentRgb)) {
        cachedThemeRgb = accentRgb;
        return accentRgb;
      }
    } catch {}
    return cachedThemeRgb;
  }

  function isVisualizerCanvasVisible(canvas) {
    if (!canvas || !canvas.isConnected || canvas.offsetWidth <= 0 || canvas.offsetHeight <= 0) return false;
    if (canvas.offsetParent === null) return false;
    if (isMobileEnv) {
      const np = canvas.closest('#nowPlayingModal');
      if (np && !np.classList.contains('open')) return false;
      const panel = canvas.closest('.m-np-panel');
      if (panel && !panel.classList.contains('active')) return false;
    }
    return true;
  }

  function drawVisualizerFrame() {
    visRafId = 0;
    if (!state.visualizerEnabled || document.hidden || !audioEl || audioEl.paused) {
      return;
    }
    const activeOnes = visualizers.filter((v) => isVisualizerCanvasVisible(v.canvas));
    if (!activeOnes.length) return;

    const nowMs = Date.now();
    if (isMobileEnv && nowMs - lastVisDrawMs < 44) {
      visRafId = global.requestAnimationFrame(drawVisualizerFrame);
      return;
    }
    lastVisDrawMs = nowMs;

    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
    }
    visPhase += isMobileEnv ? 0.14 : 0.08;
    const rgb = readThemeRgb(nowMs);

    activeOnes.forEach((v) => {
      const canvas = v.canvas;
      const dpr = isMobileEnv ? 1 : Math.min(2, global.devicePixelRatio || 1);
      const targetW = Math.max(120, Math.floor(canvas.offsetWidth * dpr));
      const targetH = Math.max(28, Math.floor(canvas.offsetHeight * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barCount = v.bars || 28;
      const gap = Math.max(2 * dpr, canvas.width * 0.008);
      const totalGap = gap * (barCount - 1);
      const barW = Math.max(2 * dpr, (canvas.width - totalGap) / barCount);
      const midY = canvas.height / 2;

      for (let i = 0; i < barCount; i += 1) {
        const mirrorIdx = Math.abs(i - Math.floor(barCount / 2));
        const binIdx = Math.min(
          freqData ? freqData.length - 1 : 0,
          Math.floor((mirrorIdx / Math.max(1, barCount / 2)) * ((freqData ? freqData.length : 32) * 0.72))
        );
        const raw = freqData ? freqData[binIdx] / 255 : 0;
        const synth = raw > 0.02 ? raw : 0.14 + Math.abs(Math.sin(visPhase + i * 0.45)) * 0.28;
        const h = Math.max(4 * dpr, synth * canvas.height * 0.88);
        const x = i * (barW + gap);
        const y = midY - h / 2;
        const alpha = (0.35 + synth * 0.58).toFixed(2);
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        const r = Math.min(barW / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + barW - r, y);
        ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
        ctx.lineTo(x + barW, y + h - r);
        ctx.quadraticCurveTo(x + barW, y + h, x + barW - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.fill();
      }
    });

    visRafId = global.requestAnimationFrame(drawVisualizerFrame);
  }

  function startVisualizerLoop() {
    if (visRafId) return;
    if (!state.visualizerEnabled || document.hidden || !audioEl || audioEl.paused) return;
    const hasVisible = visualizers.some((v) => isVisualizerCanvasVisible(v.canvas));
    if (!hasVisible) return;
    visRafId = global.requestAnimationFrame(drawVisualizerFrame);
  }

  function attachVisualizer(canvas, options = {}) {
    if (!canvas) return;
    const existing = visualizers.find((v) => v.canvas === canvas);
    if (!existing) {
      visualizers.push({ canvas, bars: options.bars || 28 });
    }
    startVisualizerLoop();
  }

  function getAudioRmsLevel() {
    if (!analyser || !audioCtx || audioCtx.state !== 'running') return -1;
    if (!timeData || timeData.length !== analyser.fftSize) {
      timeData = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(timeData);
    let sumSq = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const v = (timeData[i] - 128) / 128;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / timeData.length);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) startVisualizerLoop();
  });

  function formatFreqBands() {
    return EQ_FREQUENCIES.map((freq, idx) => ({
      index: idx,
      freq,
      label: EQ_LABELS[idx],
      gain: state.eqBands[idx] || 0,
    }));
  }

  global.SunifyAudioFX = {
    EQ_FREQUENCIES,
    EQ_LABELS,
    EQ_PRESETS,
    MOOD_PRESETS,
    init,
    initIfNeeded,
    hasActiveDsp,
    resume,
    reapplyToAudio,
    getAudioContext: () => audioCtx,
    getAudioRmsLevel,
    getState: () => ({ ...state, eqBands: [...state.eqBands] }),
    getBandsMeta: formatFreqBands,
    setEqBands,
    setEqBand,
    applyEqPreset,
    setReverb,
    setNormalization,
    setSpeedPitch,
    applyMoodPreset,
    setCrossfade,
    setVisualizerEnabled,
    handleTimeUpdate,
    fadeInForNewTrack,
    resetMasterGain,
    startSleepTimer,
    cancelSleepTimer,
    notifyTrackEnded,
    attachVisualizer,
    startVisualizerLoop,
  };
})(window);
