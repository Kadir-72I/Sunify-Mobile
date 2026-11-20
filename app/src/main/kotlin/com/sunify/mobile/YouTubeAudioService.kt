package com.sunify.mobile

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class YouTubeAudioService(private val context: Context) {

    private val coverCache = ConcurrentHashMap<String, String>()

    data class TrackItem(
        val id: String,
        val title: String,
        val artist: String,
        val thumbnail: String,
        val duration: Long,
        val query: String,
        val reason: String = ""
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id)
            put("title", title)
            put("artist", artist)
            put("thumbnail", thumbnail)
            put("duration", duration)
            put("query", query)
            if (reason.isNotEmpty()) put("reason", reason)
        }
    }

    data class CachedStream(
        val url: String,
        val mimeType: String,
        val expiresAt: Long
    )

    data class SavedTrackResult(
        val fileName: String,
        val displayPath: String,
        val uriString: String,
        val sizeBytes: Long,
        val mimeType: String
    )

    private val searchCache = ConcurrentHashMap<String, Pair<Long, List<TrackItem>>>()
    private val streamCache = ConcurrentHashMap<String, CachedStream>()
    private val queryToVideoId = ConcurrentHashMap<String, String>()
    private val downloadsIndexLock = Any()

    val cacheDir: File by lazy {
        File(context.cacheDir, "SunifyAudioCache").apply { mkdirs() }
    }
    val downloadsDir: File by lazy {
        File(context.filesDir, "downloads").apply { mkdirs() }
    }
    private val downloadsIndexFile: File by lazy {
        File(context.filesDir, "downloads_index.json")
    }

    @Volatile
    var cacheLimitBytes: Long = 512L * 1024L * 1024L

    @Volatile
    var downloadLimitBytes: Long = 5L * 1024L * 1024L * 1024L

    private val junkRegex = Regex(
        "\\b(full album|full ep|1 hour|2 hours|3 hours|10 hours|1 saat|2 saat|playlist|mixtape|compilation|derleme|reaction|inceleme|teaser|trailer|fragman|karaoke|instrumental|altyap[ıi]|type beat|free beat|ringtone|zil sesi|shorts|tiktok|live stream|canl[ıi] yay[ıi]n|podcast|interview|röportaj)\\b",
        RegexOption.IGNORE_CASE
    )
    private val chillOnlyRegex = Regex(
        "\\b(slowed|reverb|8d audio|nightcore|sped up)\\b",
        RegexOption.IGNORE_CASE
    )

    fun extractVideoId(urlOrId: String): String {
        val raw = urlOrId.trim()
        if (Regex("^[a-zA-Z0-9_-]{11}$").matches(raw)) return raw
        val match = Regex("(?:v=|youtu\\.be/|shorts/|embed/)([a-zA-Z0-9_-]{11})").find(raw)
        return match?.groupValues?.getOrNull(1).orEmpty()
    }

    fun cleanMetadata(rawTitle: String, rawAuthor: String): Pair<String, String> {
        var title = rawTitle.trim()
        var artist = rawAuthor.replace(Regex("\\s*-\\s*Topic$", RegexOption.IGNORE_CASE), "").trim()
        title = title.replace(
            Regex("\\s*[\\[(](?:official\\s*(?:music\\s*)?(?:video|audio|lyric\\s*video|visualizer)|lyrics?|hd|4k|audio|video|offiziell[^)\\]]*)[\\])]", RegexOption.IGNORE_CASE),
            ""
        ).trim()

        val splitMatch = Regex("^(.{2,45}?)\\s+[-–—]\\s+(.+)$").find(title)
        if (splitMatch != null) {
            val left = splitMatch.groupValues[1].trim()
            val right = splitMatch.groupValues[2].trim()
            if (artist.isEmpty() || artist.equals(left, ignoreCase = true) || artist.contains(left, ignoreCase = true)) {
                artist = left
                title = right
            } else if (title.contains(" - ")) {
                artist = left
                title = right
            }
        }
        return (title.ifEmpty { rawTitle }) to (artist.ifEmpty { rawAuthor.ifEmpty { "Bilinmeyen Sanatçı" } })
    }

    private fun bestThumb(item: InfoItem, videoId: String): String {
        val thumbs = item.thumbnails
        val best = thumbs.lastOrNull()?.url ?: thumbs.firstOrNull()?.url
        if (!best.isNullOrBlank()) return best
        return if (videoId.isNotEmpty()) "https://i.ytimg.com/vi/$videoId/hqdefault.jpg" else ""
    }

    fun searchTracks(query: String, forceRefresh: Boolean = false): List<TrackItem> {
        val key = query.trim().lowercase(Locale("tr", "TR"))
        if (!forceRefresh) {
            searchCache[key]?.let { (ts, items) ->
                if (System.currentTimeMillis() - ts < 10 * 60 * 1000L) return items
            }
        }
        val yt = ServiceList.YouTube
        val qh = yt.searchQHFactory.fromQuery(query)
        val info = SearchInfo.getInfo(yt, qh)
        val items = info.relatedItems
            .filterIsInstance<StreamInfoItem>()
            .filter { !it.isShortFormContent && it.duration > 0 }
            .take(20)
            .mapNotNull { item ->
                val vid = extractVideoId(item.url)
                if (vid.isEmpty()) return@mapNotNull null
                val (cleanTitle, cleanArtist) = cleanMetadata(item.name.orEmpty(), item.uploaderName.orEmpty())
                TrackItem(
                    id = vid,
                    title = cleanTitle,
                    artist = cleanArtist,
                    thumbnail = bestThumb(item, vid),
                    duration = max(0L, item.duration),
                    query = "$cleanArtist $cleanTitle".trim()
                )
            }
        if (searchCache.size > 60) searchCache.clear()
        searchCache[key] = System.currentTimeMillis() to items
        return items
    }

    fun searchPlaylists(query: String): JSONArray {
        val yt = ServiceList.YouTube
        val qh = yt.searchQHFactory.fromQuery(query, listOf("playlists"), "")
        val info = SearchInfo.getInfo(yt, qh)
        val arr = JSONArray()
        info.relatedItems.filterIsInstance<PlaylistInfoItem>().take(12).forEach { pl ->
            val url = pl.url.orEmpty()
            val listId = Regex("[?&]list=([^&]+)").find(url)?.groupValues?.getOrNull(1) ?: url
            arr.put(JSONObject().apply {
                put("id", listId)
                put("title", pl.name ?: "Çalma listesi")
                put("author", pl.uploaderName ?: "YouTube")
                put("thumbnail", pl.thumbnails.lastOrNull()?.url ?: pl.thumbnails.firstOrNull()?.url ?: "")
                put("size", if (pl.streamCount > 0) "${pl.streamCount} şarkı" else "Çalma listesi")
                put("url", url)
            })
        }
        return arr
    }

    fun importPlaylist(url: String): JSONObject {
        val spotifyMatch = Regex("open\\.spotify\\.com/(?:intl-[a-z-]+/)?playlist/([a-zA-Z0-9]+)", RegexOption.IGNORE_CASE).find(url)
        if (spotifyMatch != null) {
            return importSpotifyPlaylist(spotifyMatch.groupValues[1])
        }
        val info = PlaylistInfo.getInfo(ServiceList.YouTube, url)
        val tracks = JSONArray()
        info.relatedItems.take(100).forEach { item ->
            val vid = extractVideoId(item.url)
            if (vid.isNotEmpty()) {
                val (cleanTitle, cleanArtist) = cleanMetadata(item.name.orEmpty(), item.uploaderName.orEmpty())
                tracks.put(
                    TrackItem(
                        id = vid,
                        title = cleanTitle,
                        artist = cleanArtist,
                        thumbnail = bestThumb(item, vid),
                        duration = max(0L, item.duration),
                        query = "$cleanArtist $cleanTitle".trim()
                    ).toJson()
                )
            }
        }
        return JSONObject().apply {
            put("name", info.name ?: "İçe Aktarılan Liste")
            put("author", info.uploaderName ?: "YouTube")
            put("thumbnail", info.thumbnails.lastOrNull()?.url ?: "")
            put("tracks", tracks)
        }
    }

    fun fetchTrackCover(artist: String, title: String): String {
        val cleanTerm = "$artist $title"
            .replace(Regex("[><\\-_()\\[\\]]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (cleanTerm.isEmpty()) return ""
        val key = cleanTerm.lowercase(Locale.US)
        coverCache[key]?.let { return it }

        val encoded = URLEncoder.encode(cleanTerm, "UTF-8")

        // 1. iTunes HD kapak
        val itunesArt = runCatching {
            val req = Request.Builder()
                .url("https://itunes.apple.com/search?term=$encoded&entity=song&limit=1")
                .header("User-Agent", "SunifyMobile/1.2.1")
                .build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) "" else {
                    val raw = res.body?.string().orEmpty()
                    JSONObject(raw).optJSONArray("results")?.optJSONObject(0)
                        ?.optString("artworkUrl100")
                        ?.replace("100x100bb", "600x600bb")
                        .orEmpty()
                }
            }
        }.getOrDefault("")
        if (itunesArt.isNotEmpty()) {
            if (coverCache.size > 500) coverCache.clear()
            coverCache[key] = itunesArt
            return itunesArt
        }

        // 2. Deezer HD kapak yedeği
        val deezerArt = runCatching {
            val req = Request.Builder()
                .url("https://api.deezer.com/search?q=$encoded&limit=1")
                .header("User-Agent", "SunifyMobile/1.2.1")
                .build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) "" else {
                    val album = JSONObject(res.body?.string().orEmpty())
                        .optJSONArray("data")?.optJSONObject(0)?.optJSONObject("album")
                    album?.optString("cover_big").orEmpty()
                        .ifEmpty { album?.optString("cover_medium").orEmpty() }
                }
            }
        }.getOrDefault("")
        if (deezerArt.isNotEmpty()) {
            if (coverCache.size > 500) coverCache.clear()
            coverCache[key] = deezerArt
            return deezerArt
        }

        // 3. YouTube arama kapağı yedeği
        val ytArt = runCatching {
            searchTracks(cleanTerm).firstOrNull()?.thumbnail.orEmpty()
        }.getOrDefault("")
        if (ytArt.isNotEmpty()) {
            if (coverCache.size > 500) coverCache.clear()
            coverCache[key] = ytArt
            return ytArt
        }

        return ""
    }

    private fun importSpotifyPlaylist(playlistId: String): JSONObject {
        var playlistTitle = "Spotify Çalma Listesi"
        var thumbnail = ""
        val trackModels = mutableListOf<TrackItem>()

        val embedReq = Request.Builder()
            .url("https://open.spotify.com/embed/playlist/$playlistId")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
            .build()
        val embedHtml = runCatching {
            OkHttpDownloader.sharedClient.newCall(embedReq).execute().use { res ->
                if (res.isSuccessful) res.body?.string().orEmpty() else ""
            }
        }.getOrDefault("")

        val nextDataMatch = Regex("<script id=\"__NEXT_DATA__\"[^>]*>([\\s\\S]*?)</script>").find(embedHtml)
        if (nextDataMatch != null) {
            val entity = runCatching {
                JSONObject(nextDataMatch.groupValues[1])
                    .optJSONObject("props")
                    ?.optJSONObject("pageProps")
                    ?.optJSONObject("state")
                    ?.optJSONObject("data")
                    ?.optJSONObject("entity")
            }.getOrNull()

            if (entity != null) {
                playlistTitle = entity.optString("title").ifEmpty { entity.optString("name") }.ifEmpty { playlistTitle }
                val imgArr = entity.optJSONObject("visualIdentity")?.optJSONArray("image")
                if (imgArr != null && imgArr.length() > 0) {
                    thumbnail = imgArr.optJSONObject(0)?.optString("url").orEmpty()
                }
                val rawTracks = entity.optJSONArray("trackList") ?: JSONArray()
                for (i in 0 until rawTracks.length()) {
                    val item = rawTracks.optJSONObject(i) ?: continue
                    val trackTitle = item.optString("title").ifEmpty { item.optString("name") }.ifEmpty { "Parça ${i + 1}" }
                    var artistName = item.optString("subtitle")
                    if (artistName.isEmpty()) {
                        val arts = item.optJSONArray("artists")
                        artistName = buildString {
                            if (arts != null) {
                                for (j in 0 until arts.length()) {
                                    val n = arts.optJSONObject(j)?.optString("name").orEmpty()
                                    if (n.isNotEmpty()) {
                                        if (isNotEmpty()) append(", ")
                                        append(n)
                                    }
                                }
                            }
                        }.ifEmpty { "Bilinmeyen Sanatçı" }
                    }
                    val durationSec = item.optLong("duration", 180_000L) / 1000L
                    trackModels.add(
                        TrackItem(
                            id = "",
                            title = trackTitle,
                            artist = artistName,
                            thumbnail = thumbnail,
                            duration = max(0L, durationSec),
                            query = "$artistName - $trackTitle"
                        )
                    )
                }
            }
        }

        if (thumbnail.isEmpty() || trackModels.isEmpty()) {
            val oembedReq = Request.Builder()
                .url("https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/$playlistId")
                .build()
            runCatching {
                OkHttpDownloader.sharedClient.newCall(oembedReq).execute().use { res ->
                    if (res.isSuccessful) {
                        val obj = JSONObject(res.body?.string().orEmpty())
                        if (playlistTitle == "Spotify Çalma Listesi") {
                            playlistTitle = obj.optString("title").ifEmpty { playlistTitle }
                        }
                        if (thumbnail.isEmpty()) {
                            thumbnail = obj.optString("thumbnail_url")
                        }
                    }
                }
            }
        }

        if (trackModels.isEmpty()) {
            throw IllegalStateException("Spotify listesi gizli olabilir veya parçalar alınamadı.")
        }

        // Tüm şarkılar için gerçek HD kapakları 8 paralel iş parçacığıyla çek
        val resolvedCovers = arrayOfNulls<String>(trackModels.size)
        val executor = Executors.newFixedThreadPool(8)
        try {
            val futures = trackModels.mapIndexed { idx, t ->
                executor.submit(Callable {
                    idx to runCatching { fetchTrackCover(t.artist, t.title) }.getOrDefault("")
                })
            }
            val deadlineNs = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
            futures.forEach { fut ->
                val remMs = TimeUnit.NANOSECONDS.toMillis((deadlineNs - System.nanoTime()).coerceAtLeast(250_000_000L))
                val pair = runCatching { fut.get(remMs, TimeUnit.MILLISECONDS) }.getOrNull()
                if (pair != null && pair.second.isNotEmpty()) {
                    resolvedCovers[pair.first] = pair.second
                }
            }
        } finally {
            executor.shutdownNow()
        }

        val tracks = JSONArray()
        trackModels.forEachIndexed { idx, t ->
            val cover = resolvedCovers[idx]?.takeIf { it.isNotEmpty() } ?: thumbnail
            tracks.put(t.copy(thumbnail = cover).toJson())
        }

        return JSONObject().apply {
            put("name", playlistTitle)
            put("author", "Spotify")
            put("thumbnail", thumbnail)
            put("tracks", tracks)
        }
    }

    fun normalizeRecText(value: String): String {
        val decomposed = Normalizer.normalize(value, Normalizer.Form.NFD)
            .replace(Regex("[\\u0300-\\u036f]"), "")
            .lowercase(Locale("tr", "TR"))
        return decomposed
            .replace(Regex("\\([^)]*\\)|\\[[^\\]]*\\]"), " ")
            .replace(Regex("\\b(official|music video|video|audio|lyrics?|visuali[sz]er|topic|remaster(?:ed)?|hd|4k|slowed|sped up|nightcore|karaoke|cover)\\b"), " ")
            .replace(Regex("[^a-z0-9]+"), " ")
            .trim()
            .replace(Regex("\\s+"), " ")
    }

    private fun textSimilarity(left: String, right: String): Double {
        val a = normalizeRecText(left).split(" ").filter { it.length > 1 }.toSet()
        val b = normalizeRecText(right).split(" ").filter { it.length > 1 }.toSet()
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val inter = a.intersect(b).size
        return inter.toDouble() / (a.size + b.size - inter).toDouble()
    }

    private fun isJunkVideo(title: String, duration: Long, mode: String): Boolean {
        if (junkRegex.containsMatchIn(title)) return true
        if (mode != "chill" && chillOnlyRegex.containsMatchIn(title)) return true
        if (duration > 0 && (duration < 60 || duration > 510)) return true
        return false
    }

    private data class Seed(val title: String, val artist: String, val duration: Long, val weight: Int)

    private data class Candidate(
        val track: TrackItem,
        var score: Double,
        val artistKey: String,
        var reason: String,
        val matchedSeeds: MutableSet<Int>
    )

    fun getRecommendations(
        seedsJson: String?,
        query: String?,
        modeParam: String?,
        excludeArtistsJson: String?,
        forceRefresh: Boolean
    ): List<TrackItem> {
        val mode = if (modeParam in setOf("all", "similar", "discovery", "energetic", "chill")) modeParam!! else "all"
        val seeds = mutableListOf<Seed>()
        if (!seedsJson.isNullOrBlank()) {
            val arr = JSONArray(seedsJson)
            for (i in 0 until min(6, arr.length())) {
                val obj = arr.optJSONObject(i) ?: continue
                val t = obj.optString("title").trim()
                if (t.isNotEmpty()) {
                    seeds.add(
                        Seed(
                            title = t.take(160),
                            artist = obj.optString("artist").trim().take(120),
                            duration = max(0L, obj.optLong("duration", 0L)),
                            weight = obj.optInt("weight", 1).coerceIn(1, 8)
                        )
                    )
                }
            }
        }
        if (seeds.isEmpty() && !query.isNullOrBlank()) {
            seeds.add(Seed(query.trim().take(160), "", 0L, 1))
        }
        if (seeds.isEmpty()) return emptyList()

        val excludedArtists = mutableSetOf<String>()
        if (!excludeArtistsJson.isNullOrBlank()) {
            runCatching {
                val arr = JSONArray(excludeArtistsJson)
                for (i in 0 until arr.length()) {
                    val k = normalizeRecText(arr.optString(i))
                    if (k.isNotEmpty()) excludedArtists.add(k)
                }
            }
        }
        val seedArtists = seeds.map { normalizeRecText(it.artist) }.filter { it.isNotEmpty() }.toSet()

        val candidates = linkedMapOf<String, Candidate>()
        seeds.forEachIndexed { seedIdx, seed ->
            val queries = when {
                seed.artist.isEmpty() -> listOf(seed.title)
                mode == "discovery" -> if (seedIdx % 2 == 0) listOf("${seed.artist} feat", "${seed.artist} ${seed.title} mix") else listOf("${seed.artist} düet", "songs like ${seed.artist} ${seed.title}")
                mode == "energetic" -> listOf("${seed.artist} ${seed.title} remix", "${seed.artist} hareketli popüler şarkılar")
                mode == "chill" -> listOf("${seed.artist} akustik slow", "${seed.artist} ${seed.title} chill")
                mode == "similar" -> if (seedIdx == 0) listOf("${seed.artist} ${seed.title} mix", "${seed.artist} feat") else listOf("${seed.artist} ${seed.title} radio")
                else -> if (seedIdx < 2) listOf("${seed.artist} ${seed.title} mix", "${seed.artist} feat") else listOf("${seed.artist} ${seed.title} radio")
            }

            queries.forEachIndexed { qIdx, sq ->
                val results = runCatching { searchTracks(sq, forceRefresh && qIdx == 0) }.getOrDefault(emptyList())
                results.take(14).forEach { track ->
                    if (isJunkVideo(track.title, track.duration, mode)) return@forEach
                    val artistKey = normalizeRecText(track.artist)
                    if (artistKey.isEmpty() || artistKey == "bilinmeyen sanatci") return@forEach
                    val sameArtist = seedArtists.contains(artistKey)
                    val titleMatch = seeds.maxOf { textSimilarity(track.title, it.title) }
                    if (titleMatch >= if (sameArtist) 0.62 else 0.85) return@forEach

                    val isCollab = Regex("\\b(feat\\.?|ft\\.?|x|&|,)\\b", RegexOption.IGNORE_CASE)
                        .containsMatchIn("${track.artist} ${track.title}")
                    if (mode == "discovery" && (sameArtist || excludedArtists.contains(artistKey)) && !isCollab) {
                        return@forEach
                    }

                    var score = seed.weight * 0.35 + (if (isCollab) 0.55 else 0.0)
                    score += if (mode == "discovery" && !sameArtist && !excludedArtists.contains(artistKey)) 2.1 else 0.9

                    val cKey = "$artistKey|${normalizeRecText(track.title)}"
                    val existing = candidates[cKey]
                    if (existing != null) {
                        existing.matchedSeeds.add(seedIdx)
                        existing.score = max(existing.score, score) + (existing.matchedSeeds.size - 1) * 1.65
                        if (existing.matchedSeeds.size >= 2) {
                            existing.reason = "🔥 ${existing.matchedSeeds.size} favori şarkınla ortak eşleşme"
                        }
                    } else {
                        val label = seed.artist.ifEmpty { seed.title }
                        val reason = when {
                            mode == "discovery" && !sameArtist -> "🧭 $label sevenlere yeni keşif"
                            mode == "energetic" -> "⚡ Enerjik mod · $label"
                            mode == "chill" -> "🌙 Gece & Chill · $label"
                            isCollab && sameArtist -> "🤝 $label ortak çalışması"
                            else -> "🎯 $label tarzına göre"
                        }
                        candidates[cKey] = Candidate(track, score, artistKey, reason, mutableSetOf(seedIdx))
                    }
                }
            }
        }

        val ranked = candidates.values.sortedByDescending { it.score }
        val output = mutableListOf<TrackItem>()
        val artistCounts = mutableMapOf<String, Int>()
        val maxPerArtist = if (mode == "discovery") 1 else 2
        var lastArtist = ""
        for (c in ranked) {
            if (output.any { textSimilarity(it.title, c.track.title) >= 0.8 }) continue
            val count = artistCounts[c.artistKey] ?: 0
            if (count >= maxPerArtist || c.artistKey == lastArtist) continue
            output.add(c.track.copy(reason = c.reason))
            artistCounts[c.artistKey] = count + 1
            lastArtist = c.artistKey
            if (output.size >= 25) break
        }
        return output
    }

    fun getArtistMixTracks(artistsJson: String): List<TrackItem> {
        val arr = runCatching { JSONArray(artistsJson) }.getOrNull() ?: return emptyList()
        val artists = (0 until min(6, arr.length())).mapNotNull { arr.optString(it).trim().takeIf { s -> s.isNotEmpty() } }
        if (artists.isEmpty()) return emptyList()
        val seen = HashSet<String>()
        val out = mutableListOf<TrackItem>()
        artists.forEach { artist ->
            val items = runCatching { searchTracks("$artist songs") }.getOrDefault(emptyList())
            items.filter { !isJunkVideo(it.title, it.duration, "all") }.forEach { track ->
                val k = normalizeRecText("${track.artist} ${track.title}")
                if (seen.add(k) && out.size < 25) out.add(track)
            }
        }
        return out
    }

    fun resolveVideoIdForQuery(query: String, excludeVideoIds: Set<String> = emptySet()): String {
        val norm = query.trim().lowercase(Locale("tr", "TR"))
        if (excludeVideoIds.isEmpty()) {
            queryToVideoId[norm]?.let { return it }
        }
        val tracks = searchTracks(query, forceRefresh = excludeVideoIds.isNotEmpty())
        val found = tracks.firstOrNull { it.id !in excludeVideoIds }?.id.orEmpty()
        if (found.isNotEmpty() && excludeVideoIds.isEmpty()) {
            queryToVideoId[norm] = found
        }
        return found
    }

    fun resolveAudioStream(videoIdOrQuery: String, title: String = "", artist: String = ""): CachedStream {
        val vid = extractVideoId(videoIdOrQuery).ifEmpty {
            val q = "$artist $title".trim().ifEmpty { videoIdOrQuery }
            resolveVideoIdForQuery(q)
        }
        if (vid.isEmpty()) throw IllegalStateException("Şarkı YouTube üzerinde bulunamadı.")

        streamCache[vid]?.let { cached ->
            if (System.currentTimeMillis() < cached.expiresAt) return cached
        }

        val info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=$vid")
        val bestAudio: AudioStream = info.audioStreams
            .filter { !it.content.isNullOrBlank() }
            .maxByOrNull { it.averageBitrate }
            ?: throw IllegalStateException("Bu parça için ses akışı bulunamadı.")

        val mime = bestAudio.format?.mimeType ?: "audio/mp4"
        val cached = CachedStream(
            url = bestAudio.content,
            mimeType = mime,
            expiresAt = System.currentTimeMillis() + 40 * 60 * 1000L
        )
        streamCache[vid] = cached
        return cached
    }

    fun cacheFileForKey(key: String): File {
        val hash = MessageDigest.getInstance("SHA-256")
            .digest(key.toByteArray())
            .joinToString("") { "%02x".format(it) }
        return File(cacheDir, "$hash.m4a")
    }

    private fun sanitizeDownloadSegment(raw: String, fallback: String): String {
        val cleaned = raw
            .replace(Regex("[\\\\/:*?\"<>|\\r\\n\\t]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .trim('.')
        return cleaned.ifEmpty { fallback }.take(56).trim()
    }

    private fun buildDownloadFileName(artist: String, title: String): String {
        val safeArtist = sanitizeDownloadSegment(artist, "")
        val safeTitle = sanitizeDownloadSegment(title, "Sunify Şarkı")
        val combined = if (safeArtist.isNotEmpty()) "$safeArtist - $safeTitle" else safeTitle
        return "${combined.take(120).trim()}.mp3"
    }

    private fun fetchCoverBytesBestEffort(url: String): ByteArray? {
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
            return null
        }
        return runCatching {
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                .build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return null
                val bytes = res.body?.bytes() ?: return null
                if (bytes.size in 100..(350 * 1024)) bytes else null
            }
        }.getOrNull()
    }

    private fun readDownloadsIndex(): MutableList<JSONObject> {
        synchronized(downloadsIndexLock) {
            if (!downloadsIndexFile.exists()) return mutableListOf()
            val arr = runCatching { JSONArray(downloadsIndexFile.readText(Charsets.UTF_8)) }.getOrNull() ?: return mutableListOf()
            val list = mutableListOf<JSONObject>()
            for (i in 0 until arr.length()) {
                arr.optJSONObject(i)?.let { list.add(it) }
            }
            return list
        }
    }

    private fun writeDownloadsIndex(entries: List<JSONObject>) {
        synchronized(downloadsIndexLock) {
            val arr = JSONArray()
            entries.forEach { arr.put(it) }
            runCatching { downloadsIndexFile.writeText(arr.toString(), Charsets.UTF_8) }
        }
    }

    private fun isUriReadable(uriString: String): Boolean {
        if (!uriString.startsWith("content://")) return File(uriString).let { it.exists() && it.length() > 1024L }
        return runCatching {
            context.contentResolver.openFileDescriptor(Uri.parse(uriString), "r")?.use { pfd ->
                pfd.statSize != 0L
            } ?: false
        }.getOrDefault(false)
    }

    private fun publicSunifyDir(): File = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
        "Sunify"
    )

    fun resolveDownloadFileOrUri(uriParam: String, nameParam: String): Pair<Uri?, File?> {
        if (uriParam.startsWith("content://")) {
            return Uri.parse(uriParam) to null
        }
        val cleanName = File(nameParam).name
        if (cleanName.isNotEmpty()) {
            val pubFile = File(publicSunifyDir(), cleanName)
            if (pubFile.exists() && pubFile.isFile) return null to pubFile
            val privFile = File(downloadsDir, cleanName)
            if (privFile.exists() && privFile.isFile) return null to privFile

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val foundUri = queryMediaStoreDownloadByName(cleanName)
                if (foundUri != null) return foundUri to null
            }
        }
        return null to null
    }

    private fun queryMediaStoreDownloadByName(fileName: String): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val projection = arrayOf(MediaStore.MediaColumns._ID)
        val selection = "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
        val args = arrayOf(fileName, "%Sunify%")
        return runCatching {
            context.contentResolver.query(collection, projection, selection, args, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val id = cursor.getLong(0)
                    Uri.withAppendedPath(collection, id.toString())
                } else null
            }
        }.getOrNull()
    }

    fun saveTrackLocally(
        id: String,
        title: String,
        artist: String,
        query: String,
        thumbnail: String = ""
    ): SavedTrackResult {
        val cleanTitle = title.trim().ifEmpty { query.trim().ifEmpty { "Sunify Şarkı" } }
        val cleanArtist = artist.trim()
        val fileName = buildDownloadFileName(cleanArtist, cleanTitle)
        val ts = System.currentTimeMillis()
        val tmpSrc = File(cacheDir, "tmp_src_$ts.m4a")
        val tmpMp3 = File(cacheDir, "tmp_out_$ts.mp3")

        try {
            val stream = resolveAudioStream(id.ifEmpty { query }, cleanTitle, cleanArtist)
            val req = Request.Builder()
                .url(stream.url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                .build()
            OkHttpDownloader.streamClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw IllegalStateException("İndirme başarısız (${res.code})")
                val input = res.body?.byteStream() ?: throw IllegalStateException("Boş ses akışı")
                input.use { srcStream ->
                    tmpSrc.outputStream().buffered(65536).use { out ->
                        srcStream.copyTo(out, 65536)
                    }
                }
            }

            if (!tmpSrc.exists() || tmpSrc.length() < 4096L) {
                throw IllegalStateException("Ses dosyası indirilemedi.")
            }

            val coverBytes = fetchCoverBytesBestEffort(thumbnail)
            Mp3Converter.convertToMp3(tmpSrc, tmpMp3, cleanTitle, cleanArtist, coverBytes)
            val sizeBytes = tmpMp3.length()

            var savedUriString = ""
            var displayPath = "İndirilenler/Sunify/$fileName"

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = context.contentResolver
                val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                runCatching {
                    resolver.delete(
                        collection,
                        "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
                        arrayOf(fileName, "%Sunify%")
                    )
                }
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, "audio/mpeg")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Sunify")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val itemUri = resolver.insert(collection, values)
                if (itemUri != null) {
                    var copyOk = false
                    try {
                        resolver.openOutputStream(itemUri)?.use { os ->
                            tmpMp3.inputStream().buffered(65536).use { ins ->
                                ins.copyTo(os, 65536)
                            }
                            os.flush()
                        } ?: throw IllegalStateException("MediaStore çıkış akışı açılamadı.")
                        values.clear()
                        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                        resolver.update(itemUri, values, null, null)
                        savedUriString = itemUri.toString()
                        copyOk = true
                    } finally {
                        if (!copyOk) runCatching { resolver.delete(itemUri, null, null) }
                    }
                }
            }

            if (savedUriString.isEmpty()) {
                val targetPublicDir = publicSunifyDir()
                val destFile = runCatching {
                    if (!targetPublicDir.exists()) targetPublicDir.mkdirs()
                    val candidate = File(targetPublicDir, fileName)
                    tmpMp3.copyTo(candidate, overwrite = true)
                    MediaScannerConnection.scanFile(context, arrayOf(candidate.absolutePath), arrayOf("audio/mpeg"), null)
                    candidate
                }.getOrElse {
                    displayPath = fileName
                    val privFile = File(downloadsDir, fileName)
                    tmpMp3.copyTo(privFile, overwrite = true)
                    privFile
                }
                savedUriString = destFile.absolutePath
            }

            val existing = readDownloadsIndex()
                .filter { it.optString("fileName") != fileName }
                .toMutableList()
            existing.add(0, JSONObject().apply {
                put("id", id)
                put("title", cleanTitle)
                put("artist", cleanArtist.ifEmpty { "Yerel" })
                put("thumbnail", thumbnail)
                put("fileName", fileName)
                put("uri", savedUriString)
                put("size", sizeBytes)
                put("format", "mp3")
                put("savedAt", System.currentTimeMillis())
            })
            writeDownloadsIndex(existing)

            return SavedTrackResult(
                fileName = fileName,
                displayPath = displayPath,
                uriString = savedUriString,
                sizeBytes = sizeBytes,
                mimeType = "audio/mpeg"
            )
        } finally {
            runCatching { if (tmpSrc.exists()) tmpSrc.delete() }
            runCatching { if (tmpMp3.exists()) tmpMp3.delete() }
        }
    }

    fun listDownloadedTracks(): JSONArray {
        val result = JSONArray()
        val seenNames = HashSet<String>()
        val validIndex = mutableListOf<JSONObject>()

        readDownloadsIndex().forEach { entry ->
            val fileName = entry.optString("fileName")
            val uriStr = entry.optString("uri")
            if (fileName.isBlank() || uriStr.isBlank()) return@forEach
            if (!isUriReadable(uriStr)) return@forEach
            validIndex.add(entry)
            if (seenNames.add(fileName.lowercase(Locale.ROOT))) {
                val localUrl = if (uriStr.startsWith("content://")) {
                    "/api/library/file?uri=${URLEncoder.encode(uriStr, "UTF-8")}&name=${URLEncoder.encode(fileName, "UTF-8")}"
                } else {
                    "/api/library/file?name=${URLEncoder.encode(fileName, "UTF-8")}"
                }
                result.put(JSONObject().apply {
                    put("id", entry.optString("id"))
                    put("title", entry.optString("title"))
                    put("artist", entry.optString("artist").ifEmpty { "Yerel" })
                    put("thumbnail", entry.optString("thumbnail"))
                    put("isLocal", true)
                    put("size", entry.optLong("size", 0L))
                    put("format", entry.optString("format", "mp3"))
                    put("fileName", fileName)
                    put("localUrl", localUrl)
                })
            }
        }
        writeDownloadsIndex(validIndex)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runCatching {
                val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val proj = arrayOf(
                    MediaStore.MediaColumns._ID,
                    MediaStore.MediaColumns.DISPLAY_NAME,
                    MediaStore.MediaColumns.SIZE
                )
                context.contentResolver.query(
                    collection,
                    proj,
                    "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
                    arrayOf("%Sunify%", "%.mp3"),
                    "${MediaStore.MediaColumns.DATE_ADDED} DESC"
                )?.use { c ->
                    while (c.moveToNext()) {
                        val rowId = c.getLong(0)
                        val fname = c.getString(1).orEmpty()
                        val sz = c.getLong(2)
                        if (fname.isNotEmpty() && seenNames.add(fname.lowercase(Locale.ROOT))) {
                            val base = fname.substringBeforeLast(".")
                            val parts = base.split(" - ", limit = 2)
                            val art = if (parts.size == 2) parts[0].trim() else "Yerel"
                            val ttl = if (parts.size == 2) parts[1].trim() else base
                            val uriStr = Uri.withAppendedPath(collection, rowId.toString()).toString()
                            result.put(JSONObject().apply {
                                put("title", ttl)
                                put("artist", art)
                                put("isLocal", true)
                                put("size", sz)
                                put("format", "mp3")
                                put("fileName", fname)
                                put("localUrl", "/api/library/file?uri=${URLEncoder.encode(uriStr, "UTF-8")}&name=${URLEncoder.encode(fname, "UTF-8")}")
                            })
                        }
                    }
                }
            }
        } else {
            publicSunifyDir().listFiles()?.filter { it.isFile && it.extension.equals("mp3", ignoreCase = true) }?.forEach { f ->
                if (seenNames.add(f.name.lowercase(Locale.ROOT))) {
                    val base = f.nameWithoutExtension
                    val parts = base.split(" - ", limit = 2)
                    result.put(JSONObject().apply {
                        put("title", if (parts.size == 2) parts[1].trim() else base)
                        put("artist", if (parts.size == 2) parts[0].trim() else "Yerel")
                        put("isLocal", true)
                        put("size", f.length())
                        put("format", "mp3")
                        put("fileName", f.name)
                        put("localUrl", "/api/library/file?name=${URLEncoder.encode(f.name, "UTF-8")}")
                    })
                }
            }
        }

        downloadsDir.listFiles()?.filter { it.isFile }?.forEach { file ->
            if (seenNames.add(file.name.lowercase(Locale.ROOT))) {
                val base = file.nameWithoutExtension
                val sep = if (base.contains(" - ")) " - " else "_"
                val parts = base.split(sep, limit = 2)
                val artistName = parts.getOrNull(0).orEmpty().ifEmpty { "Yerel" }
                val titleName = parts.getOrNull(1).orEmpty().ifEmpty { base }
                result.put(JSONObject().apply {
                    put("title", titleName)
                    put("artist", artistName)
                    put("isLocal", true)
                    put("size", file.length())
                    put("format", file.extension.lowercase(Locale.ROOT).ifEmpty { "m4a" })
                    put("fileName", file.name)
                    put("localUrl", "/api/library/file?name=${URLEncoder.encode(file.name, "UTF-8")}")
                })
            }
        }
        return result
    }

    fun getTotalDownloadsBytes(): Long {
        val tracks = listDownloadedTracks()
        var total = 0L
        for (i in 0 until tracks.length()) {
            total += tracks.optJSONObject(i)?.optLong("size", 0L) ?: 0L
        }
        return total
    }
}
