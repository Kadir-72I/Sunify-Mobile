/* sunify-qr.js — Sıfır bağımlılıklı ISO/IEC 18004 QR Kod üreticisi (Byte Mode, ECC-L, Version 1–10) */
(function initSunifyQrModule(global) {
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, ecCount) {
    const gen = rsGenerator(ecCount);
    const rem = new Uint8Array(ecCount);
    for (let i = 0; i < data.length; i += 1) {
      const factor = data[i] ^ rem[0];
      for (let j = 0; j < ecCount - 1; j += 1) rem[j] = rem[j + 1];
      rem[ecCount - 1] = 0;
      for (let j = 0; j < ecCount; j += 1) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  // [version]: { totalCodewords, ecPerBlock, blocks: [[count, dataCW], ...], align: [...] }
  const VER_INFO = {
    1: { total: 26, ec: 7, blocks: [[1, 19]], align: [] },
    2: { total: 44, ec: 10, blocks: [[1, 34]], align: [6, 18] },
    3: { total: 70, ec: 15, blocks: [[1, 55]], align: [6, 22] },
    4: { total: 100, ec: 20, blocks: [[1, 80]], align: [6, 26] },
    5: { total: 134, ec: 26, blocks: [[1, 108]], align: [6, 30] },
    6: { total: 172, ec: 18, blocks: [[2, 68]], align: [6, 34] },
    7: { total: 196, ec: 20, blocks: [[2, 78]], align: [6, 22, 38] },
    8: { total: 242, ec: 24, blocks: [[2, 97]], align: [6, 24, 42] },
    9: { total: 292, ec: 30, blocks: [[2, 116]], align: [6, 26, 46] },
    10: { total: 346, ec: 18, blocks: [[2, 68], [2, 69]], align: [6, 28, 50] },
  };

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    const encoded = unescape(encodeURIComponent(str));
    const out = [];
    for (let i = 0; i < encoded.length; i += 1) out.push(encoded.charCodeAt(i));
    return out;
  }

  function encodeMatrix(text) {
    const bytes = utf8Bytes(String(text || ''));
    let version = 0;
    for (let v = 1; v <= 10; v += 1) {
      const info = VER_INFO[v];
      const dataCap = info.blocks.reduce((acc, b) => acc + b[0] * b[1], 0);
      const headerBits = 4 + (v < 10 ? 8 : 16);
      if (headerBits + bytes.length * 8 <= dataCap * 8) {
        version = v;
        break;
      }
    }
    if (!version) {
      return encodeMatrix(String(text || '').slice(0, 220));
    }

    const info = VER_INFO[version];
    const dataCap = info.blocks.reduce((acc, b) => acc + b[0] * b[1], 0);
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
    };
    pushBits(0b0100, 4); // Byte mode
    pushBits(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => pushBits(b, 8));
    const maxBits = dataCap * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i += 1) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let cw = 0;
      for (let j = 0; j < 8; j += 1) cw = (cw << 1) | bits[i + j];
      dataCodewords.push(cw);
    }
    const padBytes = [0xec, 0x11];
    let pIdx = 0;
    while (dataCodewords.length < dataCap) {
      dataCodewords.push(padBytes[pIdx % 2]);
      pIdx += 1;
    }

    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    info.blocks.forEach(([count, len]) => {
      for (let c = 0; c < count; c += 1) {
        const blk = dataCodewords.slice(offset, offset + len);
        offset += len;
        dataBlocks.push(blk);
        ecBlocks.push(Array.from(rsRemainder(blk, info.ec)));
      }
    });

    const interleaved = [];
    const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxDataLen; i += 1) {
      dataBlocks.forEach((b) => { if (i < b.length) interleaved.push(b[i]); });
    }
    for (let i = 0; i < info.ec; i += 1) {
      ecBlocks.forEach((b) => { if (i < b.length) interleaved.push(b[i]); });
    }

    const size = version * 4 + 17;
    const mat = Array.from({ length: size }, () => new Int8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    const setMod = (r, c, val, func = true) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      mat[r][c] = val ? 1 : 0;
      if (func) isFunc[r][c] = 1;
    };

    const drawFinder = (r0, c0) => {
      for (let r = -1; r <= 7; r += 1) {
        for (let c = -1; c <= 7; c += 1) {
          const rr = r0 + r;
          const cc = c0 + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          setMod(rr, cc, dark, true);
        }
      }
    };
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i += 1) {
      setMod(6, i, i % 2 === 0, true);
      setMod(i, 6, i % 2 === 0, true);
    }

    const align = info.align;
    for (let i = 0; i < align.length; i += 1) {
      for (let j = 0; j < align.length; j += 1) {
        const ar = align[i];
        const ac = align[j];
        if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            setMod(ar + r, ac + c, dark, true);
          }
        }
      }
    }

    // Reserve format areas + dark module
    for (let i = 0; i <= 8; i += 1) {
      if (i !== 6) {
        isFunc[8][i] = 1;
        isFunc[i][8] = 1;
      }
    }
    for (let i = size - 8; i < size; i += 1) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
    setMod(size - 8, 8, true, true);

    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vBits = (version << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const bit = ((vBits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setMod(a, b, bit, true);
        setMod(b, a, bit, true);
      }
    }

    // Place data bits with mask 0 ((r + c) % 2 === 0)
    let bitIdx = 0;
    const totalBits = interleaved.length * 8;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j += 1) {
          const c = right - j;
          if (isFunc[r][c]) continue;
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((interleaved[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
            bitIdx += 1;
          }
          if ((r + c) % 2 === 0) dark = !dark;
          mat[r][c] = dark ? 1 : 0;
        }
      }
      upward = !upward;
    }

    // Format bits for ECC-L (01) + Mask 0 (000) -> 01000
    const fmtData = (0b01 << 3) | 0;
    let fmtRem = fmtData;
    for (let i = 0; i < 10; i += 1) fmtRem = (fmtRem << 1) ^ ((fmtRem >>> 9) * 0x537);
    const fmtBits = ((fmtData << 10) | fmtRem) ^ 0x5412;

    for (let i = 0; i <= 5; i += 1) setMod(8, i, ((fmtBits >>> i) & 1) !== 0, true);
    setMod(8, 7, ((fmtBits >>> 6) & 1) !== 0, true);
    setMod(8, 8, ((fmtBits >>> 7) & 1) !== 0, true);
    setMod(7, 8, ((fmtBits >>> 8) & 1) !== 0, true);
    for (let i = 9; i < 15; i += 1) setMod(14 - i, 8, ((fmtBits >>> i) & 1) !== 0, true);

    for (let i = 0; i < 8; i += 1) setMod(size - 1 - i, 8, ((fmtBits >>> i) & 1) !== 0, true);
    for (let i = 8; i < 15; i += 1) setMod(8, size - 15 + i, ((fmtBits >>> i) & 1) !== 0, true);

    return mat;
  }

  function drawQrToCanvas(canvas, text, options = {}) {
    if (!canvas) return '';
    const mat = encodeMatrix(text);
    const n = mat.length;
    const size = Number(options.size) || 260;
    const quiet = 4;
    const cell = Math.floor(size / (n + quiet * 2));
    const realSize = cell * (n + quiet * 2);
    canvas.width = realSize;
    canvas.height = realSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.fillStyle = options.bgColor || '#ffffff';
    ctx.fillRect(0, 0, realSize, realSize);
    ctx.fillStyle = options.fgColor || '#120e1c';

    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (mat[r][c]) {
          ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
        }
      }
    }
    return canvas.toDataURL('image/png');
  }

  function buildShareUrl(type, payload = {}) {
    const qs = new URLSearchParams();
    qs.set('type', type);
    if (payload.id) qs.set('id', String(payload.id).slice(0, 60));
    if (payload.title) qs.set('title', String(payload.title).slice(0, 80));
    if (payload.artist) qs.set('artist', String(payload.artist).slice(0, 60));
    if (payload.code) qs.set('code', String(payload.code).slice(0, 20));
    if (payload.name) qs.set('name', String(payload.name).slice(0, 60));
    return `sunify://share?${qs.toString()}`;
  }

  global.SunifyQR = {
    encodeMatrix,
    drawQrToCanvas,
    buildShareUrl,
  };
})(window);
