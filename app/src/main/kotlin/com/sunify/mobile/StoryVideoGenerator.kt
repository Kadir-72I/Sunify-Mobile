package com.sunify.mobile

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

object StoryVideoGenerator {
    private const val WIDTH = 720
    private const val HEIGHT = 1280
    private const val FPS = 24
    private const val BITRATE = 4_800_000
    private const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"

    @Volatile
    var isGenerating: Boolean = false
        private set

    @Volatile
    var progressPercent: Int = 0
        private set

    @Volatile
    var progressStage: String = ""
        private set

    fun getProgressJson(): JSONObject = JSONObject().apply {
        put("active", isGenerating)
        put("percent", progressPercent)
        put("stage", progressStage)
    }

    private fun updateProgress(pct: Int, stage: String) {
        progressPercent = pct.coerceIn(0, 100)
        progressStage = stage
    }

    data class VideoResult(
        val cacheFile: File,
        val fileName: String,
        val displayPath: String
    )

    private fun parseRgb(raw: String): IntArray {
        val parts = raw.split(",").mapNotNull { it.trim().toIntOrNull()?.coerceIn(0, 255) }
        return if (parts.size == 3) intArrayOf(parts[0], parts[1], parts[2]) else intArrayOf(181, 122, 255)
    }

    private fun shiftColor(rgb: IntArray, hueShiftDeg: Float): IntArray {
        val hsv = FloatArray(3)
        Color.RGBToHSV(rgb[0], rgb[1], rgb[2], hsv)
        hsv[0] = (hsv[0] + hueShiftDeg + 360f) % 360f
        hsv[1] = hsv[1].coerceIn(0.55f, 0.92f)
        hsv[2] = hsv[2].coerceIn(0.68f, 0.96f)
        val c = Color.HSVToColor(hsv)
        return intArrayOf(Color.red(c), Color.green(c), Color.blue(c))
    }

    private fun fetchBitmap(url: String, maxDim: Int = 420): Bitmap? {
        if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) return null
        return runCatching {
            val req = Request.Builder().url(url).header("User-Agent", UA).build()
            OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use null
                val bytes = res.body?.bytes() ?: return@use null
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                var sample = 1
                while (max(opts.outWidth, opts.outHeight) / sample > maxDim * 2) sample *= 2
                val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
                    inSampleSize = sample
                }) ?: return@use null
                val side = min(raw.width, raw.height)
                val sq = Bitmap.createBitmap(raw, (raw.width - side) / 2, (raw.height - side) / 2, side, side)
                if (sq !== raw) raw.recycle()
                if (side > maxDim) {
                    Bitmap.createScaledBitmap(sq, maxDim, maxDim, true).also { if (it !== sq) sq.recycle() }
                } else sq
            }
        }.getOrNull()
    }

    private fun easeOutCubic(t: Float): Float {
        val c = t.coerceIn(0f, 1f)
        val inv = 1f - c
        return 1f - inv * inv * inv
    }

    private fun easeOutBack(t: Float): Float {
        val c = t.coerceIn(0f, 1f)
        val c1 = 1.70158f
        val c3 = c1 + 1f
        val u = c - 1f
        return (1f + c3 * u * u * u + c1 * u * u).coerceIn(0f, 1.12f)
    }

    private fun bakeBackgroundBitmap(rgb: IntArray, rgb2: IntArray, coverBmp: Bitmap?, dimCoverAlpha: Int): Bitmap {
        val bmp = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val bgPaint = Paint().apply {
            shader = LinearGradient(
                0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat(),
                intArrayOf(
                    Color.rgb((rgb[0] * 0.22f).toInt().coerceAtLeast(14), (rgb[1] * 0.14f).toInt().coerceAtLeast(10), (rgb[2] * 0.30f).toInt().coerceAtLeast(26)),
                    Color.rgb(8, 7, 15),
                    Color.rgb((rgb2[0] * 0.24f).toInt().coerceAtLeast(16), (rgb2[1] * 0.12f).toInt().coerceAtLeast(10), (rgb2[2] * 0.28f).toInt().coerceAtLeast(24))
                ),
                floatArrayOf(0f, 0.50f, 1f),
                Shader.TileMode.CLAMP
            )
        }
        c.drawRect(0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat(), bgPaint)

        if (coverBmp != null && dimCoverAlpha > 0) {
            val tiny = Bitmap.createScaledBitmap(coverBmp, 20, 20, true)
            val drawW = HEIGHT * 1.18f
            val dx = (WIDTH - drawW) / 2f
            val dy = (HEIGHT - drawW) / 2f
            val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { alpha = dimCoverAlpha }
            c.drawBitmap(tiny, null, RectF(dx, dy, dx + drawW, dy + drawW), p)
            tiny.recycle()
            c.drawColor(Color.argb(150, 9, 7, 16))
        }

        // Hafif üst & alt sinematik vinyet
        val vigPaint = Paint().apply {
            shader = LinearGradient(
                0f, 0f, 0f, HEIGHT.toFloat(),
                intArrayOf(Color.argb(145, 5, 4, 10), Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(185, 5, 4, 10)),
                floatArrayOf(0f, 0.20f, 0.78f, 1f),
                Shader.TileMode.CLAMP
            )
        }
        c.drawRect(0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat(), vigPaint)
        return bmp
    }

    private fun bakeOrbBitmap(colorInt: Int, size: Int = 256): Bitmap {
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val r = size / 2f
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = RadialGradient(r, r, r, intArrayOf(colorInt, Color.TRANSPARENT), null, Shader.TileMode.CLAMP)
        }
        c.drawCircle(r, r, r, p)
        return bmp
    }

    private fun bakeRoundedCover(coverBmp: Bitmap, size: Int, radius: Float): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val rect = RectF(0f, 0f, size.toFloat(), size.toFloat())
        val path = Path().apply { addRoundRect(rect, radius, radius, Path.Direction.CW) }
        c.clipPath(path)
        c.drawBitmap(coverBmp, null, rect, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 3f
            color = Color.argb(75, 255, 255, 255)
        }
        c.drawRoundRect(rect, radius, radius, border)
        return out
    }

    private fun bakeSunifyLogoBitmap(rgb: IntArray, rgb2: IntArray, size: Int = 200): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val cx = size / 2f
        val cy = size / 2f
        val radius = size * 0.45f

        val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(
                cx - radius, cy - radius, cx + radius, cy + radius,
                Color.rgb(rgb[0], rgb[1], rgb[2]),
                Color.rgb(rgb2[0], rgb2[1], rgb2[2]),
                Shader.TileMode.CLAMP
            )
        }
        c.drawCircle(cx, cy, radius, bgPaint)

        val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = radius * 0.08f
            color = Color.argb(185, 255, 255, 255)
        }
        c.drawCircle(cx, cy, radius * 0.94f, ringPaint)

        val wavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeWidth = radius * 0.14f
            color = Color.WHITE
        }
        val barHeights = floatArrayOf(0.28f, 0.58f, 0.84f, 0.54f, 0.28f)
        val spacing = radius * 0.28f
        for (i in barHeights.indices) {
            val bx = cx + (i - 2) * spacing
            val halfH = radius * barHeights[i] * 0.48f
            c.drawLine(bx, cy - halfH, bx, cy + halfH, wavePaint)
        }
        return out
    }

    private fun bakeLyricEdgeMasks(): Pair<Bitmap, Bitmap> {
        val h = 110
        val topMask = Bitmap.createBitmap(WIDTH, h, Bitmap.Config.ARGB_8888)
        Canvas(topMask).drawRect(
            0f, 0f, WIDTH.toFloat(), h.toFloat(),
            Paint().apply {
                shader = LinearGradient(0f, 0f, 0f, h.toFloat(), Color.argb(235, 9, 7, 16), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            }
        )
        val botMask = Bitmap.createBitmap(WIDTH, h, Bitmap.Config.ARGB_8888)
        Canvas(botMask).drawRect(
            0f, 0f, WIDTH.toFloat(), h.toFloat(),
            Paint().apply {
                shader = LinearGradient(0f, 0f, 0f, h.toFloat(), Color.TRANSPARENT, Color.argb(240, 9, 7, 16), Shader.TileMode.CLAMP)
            }
        )
        return topMask to botMask
    }

    private fun drawParticles(canvas: Canvas, tSec: Float, dotPaint: Paint, rgb: IntArray) {
        for (i in 0 until 16) {
            val seed = i * 1.61803f
            val x = ((sin(seed * 3.1f + tSec * 0.28f) * 0.48f + 0.5f) * WIDTH)
            val y = ((HEIGHT - ((tSec * (26f + (i % 5) * 9f) + i * 97f) % (HEIGHT + 80f))) + 40f)
            val r = 2.5f + (i % 4) * 1.4f
            val alpha = (45 + 55 * abs(sin(tSec * 1.5f + seed))).toInt()
            dotPaint.color = if (i % 3 == 0) Color.argb(alpha, rgb[0], rgb[1], rgb[2]) else Color.argb(alpha, 255, 255, 255)
            canvas.drawCircle(x, y, r, dotPaint)
        }
    }

    private fun fmtTimeSec(sec: Double): String {
        val s = sec.toInt().coerceAtLeast(0)
        val m = s / 60
        val r = s % 60
        return "$m:${if (r < 10) "0" else ""}$r"
    }

    private fun ellipsize(paint: Paint, text: String, maxWidth: Float): String {
        if (paint.measureText(text) <= maxWidth) return text
        var s = text
        while (s.length > 2 && paint.measureText("$s…") > maxWidth) s = s.dropLast(1)
        return "$s…"
    }

    private fun wrapText(paint: Paint, text: String, maxWidth: Float): List<String> {
        val words = text.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val out = mutableListOf<String>()
        var cur = ""
        for (w in words) {
            val cand = if (cur.isEmpty()) w else "$cur $w"
            if (paint.measureText(cand) <= maxWidth) cur = cand
            else {
                if (cur.isNotEmpty()) out.add(cur)
                cur = w
            }
        }
        if (cur.isNotEmpty()) out.add(cur)
        return out
    }

    private fun saveVideoToGallery(context: Context, srcFile: File, fileName: String): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/Sunify")
                put(MediaStore.Video.Media.IS_PENDING, 1)
            }
            val uri = context.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
            if (uri != null) {
                context.contentResolver.openOutputStream(uri)?.use { os ->
                    srcFile.inputStream().buffered(65536).use { it.copyTo(os, 65536) }
                }
                values.clear()
                values.put(MediaStore.Video.Media.IS_PENDING, 0)
                context.contentResolver.update(uri, values, null, null)
                return "Filmler/Sunify/$fileName"
            }
        } else {
            runCatching {
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "Sunify")
                dir.mkdirs()
                val dst = File(dir, fileName)
                srcFile.copyTo(dst, overwrite = true)
                MediaScannerConnection.scanFile(context, arrayOf(dst.absolutePath), arrayOf("video/mp4"), null)
                return "Filmler/Sunify/$fileName"
            }
        }
        return fileName
    }

    private fun openAacExtractor(
        context: Context,
        audioService: YouTubeAudioService,
        id: String,
        title: String,
        artist: String
    ): Pair<MediaExtractor?, File?> {
        val streamUrl = runCatching {
            audioService.resolveAudioStream(id.ifBlank { "$artist $title" }, title, artist).url
        }.getOrNull() ?: return null to null

        val directEx = runCatching {
            val ex = MediaExtractor()
            ex.setDataSource(streamUrl, mapOf("User-Agent" to UA))
            var idx = -1
            for (i in 0 until ex.trackCount) {
                if (ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME).equals("audio/mp4a-latm", true)) {
                    idx = i
                    break
                }
            }
            if (idx >= 0) {
                ex.selectTrack(idx)
                ex
            } else {
                ex.release()
                null
            }
        }.getOrNull()
        if (directEx != null) return directEx to null

        val tmpFile = runCatching {
            val tmp = File(context.cacheDir, "story_audio_${System.currentTimeMillis()}.m4a")
            val req = Request.Builder().url(streamUrl).header("User-Agent", UA).build()
            OkHttpDownloader.streamClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use null
                res.body?.byteStream()?.use { ins ->
                    tmp.outputStream().buffered(65536).use { ins.copyTo(it, 65536) }
                }
            }
            if (tmp.exists() && tmp.length() > 4096L) tmp else null
        }.getOrNull() ?: return null to null

        val fileEx = runCatching {
            val ex = MediaExtractor()
            ex.setDataSource(tmpFile.absolutePath)
            var idx = -1
            for (i in 0 until ex.trackCount) {
                if (ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME).equals("audio/mp4a-latm", true)) {
                    idx = i
                    break
                }
            }
            if (idx >= 0) {
                ex.selectTrack(idx)
                ex
            } else {
                ex.release()
                null
            }
        }.getOrNull()
        return fileEx to tmpFile
    }

    private fun renderAndMuxVideo(
        context: Context,
        durationSec: Double,
        audioExtractor: MediaExtractor?,
        audioStartSec: Double,
        fileName: String,
        drawFrame: (canvas: Canvas, tSec: Float, progress: Float) -> Unit
    ): VideoResult {
        val storiesDir = File(context.cacheDir, "stories").apply { mkdirs() }
        val outFile = File(storiesDir, "story_${System.currentTimeMillis()}.mp4")

        val safeDur = durationSec.coerceIn(4.0, 600.0)
        val totalFrames = (safeDur * FPS).toInt().coerceAtLeast(FPS * 4)

        var encoder: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var muxerStarted = false

        try {
            var audioFormat: MediaFormat? = null
            if (audioExtractor != null) {
                for (i in 0 until audioExtractor.trackCount) {
                    val fmt = audioExtractor.getTrackFormat(i)
                    if (fmt.getString(MediaFormat.KEY_MIME).equals("audio/mp4a-latm", true)) {
                        audioFormat = fmt
                        break
                    }
                }
            }

            val videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
                setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                }
            }

            val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            encoder = enc
            enc.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val inputSurface = enc.createInputSurface()
            enc.start()

            val mx = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = mx
            var videoTrackIndex = -1
            var audioTrackIndex = -1
            val bufferInfo = MediaCodec.BufferInfo()
            val frameDurationUs = 1_000_000L / FPS
            var writtenVideoFrames = 0L

            fun drainEncoder(endOfStream: Boolean) {
                if (endOfStream) enc.signalEndOfInputStream()
                val timeoutUs = if (endOfStream) 5_000L else 0L
                while (true) {
                    val outIdx = enc.dequeueOutputBuffer(bufferInfo, timeoutUs)
                    when {
                        outIdx == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                            if (!endOfStream) break
                        }
                        outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            videoTrackIndex = mx.addTrack(enc.outputFormat)
                            if (audioFormat != null) {
                                audioTrackIndex = mx.addTrack(audioFormat!!)
                            }
                            mx.start()
                            muxerStarted = true
                        }
                        outIdx >= 0 -> {
                            val encoded = enc.getOutputBuffer(outIdx)
                            if (encoded != null && bufferInfo.size > 0 &&
                                (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 &&
                                muxerStarted
                            ) {
                                encoded.position(bufferInfo.offset)
                                encoded.limit(bufferInfo.offset + bufferInfo.size)
                                bufferInfo.presentationTimeUs = writtenVideoFrames * frameDurationUs
                                writtenVideoFrames++
                                mx.writeSampleData(videoTrackIndex, encoded, bufferInfo)
                            }
                            val isEos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            enc.releaseOutputBuffer(outIdx, false)
                            if (isEos) break
                        }
                    }
                }
            }

            updateProgress(15, "Video kareleri işleniyor...")
            for (frame in 0 until totalFrames) {
                val tSec = frame.toFloat() / FPS.toFloat()
                val progress = frame.toFloat() / max(1, totalFrames - 1).toFloat()
                val canvas = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    inputSurface.lockHardwareCanvas()
                } else {
                    inputSurface.lockCanvas(null)
                }
                try {
                    drawFrame(canvas, tSec, progress)
                } finally {
                    inputSurface.unlockCanvasAndPost(canvas)
                }
                drainEncoder(false)
                if (frame % 8 == 0) {
                    val pct = 15 + ((frame.toFloat() / totalFrames.toFloat()) * 73f).toInt()
                    updateProgress(pct, "Kareler işleniyor (${frame + 1}/$totalFrames)")
                }
            }
            updateProgress(88, "Video sonlandırılıyor...")
            drainEncoder(true)
            inputSurface.release()

            if (muxerStarted && audioTrackIndex >= 0 && audioExtractor != null) {
                updateProgress(91, "Ses senkronize ediliyor...")
                val startUs = (audioStartSec.coerceAtLeast(0.0) * 1_000_000.0).toLong()
                val maxDurUs = (safeDur * 1_000_000.0).toLong()
                if (startUs > 0L) audioExtractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                val firstPts = audioExtractor.sampleTime.coerceAtLeast(0L)
                val audioBuf = ByteBuffer.allocate(256 * 1024)
                val aInfo = MediaCodec.BufferInfo()
                var lastAudioPts = -1L
                while (true) {
                    val sampleSize = audioExtractor.readSampleData(audioBuf, 0)
                    if (sampleSize < 0) break
                    val pts = audioExtractor.sampleTime
                    var relPts = (pts - firstPts).coerceAtLeast(0L)
                    if (relPts <= lastAudioPts) relPts = lastAudioPts + 1000L
                    if (relPts > maxDurUs) break
                    lastAudioPts = relPts
                    aInfo.offset = 0
                    aInfo.size = sampleSize
                    aInfo.presentationTimeUs = relPts
                    aInfo.flags = if ((audioExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                        MediaCodec.BUFFER_FLAG_KEY_FRAME
                    } else 0
                    mx.writeSampleData(audioTrackIndex, audioBuf, aInfo)
                    audioExtractor.advance()
                }
            }

            updateProgress(96, "MP4 dosyası paketleniyor...")
            runCatching { enc.stop() }
            runCatching { enc.release() }
            encoder = null
            if (muxerStarted) {
                mx.stop()
                muxerStarted = false
            }
            mx.release()
            muxer = null

            if (!outFile.exists() || outFile.length() < 8192L) {
                throw IllegalStateException("Video dosyası oluşturulamadı.")
            }

            updateProgress(98, "Galeriye kaydediliyor...")
            val displayPath = saveVideoToGallery(context, outFile, fileName)
            updateProgress(100, "Tamamlandı!")
            return VideoResult(outFile, fileName, displayPath)
        } finally {
            runCatching { encoder?.stop() }
            runCatching { encoder?.release() }
            if (muxerStarted) runCatching { muxer?.stop() }
            runCatching { muxer?.release() }
        }
    }

    fun generateWrappedStoryVideo(
        context: Context,
        audioService: YouTubeAudioService,
        payload: JSONObject
    ): VideoResult {
        isGenerating = true
        updateProgress(2, "Dinleme verilerin analiz ediliyor...")
        val username = payload.optString("username", "Sunify Dinleyicisi").ifBlank { "Sunify Dinleyicisi" }
        val coverRgb = parseRgb(payload.optString("coverRgb", "181, 122, 255"))
        val accentRgb2 = shiftColor(coverRgb, 48f)
        val totalMinutes = payload.optInt("totalMinutes", 0)
        val totalPlays = payload.optInt("totalPlays", 0)
        val streakDays = payload.optInt("streakDays", 0)
        val uniqueTracks = payload.optInt("uniqueTracks", 0)
        val uniqueArtists = payload.optInt("uniqueArtists", 0)
        val topTracksArr = payload.optJSONArray("topTracks") ?: JSONArray()
        val topArtistsArr = payload.optJSONArray("topArtists") ?: JSONArray()
        val weekdayArr = payload.optJSONArray("weekdayMinutes") ?: JSONArray()
        val topMonthsArr = payload.optJSONArray("topMonths") ?: JSONArray()
        val peakWeekday = payload.optString("peakWeekday", "Cuma").ifBlank { "Cuma" }
        val peakHourLabel = payload.optString("peakHourLabel", "21:00 – 00:00").ifBlank { "21:00 – 00:00" }
        val peakHourMood = payload.optString("peakHourMood", "Gece Kuşu").ifBlank { "Gece Kuşu" }
        val peakHourVal = payload.optInt("peakHour", 22).coerceIn(0, 23)

        val topTracks = mutableListOf<JSONObject>()
        for (i in 0 until min(5, topTracksArr.length())) topTracksArr.optJSONObject(i)?.let { topTracks.add(it) }
        val topArtists = mutableListOf<Pair<String, Int>>()
        for (i in 0 until min(4, topArtistsArr.length())) {
            val a = topArtistsArr.optJSONObject(i) ?: continue
            topArtists.add(a.optString("name") to a.optInt("count", 0))
        }
        val weekdayMins = IntArray(7) { idx -> weekdayArr.optInt(idx, 0) }
        val topMonths = mutableListOf<Pair<String, Int>>()
        for (i in 0 until min(4, topMonthsArr.length())) {
            val m = topMonthsArr.optJSONObject(i) ?: continue
            topMonths.add(m.optString("label") to m.optInt("minutes", 0))
        }

        updateProgress(6, "Albüm kapakları ve grafikler hazırlanıyor...")
        val firstTrack = topTracks.firstOrNull()
        val topCoverRaw = firstTrack?.optString("thumbnail").orEmpty().let { fetchBitmap(it, 420) }
        val topCoverRounded = topCoverRaw?.let { bakeRoundedCover(it, 420, 44f) }
        val miniCovers = topTracks.map { t ->
            fetchBitmap(t.optString("thumbnail"), 120)?.let { raw ->
                bakeRoundedCover(raw, 84, 18f).also { raw.recycle() }
            }
        }
        val prebakedBg = bakeBackgroundBitmap(coverRgb, accentRgb2, topCoverRaw, 58)
        val orb1Bmp = bakeOrbBitmap(Color.argb(140, coverRgb[0], coverRgb[1], coverRgb[2]), 256)
        val orb2Bmp = bakeOrbBitmap(Color.argb(120, accentRgb2[0], accentRgb2[1], accentRgb2[2]), 256)
        val logoBmp = bakeSunifyLogoBitmap(coverRgb, accentRgb2, 200)

        updateProgress(11, "Arka plan müziği bağlanıyor...")
        val (audioEx, tmpAudio) = if (firstTrack != null) {
            openAacExtractor(context, audioService, firstTrack.optString("id"), firstTrack.optString("title"), firstTrack.optString("artist"))
        } else null to null

        val personality = when {
            peakHourVal >= 22 || peakHourVal <= 4 -> "Gece Melodisi Tutkunu"
            totalMinutes >= 600 -> "Durdurulamaz Müzik Aşığı"
            streakDays >= 7 -> "Sadık Ritim Yolcusu"
            uniqueArtists >= 12 -> "Türler Arası Kaşif"
            else -> "Sunify Ritim Gezgini"
        }

        val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(215, 255, 255, 255); typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL) }
        val accentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2]); typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val accent2Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(accentRgb2[0], accentRgb2[1], accentRgb2[2]); typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val cardFillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val cardStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2.2f }
        val barBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(65, 255, 255, 255) }
        val barFgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        val bmpPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val ringStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
        val tmpRect = RectF()
        val segTimes = floatArrayOf(0f, 3.6f, 7.6f, 11.6f, 15.8f, 20.0f, 24.4f, 28.4f, 32.0f)
        val segCount = 8
        val segBarW = (WIDTH - 56f - (segCount - 1) * 6f) / segCount
        val footerLogoRect = RectF(50f, HEIGHT - 88f, 92f, HEIGHT - 46f)
        val dayLabels = arrayOf("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")
        val maxDayMin = max(1, weekdayMins.maxOrNull() ?: 1)
        val maxMonthMin = max(1, topMonths.maxOfOrNull { it.second } ?: 1)
        val totalArtistPlays = max(1, topArtists.sumOf { it.second })

        try {
            return renderAndMuxVideo(
                context = context,
                durationSec = 32.0,
                audioExtractor = audioEx,
                audioStartSec = 25.0,
                fileName = "Sunify-Wrapped-${System.currentTimeMillis()}.mp4"
            ) { canvas, tSec, _ ->
                canvas.drawBitmap(prebakedBg, 0f, 0f, null)

                val ox1 = WIDTH * 0.20f + cos(tSec * 0.7f) * 95f
                val oy1 = HEIGHT * 0.22f + sin(tSec * 0.55f) * 80f
                tmpRect.set(ox1 - 390f, oy1 - 390f, ox1 + 390f, oy1 + 390f)
                canvas.drawBitmap(orb1Bmp, null, tmpRect, null)

                val ox2 = WIDTH * 0.82f + sin(tSec * 0.65f) * 85f
                val oy2 = HEIGHT * 0.76f + cos(tSec * 0.8f) * 85f
                tmpRect.set(ox2 - 370f, oy2 - 370f, ox2 + 370f, oy2 + 370f)
                canvas.drawBitmap(orb2Bmp, null, tmpRect, null)

                drawParticles(canvas, tSec, dotPaint, coverRgb)

                // Üst 8 sahneli Story ilerleme çubuğu
                for (s in 0 until segCount) {
                    val bx = 28f + s * (segBarW + 6f)
                    tmpRect.set(bx, 38f, bx + segBarW, 44f)
                    canvas.drawRoundRect(tmpRect, 3f, 3f, barBgPaint)
                    val sp = ((tSec - segTimes[s]) / (segTimes[s + 1] - segTimes[s])).coerceIn(0f, 1f)
                    if (sp > 0f) {
                        tmpRect.set(bx, 38f, bx + segBarW * sp, 44f)
                        canvas.drawRoundRect(tmpRect, 3f, 3f, barFgPaint)
                    }
                }

                when {
                    // SAHNE 1: SİNEMATİK AÇILIŞ
                    tSec < segTimes[1] -> {
                        val p = easeOutBack(tSec / 1.0f)
                        val p2 = easeOutCubic((tSec - 0.3f) / 0.9f)
                        val pulse = 1f + 0.045f * sin(tSec * 4.2f)

                        ringStrokePaint.strokeWidth = 3f
                        ringStrokePaint.color = Color.argb((120 * p2).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                        canvas.drawCircle(WIDTH / 2f, 450f, 145f * pulse, ringStrokePaint)
                        ringStrokePaint.color = Color.argb((70 * p2).toInt(), accentRgb2[0], accentRgb2[1], accentRgb2[2])
                        canvas.drawCircle(WIDTH / 2f, 450f, 195f * (2f - pulse), ringStrokePaint)

                        val r = 104f * p.coerceAtMost(1.06f) * pulse
                        bmpPaint.alpha = (255 * p.coerceIn(0f, 1f)).toInt()
                        tmpRect.set(WIDTH / 2f - r, 450f - r, WIDTH / 2f + r, 450f + r)
                        canvas.drawBitmap(logoBmp, null, tmpRect, bmpPaint)
                        bmpPaint.alpha = 255

                        titlePaint.textAlign = Paint.Align.CENTER; titlePaint.textSize = 64f; titlePaint.alpha = (255 * p2).toInt()
                        canvas.drawText("SUNIFY", WIDTH / 2f, 665f + (1f - p2) * 35f, titlePaint)
                        accentPaint.textAlign = Paint.Align.CENTER; accentPaint.textSize = 36f; accentPaint.alpha = (255 * p2).toInt()
                        canvas.drawText("DİNLEME ÖZETİN", WIDTH / 2f, 725f, accentPaint)

                        val ba = (255 * easeOutCubic((tSec - 0.8f) / 0.8f)).toInt()
                        tmpRect.set(140f, 795f, WIDTH - 140f, 875f)
                        cardFillPaint.color = Color.argb((ba * 0.16f).toInt(), 255, 255, 255)
                        canvas.drawRoundRect(tmpRect, 40f, 40f, cardFillPaint)
                        cardStrokePaint.color = Color.argb((ba * 0.45f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                        canvas.drawRoundRect(tmpRect, 40f, 40f, cardStrokePaint)
                        subPaint.textAlign = Paint.Align.CENTER; subPaint.textSize = 30f; subPaint.alpha = ba
                        canvas.drawText(ellipsize(subPaint, username, 390f), WIDTH / 2f, 846f, subPaint)
                    }

                    // SAHNE 2: TOPLAM DİNLEME, SAAT & SERİ
                    tSec < segTimes[2] -> {
                        val lt = tSec - segTimes[1]
                        val p = easeOutCubic(lt / 0.75f)
                        accentPaint.textAlign = Paint.Align.LEFT; accentPaint.textSize = 24f; accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("01  •  SENİN RİTMİN", 54f, 150f, accentPaint)
                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 50f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("Müziğinle Geçen Zaman", 54f, 218f, titlePaint)

                        val cp = easeOutCubic(lt / 1.5f)
                        val hrs = String.format(java.util.Locale.US, "%.1f saat", (totalMinutes * cp) / 60.0)
                        val rows = listOf(
                            Triple("${(totalMinutes * cp).toInt()} dk", "TOPLAM DİNLEME ($hrs)", 295f),
                            Triple("${(totalPlays * cp).toInt()}", "TAMAMLANAN ŞARKI  •  $uniqueTracks FARKLI PARÇA", 505f),
                            Triple("${(streakDays * cp).toInt()} gün", "KESİNTİSİZ AKTİF SERİ  •  $uniqueArtists SANATÇI", 715f)
                        )
                        rows.forEachIndexed { i, (valStr, lbl, topY) ->
                            val rp = easeOutCubic((lt - i * 0.22f) / 0.65f)
                            val sl = (1f - rp) * 85f
                            tmpRect.set(54f + sl, topY, WIDTH - 54f + sl, topY + 178f)
                            cardFillPaint.color = Color.argb((rp * 38f).toInt(), 255, 255, 255)
                            canvas.drawRoundRect(tmpRect, 34f, 34f, cardFillPaint)
                            cardStrokePaint.color = Color.argb((rp * 120f).toInt(), if (i % 2 == 0) coverRgb[0] else accentRgb2[0], if (i % 2 == 0) coverRgb[1] else accentRgb2[1], if (i % 2 == 0) coverRgb[2] else accentRgb2[2])
                            canvas.drawRoundRect(tmpRect, 34f, 34f, cardStrokePaint)

                            titlePaint.textSize = 68f; titlePaint.alpha = (255 * rp).toInt()
                            canvas.drawText(valStr, tmpRect.left + 34f, topY + 94f, titlePaint)
                            subPaint.textAlign = Paint.Align.LEFT; subPaint.textSize = 21f; subPaint.alpha = (205 * rp).toInt()
                            canvas.drawText(lbl, tmpRect.left + 34f, topY + 144f, subPaint)
                        }
                    }

                    // SAHNE 3: HAFTANIN EN YOĞUN GÜNÜ (7 GÜNLÜK ANİMASYONLU BAR GRAFİĞİ)
                    tSec < segTimes[3] -> {
                        val lt = tSec - segTimes[2]
                        val p = easeOutCubic(lt / 0.7f)
                        accent2Paint.textAlign = Paint.Align.LEFT; accent2Paint.textSize = 24f; accent2Paint.alpha = (255 * p).toInt()
                        canvas.drawText("02  •  HAFTALIK RİTMİN", 54f, 150f, accent2Paint)
                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 48f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("En Çok $peakWeekday", 54f, 218f, titlePaint)
                        titlePaint.textSize = 42f
                        canvas.drawText("Günleri Dinledin", 54f, 272f, titlePaint)

                        // Grafik kartı
                        tmpRect.set(46f, 340f, WIDTH - 46f, 940f)
                        cardFillPaint.color = Color.argb((p * 32f).toInt(), 255, 255, 255)
                        canvas.drawRoundRect(tmpRect, 36f, 36f, cardFillPaint)
                        cardStrokePaint.color = Color.argb((p * 95f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                        canvas.drawRoundRect(tmpRect, 36f, 36f, cardStrokePaint)

                        val chartLeft = 82f
                        val chartBottom = 840f
                        val maxBarH = 380f
                        val colW = (WIDTH - 164f) / 7f
                        for (d in 0 until 7) {
                            val bp = easeOutBack((lt - d * 0.08f) / 0.75f).coerceIn(0f, 1.05f)
                            val mins = weekdayMins[d]
                            val isPeak = mins == maxDayMin && mins > 0
                            val h = max(18f, (mins.toFloat() / maxDayMin.toFloat()) * maxBarH) * bp.coerceAtMost(1f)
                            val cx = chartLeft + d * colW + colW / 2f
                            tmpRect.set(cx - 22f, chartBottom - h, cx + 22f, chartBottom)
                            cardFillPaint.color = if (isPeak) {
                                Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2])
                            } else {
                                Color.argb(120, accentRgb2[0], accentRgb2[1], accentRgb2[2])
                            }
                            canvas.drawRoundRect(tmpRect, 14f, 14f, cardFillPaint)

                            subPaint.textAlign = Paint.Align.CENTER
                            subPaint.textSize = 22f
                            subPaint.alpha = if (isPeak) 255 else 185
                            canvas.drawText(dayLabels[d], cx, chartBottom + 44f, subPaint)
                            if (mins > 0) {
                                subPaint.textSize = 18f
                                canvas.drawText("${mins}d", cx, chartBottom - h - 14f, subPaint)
                            }
                        }

                        val hintP = easeOutCubic((lt - 0.8f) / 0.7f)
                        subPaint.textAlign = Paint.Align.CENTER; subPaint.textSize = 26f; subPaint.alpha = (220 * hintP).toInt()
                        canvas.drawText("Hafta içi ve hafta sonu dinleme dağılımın", WIDTH / 2f, 1020f, subPaint)
                    }

                    // SAHNE 4: EN ÇOK DİNLENEN AYLAR & SAAT DİLİMİ
                    tSec < segTimes[4] -> {
                        val lt = tSec - segTimes[3]
                        val p = easeOutCubic(lt / 0.7f)
                        accentPaint.textAlign = Paint.Align.LEFT; accentPaint.textSize = 24f; accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("03  •  ZAMAN & AYLAR", 54f, 148f, accentPaint)
                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 46f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("En Yoğun Saat & Ayların", 54f, 212f, titlePaint)

                        // Üst Saat Kadranı Kartı
                        tmpRect.set(50f, 265f, WIDTH - 50f, 545f)
                        cardFillPaint.color = Color.argb((p * 36f).toInt(), 255, 255, 255)
                        canvas.drawRoundRect(tmpRect, 34f, 34f, cardFillPaint)
                        cardStrokePaint.color = Color.argb((p * 115f).toInt(), accentRgb2[0], accentRgb2[1], accentRgb2[2])
                        canvas.drawRoundRect(tmpRect, 34f, 34f, cardStrokePaint)

                        val clockCx = 165f
                        val clockCy = 405f
                        ringStrokePaint.strokeWidth = 10f
                        ringStrokePaint.color = Color.argb(65, 255, 255, 255)
                        canvas.drawCircle(clockCx, clockCy, 76f, ringStrokePaint)
                        val sweep = 110f * easeOutCubic(lt / 1.1f)
                        val startAngle = ((peakHourVal % 12) * 30f) - 90f
                        ringStrokePaint.color = Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2])
                        tmpRect.set(clockCx - 76f, clockCy - 76f, clockCx + 76f, clockCy + 76f)
                        canvas.drawArc(tmpRect, startAngle, sweep, false, ringStrokePaint)

                        titlePaint.textAlign = Paint.Align.CENTER; titlePaint.textSize = 32f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText(String.format(java.util.Locale.US, "%02d:00", peakHourVal), clockCx, clockCy + 11f, titlePaint)

                        accent2Paint.textAlign = Paint.Align.LEFT; accent2Paint.textSize = 23f; accent2Paint.alpha = (255 * p).toInt()
                        canvas.drawText("EN AKTİF ZAMANIN", 275f, 355f, accent2Paint)
                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 38f
                        canvas.drawText(peakHourMood, 275f, 408f, titlePaint)
                        subPaint.textAlign = Paint.Align.LEFT; subPaint.textSize = 26f; subPaint.alpha = (210 * p).toInt()
                        canvas.drawText(peakHourLabel, 275f, 456f, subPaint)

                        // Alt Aylar Kartı
                        accentPaint.textAlign = Paint.Align.LEFT; accentPaint.textSize = 23f
                        canvas.drawText("EN ÇOK DİNLEDİĞİN AYLAR", 54f, 615f, accentPaint)

                        val displayMonths = if (topMonths.isNotEmpty()) topMonths else listOf("Bu Ay" to totalMinutes)
                        displayMonths.forEachIndexed { idx, (mLabel, mMins) ->
                            val mp = easeOutCubic((lt - 0.35f - idx * 0.16f) / 0.7f)
                            val y = 650f + idx * 104f
                            tmpRect.set(50f, y, WIDTH - 50f, y + 84f)
                            cardFillPaint.color = Color.argb((mp * 32f).toInt(), 255, 255, 255)
                            canvas.drawRoundRect(tmpRect, 24f, 24f, cardFillPaint)

                            val fillW = max(24f, ((WIDTH - 136f) * (mMins.toFloat() / maxMonthMin.toFloat())) * mp)
                            tmpRect.set(68f, y + 54f, 68f + fillW, y + 66f)
                            cardFillPaint.color = if (idx == 0) Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2]) else Color.argb(175, accentRgb2[0], accentRgb2[1], accentRgb2[2])
                            canvas.drawRoundRect(tmpRect, 6f, 6f, cardFillPaint)

                            titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 26f; titlePaint.alpha = (255 * mp).toInt()
                            canvas.drawText(mLabel, 68f, y + 39f, titlePaint)
                            subPaint.textAlign = Paint.Align.RIGHT; subPaint.textSize = 23f; subPaint.alpha = (220 * mp).toInt()
                            canvas.drawText("$mMins dk", WIDTH - 68f, y + 39f, subPaint)
                        }
                    }

                    // SAHNE 5: #1 ZİRVEDEKİ ŞARKI
                    tSec < segTimes[5] -> {
                        val lt = tSec - segTimes[4]
                        val p = easeOutBack(lt / 0.9f)
                        val pLinear = easeOutCubic(lt / 0.75f)
                        accentPaint.textAlign = Paint.Align.CENTER; accentPaint.textSize = 24f; accentPaint.alpha = (255 * pLinear).toInt()
                        canvas.drawText("04  •  ZİRVEDEKİ PARÇAN", WIDTH / 2f, 152f, accentPaint)
                        titlePaint.textAlign = Paint.Align.CENTER; titlePaint.textSize = 48f; titlePaint.alpha = (255 * pLinear).toInt()
                        canvas.drawText("1 Numaralı Şarkın", WIDTH / 2f, 218f, titlePaint)

                        val pulse = 1f + 0.025f * sin(lt * 3.8f)
                        val artSize = 410f * (0.76f + 0.24f * p.coerceAtMost(1.05f)) * pulse
                        val artLeft = (WIDTH - artSize) / 2f
                        val artTop = 285f
                        tmpRect.set(artLeft - 45f, artTop - 45f, artLeft + artSize + 45f, artTop + artSize + 45f)
                        canvas.drawBitmap(orb1Bmp, null, tmpRect, null)

                        tmpRect.set(artLeft, artTop, artLeft + artSize, artTop + artSize)
                        if (topCoverRounded != null) canvas.drawBitmap(topCoverRounded, null, tmpRect, bmpPaint)
                        else {
                            cardFillPaint.color = Color.argb(145, coverRgb[0], coverRgb[1], coverRgb[2])
                            canvas.drawRoundRect(tmpRect, 44f, 44f, cardFillPaint)
                        }

                        val tTitle = firstTrack?.optString("title").orEmpty().ifBlank { "Henüz Veri Yok" }
                        val tArtist = firstTrack?.optString("artist").orEmpty()
                        val tPlays = firstTrack?.optInt("playCount", 0) ?: 0
                        val tp = easeOutCubic((lt - 0.35f) / 0.7f)
                        titlePaint.textAlign = Paint.Align.CENTER; titlePaint.textSize = 42f; titlePaint.alpha = (255 * tp).toInt()
                        canvas.drawText(ellipsize(titlePaint, tTitle, 610f), WIDTH / 2f, 800f, titlePaint)
                        subPaint.textAlign = Paint.Align.CENTER; subPaint.textSize = 29f; subPaint.alpha = (210 * tp).toInt()
                        canvas.drawText(ellipsize(subPaint, tArtist, 580f), WIDTH / 2f, 852f, subPaint)

                        tmpRect.set(190f, 904f, WIDTH - 190f, 976f)
                        cardFillPaint.color = Color.argb((tp * 215f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                        canvas.drawRoundRect(tmpRect, 36f, 36f, cardFillPaint)
                        titlePaint.textSize = 27f
                        canvas.drawText("$tPlays kez baştan sona dinlendi", WIDTH / 2f, 950f, titlePaint)
                    }

                    // SAHNE 6: TOP 5 PARÇALAR (GERÇEK MİNİ KAPAKLARLA)
                    tSec < segTimes[6] -> {
                        val lt = tSec - segTimes[5]
                        val p = easeOutCubic(lt / 0.65f)
                        accent2Paint.textAlign = Paint.Align.LEFT; accent2Paint.textSize = 24f; accent2Paint.alpha = (255 * p).toInt()
                        canvas.drawText("05  •  TOP 5 LİSTEN", 52f, 148f, accent2Paint)
                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 46f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("Döngüye Aldığın Parçalar", 52f, 212f, titlePaint)

                        topTracks.forEachIndexed { idx, item ->
                            val rp = easeOutCubic((lt - idx * 0.14f) / 0.55f)
                            val y = 266f + idx * 144f
                            val sl = (1f - rp) * 95f
                            tmpRect.set(48f + sl, y, WIDTH - 48f + sl, y + 122f)
                            cardFillPaint.color = Color.argb((rp * 38f).toInt(), 255, 255, 255)
                            canvas.drawRoundRect(tmpRect, 28f, 28f, cardFillPaint)
                            if (idx == 0) {
                                cardStrokePaint.color = Color.argb((rp * 145f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                                canvas.drawRoundRect(tmpRect, 28f, 28f, cardStrokePaint)
                            }

                            accentPaint.textAlign = Paint.Align.CENTER; accentPaint.textSize = 34f; accentPaint.alpha = (255 * rp).toInt()
                            canvas.drawText("${idx + 1}", tmpRect.left + 36f, y + 72f, accentPaint)

                            val mc = miniCovers.getOrNull(idx)
                            val cLeft = tmpRect.left + 68f
                            val cRect = RectF(cLeft, y + 19f, cLeft + 84f, y + 103f)
                            if (mc != null) canvas.drawBitmap(mc, null, cRect, bmpPaint)
                            else {
                                cardFillPaint.color = Color.argb(120, coverRgb[0], coverRgb[1], coverRgb[2])
                                canvas.drawRoundRect(cRect, 18f, 18f, cardFillPaint)
                            }

                            titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 27f; titlePaint.alpha = (255 * rp).toInt()
                            canvas.drawText(ellipsize(titlePaint, item.optString("title"), 345f), cLeft + 102f, y + 54f, titlePaint)
                            subPaint.textAlign = Paint.Align.LEFT; subPaint.textSize = 21f; subPaint.alpha = (190 * rp).toInt()
                            canvas.drawText(ellipsize(subPaint, item.optString("artist"), 345f), cLeft + 102f, y + 88f, subPaint)
                            accent2Paint.textAlign = Paint.Align.RIGHT; accent2Paint.textSize = 24f; accent2Paint.alpha = (240 * rp).toInt()
                            canvas.drawText("${item.optInt("playCount", 0)}x", tmpRect.right - 24f, y + 70f, accent2Paint)
                        }
                    }

                    // SAHNE 7: FAVORİ SANATÇILAR
                    tSec < segTimes[7] -> {
                        val lt = tSec - segTimes[6]
                        val p = easeOutCubic(lt / 0.7f)
                        accentPaint.textAlign = Paint.Align.LEFT; accentPaint.textSize = 24f; accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("06  •  FAVORİ SANATÇILARIN", 52f, 150f, accentPaint)
                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 46f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("Sana Eşlik Eden İsimler", 52f, 214f, titlePaint)

                        topArtists.forEachIndexed { idx, (name, cnt) ->
                            val rp = easeOutCubic((lt - idx * 0.18f) / 0.65f)
                            val y = 285f + idx * 172f
                            val sl = (1f - rp) * 80f
                            tmpRect.set(50f + sl, y, WIDTH - 50f + sl, y + 144f)
                            cardFillPaint.color = Color.argb((rp * 38f).toInt(), 255, 255, 255)
                            canvas.drawRoundRect(tmpRect, 30f, 30f, cardFillPaint)

                            val pct = ((cnt * 100f) / totalArtistPlays).toInt().coerceIn(5, 100)
                            val fillW = max(36f, ((WIDTH - 148f) * (pct / 100f)) * rp)
                            tmpRect.set(74f + sl, y + 104f, 74f + sl + fillW, y + 118f)
                            cardFillPaint.color = if (idx == 0) Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2]) else Color.argb(190, accentRgb2[0], accentRgb2[1], accentRgb2[2])
                            canvas.drawRoundRect(tmpRect, 7f, 7f, cardFillPaint)

                            accentPaint.textAlign = Paint.Align.LEFT; accentPaint.textSize = 36f; accentPaint.alpha = (255 * rp).toInt()
                            canvas.drawText("#${idx + 1}", 74f + sl, y + 66f, accentPaint)
                            titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 32f; titlePaint.alpha = (255 * rp).toInt()
                            canvas.drawText(ellipsize(titlePaint, name, 370f), 148f + sl, y + 64f, titlePaint)
                            subPaint.textAlign = Paint.Align.RIGHT; subPaint.textSize = 24f; subPaint.alpha = (210 * rp).toInt()
                            canvas.drawText("$cnt dinleme", WIDTH - 74f + sl, y + 64f, subPaint)
                        }
                    }

                    // SAHNE 8: FİNAL PAYLAŞIM KARTI & MÜZİK KİŞİLİĞİN
                    else -> {
                        val lt = tSec - segTimes[7]
                        val p = easeOutCubic(lt / 0.75f)
                        val r = 64f * p
                        bmpPaint.alpha = (255 * p).toInt()
                        tmpRect.set(WIDTH / 2f - r, 210f - r, WIDTH / 2f + r, 210f + r)
                        canvas.drawBitmap(logoBmp, null, tmpRect, bmpPaint)
                        bmpPaint.alpha = 255

                        accent2Paint.textAlign = Paint.Align.CENTER; accent2Paint.textSize = 24f; accent2Paint.alpha = (255 * p).toInt()
                        canvas.drawText("MÜZİK KİŞİLİĞİN", WIDTH / 2f, 326f, accent2Paint)
                        titlePaint.textAlign = Paint.Align.CENTER; titlePaint.textSize = 48f; titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText(ellipsize(titlePaint, personality, 620f), WIDTH / 2f, 388f, titlePaint)

                        // Final özet cam kartı
                        tmpRect.set(52f, 440f, WIDTH - 52f, 1080f)
                        cardFillPaint.color = Color.argb((p * 42f).toInt(), 255, 255, 255)
                        canvas.drawRoundRect(tmpRect, 38f, 38f, cardFillPaint)
                        cardStrokePaint.color = Color.argb((p * 140f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                        canvas.drawRoundRect(tmpRect, 38f, 38f, cardStrokePaint)

                        subPaint.textAlign = Paint.Align.CENTER; subPaint.textSize = 25f; subPaint.alpha = (235 * p).toInt()
                        canvas.drawText("$totalMinutes dk  •  $totalPlays çalma  •  $streakDays gün seri", WIDTH / 2f, 506f, subPaint)
                        accentPaint.textAlign = Paint.Align.CENTER; accentPaint.textSize = 23f; accentPaint.alpha = (240 * p).toInt()
                        canvas.drawText("En Yoğun: $peakWeekday  •  $peakHourLabel", WIDTH / 2f, 552f, accentPaint)

                        titlePaint.textAlign = Paint.Align.LEFT; titlePaint.textSize = 23f; titlePaint.alpha = (210 * p).toInt()
                        canvas.drawText("TOP ŞARKILAR", 86f, 622f, titlePaint)
                        topTracks.take(3).forEachIndexed { idx, t ->
                            titlePaint.textSize = 28f; titlePaint.alpha = (255 * p).toInt()
                            canvas.drawText("${idx + 1}. ${ellipsize(titlePaint, t.optString("title"), 510f)}", 86f, 668f + idx * 52f, titlePaint)
                        }

                        titlePaint.textSize = 23f; titlePaint.alpha = (210 * p).toInt()
                        canvas.drawText("TOP SANATÇILAR", 86f, 862f, titlePaint)
                        topArtists.take(3).forEachIndexed { idx, (n, _) ->
                            titlePaint.textSize = 28f; titlePaint.alpha = (255 * p).toInt()
                            canvas.drawText("${idx + 1}. ${ellipsize(titlePaint, n, 510f)}", 86f, 908f + idx * 52f, titlePaint)
                        }

                        subPaint.textAlign = Paint.Align.CENTER; subPaint.textSize = 22f; subPaint.alpha = (180 * p).toInt()
                        canvas.drawText("Sunify ile oluşturuldu  •  $username", WIDTH / 2f, 1142f, subPaint)
                    }
                }

                canvas.drawBitmap(logoBmp, null, footerLogoRect, bmpPaint)
                subPaint.textAlign = Paint.Align.LEFT; subPaint.textSize = 22f; subPaint.alpha = 220
                canvas.drawText("Sunify Wrapped", 104f, HEIGHT - 59f, subPaint)
            }
        } finally {
            isGenerating = false
            topCoverRaw?.recycle()
            topCoverRounded?.recycle()
            miniCovers.forEach { it?.recycle() }
            prebakedBg.recycle()
            orb1Bmp.recycle()
            orb2Bmp.recycle()
            logoBmp.recycle()
            runCatching { audioEx?.release() }
            runCatching { tmpAudio?.delete() }
        }
    }

    fun generateLyricClipStoryVideo(
        context: Context,
        audioService: YouTubeAudioService,
        payload: JSONObject
    ): VideoResult {
        isGenerating = true
        updateProgress(2, "Şarkı bilgileri ve sözler hazırlanıyor...")
        val trackId = payload.optString("id")
        val title = payload.optString("title", "Sunify").ifBlank { "Sunify" }
        val artist = payload.optString("artist", "")
        val thumbnail = payload.optString("thumbnail", "")
        val coverRgb = parseRgb(payload.optString("coverRgb", "181, 122, 255"))
        val accentRgb2 = shiftColor(coverRgb, 42f)
        val startSec = payload.optDouble("startSec", 0.0).coerceAtLeast(0.0)
        val rawEndSec = payload.optDouble("endSec", startSec + 20.0)
        val durationSec = (rawEndSec - startSec).coerceIn(4.0, 600.0)
        val lyricsOffset = payload.optDouble("lyricsOffset", 0.0)
        val rawLines = payload.optJSONArray("lyrics") ?: JSONArray()

        data class LyricLine(val time: Double, val text: String, val wrappedActive: List<String>, val wrappedDim: List<String>)
        val activeLyricPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 44f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val activeGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(115, coverRgb[0], coverRgb[1], coverRgb[2]); textSize = 44f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val dimLyricPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(125, 255, 255, 255); textSize = 33f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }

        val lines = mutableListOf<LyricLine>()
        for (i in 0 until rawLines.length()) {
            val o = rawLines.optJSONObject(i) ?: continue
            val txt = o.optString("text").trim()
            if (txt.isNotEmpty()) {
                lines.add(
                    LyricLine(
                        time = o.optDouble("time", 0.0),
                        text = txt,
                        wrappedActive = wrapText(activeLyricPaint, txt, WIDTH - 116f).take(3),
                        wrappedDim = wrapText(dimLyricPaint, txt, WIDTH - 116f).take(2)
                    )
                )
            }
        }

        updateProgress(7, "Kapak ve sinematik arka plan pişiriliyor...")
        val coverRaw = fetchBitmap(thumbnail, 420)
        val coverRounded = coverRaw?.let { bakeRoundedCover(it, 132, 24f) }
        val prebakedBg = bakeBackgroundBitmap(coverRgb, accentRgb2, coverRaw, 102)
        val orb1Bmp = bakeOrbBitmap(Color.argb(135, coverRgb[0], coverRgb[1], coverRgb[2]), 256)
        val orb2Bmp = bakeOrbBitmap(Color.argb(110, accentRgb2[0], accentRgb2[1], accentRgb2[2]), 256)
        val logoBmp = bakeSunifyLogoBitmap(coverRgb, accentRgb2, 128)
        val (topFadeMask, botFadeMask) = bakeLyricEdgeMasks()

        updateProgress(11, "Yüksek kaliteli ses akışı bağlanıyor...")
        val (audioEx, tmpAudio) = openAacExtractor(context, audioService, trackId, title, artist)

        val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 33f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(210, 255, 255, 255); textSize = 24f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL) }
        val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(185, 255, 255, 255); textSize = 20f; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val headerFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(165, 12, 10, 22) }
        val headerStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2.4f; color = Color.argb(145, coverRgb[0], coverRgb[1], coverRgb[2]) }
        val fallbackArtPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(160, coverRgb[0], coverRgb[1], coverRgb[2]) }
        val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val progBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(65, 255, 255, 255) }
        val progFgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2]) }
        val knobPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        val bmpPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val highlightPillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(38, coverRgb[0], coverRgb[1], coverRgb[2]) }

        val headerRect = RectF(40f, 76f, WIDTH - 40f, 252f)
        val artRect = RectF(62f, 98f, 194f, 230f)
        val headerLogoRect = RectF(WIDTH - 122f, 136f, WIDTH - 64f, 194f)
        val footerLogoRect = RectF(54f, 1218f, 90f, 1254f)
        val lyricsTop = 290f
        val lyricsBottom = 1030f
        val clipRect = RectF(32f, lyricsTop, WIDTH - 32f, lyricsBottom)
        val progBgRect = RectF(56f, 1170f, WIDTH - 56f, 1178f)
        val tmpRect = RectF()
        val ellipsizedTitle = ellipsize(titlePaint, title, 345f)
        val ellipsizedArtist = ellipsize(subPaint, artist, 345f)
        val fallbackCenterTitle = ellipsize(activeLyricPaint, title, 600f)
        val endTimeLabel = fmtTimeSec(startSec + durationSec)

        var smoothedScrollIdx = 0f
        var prevActiveIdx = -1
        var activeLineAge = 0f

        try {
            val cleanName = "${artist.trim()} - ${title.trim()}"
                .replace(Regex("[\\\\/:*?\"<>|\\r\\n\\t]+"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()
                .ifEmpty { "Sunify-Klip" }
                .take(64)

            return renderAndMuxVideo(
                context = context,
                durationSec = durationSec,
                audioExtractor = audioEx,
                audioStartSec = startSec,
                fileName = "$cleanName-Story.mp4"
            ) { canvas, tSec, progress ->
                canvas.drawBitmap(prebakedBg, 0f, 0f, null)

                val ox1 = WIDTH * 0.22f + cos(tSec * 0.75f) * 85f
                val oy1 = HEIGHT * 0.22f + sin(tSec * 0.6f) * 70f
                tmpRect.set(ox1 - 380f, oy1 - 380f, ox1 + 380f, oy1 + 380f)
                canvas.drawBitmap(orb1Bmp, null, tmpRect, null)

                val ox2 = WIDTH * 0.80f + sin(tSec * 0.7f) * 80f
                val oy2 = HEIGHT * 0.76f + cos(tSec * 0.85f) * 75f
                tmpRect.set(ox2 - 360f, oy2 - 360f, ox2 + 360f, oy2 + 360f)
                canvas.drawBitmap(orb2Bmp, null, tmpRect, null)

                drawParticles(canvas, tSec, dotPaint, coverRgb)

                // Üst Premium Cam Şarkı Kartı
                canvas.drawRoundRect(headerRect, 36f, 36f, headerFill)
                canvas.drawRoundRect(headerRect, 36f, 36f, headerStroke)

                if (coverRounded != null) canvas.drawBitmap(coverRounded, null, artRect, bmpPaint)
                else canvas.drawRoundRect(artRect, 24f, 24f, fallbackArtPaint)

                canvas.drawText(ellipsizedTitle, 214f, 152f, titlePaint)
                subPaint.textSize = 24f; subPaint.alpha = 205
                canvas.drawText(ellipsizedArtist, 214f, 192f, subPaint)

                // Mini canlı çalan ekolayzer çubukları (3 çubuk)
                for (mb in 0 until 3) {
                    val mh = 7f + 13f * abs(sin(tSec * 6.5f + mb * 1.1f))
                    barPaint.color = Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2])
                    tmpRect.set(214f + mb * 9f, 224f - mh, 220f + mb * 9f, 224f)
                    canvas.drawRoundRect(tmpRect, 3f, 3f, barPaint)
                }
                subPaint.textSize = 18f; subPaint.alpha = 165
                canvas.drawText("Şimdi Çalıyor", 248f, 223f, subPaint)
                canvas.drawBitmap(logoBmp, null, headerLogoRect, bmpPaint)

                // Orta Kayan Sözler + Yumuşak Üst/Alt Fade Maskesi
                val centerY = (lyricsTop + lyricsBottom) / 2f
                val curSongTime = startSec + tSec + lyricsOffset
                var activeIdx = 0
                for (i in lines.indices) {
                    if (curSongTime >= lines[i].time) activeIdx = i
                }
                if (activeIdx != prevActiveIdx) {
                    prevActiveIdx = activeIdx
                    activeLineAge = 0f
                } else {
                    activeLineAge += 1f / FPS.toFloat()
                }
                smoothedScrollIdx += (activeIdx.toFloat() - smoothedScrollIdx) * 0.22f

                val saveLyrics = canvas.save()
                canvas.clipRect(clipRect)
                if (lines.isEmpty()) {
                    activeLyricPaint.textAlign = Paint.Align.CENTER
                    canvas.drawText(fallbackCenterTitle, WIDTH / 2f, centerY, activeLyricPaint)
                    activeLyricPaint.textAlign = Paint.Align.LEFT
                } else {
                    val lineSpacing = 152f
                    val popScale = 1f + 0.045f * easeOutCubic(activeLineAge / 0.28f)
                    for (i in lines.indices) {
                        val delta = i - smoothedScrollIdx
                        if (abs(delta) > 3.6f) continue
                        val yBase = centerY + delta * lineSpacing
                        val distNorm = abs(delta).coerceIn(0f, 2.5f)
                        val isActive = i == activeIdx

                        if (isActive) {
                            val wrapped = lines[i].wrappedActive
                            val blockH = wrapped.size * 54f + 22f
                            val topBox = yBase - blockH / 2f - 10f
                            tmpRect.set(42f, topBox, WIDTH - 42f, topBox + blockH + 14f)
                            canvas.drawRoundRect(tmpRect, 24f, 24f, highlightPillPaint)

                            val scSave = canvas.save()
                            canvas.scale(popScale, popScale, 60f, yBase)
                            val blockOff = -(wrapped.size - 1) * 26f
                            for (wi in wrapped.indices) {
                                val ly = yBase + blockOff + wi * 54f
                                canvas.drawText(wrapped[wi], 62f, ly + 2f, activeGlowPaint)
                                canvas.drawText(wrapped[wi], 60f, ly, activeLyricPaint)
                            }
                            canvas.restoreToCount(scSave)
                        } else {
                            dimLyricPaint.alpha = if (distNorm < 1.3f) 140 else 65
                            val wrapped = lines[i].wrappedDim
                            val blockOff = -(wrapped.size - 1) * 20f
                            for (wi in wrapped.indices) {
                                canvas.drawText(wrapped[wi], 60f, yBase + blockOff + wi * 42f, dimLyricPaint)
                            }
                        }
                    }
                }
                canvas.drawBitmap(topFadeMask, 0f, lyricsTop, null)
                canvas.drawBitmap(botFadeMask, 0f, lyricsBottom - botFadeMask.height, null)
                canvas.restoreToCount(saveLyrics)

                // Alt Simetrik Aynalı Spektrum Çubukları (32 çubuk)
                val barCount = 32
                val vizLeft = 52f
                val gap = 5f
                val bw = (WIDTH - 104f - gap * (barCount - 1)) / barCount
                val vizBaseY = 1110f
                val half = barCount / 2f
                for (b in 0 until barCount) {
                    val distFromCenter = abs(b - half) / half
                    val envelope = 1f - distFromCenter * 0.55f
                    val wave = (0.20f + 0.80f * abs(sin((tSec * 4.8f + b * 0.42f).toDouble())).toFloat()) * envelope
                    val bh = 10f + wave * 54f
                    val bx = vizLeft + b * (bw + gap)
                    barPaint.color = Color.argb((115 + wave * 135).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                    tmpRect.set(bx, vizBaseY - bh / 2f, bx + bw, vizBaseY + bh / 2f)
                    canvas.drawRoundRect(tmpRect, bw / 2f, bw / 2f, barPaint)
                }

                // İlerleme Çubuğu + Parlak Uç Nokta + Zaman Damgaları
                canvas.drawRoundRect(progBgRect, 4f, 4f, progBgPaint)
                val curX = 56f + (WIDTH - 112f) * progress
                tmpRect.set(56f, 1170f, curX, 1178f)
                canvas.drawRoundRect(tmpRect, 4f, 4f, progFgPaint)
                canvas.drawCircle(curX, 1174f, 7f, knobPaint)

                timePaint.textAlign = Paint.Align.LEFT
                canvas.drawText(fmtTimeSec(startSec + tSec), 56f, 1202f, timePaint)
                timePaint.textAlign = Paint.Align.RIGHT
                canvas.drawText(endTimeLabel, WIDTH - 56f, 1202f, timePaint)

                canvas.drawBitmap(logoBmp, null, footerLogoRect, bmpPaint)
                subPaint.textAlign = Paint.Align.LEFT; subPaint.textSize = 21f; subPaint.alpha = 220
                canvas.drawText("Sunify  •  Şarkı Klibi", 102f, 1244f, subPaint)
            }
        } finally {
            isGenerating = false
            coverRaw?.recycle()
            coverRounded?.recycle()
            prebakedBg.recycle()
            orb1Bmp.recycle()
            orb2Bmp.recycle()
            logoBmp.recycle()
            topFadeMask.recycle()
            botFadeMask.recycle()
            runCatching { audioEx?.release() }
            runCatching { tmpAudio?.delete() }
        }
    }
}
