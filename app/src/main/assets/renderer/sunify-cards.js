/* sunify-cards.js — Dinleme ısı haritası, seri takibi, özet/şarkı sözü kartı PNG üretimi ve görsel küçültme */
(function initSunifyCardsModule(global) {
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function localDateKey(dateObj) {
    const d = dateObj || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function recordDailySeconds(statsObj, addedSec) {
    const sec = Math.floor(Number(addedSec) || 0);
    if (!statsObj || typeof statsObj !== 'object' || sec <= 0) return;
    if (!statsObj.__dailyLog || typeof statsObj.__dailyLog !== 'object' || Array.isArray(statsObj.__dailyLog)) {
      statsObj.__dailyLog = {};
    }
    const today = localDateKey(new Date());
    statsObj.__dailyLog[today] = (Number(statsObj.__dailyLog[today]) || 0) + sec;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = localDateKey(cutoff);
    Object.keys(statsObj.__dailyLog).forEach((k) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < cutoffKey) {
        delete statsObj.__dailyLog[k];
      }
    });
  }

  function computeStreakAndHeatmap(statsObj, dailyGoalOverride) {
    const meta = statsObj && typeof statsObj.__meta === 'object' ? statsObj.__meta : {};
    const goalMinutes = Math.max(10, Math.min(300, Number(dailyGoalOverride || meta.dailyGoalMinutes) || 30));
    const log = statsObj && typeof statsObj.__dailyLog === 'object' && !Array.isArray(statsObj.__dailyLog) ? statsObj.__dailyLog : {};

    const inferredDates = {};
    if (statsObj && typeof statsObj === 'object') {
      Object.entries(statsObj).forEach(([k, v]) => {
        if (k.startsWith('__') || !v || typeof v !== 'object') return;
        if (v.lastPlayed) {
          const d = new Date(v.lastPlayed);
          if (!Number.isNaN(d.getTime())) {
            const dk = localDateKey(d);
            inferredDates[dk] = (inferredDates[dk] || 0) + Math.max(60, Number(v.duration) || 180);
          }
        }
      });
    }

    const cells = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = 69; offset >= 0; offset -= 1) {
      const d = new Date(today);
      d.setDate(today.getDate() - offset);
      const dk = localDateKey(d);
      const sec = Number(log[dk]) || Number(inferredDates[dk]) || 0;
      const mins = Math.round(sec / 60);
      let level = 0;
      if (mins >= goalMinutes) level = 4;
      else if (mins >= Math.max(5, Math.round(goalMinutes * 0.6))) level = 3;
      else if (mins >= Math.max(2, Math.round(goalMinutes * 0.25))) level = 2;
      else if (sec >= 30) level = 1;
      cells.push({ date: dk, minutes: mins, seconds: sec, level });
    }

    const todayKey = localDateKey(today);
    const todaySec = Number(log[todayKey]) || 0;
    const todayMinutes = Math.round(todaySec / 60);
    const goalPct = Math.min(100, Math.round((todayMinutes / goalMinutes) * 100));

    let streakDays = 0;
    const startIdx = cells.length - 1;
    let i = startIdx;
    if (cells[i] && cells[i].seconds < 30 && cells[i - 1] && cells[i - 1].seconds >= 30) {
      i -= 1;
    }
    while (i >= 0 && cells[i].seconds >= 30) {
      streakDays += 1;
      i -= 1;
    }

    return {
      streakDays,
      todayMinutes,
      goalMinutes,
      goalPct,
      cells,
    };
  }

  function renderHeatmapWidget(container, statsObj, options = {}) {
    if (!container) return;
    const data = computeStreakAndHeatmap(statsObj);
    const goalChoices = [30, 60, 90];

    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'sfx-heatmap-card';

    const header = document.createElement('div');
    header.className = 'sfx-heatmap-head';

    const streakBadge = document.createElement('div');
    streakBadge.className = 'sfx-streak-pill';
    streakBadge.innerHTML = `<i class="fa-solid fa-fire"></i> <span>${data.streakDays} gün seri</span>`;

    const goalGroup = document.createElement('div');
    goalGroup.className = 'sfx-goal-pills';
    goalChoices.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `sfx-goal-btn ${data.goalMinutes === m ? 'active' : ''}`;
      btn.textContent = `${m} dk`;
      btn.onclick = () => {
        if (typeof options.onGoalChange === 'function') options.onGoalChange(m);
      };
      goalGroup.appendChild(btn);
    });

    header.append(streakBadge, goalGroup);

    const progressMeta = document.createElement('div');
    progressMeta.className = 'sfx-goal-meta';
    progressMeta.innerHTML = `<span>Bugün: <strong>${data.todayMinutes} / ${data.goalMinutes} dk</strong></span><span>%${data.goalPct}</span>`;

    const barTrack = document.createElement('div');
    barTrack.className = 'sfx-goal-bar';
    const barFill = document.createElement('div');
    barFill.className = 'sfx-goal-bar-fill';
    barFill.style.width = `${data.goalPct}%`;
    barTrack.appendChild(barFill);

    const grid = document.createElement('div');
    grid.className = 'sfx-heatmap-grid';
    grid.setAttribute('aria-label', 'Son 70 gün dinleme yoğunluğu');
    data.cells.forEach((cell) => {
      const dot = document.createElement('span');
      dot.className = 'sfx-hm-cell';
      dot.dataset.level = String(cell.level);
      dot.title = `${cell.date}: ${cell.minutes} dk`;
      grid.appendChild(dot);
    });

    card.append(header, progressMeta, barTrack, grid);
    container.appendChild(card);
  }

  function loadSafeImage(url, apiBase) {
    return new Promise((resolve) => {
      const src = String(url || '').trim();
      if (!src) {
        resolve(null);
        return;
      }
      const img = new Image();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, 4500);

      img.onload = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(img);
        }
      };
      img.onerror = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(null);
        }
      };
      if (src.startsWith('data:') || src.startsWith('blob:')) {
        img.src = src;
      } else {
        img.crossOrigin = 'anonymous';
        const base = String(apiBase || '').replace(/\/$/, '');
        img.src = `${base}/api/image-proxy?url=${encodeURIComponent(src)}`;
      }
    });
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    const str = String(text || '');
    if (ctx.measureText(str).width <= maxWidth) return str;
    let out = str;
    while (out.length > 3 && ctx.measureText(`${out}…`).width > maxWidth) {
      out = out.slice(0, -1);
    }
    return `${out}…`;
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
    return lines;
  }

  function extractRgbString(raw) {
    if (raw && /^\d+,\s*\d+,\s*\d+$/.test(raw.trim())) return raw.trim();
    return '181, 122, 255';
  }

  async function generateWrappedCardDataUrl({ stats, username, coverRgb, apiBase }) {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    const rgb = extractRgbString(coverRgb);

    const bg = ctx.createLinearGradient(0, 0, 1080, 1920);
    bg.addColorStop(0, '#120d1f');
    bg.addColorStop(0.5, '#0b0912');
    bg.addColorStop(1, '#170f28');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1080, 1920);

    const orb1 = ctx.createRadialGradient(220, 320, 40, 220, 320, 560);
    orb1.addColorStop(0, `rgba(${rgb}, 0.52)`);
    orb1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = orb1;
    ctx.fillRect(0, 0, 1080, 1920);

    const orb2 = ctx.createRadialGradient(880, 1520, 40, 880, 1520, 620);
    orb2.addColorStop(0, 'rgba(236, 106, 213, 0.34)');
    orb2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = orb2;
    ctx.fillRect(0, 0, 1080, 1920);

    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.arc(108, 126, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 42px Inter, sans-serif';
    ctx.fillText('Sunify Özet', 156, 140);

    if (username) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      drawRoundedRect(ctx, 78, 184, Math.min(920, ctx.measureText(username).width + 64), 56, 28);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '700 28px Inter, sans-serif';
      ctx.fillText(fitText(ctx, `@${username}`, 860), 108, 221);
    }

    const entries = Object.entries(stats || {})
      .filter(([k, v]) => !k.startsWith('__') && v && typeof v === 'object' && v.title)
      .map(([, v]) => v);
    const totalPlays = entries.reduce((s, e) => s + (Number(e.playCount) || 0), 0);
    const totalMinutes = Math.round(entries.reduce((s, e) => s + (Number(e.totalSeconds) || 0), 0) / 60);
    const streakInfo = computeStreakAndHeatmap(stats);

    const kpis = [
      { label: 'Toplam Süre', val: `${totalMinutes} dk` },
      { label: 'Tam Dinleme', val: `${totalPlays}` },
      { label: 'Seri', val: `${streakInfo.streakDays} gün` },
    ];
    kpis.forEach((k, idx) => {
      const x = 78 + idx * 316;
      const y = 290;
      ctx.fillStyle = 'rgba(255,255,255,0.09)';
      drawRoundedRect(ctx, x, y, 294, 176, 28);
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb}, 0.45)`;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.68)';
      ctx.font = '600 26px Inter, sans-serif';
      ctx.fillText(k.label, x + 28, y + 58);

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 48px Inter, sans-serif';
      ctx.fillText(k.val, x + 28, y + 128);
    });

    const topTracks = [...entries]
      .filter((e) => (Number(e.playCount) || 0) > 0)
      .sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0))
      .slice(0, 5);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    drawRoundedRect(ctx, 78, 512, 924, 720, 34);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = `rgb(${rgb})`;
    ctx.font = '800 30px Inter, sans-serif';
    ctx.fillText('EN ÇOK DİNLENEN PARÇALAR', 118, 578);

    const coverImgs = await Promise.all(topTracks.map((t) => loadSafeImage(t.thumbnail, apiBase)));

    if (!topTracks.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '600 30px Inter, sans-serif';
      ctx.fillText('Henüz sona kadar dinlenen şarkı bulunmuyor.', 118, 660);
    } else {
      topTracks.forEach((t, idx) => {
        const rowY = 620 + idx * 116;
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '800 34px Inter, sans-serif';
        ctx.fillText(`${idx + 1}`, 120, rowY + 58);

        const img = coverImgs[idx];
        ctx.save();
        drawRoundedRect(ctx, 174, rowY + 8, 84, 84, 18);
        ctx.clip();
        if (img) {
          ctx.drawImage(img, 174, rowY + 8, 84, 84);
        } else {
          ctx.fillStyle = `rgba(${rgb}, 0.35)`;
          ctx.fillRect(174, rowY + 8, 84, 84);
        }
        ctx.restore();

        ctx.fillStyle = '#ffffff';
        ctx.font = '700 32px Inter, sans-serif';
        ctx.fillText(fitText(ctx, t.title, 540), 282, rowY + 46);

        ctx.fillStyle = 'rgba(255,255,255,0.68)';
        ctx.font = '500 26px Inter, sans-serif';
        ctx.fillText(fitText(ctx, `${t.artist || ''} · ${t.playCount} kez`, 540), 282, rowY + 84);
      });
    }

    const artistMap = new Map();
    entries.forEach((e) => {
      const c = Number(e.playCount) || 0;
      if (c > 0 && e.artist) artistMap.set(e.artist, (artistMap.get(e.artist) || 0) + c);
    });
    const topArtists = [...artistMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    drawRoundedRect(ctx, 78, 1272, 924, 420, 34);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.stroke();

    ctx.fillStyle = `rgb(${rgb})`;
    ctx.font = '800 30px Inter, sans-serif';
    ctx.fillText('FAVORİ SANATÇILARIN', 118, 1340);

    if (!topArtists.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '600 28px Inter, sans-serif';
      ctx.fillText('Dinledikçe sanatçı sıralaman oluşur.', 118, 1420);
    } else {
      topArtists.forEach(([name, count], idx) => {
        const y = 1388 + idx * 96;
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 34px Inter, sans-serif';
        ctx.fillText(`${idx + 1}. ${fitText(ctx, name, 580)}`, 118, y + 40);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '600 28px Inter, sans-serif';
        ctx.fillText(`${count} dinleme`, 770, y + 40);
      });
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '600 26px Inter, sans-serif';
    ctx.fillText(`Sunify Müzik • ${new Date().toLocaleDateString('tr-TR')}`, 78, 1828);

    return canvas.toDataURL('image/png');
  }

  async function generateLyricCardDataUrl({ track, lines, translations = [], coverRgb, apiBase }) {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    const rgb = extractRgbString(coverRgb);

    const bg = ctx.createLinearGradient(0, 0, 1080, 1350);
    bg.addColorStop(0, '#140e24');
    bg.addColorStop(1, '#08070f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1080, 1350);

    const img = await loadSafeImage(track?.thumbnail, apiBase);
    if (img) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.filter = 'blur(42px) saturate(1.6)';
      ctx.drawImage(img, -80, -80, 1240, 1510);
      ctx.restore();
    }

    const orb = ctx.createRadialGradient(540, 620, 60, 540, 620, 620);
    orb.addColorStop(0, `rgba(${rgb}, 0.42)`);
    orb.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = orb;
    ctx.fillRect(0, 0, 1080, 1350);

    ctx.fillStyle = 'rgba(14, 12, 22, 0.72)';
    drawRoundedRect(ctx, 74, 86, 932, 1178, 44);
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb}, 0.55)`;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.save();
    drawRoundedRect(ctx, 132, 148, 132, 132, 26);
    ctx.clip();
    if (img) {
      ctx.drawImage(img, 132, 148, 132, 132);
    } else {
      ctx.fillStyle = `rgba(${rgb}, 0.45)`;
      ctx.fillRect(132, 148, 132, 132);
    }
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 38px Inter, sans-serif';
    ctx.fillText(fitText(ctx, track?.title || 'Sunify', 660), 292, 206);
    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    ctx.font = '600 28px Inter, sans-serif';
    ctx.fillText(fitText(ctx, track?.artist || '', 660), 292, 252);

    let cursorY = 390;
    const maxY = 1110;
    (lines || []).slice(0, 4).forEach((line, idx) => {
      if (cursorY > maxY) return;
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 46px Inter, sans-serif';
      const wrapped = wrapLines(ctx, line, 800);
      wrapped.forEach((wl) => {
        if (cursorY <= maxY) {
          ctx.fillText(wl, 132, cursorY);
          cursorY += 62;
        }
      });
      const tr = String(translations[idx] || '').trim();
      if (tr && cursorY <= maxY) {
        ctx.fillStyle = `rgba(${rgb}, 0.95)`;
        ctx.font = '600 30px Inter, sans-serif';
        const wrappedTr = wrapLines(ctx, tr, 800);
        wrappedTr.forEach((wt) => {
          if (cursorY <= maxY) {
            ctx.fillText(wt, 132, cursorY - 6);
            cursorY += 44;
          }
        });
      }
      cursorY += 28;
    });

    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.arc(154, 1188, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = '700 28px Inter, sans-serif';
    ctx.fillText('Sunify • Şarkı Sözü Kartı', 188, 1198);

    return canvas.toDataURL('image/png');
  }

  function shareOrDownloadCard(dataUrl, fileName = 'sunify-kart.png', title = 'Sunify') {
    if (!dataUrl) return false;
    if (global.SunifyAndroidBridge && typeof global.SunifyAndroidBridge.shareImageDataUrl === 'function') {
      try {
        return Boolean(global.SunifyAndroidBridge.shareImageDataUrl(dataUrl, fileName, title));
      } catch {}
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  function resizeImageFileToDataUrl(file, maxSize = 256, quality = 0.74) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('Görsel dosyası seçilmedi.'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Görsel okunamadı.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Geçersiz görsel dosyası.'));
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');
          const minSide = Math.min(img.width, img.height);
          const sx = Math.max(0, (img.width - minSide) / 2);
          const sy = Math.max(0, (img.height - minSide) / 2);
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  global.SunifyCards = {
    localDateKey,
    recordDailySeconds,
    computeStreakAndHeatmap,
    renderHeatmapWidget,
    loadSafeImage,
    generateWrappedCardDataUrl,
    generateLyricCardDataUrl,
    shareOrDownloadCard,
    resizeImageFileToDataUrl,
  };
})(window);
