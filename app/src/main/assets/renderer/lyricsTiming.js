(function exposeLyricsTiming(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SunifyLyricsTiming = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLyricsTiming() {
  const lineStampRegex = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const wordStampRegex = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  const vowelRegex = /[aeıioöuü]+/giu;

  function timestampToSeconds(match) {
    const minutes = Number.parseInt(match[1], 10);
    const seconds = Number.parseInt(match[2], 10);
    const milliseconds = match[3] ? Number.parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) return null;
    return minutes * 60 + seconds + milliseconds / 1000;
  }

  function wordWeight(word) {
    const syllables = [...String(word).matchAll(vowelRegex)].length;
    const punctuationPause = /[.,!?;:]$/.test(word) ? 0.25 : 0;
    return Math.max(1, syllables) + punctuationPause;
  }

  function distributeWords(text, startTime, endTime, timed = false) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const duration = Math.max(0, endTime - startTime);
    const totalWeight = words.reduce((sum, word) => sum + wordWeight(word), 0);
    let cursor = startTime;
    return words.map((word, index) => {
      const end = index === words.length - 1
        ? endTime
        : cursor + duration * wordWeight(word) / totalWeight;
      const result = { word, startTime: cursor, endTime: Math.max(cursor, end), timed };
      cursor = end;
      return result;
    });
  }

  function parseEnhancedWords(text, lineTime, lineEnd, fileOffset = 0) {
    const matches = [...text.matchAll(wordStampRegex)];
    if (!matches.length) return { words: distributeWords(text, lineTime, lineEnd), hasWordTiming: false };

    const segments = [];
    let cursor = 0;
    let segmentStart = lineTime;
    for (const match of matches) {
      const before = text.slice(cursor, match.index);
      if (before.trim()) segments.push({ text: before, start: segmentStart });
      const parsedTime = timestampToSeconds(match);
      segmentStart = parsedTime === null
        ? segmentStart
        : Math.max(lineTime, Math.min(lineEnd, parsedTime + fileOffset));
      cursor = match.index + match[0].length;
    }
    const tail = text.slice(cursor);
    if (tail.trim()) segments.push({ text: tail, start: segmentStart });

    if (!segments.length) return { words: [], hasWordTiming: true };
    const words = [];
    segments.forEach((segment, index) => {
      const nextStart = segments[index + 1]?.start ?? lineEnd;
      const segmentEnd = Math.max(segment.start, Math.min(lineEnd, nextStart));
      words.push(...distributeWords(segment.text, segment.start, segmentEnd, true));
    });
    return { words, hasWordTiming: true };
  }

  function parseLRCWithWordTiming(lrcText, totalDurationSeconds = 0) {
    const entries = [];
    let fileOffset = 0;
    String(lrcText || '').split(/\r?\n/).forEach((line, lineIndex) => {
      const offsetMatch = line.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (offsetMatch) fileOffset = (Number.parseInt(offsetMatch[1], 10) || 0) / 1000;

      const content = line.replace(/^\s*\[offset:\s*[+-]?\d+\s*\]/i, '');
      const stamps = [...content.matchAll(lineStampRegex)];
      if (!stamps.length) return;
      const lyricText = content.replace(lineStampRegex, '').trim();
      if (!lyricText) return;
      const textWithoutWordStamps = lyricText.replace(wordStampRegex, '').trim();
      if (!textWithoutWordStamps) return;

      stamps.forEach((stamp, stampIndex) => {
        const rawTime = timestampToSeconds(stamp);
        if (rawTime === null) return;
        entries.push({
          time: Math.max(0, rawTime + fileOffset),
          text: textWithoutWordStamps,
          timedText: lyricText,
          id: `line-${lineIndex}-${stampIndex}`,
        });
      });
    });

    entries.sort((a, b) => a.time - b.time);
    const unique = entries.filter((entry, index) => index === 0
      || entry.time !== entries[index - 1].time
      || entry.text !== entries[index - 1].text);
    const knownDuration = Number(totalDurationSeconds) || 0;

    return unique.map((entry, index) => {
      const intervalEnd = unique[index + 1]?.time
        ?? (knownDuration > entry.time ? knownDuration : entry.time + 4);
      const interval = Math.max(0, intervalEnd - entry.time);
      // Keep a small gap before the next lyric for instrumental sections, while
      // never letting the previous line's word fill extend into the next line.
      const fallbackLineDuration = Math.min(interval, index === unique.length - 1 ? 7 : 4.8);
      const parsedWords = parseEnhancedWords(
        entry.timedText,
        entry.time,
        entry.time + fallbackLineDuration,
        fileOffset
      );
      const words = parsedWords.words.map((word, wordIndex) => ({
        ...word,
        id: `${entry.id}-w${wordIndex}`,
      }));
      const lastSpokenWordEnd = words.at(-1)?.endTime ?? entry.time;
      const lyricEnd = Math.min(intervalEnd, Math.max(entry.time, lastSpokenWordEnd));
      const instrumentalDuration = Math.max(0, intervalEnd - lyricEnd);

      return {
        time: entry.time,
        text: entry.text,
        id: entry.id,
        endTime: intervalEnd,
        duration: Math.max(0, lyricEnd - entry.time),
        instrumentalStart: lyricEnd,
        instrumentalEnd: intervalEnd,
        instrumentalDuration,
        hasWordTiming: parsedWords.hasWordTiming,
        words,
      };
    });
  }

  return { parseLRCWithWordTiming };
});
