package com.sunify.mobile

import android.util.Base64
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

object LyricsService {
    private val cache = ConcurrentHashMap<String, JSONObject>()
    private val allSources = listOf("lrclib", "netease", "kugou", "genius", "lyricsovh", "sarkisozum")

    data class ScoredLyrics(
        val json: JSONObject,
        val score: Double,
        val synced: Boolean,
        val durationGap: Double
    )

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun normalize(value: String): String {
        val turkish = value
            .replace('ı', 'i').replace('İ', 'i')
            .replace('ş', 's').replace('Ş', 's')
            .replace('ğ', 'g').replace('Ğ', 'g')
            .replace('ü', 'u').replace('Ü', 'u')
            .replace('ö', 'o').replace('Ö', 'o')
            .replace('ç', 'c').replace('Ç', 'c')
        return Normalizer.normalize(turkish, Normalizer.Form.NFD)
            .replace(Regex("[\\u0300-\\u036f]"), "")
            .lowercase(Locale.US)
            .replace(Regex("[^a-z0-9]+"), " ")
            .trim()
    }

    private fun cleanMeta(value: String): String = value
        .replace(Regex("\\[[^\\]]*\\]"), " ")
        .replace(
            Regex("\\((?:offiziell|official|resmi|hd|4k|audio|video|clip|klip|lyrics?|sarki sozu|şarkı sözü|prod\\.?[^)]*|explicit|visualizer)[^)]*\\)", RegexOption.IGNORE_CASE),
            " "
        )
        .replace(Regex("\\b(?:offiziell\\s*hd|official\\s*(?:music\\s*)?video|official\\s*audio|prod\\.?\\s*by\\s+\\S+)\\b", RegexOption.IGNORE_CASE), " ")
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun splitArtistTitle(rawTitle: String, rawArtist: String): Pair<String, String> {
        var title = cleanMeta(rawTitle)
        var artist = cleanMeta(rawArtist)
        val sep = Regex("\\s+[-–—]\\s+")
        if (sep.containsMatchIn(title)) {
            val parts = title.split(sep, limit = 2)
            if (parts.size == 2) {
                val left = parts[0].trim()
                val right = parts[1].trim()
                if (artist.isEmpty() || left.equals(artist, ignoreCase = true) || left.contains(artist, ignoreCase = true)) {
                    if (artist.isEmpty()) artist = left
                    title = right
                }
            }
        }
        val cleanTitle = title
            .replace(Regex("\\s*(?:\\(|\\[)?\\b(?:feat\\.?|ft\\.?)\\s+[^)\\]]+(?:\\)|\\])?", RegexOption.IGNORE_CASE), "")
            .trim()
            .ifEmpty { title }
        val primaryArtist = artist
            .split(Regex("\\s*(?:,|&|\\bx\\b|\\bfeat\\.?|\\bft\\.?)\\s*", RegexOption.IGNORE_CASE))
            .firstOrNull()?.trim().orEmpty()
        return cleanTitle to primaryArtist
    }

    private fun titleSimilarity(target: String, candidate: String): Double {
        val a = normalize(target)
        val b = normalize(candidate)
        if (a.isEmpty() || b.isEmpty()) return 0.0
        if (a == b) return 1.0
        if (a.contains(b) || b.contains(a)) {
            return min(a.length, b.length).toDouble() / max(a.length, b.length).toDouble()
        }
        val aWords = a.split(' ').filter { it.isNotEmpty() }.toSet()
        val bWords = b.split(' ').filter { it.isNotEmpty() }.toSet()
        if (aWords.isEmpty() || bWords.isEmpty()) return 0.0
        val common = aWords.count { it in bWords }
        return (2.0 * common) / (aWords.size + bWords.size)
    }

    private fun candidateScore(
        candTitle: String,
        candArtist: String,
        candDuration: Double,
        rawTitle: String,
        rawArtist: String,
        cleanTitle: String,
        primaryArtist: String,
        targetDuration: Double
    ): Double {
        val titleScore = max(
            titleSimilarity(rawTitle, candTitle),
            titleSimilarity(cleanTitle, candTitle)
        )
        if (titleScore < 0.45) return 0.0

        val wantedArtists = buildList {
            if (rawArtist.isNotBlank()) add(rawArtist)
            if (primaryArtist.isNotBlank()) add(primaryArtist)
            rawArtist.split(Regex("[,&]")).map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(it) }
        }.distinct()

        val normCandArtist = normalize(candArtist)
        val normPrimary = normalize(primaryArtist)
        var artistScore = if (wantedArtists.isEmpty()) {
            0.7
        } else {
            wantedArtists.maxOfOrNull { titleSimilarity(it, candArtist) } ?: 0.0
        }
        if (normPrimary.isNotEmpty() && normalize(candTitle).contains(normPrimary)) {
            artistScore = max(artistScore, 0.5)
        }
        val normWanted = normalize(primaryArtist.ifEmpty { rawArtist })
        if (normWanted.isNotEmpty() && normCandArtist.isNotEmpty() && artistScore < 0.38) {
            return 0.0
        }

        if (candDuration > 0 && targetDuration > 0 && abs(candDuration - targetDuration) > 25.0) {
            return 0.0
        }
        val durationScore = if (candDuration > 0 && targetDuration > 0) {
            max(0.0, 1.0 - abs(candDuration - targetDuration) / max(12.0, targetDuration * 0.22))
        } else {
            0.5
        }
        return titleScore * 0.55 + artistScore * 0.33 + durationScore * 0.12
    }

    private fun isNonTrivialLyrics(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.length < 30) return false
        val lines = trimmed.lines().count { it.trim().isNotEmpty() }
        return lines >= 3
    }

    fun fetchLyrics(title: String, artist: String, duration: Double, source: String = "auto"): JSONObject {
        val (cleanTitle, primaryArtist) = splitArtistTitle(title, artist)
        val durBucket = if (duration > 0) ((duration / 5.0).roundToInt() * 5) else 0
        val cacheKey = "${normalize(primaryArtist)}|${normalize(cleanTitle)}|$durBucket|${source.lowercase()}"
        cache[cacheKey]?.let { return it }

        val minSynced = if (source.equals("auto", ignoreCase = true)) 0.58 else 0.42
        val minPlain = if (source.equals("auto", ignoreCase = true)) 0.64 else 0.42

        val chosen: ScoredLyrics? = when (source.lowercase()) {
            "lrclib" -> tryLrcLib(title, artist, cleanTitle, primaryArtist, duration, minSynced, minPlain)
            "netease" -> tryNetease(title, artist, cleanTitle, primaryArtist, duration, minSynced, minPlain)
            "kugou" -> tryKugou(title, artist, cleanTitle, primaryArtist, duration, minSynced, minPlain)
            "genius" -> tryGenius(title, artist, cleanTitle, primaryArtist, if (source == "genius") 0.42 else 0.60)
            "lyricsovh" -> tryLyricsOvh(cleanTitle, primaryArtist)
            "sarkisozum" -> trySarkisozum(cleanTitle, primaryArtist)
            else -> findBestAutoLyrics(title, artist, cleanTitle, primaryArtist, duration, minSynced, minPlain)
        }

        val result = chosen?.json ?: JSONObject().apply {
            put("lyrics", "")
            put("synced", false)
            put("source", "Bulunamadı")
            put("lyricsType", "none")
            put("wordSynced", false)
            put("fallbackSources", JSONArray(allSources))
        }

        if (result.optString("lyrics").isNotBlank()) {
            if (cache.size > 150) cache.clear()
            cache[cacheKey] = result
        }
        return result
    }

    private fun rankScore(entry: ScoredLyrics): Double {
        val durBonus = if (entry.durationGap in 0.0..5.0) 0.04 else 0.0
        val syncBonus = if (entry.synced) 0.15 else 0.0
        return entry.score + durBonus + syncBonus
    }

    private fun findBestAutoLyrics(
        rawTitle: String,
        rawArtist: String,
        cleanTitle: String,
        primaryArtist: String,
        duration: Double,
        minSynced: Double,
        minPlain: Double
    ): ScoredLyrics? {
        val syncPool = Executors.newFixedThreadPool(3)
        val syncCandidates = try {
            val jobs = listOf(
                syncPool.submit(Callable { runCatching { tryLrcLib(rawTitle, rawArtist, cleanTitle, primaryArtist, duration, minSynced, minPlain) }.getOrNull() }),
                syncPool.submit(Callable { runCatching { tryNetease(rawTitle, rawArtist, cleanTitle, primaryArtist, duration, minSynced, minPlain) }.getOrNull() }),
                syncPool.submit(Callable { runCatching { tryKugou(rawTitle, rawArtist, cleanTitle, primaryArtist, duration, minSynced, minPlain) }.getOrNull() })
            )
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(4500)
            jobs.mapNotNull { job ->
                val remMs = TimeUnit.NANOSECONDS.toMillis((deadline - System.nanoTime()).coerceAtLeast(150_000_000L))
                runCatching { job.get(remMs, TimeUnit.MILLISECONDS) }.getOrNull()
            }
        } finally {
            syncPool.shutdownNow()
        }

        val bestSynced = syncCandidates.filter { it.synced }.maxByOrNull { rankScore(it) }
        if (bestSynced != null) return bestSynced

        val plainFromSync = syncCandidates.filter { !it.synced && it.score >= minPlain }
        val plainPool = Executors.newFixedThreadPool(3)
        val plainCandidates = try {
            val jobs = listOf(
                plainPool.submit(Callable { runCatching { tryGenius(rawTitle, rawArtist, cleanTitle, primaryArtist, 0.60) }.getOrNull() }),
                plainPool.submit(Callable { runCatching { tryLyricsOvh(cleanTitle, primaryArtist) }.getOrNull() }),
                plainPool.submit(Callable { runCatching { trySarkisozum(cleanTitle, primaryArtist) }.getOrNull() })
            )
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(4500)
            jobs.mapNotNull { job ->
                val remMs = TimeUnit.NANOSECONDS.toMillis((deadline - System.nanoTime()).coerceAtLeast(150_000_000L))
                runCatching { job.get(remMs, TimeUnit.MILLISECONDS) }.getOrNull()
            }
        } finally {
            plainPool.shutdownNow()
        }

        return (plainFromSync + plainCandidates).maxByOrNull { rankScore(it) }
    }

    private fun httpGet(url: String, headers: Map<String, String> = emptyMap()): String? {
        val builder = Request.Builder()
            .url(url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")
        headers.forEach { (k, v) -> builder.header(k, v) }
        return runCatching {
            OkHttpDownloader.sharedClient.newCall(builder.build()).execute().use { res ->
                if (!res.isSuccessful) null else res.body?.string()
            }
        }.getOrNull()
    }

    private fun hasLrcTimestamps(text: String): Boolean =
        Regex("\\[\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?\\]").containsMatchIn(text)

    private fun tryLrcLib(
        rawTitle: String,
        rawArtist: String,
        cleanTitle: String,
        primaryArtist: String,
        duration: Double,
        minSynced: Double,
        minPlain: Double
    ): ScoredLyrics? {
        var bestEntry: ScoredLyrics? = null
        var bestScore = -1.0

        fun evaluateItem(item: JSONObject) {
            val synced = item.optString("syncedLyrics").trim()
            val plain = item.optString("plainLyrics").trim()
            val chosenText = synced.ifEmpty { plain }
            if (!isNonTrivialLyrics(chosenText)) return
            val hasSync = synced.isNotEmpty()
            val candDuration = item.optDouble("duration", 0.0)
            val s = candidateScore(
                item.optString("trackName"),
                item.optString("artistName"),
                candDuration,
                rawTitle,
                rawArtist,
                cleanTitle,
                primaryArtist,
                duration
            )
            val threshold = if (hasSync) minSynced else minPlain
            if (s < threshold) return
            val effective = s + (if (hasSync) 0.06 else 0.0)
            if (effective > bestScore) {
                bestScore = effective
                val gap = if (duration > 0 && candDuration > 0) abs(duration - candDuration) else 999.0
                bestEntry = ScoredLyrics(
                    formatResult(chosenText, hasSync, if (hasSync) "LRCLIB · Senkron" else "LRCLIB"),
                    s,
                    hasSync,
                    gap
                )
            }
        }

        if (primaryArtist.isNotEmpty() && cleanTitle.isNotEmpty()) {
            val durPart = if (duration > 0) "&duration=${duration.roundToInt()}" else ""
            val exactRaw = httpGet("https://lrclib.net/api/get?track_name=${enc(cleanTitle)}&artist_name=${enc(primaryArtist)}$durPart")
            exactRaw?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { evaluateItem(it) }
            if (bestEntry != null && bestEntry!!.synced && bestEntry!!.score >= 0.78) return bestEntry
        }

        val queries = listOfNotNull(
            "$primaryArtist $cleanTitle".trim().takeIf { it.isNotEmpty() },
            cleanTitle.takeIf { it.isNotEmpty() && it != "$primaryArtist $cleanTitle".trim() }
        )
        for (q in queries) {
            val raw = httpGet("https://lrclib.net/api/search?q=${enc(q)}") ?: continue
            val arr = runCatching { JSONArray(raw) }.getOrNull() ?: continue
            for (i in 0 until minOf(10, arr.length())) {
                arr.optJSONObject(i)?.let { evaluateItem(it) }
            }
        }
        return bestEntry
    }

    private fun tryNetease(
        rawTitle: String,
        rawArtist: String,
        cleanTitle: String,
        primaryArtist: String,
        duration: Double,
        minSynced: Double,
        minPlain: Double
    ): ScoredLyrics? {
        val q = "$cleanTitle $primaryArtist".trim()
        if (q.isEmpty()) return null
        val headers = mapOf("Referer" to "https://music.163.com/")
        val raw = httpGet("https://music.163.com/api/cloudsearch/pc?s=${enc(q)}&type=1&limit=8", headers)
            ?: httpGet("https://music.163.com/api/search/get?s=${enc(q)}&type=1&limit=8", headers)
            ?: return null
        val songs = runCatching { JSONObject(raw).optJSONObject("result")?.optJSONArray("songs") }.getOrNull() ?: return null

        var bestId = 0L
        var bestScore = -1.0
        var bestGap = 999.0
        for (i in 0 until songs.length()) {
            val song = songs.optJSONObject(i) ?: continue
            val id = song.optLong("id", 0L)
            if (id <= 0) continue
            val name = song.optString("name")
            val arArr = song.optJSONArray("ar") ?: song.optJSONArray("artists")
            val arName = buildString {
                if (arArr != null) {
                    for (j in 0 until arArr.length()) {
                        val n = arArr.optJSONObject(j)?.optString("name").orEmpty()
                        if (n.isNotEmpty()) {
                            if (isNotEmpty()) append(", ")
                            append(n)
                        }
                    }
                }
            }
            val dur = song.optDouble("dt", song.optDouble("duration", 0.0)) / 1000.0
            val s = candidateScore(name, arName, dur, rawTitle, rawArtist, cleanTitle, primaryArtist, duration)
            if (s >= minSynced && s > bestScore) {
                bestScore = s
                bestId = id
                bestGap = if (duration > 0 && dur > 0) abs(duration - dur) else 999.0
            }
        }
        if (bestId <= 0) return null
        val lrcRaw = httpGet("https://music.163.com/api/song/lyric?id=$bestId&lv=-1&tv=-1", headers) ?: return null
        val rawLrc = runCatching { JSONObject(lrcRaw).optJSONObject("lrc")?.optString("lyric").orEmpty().trim() }.getOrDefault("")
        val cleaned = rawLrc.lines()
            .filter { !Regex("\\[\\d{1,2}:\\d{2}(?:[.:]\\d{1,3})?\\]\\s*(?:作词|作曲|编曲|制作人|混音|母带|录音|出品|词\\s*:|曲\\s*:)").containsMatchIn(it) }
            .joinToString("\n")
            .trim()
        if (!isNonTrivialLyrics(cleaned)) return null
        val synced = hasLrcTimestamps(cleaned)
        if (!synced && bestScore < minPlain) return null
        return ScoredLyrics(
            formatResult(cleaned, synced, if (synced) "NetEase · Senkron" else "NetEase"),
            bestScore,
            synced,
            bestGap
        )
    }

    private fun tryKugou(
        rawTitle: String,
        rawArtist: String,
        cleanTitle: String,
        primaryArtist: String,
        duration: Double,
        minSynced: Double,
        minPlain: Double
    ): ScoredLyrics? {
        val keyword = "$primaryArtist $cleanTitle".trim()
        if (keyword.isEmpty()) return null
        val durMs = if (duration > 0) "&duration=${(duration * 1000).toInt()}" else ""
        val searchRaw = httpGet("http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${enc(keyword)}$durMs") ?: return null
        val candidates = runCatching { JSONObject(searchRaw).optJSONArray("candidates") }.getOrNull() ?: return null

        var bestCand: JSONObject? = null
        var bestScore = -1.0
        var bestGap = 999.0
        for (i in 0 until minOf(8, candidates.length())) {
            val cand = candidates.optJSONObject(i) ?: continue
            val candDur = cand.optDouble("duration", 0.0) / 1000.0
            val s = candidateScore(
                cand.optString("song").ifEmpty { cleanTitle },
                cand.optString("singer"),
                candDur,
                rawTitle,
                rawArtist,
                cleanTitle,
                primaryArtist,
                duration
            )
            if (s >= minSynced && s > bestScore) {
                bestScore = s
                bestCand = cand
                bestGap = if (duration > 0 && candDur > 0) abs(duration - candDur) else 999.0
            }
        }
        val chosen = bestCand ?: return null
        val id = chosen.optString("id")
        val accessKey = chosen.optString("accesskey")
        if (id.isEmpty() || accessKey.isEmpty()) return null

        val dlRaw = httpGet("http://lyrics.kugou.com/download?ver=1&client=pc&id=$id&accesskey=$accessKey&fmt=lrc&charset=utf8") ?: return null
        val encoded = runCatching { JSONObject(dlRaw).optString("content") }.getOrDefault("")
        if (encoded.isEmpty()) return null
        val decoded = runCatching { String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8).trim() }.getOrDefault("")
        if (!isNonTrivialLyrics(decoded)) return null
        val synced = hasLrcTimestamps(decoded)
        if (!synced && bestScore < minPlain) return null
        return ScoredLyrics(
            formatResult(decoded, synced, if (synced) "KuGou · Senkron" else "KuGou"),
            bestScore,
            synced,
            bestGap
        )
    }

    private fun tryGenius(
        rawTitle: String,
        rawArtist: String,
        cleanTitle: String,
        primaryArtist: String,
        minScore: Double
    ): ScoredLyrics? {
        val searchRaw = httpGet("https://genius.com/api/search/multi?q=${enc("$primaryArtist $cleanTitle".trim())}") ?: return null
        val json = runCatching { JSONObject(searchRaw) }.getOrNull() ?: return null
        val sections = json.optJSONObject("response")?.optJSONArray("sections") ?: return null
        var bestUrl = ""
        var bestScore = -1.0
        for (i in 0 until sections.length()) {
            val hits = sections.optJSONObject(i)?.optJSONArray("hits") ?: continue
            for (j in 0 until hits.length()) {
                val res = hits.optJSONObject(j)?.optJSONObject("result") ?: continue
                val url = res.optString("url")
                if (!url.startsWith("https://genius.com/") || !url.endsWith("-lyrics")) continue
                val hitTitle = res.optString("title").ifEmpty { res.optString("title_with_featured") }
                val hitArtist = res.optJSONObject("primary_artist")?.optString("name").orEmpty()
                    .ifEmpty { res.optString("artist_names") }
                val s = candidateScore(hitTitle, hitArtist, 0.0, rawTitle, rawArtist, cleanTitle, primaryArtist, 0.0)
                if (s >= minScore && s > bestScore) {
                    bestScore = s
                    bestUrl = url
                }
            }
        }
        if (bestUrl.isEmpty()) return null
        val html = httpGet(bestUrl) ?: return null
        val matches = Regex("<div[^>]*data-lyrics-container=\"true\"[^>]*>(.*?)</div>", RegexOption.DOT_MATCHES_ALL)
            .findAll(html)
            .joinToString("\n") { it.groupValues[1] }
        val clean = matches
            .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("<[^>]+>"), "")
            .replace("&amp;", "&")
            .replace("&#x27;", "'")
            .replace("&#39;", "'")
            .replace("&quot;", "\"")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
        if (!isNonTrivialLyrics(clean)) return null
        return ScoredLyrics(formatResult(clean, false, "Genius"), bestScore, false, 999.0)
    }

    private fun tryLyricsOvh(cleanTitle: String, primaryArtist: String): ScoredLyrics? {
        if (primaryArtist.isEmpty() || cleanTitle.isEmpty()) return null
        val raw = httpGet("https://api.lyrics.ovh/v1/${enc(primaryArtist)}/${enc(cleanTitle)}") ?: return null
        val lyrics = runCatching { JSONObject(raw).optString("lyrics").trim() }.getOrNull().orEmpty()
        if (!isNonTrivialLyrics(lyrics) || lyrics.length < 40 || lyrics.lines().count { it.trim().isNotEmpty() } < 4) return null
        return ScoredLyrics(formatResult(lyrics, false, "LyricsOVH"), 0.66, false, 999.0)
    }

    private fun trySarkisozum(cleanTitle: String, primaryArtist: String): ScoredLyrics? {
        val q = "$primaryArtist $cleanTitle".trim()
        if (q.isEmpty()) return null
        val searchHtml = httpGet("https://www.sarkisozum.gen.tr/?s=${enc(q)}") ?: return null
        val normTitle = normalize(cleanTitle).replace(' ', '-')
        val normArtist = normalize(primaryArtist).replace(' ', '-')
        val linkMatches = Regex("href=\"(https://www\\.sarkisozum\\.gen\\.tr/[^\"]+-sarki-sozleri[^\"]*)\"").findAll(searchHtml).toList()
        val chosenUrl = linkMatches.firstOrNull { m ->
            val u = normalize(m.groupValues[1])
            (normTitle.isEmpty() || u.contains(normalize(cleanTitle))) &&
                (normArtist.isEmpty() || u.contains(normalize(primaryArtist)))
        }?.groupValues?.get(1) ?: return null

        val pageHtml = httpGet(chosenUrl) ?: return null
        val bodyMatch = Regex("<div[^>]*class=\"[^\"]*entry-content[^\"]*\"[^>]*>(.*?)</div>", RegexOption.DOT_MATCHES_ALL)
            .find(pageHtml)?.groupValues?.get(1).orEmpty()
        val clean = bodyMatch
            .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("</p>", RegexOption.IGNORE_CASE), "\n\n")
            .replace(Regex("<[^>]+>"), "")
            .replace("&amp;", "&")
            .replace("&#8217;", "'")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
        if (!isNonTrivialLyrics(clean) || clean.length < 40) return null
        return ScoredLyrics(formatResult(clean, false, "ŞarkıSözüm"), 0.62, false, 999.0)
    }

    private fun formatResult(lyrics: String, synced: Boolean, sourceLabel: String): JSONObject {
        val wordSynced = Regex("<\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?>").containsMatchIn(lyrics)
        return JSONObject().apply {
            put("lyrics", lyrics)
            put("synced", synced)
            put("source", sourceLabel)
            put("lyricsType", if (wordSynced) "word" else if (synced) "synced" else "plain")
            put("wordSynced", wordSynced)
            put("fallbackSources", JSONArray(allSources))
        }
    }
}
