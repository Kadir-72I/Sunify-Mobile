package com.sunify.mobile

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import fi.iki.elonen.NanoHTTPD
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.round

class LocalApiServer(
    private val context: Context,
    private val audioService: YouTubeAudioService,
    port: Int = 3001
) : NanoHTTPD("127.0.0.1", port) {
    private val coverColorCache = ConcurrentHashMap<String, JSONObject>()
    private val translationCache = ConcurrentHashMap<String, JSONArray>()
    private val sponsorBlockCache = ConcurrentHashMap<String, JSONArray>()
    private val thumbCacheDir: File by lazy { File(context.cacheDir, "SunifyThumbCache").apply { mkdirs() } }

    init {
        val pool = Executors.newFixedThreadPool(10)
        setAsyncRunner(object : AsyncRunner {
            private val running = java.util.Collections.synchronizedList(ArrayList<ClientHandler>())
            override fun closeAll() {
                ArrayList(running).forEach { runCatching { it.close() } }
            }
            override fun closed(clientHandler: ClientHandler) {
                running.remove(clientHandler)
            }
            override fun exec(code: ClientHandler) {
                running.add(code)
                pool.execute(code)
            }
        })
    }

    private fun jsonResponse(status: Response.Status, body: JSONObject): Response {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        return newFixedLengthResponse(
            status,
            "application/json; charset=utf-8",
            ByteArrayInputStream(bytes),
            bytes.size.toLong()
        ).apply {
            addHeader("Access-Control-Allow-Origin", "*")
            addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
            addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        }
    }

    private fun errorResponse(status: Response.Status, msg: String): Response =
        jsonResponse(status, JSONObject().put("error", msg))

    private fun readJsonBody(session: IHTTPSession): JSONObject {
        val contentLength = session.headers["content-length"]?.toIntOrNull() ?: 0
        val raw = if (contentLength in 1..(20 * 1024 * 1024)) {
            runCatching {
                val buffer = ByteArray(contentLength)
                var totalRead = 0
                val stream = session.inputStream
                while (totalRead < contentLength) {
                    val read = stream.read(buffer, totalRead, contentLength - totalRead)
                    if (read <= 0) break
                    totalRead += read
                }
                String(buffer, 0, totalRead, Charsets.UTF_8)
            }.getOrDefault("")
        } else {
            val files = HashMap<String, String>()
            runCatching { session.parseBody(files) }
            files["postData"].orEmpty()
        }
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.OPTIONS) {
            return jsonResponse(Response.Status.OK, JSONObject().put("ok", true))
        }
        val uri = session.uri ?: "/"
        val params = session.parms ?: emptyMap()
        val authHeader = session.headers["authorization"].orEmpty()
        val bearer = authHeader.replace(Regex("^Bearer\\s+", RegexOption.IGNORE_CASE), "").trim()

        return try {
            when {
                uri == "/api/diagnostics" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("server", "ready").put("platform", "android")
                )

                uri == "/api/search" -> {
                    val q = params["q"].orEmpty().trim()
                    if (q.isEmpty()) return errorResponse(Response.Status.BAD_REQUEST, "Query is required")
                    val results = audioService.searchTracks(q)
                    jsonResponse(Response.Status.OK, JSONObject().put("results", JSONArray(results.map { it.toJson() })))
                }

                uri == "/api/search/playlists" -> {
                    val q = params["q"].orEmpty().trim()
                    if (q.isEmpty()) return errorResponse(Response.Status.BAD_REQUEST, "Query is required")
                    jsonResponse(Response.Status.OK, JSONObject().put("playlists", audioService.searchPlaylists(q)))
                }

                uri == "/api/import-playlist" -> {
                    val body = readJsonBody(session)
                    val url = body.optString("url").trim()
                    if (url.isEmpty()) return errorResponse(Response.Status.BAD_REQUEST, "URL gerekli.")
                    jsonResponse(Response.Status.OK, audioService.importPlaylist(url))
                }

                uri == "/api/recommendations" -> {
                    val tracks = audioService.getRecommendations(
                        seedsJson = params["seeds"],
                        query = params["q"],
                        modeParam = params["mode"],
                        excludeArtistsJson = params["excludeArtists"],
                        forceRefresh = params["refresh"] == "1"
                    )
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", JSONArray(tracks.map { it.toJson() })))
                }

                uri == "/api/daily-mix/artist-tracks" -> {
                    val tracks = audioService.getArtistMixTracks(params["artists"].orEmpty())
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", JSONArray(tracks.map { it.toJson() })))
                }

                uri == "/api/artists/search" -> {
                    val q = params["q"].orEmpty().trim()
                    jsonResponse(Response.Status.OK, JSONObject().put("artists", ArtistService.searchArtists(q)))
                }

                uri.startsWith("/api/artists/") -> {
                    val id = uri.removePrefix("/api/artists/").trim()
                    jsonResponse(Response.Status.OK, ArtistService.getArtistProfile(id))
                }

                uri == "/api/lyrics" -> {
                    val title = params["title"].orEmpty().trim()
                    val artist = params["artist"].orEmpty().trim()
                    val duration = params["duration"]?.toDoubleOrNull() ?: 0.0
                    val source = params["source"].orEmpty().ifEmpty { "auto" }
                    jsonResponse(Response.Status.OK, LyricsService.fetchLyrics(title, artist, duration, source))
                }

                uri == "/api/lyrics-sync-offset" -> jsonResponse(Response.Status.OK, computeLyricsSyncOffset(params))

                uri == "/api/audio-stream" || uri == "/api/stream" -> handleAudioStream(session, params)

                uri == "/api/audio-ready" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("ready", true).put("progress", 100)
                )

                uri == "/api/audio-prefetch" -> {
                    val body = readJsonBody(session)
                    val target = body.optString("id").ifEmpty { body.optString("query") }
                    if (target.isNotBlank()) {
                        Thread {
                            runCatching {
                                audioService.resolveAudioStream(target, body.optString("title"), body.optString("artist"))
                            }
                        }.start()
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("queued", true))
                }

                uri == "/api/audio-cache" -> jsonResponse(Response.Status.OK, JSONObject().put("tracks", JSONArray()))

                uri == "/api/audio-cache/clear" -> {
                    var count = 0
                    var bytes = 0L
                    audioService.cacheDir.listFiles()?.forEach { f ->
                        bytes += f.length()
                        if (f.delete()) count++
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("success", true).put("files", count).put("bytes", bytes))
                }

                uri == "/api/local-downloads" -> {
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", audioService.listDownloadedTracks()))
                }

                uri == "/api/library/file" -> {
                    val uriParam = params["uri"].orEmpty()
                    val nameParam = params["name"].orEmpty()
                    val (resolvedUri, resolvedFile) = audioService.resolveDownloadFileOrUri(uriParam, nameParam)
                    val mime = if (nameParam.endsWith(".m4a", ignoreCase = true)) "audio/mp4" else "audio/mpeg"
                    when {
                        resolvedFile != null && resolvedFile.exists() -> serveFileWithRange(session, resolvedFile, mime)
                        resolvedUri != null -> serveUriWithRange(session, resolvedUri, mime)
                        else -> errorResponse(Response.Status.NOT_FOUND, "Dosya bulunamadı.")
                    }
                }

                uri == "/api/save-track-locally" -> {
                    val body = readJsonBody(session)
                    val saved = audioService.saveTrackLocally(
                        body.optString("id"),
                        body.optString("title"),
                        body.optString("artist"),
                        body.optString("query"),
                        body.optString("thumbnail")
                    )
                    val localUrl = if (saved.uriString.startsWith("content://")) {
                        "/api/library/file?uri=${URLEncoder.encode(saved.uriString, "UTF-8")}&name=${URLEncoder.encode(saved.fileName, "UTF-8")}"
                    } else {
                        "/api/library/file?name=${URLEncoder.encode(saved.fileName, "UTF-8")}"
                    }
                    jsonResponse(
                        Response.Status.OK,
                        JSONObject()
                            .put("success", true)
                            .put("fileName", saved.fileName)
                            .put("displayPath", saved.displayPath)
                            .put("format", "mp3")
                            .put("localUrl", localUrl)
                    )
                }

                uri == "/api/storage/stats" -> {
                    val cacheBytes = audioService.cacheDir.listFiles()?.sumOf { it.length() } ?: 0L
                    val dlBytes = audioService.getTotalDownloadsBytes()
                    jsonResponse(
                        Response.Status.OK,
                        JSONObject()
                            .put("audioCacheBytes", cacheBytes)
                            .put("downloadsBytes", dlBytes)
                            .put("localMusicBytes", 0L)
                            .put("audioCacheLimitBytes", audioService.cacheLimitBytes)
                    )
                }

                uri == "/api/storage/settings" -> {
                    val body = readJsonBody(session)
                    val dlGb = body.optDouble("downloadLimitGB", 5.0)
                    val cacheGb = body.optDouble("cacheLimitGB", 0.5)
                    audioService.downloadLimitBytes = if (dlGb <= 0) 0L else (dlGb * 1024 * 1024 * 1024).toLong()
                    audioService.cacheLimitBytes = if (cacheGb <= 0) 0L else (cacheGb * 1024 * 1024 * 1024).toLong()
                    jsonResponse(Response.Status.OK, JSONObject().put("success", true))
                }

                uri == "/api/auth/login" -> {
                    val body = readJsonBody(session)
                    jsonResponse(Response.Status.OK, SupabaseSyncService.login(body.optString("email"), body.optString("password")))
                }

                uri == "/api/auth/register" -> {
                    val body = readJsonBody(session)
                    jsonResponse(
                        Response.Status.OK,
                        SupabaseSyncService.register(body.optString("username"), body.optString("email"), body.optString("password"))
                    )
                }

                uri == "/api/auth/session" -> {
                    val body = readJsonBody(session)
                    if (bearer.isEmpty()) return errorResponse(Response.Status.UNAUTHORIZED, "Oturum anahtarı gerekli.")
                    jsonResponse(Response.Status.OK, SupabaseSyncService.validateSession(bearer, body.optString("refresh_token")))
                }

                uri == "/api/auth/logout" -> jsonResponse(Response.Status.OK, JSONObject().put("success", true))

                uri == "/api/sync/pull" -> {
                    if (bearer.isEmpty()) return errorResponse(Response.Status.UNAUTHORIZED, "Yetkilendirme tokenı eksik.")
                    jsonResponse(Response.Status.OK, SupabaseSyncService.pullAccountData(bearer))
                }

                uri == "/api/sync/push" -> {
                    if (bearer.isEmpty()) return errorResponse(Response.Status.UNAUTHORIZED, "Yetkilendirme tokenı eksik.")
                    val body = readJsonBody(session)
                    val result = SupabaseSyncService.pushAccountData(
                        bearer,
                        body.optJSONArray("playlists") ?: JSONArray(),
                        body.optJSONArray("likedTracks") ?: JSONArray(),
                        body.optJSONObject("listeningStats") ?: JSONObject()
                    )
                    jsonResponse(Response.Status.OK, result)
                }

                uri == "/api/sync/recovered-stats" -> jsonResponse(
                    Response.Status.OK,
                    JSONObject().put("listeningStats", JSONObject.NULL)
                )

                uri == "/api/discover/play" -> {
                    val body = readJsonBody(session)
                    val t = body.optJSONObject("track") ?: JSONObject()
                    if (t.optString("title").isNotBlank()) {
                        Thread {
                            SupabaseSyncService.recordCompletedGlobalPlay(
                                context,
                                t.optString("id"),
                                t.optString("title"),
                                t.optString("artist"),
                                t.optString("thumbnail")
                            )
                        }.start()
                    }
                    jsonResponse(Response.Status.OK, JSONObject().put("success", true))
                }

                uri == "/api/discover/top" -> {
                    val limit = params["limit"]?.toIntOrNull() ?: 10
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", SupabaseSyncService.fetchResetGlobalTop(context, limit)))
                }

                uri == "/api/discover/daily-top" -> {
                    val limit = params["limit"]?.toIntOrNull() ?: 25
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", SupabaseSyncService.fetchChart("get_sunify_daily_top", limit)))
                }

                uri == "/api/extract-color" -> {
                    val url = params["url"].orEmpty().trim()
                    jsonResponse(Response.Status.OK, extractCoverColor(url))
                }

                uri == "/api/track-cover" -> {
                    val artist = params["artist"].orEmpty().trim()
                    val title = params["title"].orEmpty().trim()
                    val cover = if (artist.isEmpty() && title.isEmpty()) "" else audioService.fetchTrackCover(artist, title)
                    jsonResponse(Response.Status.OK, JSONObject().put("thumbnail", cover))
                }

                uri == "/api/translate-lyrics" -> {
                    val body = readJsonBody(session)
                    val lines = body.optJSONArray("lines") ?: JSONArray()
                    val targetLang = body.optString("targetLang", "tr")
                    jsonResponse(Response.Status.OK, JSONObject().put("translations", translateLyrics(lines, targetLang)))
                }

                uri == "/api/image-proxy" -> {
                    val rawUrl = params["url"].orEmpty().trim()
                    handleImageProxy(rawUrl)
                }

                uri == "/api/thumb" -> {
                    val rawUrl = params["url"].orEmpty().trim()
                    val size = (params["w"]?.toIntOrNull() ?: 128).coerceIn(64, 320)
                    handleThumbnailCache(rawUrl, size)
                }

                uri == "/api/device-music" -> {
                    jsonResponse(Response.Status.OK, JSONObject().put("tracks", scanDeviceMusic()))
                }

                uri == "/api/album-art" -> {
                    val albumId = params["id"]?.toLongOrNull() ?: -1L
                    handleAlbumArt(albumId)
                }

                uri == "/api/trim-mp3" -> {
                    val body = readJsonBody(session)
                    jsonResponse(Response.Status.OK, handleTrimMp3(body))
                }

                uri == "/api/story/progress" -> jsonResponse(
                    Response.Status.OK,
                    StoryVideoGenerator.getProgressJson()
                )

                uri == "/api/story/wrapped-video" -> {
                    val body = readJsonBody(session)
                    val res = StoryVideoGenerator.generateWrappedStoryVideo(context, audioService, body)
                    jsonResponse(
                        Response.Status.OK,
                        JSONObject()
                            .put("success", true)
                            .put("cachePath", res.cacheFile.absolutePath)
                            .put("fileName", res.fileName)
                            .put("displayPath", res.displayPath)
                    )
                }

                uri == "/api/story/lyric-clip-video" -> {
                    val body = readJsonBody(session)
                    val res = StoryVideoGenerator.generateLyricClipStoryVideo(context, audioService, body)
                    jsonResponse(
                        Response.Status.OK,
                        JSONObject()
                            .put("success", true)
                            .put("cachePath", res.cacheFile.absolutePath)
                            .put("fileName", res.fileName)
                            .put("displayPath", res.displayPath)
                    )
                }

                uri == "/api/updates/latest" -> jsonResponse(
                    Response.Status.OK,
                    checkGithubLatestRelease("1.2.1")
                )

                else -> jsonResponse(Response.Status.OK, JSONObject().put("ok", true))
            }
        } catch (e: SupabaseSyncService.AuthExpiredException) {
            errorResponse(Response.Status.UNAUTHORIZED, e.message ?: "Oturum süresi doldu.")
        } catch (e: Exception) {
            errorResponse(Response.Status.INTERNAL_ERROR, e.message ?: "İşlem başarısız.")
        }
    }

    private fun handleAudioStream(session: IHTTPSession, params: Map<String, String>): Response {
        val id = params["id"].orEmpty()
        val q = params["q"].orEmpty()
        val title = params["title"].orEmpty()
        val artist = params["artist"].orEmpty()
        val stream = audioService.resolveAudioStream(id.ifEmpty { q }, title, artist)

        val rangeHeader = session.headers["range"]
        val reqBuilder = Request.Builder()
            .url(stream.url)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
        if (!rangeHeader.isNullOrBlank()) reqBuilder.header("Range", rangeHeader)

        val upstream = OkHttpDownloader.streamClient.newCall(reqBuilder.build()).execute()
        if (!upstream.isSuccessful && upstream.code != 206) {
            upstream.close()
            return errorResponse(Response.Status.INTERNAL_ERROR, "Ses akışı başlatılamadı (${upstream.code}).")
        }

        val status = if (upstream.code == 206) Response.Status.PARTIAL_CONTENT else Response.Status.OK
        val contentType = upstream.header("Content-Type") ?: stream.mimeType
        val contentLength = upstream.header("Content-Length")?.toLongOrNull() ?: -1L
        val rawStream = upstream.body?.byteStream()
        if (rawStream == null) {
            upstream.close()
            return errorResponse(Response.Status.INTERNAL_ERROR, "Boş ses akışı.")
        }
        val bodyStream = object : BufferedInputStream(rawStream, 65536) {
            override fun close() {
                try {
                    super.close()
                } finally {
                    runCatching { upstream.close() }
                }
            }
        }

        val resp = if (contentLength >= 0) {
            newFixedLengthResponse(status, contentType, bodyStream, contentLength)
        } else {
            newChunkedResponse(status, contentType, bodyStream)
        }
        resp.addHeader("Accept-Ranges", "bytes")
        resp.addHeader("Access-Control-Allow-Origin", "*")
        upstream.header("Content-Range")?.let { resp.addHeader("Content-Range", it) }
        return resp
    }

    private fun skipFully(stream: InputStream, bytesToSkip: Long) {
        var remaining = bytesToSkip
        while (remaining > 0L) {
            val skipped = stream.skip(remaining)
            if (skipped > 0L) {
                remaining -= skipped
            } else {
                if (stream.read() < 0) break
                remaining -= 1L
            }
        }
    }

    private fun serveFileWithRange(session: IHTTPSession, file: File, mime: String): Response {
        val len = file.length()
        val range = session.headers["range"]
        if (range != null && range.startsWith("bytes=") && len > 0L) {
            val parts = range.removePrefix("bytes=").split("-")
            val start = (parts.getOrNull(0)?.toLongOrNull() ?: 0L).coerceIn(0L, max(0L, len - 1L))
            val end = (parts.getOrNull(1)?.toLongOrNull() ?: (len - 1L)).coerceIn(start, len - 1L)
            val chunkLen = (end - start + 1L).coerceAtLeast(1L)
            val fis = BufferedInputStream(file.inputStream(), 65536)
            skipFully(fis, start)
            return newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, mime, fis, chunkLen).apply {
                addHeader("Content-Range", "bytes $start-$end/$len")
                addHeader("Accept-Ranges", "bytes")
                addHeader("Access-Control-Allow-Origin", "*")
            }
        }
        return newFixedLengthResponse(Response.Status.OK, mime, BufferedInputStream(file.inputStream(), 65536), len).apply {
            addHeader("Accept-Ranges", "bytes")
            addHeader("Access-Control-Allow-Origin", "*")
        }
    }

    private fun serveUriWithRange(session: IHTTPSession, uri: Uri, mime: String): Response {
        val pfd = context.contentResolver.openFileDescriptor(uri, "r")
            ?: return errorResponse(Response.Status.NOT_FOUND, "Ses dosyası açılamadı.")
        val len = pfd.statSize
        if (len <= 0L) {
            val stream = ParcelFileDescriptor.AutoCloseInputStream(pfd)
            return newChunkedResponse(Response.Status.OK, mime, BufferedInputStream(stream, 65536)).apply {
                addHeader("Accept-Ranges", "none")
                addHeader("Access-Control-Allow-Origin", "*")
            }
        }
        val stream = BufferedInputStream(ParcelFileDescriptor.AutoCloseInputStream(pfd), 65536)
        val range = session.headers["range"]
        if (range != null && range.startsWith("bytes=")) {
            val parts = range.removePrefix("bytes=").split("-")
            val start = (parts.getOrNull(0)?.toLongOrNull() ?: 0L).coerceIn(0L, max(0L, len - 1L))
            val end = (parts.getOrNull(1)?.toLongOrNull() ?: (len - 1L)).coerceIn(start, len - 1L)
            val chunkLen = (end - start + 1L).coerceAtLeast(1L)
            skipFully(stream, start)
            return newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, mime, stream, chunkLen).apply {
                addHeader("Content-Range", "bytes $start-$end/$len")
                addHeader("Accept-Ranges", "bytes")
                addHeader("Access-Control-Allow-Origin", "*")
            }
        }
        return newFixedLengthResponse(Response.Status.OK, mime, stream, len).apply {
            addHeader("Accept-Ranges", "bytes")
            addHeader("Access-Control-Allow-Origin", "*")
        }
    }

    private fun round1(v: Double): Double = round(v * 10.0) / 10.0

    private fun fetchSponsorBlockSegments(videoId: String): JSONArray {
        if (!Regex("^[A-Za-z0-9_-]{11}$").matches(videoId)) return JSONArray()
        sponsorBlockCache[videoId]?.let { return it }

        var result = JSONArray()
        runCatching {
            val url = "https://sponsor.ajay.app/api/skipSegments?videoID=$videoId&categories=" +
                URLEncoder.encode("[\"music_offtopic\",\"intro\",\"outro\"]", "UTF-8")
            val shortClient = OkHttpDownloader.sharedClient.newBuilder()
                .readTimeout(2500, TimeUnit.MILLISECONDS)
                .connectTimeout(2500, TimeUnit.MILLISECONDS)
                .build()
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "Sunify/1.2.1")
                .build()
            shortClient.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { JSONArray(raw) }.getOrNull()
                    if (parsed != null) result = parsed
                }
            }
        }
        if (sponsorBlockCache.size > 300) sponsorBlockCache.clear()
        sponsorBlockCache[videoId] = result
        return result
    }

    private fun computeLyricsSyncOffset(params: Map<String, String>): JSONObject {
        val videoId = params["videoId"].orEmpty().trim()
        val actualDuration = params["actualDuration"]?.toDoubleOrNull() ?: 0.0
        val lyricsDuration = params["lyricsDuration"]?.toDoubleOrNull() ?: 0.0
        val firstLyricTime = params["firstLyricTime"]?.toDoubleOrNull() ?: -1.0
        val lastLyricTime = params["lastLyricTime"]?.toDoubleOrNull() ?: 0.0

        var introEnd = 0.0
        var outroSec = 0.0
        if (Regex("^[A-Za-z0-9_-]{11}$").matches(videoId)) {
            val segs = fetchSponsorBlockSegments(videoId)
            for (i in 0 until segs.length()) {
                val seg = segs.optJSONObject(i) ?: continue
                val cat = seg.optString("category")
                val range = seg.optJSONArray("segment") ?: continue
                if (range.length() < 2) continue
                val segStart = range.optDouble(0, 0.0)
                val segEnd = range.optDouble(1, 0.0)
                val segLen = max(0.0, segEnd - segStart)
                if ((cat == "music_offtopic" || cat == "intro")
                    && segStart <= 2.5
                    && segEnd in 1.0..60.0
                    && (actualDuration <= 0.0 || segEnd < actualDuration * 0.45)
                ) {
                    introEnd = max(introEnd, segEnd)
                } else if ((cat == "music_offtopic" || cat == "outro")
                    && ((actualDuration > 0.0 && segStart >= actualDuration * 0.65) || segStart > 30.0)
                ) {
                    outroSec += segLen
                }
            }
        }

        outroSec = round1(outroSec)
        if (introEnd >= 1.0) {
            val shift = round1(introEnd)
            return JSONObject().apply {
                put("offsetSec", shift)
                put("source", "sponsorblock")
                put("confidence", "high")
                put("reason", String.format(Locale.US, "Video girişi algılandı (+%.1fs)", shift))
                put("outroSec", outroSec)
            }
        }

        val durDelta = if (actualDuration > 15.0 && lyricsDuration > 15.0) actualDuration - lyricsDuration else 0.0
        val netDelta = durDelta - outroSec

        if (outroSec >= 2.0 && netDelta > -1.5 && netDelta < 1.5) {
            return JSONObject().apply {
                put("offsetSec", 0.0)
                put("source", "outro_only")
                put("confidence", "high")
                put("reason", "Fark şarkı sonunda (outro), sözler senkron")
                put("outroSec", outroSec)
            }
        }

        if (netDelta in -35.0..-1.8) {
            val runsPastEnd = lastLyricTime > 0.0 && actualDuration > 15.0 && lastLyricTime > actualDuration - 1.5
            val largeEarlyGap = abs(netDelta) >= 3.0 && firstLyricTime > abs(netDelta) + 0.5
            if (runsPastEnd || largeEarlyGap) {
                val maxAdvance = if (firstLyricTime >= 0.0) max(0.0, firstLyricTime - 0.4) else 35.0
                val shift = round1(max(-35.0, max(-maxAdvance, netDelta)))
                if (shift <= -1.0) {
                    return JSONObject().apply {
                        put("offsetSec", shift)
                        put("source", "duration_trim")
                        put("confidence", "medium")
                        put("reason", String.format(Locale.US, "Kısa/radyo sürümü algılandı (%.1fs)", shift))
                        put("outroSec", outroSec)
                    }
                }
            }
        }

        return JSONObject().apply {
            put("offsetSec", 0.0)
            put("source", "none")
            put("confidence", "low")
            put("reason", "Sözler standart zamanlamada")
            put("outroSec", outroSec)
        }
    }

    private fun extractCoverColor(imageUrl: String): JSONObject {
        val defaultResult = JSONObject().put("rgb", "181, 122, 255").put("hex", "#b57aff")
        if (imageUrl.isBlank()) return defaultResult
        coverColorCache[imageUrl]?.let { return JSONObject(it.toString()) }

        val result = runCatching {
            val rawBytes: ByteArray = if (imageUrl.startsWith("data:image/", ignoreCase = true)) {
                val base64Part = imageUrl.substringAfter(",", "")
                if (base64Part.isBlank()) return defaultResult
                android.util.Base64.decode(base64Part, android.util.Base64.DEFAULT)
            } else {
                val req = Request.Builder()
                    .url(imageUrl)
                    .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                    .build()
                OkHttpDownloader.sharedClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return defaultResult
                    resp.body?.bytes() ?: return defaultResult
                }
            }

            val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, boundsOpts)
            var sample = 1
            val maxDim = maxOf(boundsOpts.outWidth, boundsOpts.outHeight)
            while (maxDim / sample > 96 && sample < 32) sample *= 2

            val decodeOpts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            val decoded = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, decodeOpts) ?: return defaultResult
            val scaled = if (decoded.width > 36 || decoded.height > 36) {
                Bitmap.createScaledBitmap(decoded, 32, 32, true).also {
                    if (it !== decoded) decoded.recycle()
                }
            } else {
                decoded
            }

            val bucketW = FloatArray(12)
            val bucketR = FloatArray(12)
            val bucketG = FloatArray(12)
            val bucketB = FloatArray(12)
            var monoW = 0f
            var monoR = 0f
            var monoG = 0f
            var monoB = 0f
            val hsv = FloatArray(3)

            for (y in 0 until scaled.height) {
                for (x in 0 until scaled.width) {
                    val px = scaled.getPixel(x, y)
                    if (Color.alpha(px) < 128) continue
                    val r = Color.red(px)
                    val g = Color.green(px)
                    val b = Color.blue(px)
                    Color.RGBToHSV(r, g, b, hsv)
                    val h = hsv[0]
                    val s = hsv[1]
                    val v = hsv[2]

                    if (v >= 0.14f) {
                        val mw = if (v > 0.92f) 0.35f else 1f
                        monoW += mw
                        monoR += r * mw
                        monoG += g * mw
                        monoB += b * mw
                    }

                    if (s >= 0.16f && v in 0.15f..0.95f) {
                        val idx = ((h / 30f).toInt()).coerceIn(0, 11)
                        val w = (s * s * 2.4f + 0.12f) * (1f - abs(v - 0.58f) * 0.55f)
                        bucketW[idx] += w
                        bucketR[idx] += r * w
                        bucketG[idx] += g * w
                        bucketB[idx] += b * w
                    }
                }
            }
            scaled.recycle()

            var bestIdx = -1
            var bestWeight = 0f
            for (i in 0 until 12) {
                if (bucketW[i] > bestWeight) {
                    bestWeight = bucketW[i]
                    bestIdx = i
                }
            }

            val finalColor = if (bestIdx >= 0 && bestWeight > 0.25f) {
                val r = (bucketR[bestIdx] / bucketW[bestIdx]).toInt().coerceIn(0, 255)
                val g = (bucketG[bestIdx] / bucketW[bestIdx]).toInt().coerceIn(0, 255)
                val b = (bucketB[bestIdx] / bucketW[bestIdx]).toInt().coerceIn(0, 255)
                Color.RGBToHSV(r, g, b, hsv)
                hsv[1] = hsv[1].coerceIn(0.46f, 0.88f)
                hsv[2] = hsv[2].coerceIn(0.64f, 0.94f)
                Color.HSVToColor(hsv)
            } else if (monoW > 0f) {
                val r = (monoR / monoW).toInt().coerceIn(0, 255)
                val g = (monoG / monoW).toInt().coerceIn(0, 255)
                val b = (monoB / monoW).toInt().coerceIn(0, 255)
                Color.RGBToHSV(r, g, b, hsv)
                hsv[1] = hsv[1].coerceAtMost(0.35f)
                hsv[2] = hsv[2].coerceIn(0.62f, 0.86f)
                Color.HSVToColor(hsv)
            } else {
                Color.rgb(181, 122, 255)
            }

            val fr = Color.red(finalColor)
            val fg = Color.green(finalColor)
            val fb = Color.blue(finalColor)
            val hex = String.format(Locale.US, "#%02x%02x%02x", fr, fg, fb)
            JSONObject().put("rgb", "$fr, $fg, $fb").put("hex", hex)
        }.getOrDefault(defaultResult)

        if (coverColorCache.size > 400) coverColorCache.clear()
        coverColorCache[imageUrl] = result
        return JSONObject(result.toString())
    }

    private fun isPrivateOrBlockedHost(hostname: String?): Boolean {
        val h = hostname.orEmpty().trim().lowercase(Locale.ROOT).trimStart('[').trimEnd(']')
        if (h.isEmpty() || h == "localhost" || h == "0.0.0.0" || h == "::1" || h.endsWith(".local") || h.endsWith(".internal")) {
            return true
        }
        if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) {
            return true
        }
        val m172 = Regex("^172\\.(\\d+)\\.").find(h)
        if (m172 != null) {
            val second = m172.groupValues[1].toIntOrNull() ?: 0
            if (second in 16..31) return true
        }
        return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")
    }

    private fun handleImageProxy(rawUrl: String): Response {
        if (!rawUrl.startsWith("http://", ignoreCase = true) && !rawUrl.startsWith("https://", ignoreCase = true)) {
            return errorResponse(Response.Status.BAD_REQUEST, "Geçersiz görsel bağlantısı.")
        }
        val uriObj = runCatching { URI(rawUrl) }.getOrNull()
            ?: return errorResponse(Response.Status.BAD_REQUEST, "Hatalı URL.")
        if (isPrivateOrBlockedHost(uriObj.host)) {
            return errorResponse(Response.Status.FORBIDDEN, "Engellenen adres.")
        }

        return runCatching {
            val req = Request.Builder()
                .url(rawUrl)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                .build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    return errorResponse(Response.Status.INTERNAL_ERROR, "Görsel indirilemedi (${resp.code}).")
                }
                val ct = (resp.header("Content-Type") ?: "").lowercase(Locale.ROOT)
                if (!ct.startsWith("image/")) {
                    return errorResponse(Response.Status.UNSUPPORTED_MEDIA_TYPE, "Yanıt görsel değil.")
                }
                val bytes = resp.body?.bytes() ?: ByteArray(0)
                if (bytes.isEmpty() || bytes.size > 5 * 1024 * 1024) {
                    return errorResponse(Response.Status.BAD_REQUEST, "Görsel boyutu uygun değil.")
                }
                newFixedLengthResponse(
                    Response.Status.OK,
                    ct.substringBefore(";"),
                    ByteArrayInputStream(bytes),
                    bytes.size.toLong()
                ).apply {
                    addHeader("Access-Control-Allow-Origin", "*")
                    addHeader("Cache-Control", "public, max-age=3600")
                }
            }
        }.getOrElse {
            errorResponse(Response.Status.INTERNAL_ERROR, "Görsel getirilemedi.")
        }
    }

    private fun translateLyrics(rawLines: JSONArray, targetLangRaw: String): JSONArray {
        val targetLang = targetLangRaw.replace(Regex("[^a-zA-Z-]"), "").take(10).ifEmpty { "tr" }
        val maxCount = minOf(rawLines.length(), 180)
        val cleanLines = ArrayList<String>(maxCount)
        for (i in 0 until maxCount) {
            cleanLines.add(rawLines.optString(i, "").replace(Regex("[\\r\\n]+"), " ").trim())
        }
        if (cleanLines.isEmpty()) return JSONArray()

        val cacheKey = "$targetLang:${cleanLines.joinToString("\n")}"
        translationCache[cacheKey]?.let { return JSONArray(it.toString()) }

        val result = Array(cleanLines.size) { "" }
        val nonEmptyIndices = ArrayList<Int>()
        for (i in cleanLines.indices) {
            if (cleanLines[i].isNotEmpty()) nonEmptyIndices.add(i)
        }

        runCatching {
            var cursor = 0
            while (cursor < nonEmptyIndices.size) {
                val batch = ArrayList<Int>()
                var charLen = 0
                while (cursor < nonEmptyIndices.size && batch.size < 18) {
                    val idx = nonEmptyIndices[cursor]
                    val nextLen = charLen + cleanLines[idx].length + 1
                    if (batch.isNotEmpty() && nextLen > 1400) break
                    batch.add(idx)
                    charLen = nextLen
                    cursor += 1
                }
                val query = batch.joinToString("\n") { cleanLines[it] }
                val gUrl = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
                    URLEncoder.encode(targetLang, "UTF-8") +
                    "&dt=t&q=" + URLEncoder.encode(query, "UTF-8")
                val req = Request.Builder()
                    .url(gUrl)
                    .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                    .build()
                var translated = false
                OkHttpDownloader.sharedClient.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        val rawJson = JSONArray(resp.body?.string().orEmpty())
                        val segs = rawJson.optJSONArray(0) ?: JSONArray()
                        val joined = StringBuilder()
                        for (s in 0 until segs.length()) {
                            val item = segs.optJSONArray(s) ?: continue
                            joined.append(item.optString(0, ""))
                        }
                        val splitLines = joined.toString().split("\n")
                        for (bIdx in batch.indices) {
                            result[batch[bIdx]] = splitLines.getOrNull(bIdx).orEmpty().trim()
                        }
                        translated = true
                    }
                }
                if (!translated && query.length <= 420) {
                    val mmUrl = "https://api.mymemory.translated.net/get?q=" +
                        URLEncoder.encode(query, "UTF-8") +
                        "&langpair=en|" + URLEncoder.encode(targetLang, "UTF-8")
                    val mmReq = Request.Builder()
                        .url(mmUrl)
                        .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) Chrome/131.0.0.0 Mobile Safari/537.36")
                        .build()
                    OkHttpDownloader.sharedClient.newCall(mmReq).execute().use { mmResp ->
                        if (mmResp.isSuccessful) {
                            val obj = JSONObject(mmResp.body?.string().orEmpty())
                            val txt = obj.optJSONObject("responseData")?.optString("translatedText").orEmpty()
                            val splitLines = txt.split("\n")
                            for (bIdx in batch.indices) {
                                result[batch[bIdx]] = splitLines.getOrNull(bIdx).orEmpty().trim()
                            }
                        }
                    }
                }
            }
        }

        val outArr = JSONArray()
        for (line in result) outArr.put(line)
        if (translationCache.size > 100) translationCache.clear()
        translationCache[cacheKey] = outArr
        return JSONArray(outArr.toString())
    }

    private fun handleThumbnailCache(rawUrl: String, targetSize: Int): Response {
        if (!rawUrl.startsWith("http://", true) && !rawUrl.startsWith("https://", true)) {
            return errorResponse(Response.Status.BAD_REQUEST, "Geçersiz URL.")
        }
        val uriObj = runCatching { URI(rawUrl) }.getOrNull() ?: return errorResponse(Response.Status.BAD_REQUEST, "Hatalı URL.")
        if (isPrivateOrBlockedHost(uriObj.host)) return errorResponse(Response.Status.FORBIDDEN, "Engellenen adres.")

        val keyHash = MessageDigest.getInstance("SHA-256")
            .digest("${rawUrl}_$targetSize".toByteArray())
            .joinToString("") { "%02x".format(it) }
        val cacheFile = File(thumbCacheDir, "$keyHash.jpg")
        if (cacheFile.exists() && cacheFile.length() > 256L) {
            return newFixedLengthResponse(
                Response.Status.OK,
                "image/jpeg",
                BufferedInputStream(cacheFile.inputStream(), 16384),
                cacheFile.length()
            ).apply {
                addHeader("Access-Control-Allow-Origin", "*")
                addHeader("Cache-Control", "public, max-age=604800")
            }
        }

        return runCatching {
            val req = Request.Builder()
                .url(rawUrl)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                .build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return errorResponse(Response.Status.NOT_FOUND, "Görsel yok.")
                val rawBytes = resp.body?.bytes() ?: return errorResponse(Response.Status.NOT_FOUND, "Boş görsel.")
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, bounds)
                var sample = 1
                val maxDim = max(bounds.outWidth, bounds.outHeight)
                while (maxDim / sample > targetSize * 2 && sample < 32) sample *= 2
                val decoded = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, BitmapFactory.Options().apply {
                    inSampleSize = sample
                }) ?: return errorResponse(Response.Status.INTERNAL_ERROR, "Görsel çözülemedi.")
                val scaled = if (decoded.width > targetSize || decoded.height > targetSize) {
                    val ratio = targetSize.toFloat() / max(decoded.width, decoded.height).toFloat()
                    val nw = max(1, (decoded.width * ratio).toInt())
                    val nh = max(1, (decoded.height * ratio).toInt())
                    Bitmap.createScaledBitmap(decoded, nw, nh, true).also {
                        if (it !== decoded) decoded.recycle()
                    }
                } else decoded
                val baos = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, 78, baos)
                scaled.recycle()
                val outBytes = baos.toByteArray()
                runCatching {
                    val files = thumbCacheDir.listFiles()
                    if (files != null && files.size > 450) {
                        files.sortedBy { it.lastModified() }.take(120).forEach { it.delete() }
                    }
                    cacheFile.writeBytes(outBytes)
                }
                newFixedLengthResponse(Response.Status.OK, "image/jpeg", ByteArrayInputStream(outBytes), outBytes.size.toLong()).apply {
                    addHeader("Access-Control-Allow-Origin", "*")
                    addHeader("Cache-Control", "public, max-age=604800")
                }
            }
        }.getOrElse { errorResponse(Response.Status.INTERNAL_ERROR, "Küçük resim üretilemedi.") }
    }

    private fun scanDeviceMusic(): JSONArray {
        val tracks = JSONArray()
        val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM_ID,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DISPLAY_NAME
        )
        val selection = "${MediaStore.Audio.Media.IS_MUSIC} != 0 AND ${MediaStore.Audio.Media.DURATION} >= 15000"
        val sortOrder = "${MediaStore.Audio.Media.DATE_ADDED} DESC"
        runCatching {
            context.contentResolver.query(collection, projection, selection, null, sortOrder)?.use { c ->
                var count = 0
                while (c.moveToNext() && count < 600) {
                    val id = c.getLong(0)
                    val title = c.getString(1).orEmpty().ifBlank { c.getString(6).orEmpty().substringBeforeLast(".") }
                    val rawArtist = c.getString(2).orEmpty()
                    val artist = if (rawArtist.isBlank() || rawArtist == "<unknown>") "Bilinmeyen Sanatçı" else rawArtist
                    val albumId = c.getLong(3)
                    val durSec = (c.getLong(4) / 1000L).coerceAtLeast(0L)
                    val size = c.getLong(5)
                    val fname = c.getString(6).orEmpty()
                    val contentUri = ContentUris.withAppendedId(collection, id).toString()
                    val localUrl = "/api/library/file?uri=${URLEncoder.encode(contentUri, "UTF-8")}&name=${URLEncoder.encode(fname, "UTF-8")}"
                    tracks.put(JSONObject().apply {
                        put("id", "device_$id")
                        put("title", title)
                        put("artist", artist)
                        put("duration", durSec)
                        put("size", size)
                        put("isLocal", true)
                        put("isDeviceMusic", true)
                        put("fileName", fname)
                        put("localUrl", localUrl)
                        if (albumId > 0L) put("thumbnail", "http://127.0.0.1:$listeningPort/api/album-art?id=$albumId")
                    })
                    count++
                }
            }
        }
        return tracks
    }

    private fun handleAlbumArt(albumId: Long): Response {
        if (albumId <= 0L) return errorResponse(Response.Status.NOT_FOUND, "Kapak yok.")
        val artUri = ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), albumId)
        return runCatching {
            context.contentResolver.openInputStream(artUri)?.use { ins ->
                val bytes = ins.readBytes()
                if (bytes.isEmpty()) return errorResponse(Response.Status.NOT_FOUND, "Boş kapak.")
                newFixedLengthResponse(Response.Status.OK, "image/jpeg", ByteArrayInputStream(bytes), bytes.size.toLong()).apply {
                    addHeader("Access-Control-Allow-Origin", "*")
                    addHeader("Cache-Control", "public, max-age=86400")
                }
            } ?: errorResponse(Response.Status.NOT_FOUND, "Kapak bulunamadı.")
        }.getOrElse { errorResponse(Response.Status.NOT_FOUND, "Kapak okunamadı.") }
    }

    private fun handleTrimMp3(body: JSONObject): JSONObject {
        val localUrl = body.optString("localUrl")
        val id = body.optString("id")
        val title = body.optString("title", "Sunify").ifBlank { "Sunify" }
        val artist = body.optString("artist", "")
        val query = body.optString("query")
        val startSec = body.optDouble("startSec", 0.0)
        val endSec = body.optDouble("endSec", startSec + 20.0)
        val saveToDownloads = body.optBoolean("saveToDownloads", true)

        var sourceFile: File? = null
        var sourceUri: Uri? = null
        var tempDownloaded: File? = null

        if (localUrl.contains("/api/library/file")) {
            val parsedUri = runCatching { Uri.parse("http://localhost$localUrl") }.getOrNull()
            val uParam = parsedUri?.getQueryParameter("uri").orEmpty()
            val nParam = parsedUri?.getQueryParameter("name").orEmpty()
            val (rUri, rFile) = audioService.resolveDownloadFileOrUri(uParam, nParam)
            sourceUri = rUri
            sourceFile = rFile
        }

        try {
            if (sourceFile == null && sourceUri == null) {
                val stream = audioService.resolveAudioStream(id.ifEmpty { query }, title, artist)
                val tmp = File(audioService.cacheDir, "tmp_trim_${System.currentTimeMillis()}.m4a")
                val req = Request.Builder()
                    .url(stream.url)
                    .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                    .build()
                OkHttpDownloader.streamClient.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) throw IllegalStateException("Ses indirilemedi (${res.code})")
                    res.body?.byteStream()?.use { ins ->
                        tmp.outputStream().buffered(65536).use { ins.copyTo(it, 65536) }
                    }
                }
                tempDownloaded = tmp
                sourceFile = tmp
            }

            val result = Mp3Trimmer.trimToMp3(
                context = context,
                sourceFile = sourceFile,
                sourceUri = sourceUri,
                startSec = startSec,
                endSec = endSec,
                title = title,
                artist = artist,
                saveToDownloads = saveToDownloads
            )
            return JSONObject().apply {
                put("success", true)
                put("cachePath", result.cacheFile.absolutePath)
                put("fileName", result.fileName)
                put("displayPath", result.displayPath)
                put("publicUri", result.publicUri)
            }
        } finally {
            runCatching { tempDownloaded?.delete() }
        }
    }

    private fun checkGithubLatestRelease(currentVersion: String): JSONObject {
        val fallback = JSONObject()
            .put("updateAvailable", false)
            .put("currentVersion", currentVersion)
            .put("latestVersion", currentVersion)
        return runCatching {
            val req = Request.Builder()
                .url("https://api.github.com/repos/Kadir-72I/Sunify-Mobile/releases/latest")
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "Sunify-Mobile/$currentVersion")
                .build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use fallback
                val json = JSONObject(resp.body?.string().orEmpty())
                val tag = json.optString("tag_name").trim()
                val latestVer = Regex("(\\d+\\.\\d+\\.\\d+)").find(tag)?.groupValues?.get(1)
                    ?: Regex("(\\d+\\.\\d+\\.\\d+)").find(json.optString("name"))?.groupValues?.get(1)
                    ?: currentVersion
                val assets = json.optJSONArray("assets") ?: JSONArray()
                var apkUrl = ""
                for (i in 0 until assets.length()) {
                    val a = assets.optJSONObject(i) ?: continue
                    val name = a.optString("name")
                    if (name.endsWith(".apk", ignoreCase = true)) {
                        apkUrl = a.optString("browser_download_url")
                        break
                    }
                }
                val isNewer = compareSemver(latestVer, currentVersion) > 0
                JSONObject().apply {
                    put("updateAvailable", isNewer)
                    put("currentVersion", currentVersion)
                    put("latestVersion", latestVer)
                    put("releaseName", json.optString("name").ifBlank { tag })
                    put("notes", json.optString("body").take(800))
                    put("htmlUrl", json.optString("html_url"))
                    put("apkUrl", apkUrl)
                }
            }
        }.getOrDefault(fallback)
    }

    private fun compareSemver(a: String, b: String): Int {
        val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until max(pa.size, pb.size)) {
            val va = pa.getOrElse(i) { 0 }
            val vb = pb.getOrElse(i) { 0 }
            if (va != vb) return va.compareTo(vb)
        }
        return 0
    }
}
