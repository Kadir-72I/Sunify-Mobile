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
        val topPercentile = payload.optInt("topPercentile", if (totalMinutes >= 6000) 3 else if (totalMinutes >= 1500) 10 else 22)
        val fanPercentile = payload.optString("fanPercentile", "1").ifBlank { "1" }
        val yearNow = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)

        val topTracks = mutableListOf<JSONObject>()
        for (i in 0 until min(5, topTracksArr.length())) topTracksArr.optJSONObject(i)?.let { topTracks.add(it) }
        val topArtists = mutableListOf<Pair<String, Int>>()
        for (i in 0 until min(5, topArtistsArr.length())) {
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
        val topCoverRounded = topCoverRaw?.let { bakeRoundedCover(it, 420, 28f) }
        val miniCovers = topTracks.map { t ->
            fetchBitmap(t.optString("thumbnail"), 120)?.let { raw ->
                bakeRoundedCover(raw, 84, 14f).also { raw.recycle() }
            }
        }
        val spGreen = Color.rgb(30, 215, 96)
        val spBlack = Color.rgb(18, 18, 18)
        val spPink = Color.rgb(255, 77, 141)
        val spLime = Color.rgb(210, 231, 152)
        val spPurple = Color.rgb(125, 60, 255)
        val spYellow = Color.rgb(255, 230, 0)
        val spOrange = Color.rgb(255, 107, 43)
        val spCobalt = Color.rgb(45, 70, 185)
        val spPastelPink = Color.rgb(255, 153, 229)

        val orbGreen = bakeOrbBitmap(Color.argb(150, 30, 215, 96), 256)
        val orbPink = bakeOrbBitmap(Color.argb(145, 255, 77, 141), 256)
        val orbPurple = bakeOrbBitmap(Color.argb(155, 125, 60, 255), 256)
        val orbYellow = bakeOrbBitmap(Color.argb(130, 255, 230, 0), 256)
        val logoBmp = bakeSunifyLogoBitmap(intArrayOf(30, 215, 96), intArrayOf(125, 60, 255), 200)

        updateProgress(11, "Arka plan müziği bağlanıyor...")
        val (audioEx, tmpAudio) = if (firstTrack != null) {
            openAacExtractor(context, audioService, firstTrack.optString("id"), firstTrack.optString("title"), firstTrack.optString("artist"))
        } else null to null

        val personality = payload.optString("personaTitle", "").ifBlank {
            when {
                peakHourVal >= 22 || peakHourVal <= 4 -> "Gece Melodisi Tutkunu"
                totalMinutes >= 1200 -> "Durdurulamaz Müzik Aşığı"
                streakDays >= 7 -> "Sadık Ritim Yolcusu"
                uniqueArtists >= 12 -> "Türler Arası Kaşif"
                else -> "Vibe Mimarı"
            }
        }

        val boldPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
        val regPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL) }
        val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 4f }
        val bmpPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val ringStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
        val tmpRect = RectF()
        val segTimes = floatArrayOf(0f, 3.6f, 7.6f, 11.6f, 15.6f, 19.6f, 24.0f, 28.0f, 32.0f, 36.0f)
        val segCount = 9
        val segBarW = (WIDTH - 56f - (segCount - 1) * 5f) / segCount
        val footerLogoRect = RectF(50f, HEIGHT - 84f, 88f, HEIGHT - 46f)
        val dayLabels = arrayOf("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")
        val maxDayMin = max(1, weekdayMins.maxOrNull() ?: 1)
        val maxMonthMin = max(1, topMonths.maxOfOrNull { it.second } ?: 1)
        val totalArtistPlays = max(1, topArtists.sumOf { it.second })

        fun drawKineticRibbon(canvas: Canvas, cx: Float, cy: Float, w: Float, h: Float, deg: Float, color: Int) {
            canvas.save()
            canvas.translate(cx, cy)
            canvas.rotate(deg)
            fillPaint.color = color
            tmpRect.set(-w / 2f, -h / 2f, w / 2f, h / 2f)
            canvas.drawRoundRect(tmpRect, h / 2f, h / 2f, fillPaint)
            canvas.restore()
        }

        try {
            return renderAndMuxVideo(
                context = context,
                durationSec = 36.0,
                audioExtractor = audioEx,
                audioStartSec = 25.0,
                fileName = "Sunify-Wrapped-${System.currentTimeMillis()}.mp4"
            ) { canvas, tSec, _ ->
                var isLightSlide = false

                when {
                    // SAHNE 1: SPOTIFY WRAPPED INTRO (#121212 + #1ED760 + #FF4D8D)
                    tSec < segTimes[1] -> {
                        val p = easeOutBack(tSec / 0.9f)
                        val p2 = easeOutCubic((tSec - 0.2f) / 0.8f)
                        canvas.drawColor(spBlack)

                        val ox1 = WIDTH * 0.85f + sin(tSec * 1.1f) * 40f
                        val oy1 = 160f + cos(tSec * 0.9f) * 35f
                        tmpRect.set(ox1 - 320f, oy1 - 320f, ox1 + 320f, oy1 + 320f)
                        canvas.drawBitmap(orbGreen, null, tmpRect, null)

                        val ox2 = WIDTH * 0.14f + cos(tSec * 1.0f) * 45f
                        val oy2 = HEIGHT - 180f + sin(tSec * 0.8f) * 35f
                        tmpRect.set(ox2 - 310f, oy2 - 310f, ox2 + 310f, oy2 + 310f)
                        canvas.drawBitmap(orbPink, null, tmpRect, null)

                        drawKineticRibbon(canvas, WIDTH * 0.35f + tSec * 12f, 290f, 640f, 54f, -16f, Color.argb(95, 125, 60, 255))
                        drawKineticRibbon(canvas, WIDTH * 0.72f - tSec * 10f, 1020f, 520f, 44f, -16f, Color.argb(90, 30, 215, 96))

                        val r = 74f * p.coerceAtMost(1.06f)
                        tmpRect.set(56f, 360f - r, 56f + r * 2f, 360f + r)
                        canvas.drawBitmap(logoBmp, null, tmpRect, bmpPaint)

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spGreen; boldPaint.textSize = 28f; boldPaint.alpha = (255 * p2).toInt()
                        canvas.drawText("$yearNow ÖZETİN HAZIR", 56f, 525f, boldPaint)

                        boldPaint.color = Color.WHITE; boldPaint.textSize = 104f
                        canvas.drawText("Sunify", 52f, 645f + (1f - p2) * 36f, boldPaint)
                        canvas.drawText("Wrapped", 52f, 752f + (1f - p2) * 36f, boldPaint)

                        regPaint.textAlign = Paint.Align.LEFT; regPaint.color = Color.argb((215 * p2).toInt(), 255, 255, 255); regPaint.textSize = 30f
                        canvas.drawText("Bu yılın ses yolculuğu başlıyor.", 56f, 825f, regPaint)

                        val bp = easeOutBack((tSec - 0.55f) / 0.7f).coerceAtMost(1.05f)
                        tmpRect.set(56f, 890f, 56f + 390f * bp, 966f)
                        fillPaint.color = spGreen
                        canvas.drawRoundRect(tmpRect, 38f, 38f, fillPaint)
                        boldPaint.color = spBlack; boldPaint.textSize = 29f; boldPaint.alpha = (255 * bp.coerceIn(0f, 1f)).toInt()
                        canvas.drawText(ellipsize(boldPaint, username, 330f), 88f, 939f, boldPaint)
                    }

                    // SAHNE 2: TOPLAM DİNLEME DAKİKASI (#FF4D8D HOT PINK + STARK BLACK)
                    tSec < segTimes[2] -> {
                        isLightSlide = true
                        val lt = tSec - segTimes[1]
                        val p = easeOutCubic(lt / 0.65f)
                        val cp = easeOutCubic(lt / 1.4f)
                        canvas.drawColor(spPink)

                        tmpRect.set(-160f, -120f, 380f, 420f)
                        canvas.drawBitmap(orbYellow, null, tmpRect, null)
                        drawKineticRibbon(canvas, WIDTH * 0.62f, 1080f, 760f, 76f, -14f, Color.argb(45, 18, 18, 18))

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spBlack; boldPaint.textSize = 26f; boldPaint.alpha = (230 * p).toInt()
                        canvas.drawText("BU YIL MÜZİĞE DOYDUN", 56f, 195f, boldPaint)

                        val animMins = (totalMinutes * cp).toInt()
                        boldPaint.textSize = 148f; boldPaint.alpha = (255 * p).toInt()
                        canvas.drawText(String.format(java.util.Locale.forLanguageTag("tr-TR"), "%,d", animMins), 50f, 390f + (1f - p) * 40f, boldPaint)
                        boldPaint.textSize = 68f
                        canvas.drawText("dakika dinledin", 54f, 474f, boldPaint)

                        val hrs = max(1, (totalMinutes / 60))
                        boldPaint.textSize = 34f; boldPaint.alpha = (225 * p).toInt()
                        canvas.drawText("Tam $hrs saat kesintisiz müzik.", 56f, 575f, boldPaint)
                        canvas.drawText("$uniqueTracks farklı parça  •  $uniqueArtists sanatçı", 56f, 628f, boldPaint)
                        canvas.drawText("$totalPlays tam dinleme  •  $streakDays gün seri", 56f, 681f, boldPaint)

                        val bp = easeOutBack((lt - 0.45f) / 0.7f).coerceAtMost(1.04f)
                        tmpRect.set(56f, 775f, WIDTH - 56f, 868f)
                        fillPaint.color = spBlack
                        canvas.drawRoundRect(tmpRect, 46f, 46f, fillPaint)
                        boldPaint.textAlign = Paint.Align.CENTER; boldPaint.color = spYellow; boldPaint.textSize = 31f; boldPaint.alpha = (255 * bp.coerceIn(0f, 1f)).toInt()
                        canvas.drawText("En aktif %$topPercentile dinleyici dilimindesin", WIDTH / 2f, 833f, boldPaint)
                    }

                    // SAHNE 3: ZİRVE AYLARIN (#D2E798 ACID LIME + STARK BLACK)
                    tSec < segTimes[3] -> {
                        isLightSlide = true
                        val lt = tSec - segTimes[2]
                        val p = easeOutCubic(lt / 0.65f)
                        canvas.drawColor(spLime)

                        tmpRect.set(WIDTH - 340f, HEIGHT - 340f, WIDTH + 120f, HEIGHT + 120f)
                        canvas.drawBitmap(orbGreen, null, tmpRect, null)

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spBlack; boldPaint.textSize = 26f; boldPaint.alpha = (225 * p).toInt()
                        canvas.drawText("DİNLEME EVRİMİN", 56f, 185f, boldPaint)
                        boldPaint.textSize = 68f; boldPaint.alpha = (255 * p).toInt()
                        canvas.drawText("Zirve Yaptığın", 54f, 268f, boldPaint)
                        canvas.drawText("Aylar", 54f, 340f, boldPaint)

                        val displayMonths = if (topMonths.isNotEmpty()) topMonths else listOf("Bu Ay" to max(1, totalMinutes))
                        displayMonths.forEachIndexed { idx, (mLabel, mMins) ->
                            val mp = easeOutCubic((lt - 0.15f - idx * 0.15f) / 0.7f)
                            val y = 435f + idx * 145f
                            boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spBlack; boldPaint.textSize = 34f; boldPaint.alpha = (255 * mp).toInt()
                            canvas.drawText(mLabel, 56f, y, boldPaint)
                            boldPaint.textAlign = Paint.Align.RIGHT; boldPaint.textSize = 30f
                            canvas.drawText("$mMins dk", WIDTH - 56f, y, boldPaint)

                            tmpRect.set(56f, y + 22f, WIDTH - 56f, y + 62f)
                            fillPaint.color = Color.argb(45, 18, 18, 18)
                            canvas.drawRoundRect(tmpRect, 20f, 20f, fillPaint)

                            val fillW = max(36f, ((WIDTH - 112f) * (mMins.toFloat() / maxMonthMin.toFloat())) * mp)
                            tmpRect.set(56f, y + 22f, 56f + fillW, y + 62f)
                            fillPaint.color = if (idx == 0) spBlack else Color.argb(170, 18, 18, 18)
                            canvas.drawRoundRect(tmpRect, 20f, 20f, fillPaint)
                        }
                    }

                    // SAHNE 4: HAFTALIK RİTİM & SAAT (#7D3CFF ELECTRIC PURPLE + #FFE600 YELLOW)
                    tSec < segTimes[4] -> {
                        val lt = tSec - segTimes[3]
                        val p = easeOutCubic(lt / 0.65f)
                        canvas.drawColor(spPurple)

                        tmpRect.set(WIDTH - 320f, -120f, WIDTH + 120f, 320f)
                        canvas.drawBitmap(orbPink, null, tmpRect, null)

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spYellow; boldPaint.textSize = 26f; boldPaint.alpha = (255 * p).toInt()
                        canvas.drawText("HAFTALIK RİTMİN & SAATİN", 54f, 175f, boldPaint)
                        boldPaint.color = Color.WHITE; boldPaint.textSize = 60f
                        canvas.drawText("En Aktif Günün:", 52f, 250f, boldPaint)
                        boldPaint.color = spYellow; boldPaint.textSize = 72f
                        canvas.drawText(peakWeekday, 52f, 330f, boldPaint)

                        // 7 günlük grafik kutusu
                        tmpRect.set(46f, 385f, WIDTH - 46f, 805f)
                        fillPaint.color = Color.argb(72, 18, 18, 18)
                        canvas.drawRoundRect(tmpRect, 34f, 34f, fillPaint)

                        val chartLeft = 78f
                        val chartBottom = 735f
                        val maxBarH = 265f
                        val colW = (WIDTH - 156f) / 7f
                        for (d in 0 until 7) {
                            val bp = easeOutBack((lt - d * 0.07f) / 0.65f).coerceIn(0f, 1.04f)
                            val mins = weekdayMins[d]
                            val isPeak = mins == maxDayMin && mins > 0
                            val h = max(20f, (mins.toFloat() / maxDayMin.toFloat()) * maxBarH) * bp.coerceAtMost(1f)
                            val cx = chartLeft + d * colW + colW / 2f
                            tmpRect.set(cx - 22f, chartBottom - h, cx + 22f, chartBottom)
                            fillPaint.color = if (isPeak) spYellow else Color.argb(150, 255, 255, 255)
                            canvas.drawRoundRect(tmpRect, 14f, 14f, fillPaint)

                            boldPaint.textAlign = Paint.Align.CENTER; boldPaint.textSize = 22f
                            boldPaint.color = if (isPeak) spYellow else Color.WHITE
                            canvas.drawText(dayLabels[d], cx, chartBottom + 40f, boldPaint)
                        }

                        // Saat kadranı kartı
                        tmpRect.set(46f, 845f, WIDTH - 46f, 1085f)
                        fillPaint.color = Color.argb(86, 18, 18, 18)
                        canvas.drawRoundRect(tmpRect, 34f, 34f, fillPaint)

                        val clockCx = 158f; val clockCy = 965f
                        ringStrokePaint.strokeWidth = 10f; ringStrokePaint.color = Color.argb(75, 255, 255, 255)
                        canvas.drawCircle(clockCx, clockCy, 66f, ringStrokePaint)
                        ringStrokePaint.color = spYellow
                        tmpRect.set(clockCx - 66f, clockCy - 66f, clockCx + 66f, clockCy + 66f)
                        canvas.drawArc(tmpRect, ((peakHourVal % 12) * 30f) - 90f, 115f * easeOutCubic(lt / 1.0f), false, ringStrokePaint)

                        boldPaint.textAlign = Paint.Align.CENTER; boldPaint.color = Color.WHITE; boldPaint.textSize = 28f
                        canvas.drawText(String.format(java.util.Locale.US, "%02d:00", peakHourVal), clockCx, clockCy + 10f, boldPaint)

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spYellow; boldPaint.textSize = 24f
                        canvas.drawText("ZİRVE SAAT DİLİMİN", 260f, 922f, boldPaint)
                        boldPaint.color = Color.WHITE; boldPaint.textSize = 42f
                        canvas.drawText(peakHourMood, 260f, 978f, boldPaint)
                        regPaint.textAlign = Paint.Align.LEFT; regPaint.color = Color.argb(225, 255, 255, 255); regPaint.textSize = 28f
                        canvas.drawText(peakHourLabel, 260f, 1026f, regPaint)
                    }

                    // SAHNE 5: #1 NUMARALI ŞARKIN (#1ED760 SPOTIFY GREEN + OFFSET BLACK FRAME)
                    tSec < segTimes[5] -> {
                        isLightSlide = true
                        val lt = tSec - segTimes[4]
                        val p = easeOutBack(lt / 0.85f).coerceAtMost(1.04f)
                        val pLin = easeOutCubic(lt / 0.65f)
                        canvas.drawColor(spGreen)

                        drawKineticRibbon(canvas, WIDTH * 0.65f, 220f, 700f, 58f, -18f, Color.argb(38, 18, 18, 18))

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spBlack; boldPaint.textSize = 26f; boldPaint.alpha = (230 * pLin).toInt()
                        canvas.drawText("#1 NUMARALI ŞARKIN", 56f, 180f, boldPaint)
                        boldPaint.textSize = 44f; boldPaint.alpha = (255 * pLin).toInt()
                        canvas.drawText("Elinden bırakamadığın parça...", 56f, 240f, boldPaint)

                        val artSize = 400f * (0.78f + 0.22f * p)
                        val artLeft = (WIDTH - artSize) / 2f
                        val artTop = 305f
                        // Spotify Wrapped Neo-Brutalist siyah ofset gölge
                        fillPaint.color = spBlack
                        tmpRect.set(artLeft + 18f, artTop + 18f, artLeft + artSize + 18f, artTop + artSize + 18f)
                        canvas.drawRoundRect(tmpRect, 28f, 28f, fillPaint)

                        tmpRect.set(artLeft, artTop, artLeft + artSize, artTop + artSize)
                        if (topCoverRounded != null) canvas.drawBitmap(topCoverRounded, null, tmpRect, bmpPaint)
                        else {
                            fillPaint.color = spPurple
                            canvas.drawRoundRect(tmpRect, 28f, 28f, fillPaint)
                        }
                        strokePaint.color = spBlack; strokePaint.strokeWidth = 6f
                        canvas.drawRoundRect(tmpRect, 28f, 28f, strokePaint)

                        val tTitle = firstTrack?.optString("title").orEmpty().ifBlank { "Henüz Veri Yok" }
                        val tArtist = firstTrack?.optString("artist").orEmpty()
                        val tPlays = firstTrack?.optInt("playCount", 0) ?: 0
                        val tp = easeOutCubic((lt - 0.3f) / 0.65f)
                        boldPaint.textAlign = Paint.Align.CENTER; boldPaint.color = spBlack; boldPaint.textSize = 48f; boldPaint.alpha = (255 * tp).toInt()
                        canvas.drawText(ellipsize(boldPaint, tTitle, 610f), WIDTH / 2f, 815f, boldPaint)
                        boldPaint.textSize = 32f; boldPaint.alpha = (205 * tp).toInt()
                        canvas.drawText(ellipsize(boldPaint, tArtist, 580f), WIDTH / 2f, 868f, boldPaint)

                        tmpRect.set(110f, 926f, WIDTH - 110f, 1008f)
                        fillPaint.color = spBlack
                        canvas.drawRoundRect(tmpRect, 41f, 41f, fillPaint)
                        boldPaint.color = spGreen; boldPaint.textSize = 30f; boldPaint.alpha = (255 * tp).toInt()
                        canvas.drawText("Tam $tPlays kez baştan sona dinledin", WIDTH / 2f, 978f, boldPaint)
                    }

                    // SAHNE 6: EN ÇOK DİNLENEN 5 ŞARKIN (#FF6B2B VIVID ORANGE + STARK BLACK)
                    tSec < segTimes[6] -> {
                        isLightSlide = true
                        val lt = tSec - segTimes[5]
                        val p = easeOutCubic(lt / 0.65f)
                        canvas.drawColor(spOrange)

                        tmpRect.set(-140f, HEIGHT - 340f, 340f, HEIGHT + 140f)
                        canvas.drawBitmap(orbYellow, null, tmpRect, null)

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spBlack; boldPaint.textSize = 26f; boldPaint.alpha = (230 * p).toInt()
                        canvas.drawText("$yearNow LİSTEN", 52f, 168f, boldPaint)
                        boldPaint.textSize = 56f; boldPaint.alpha = (255 * p).toInt()
                        canvas.drawText("En Çok Dinlenen 5 Şarkın", 50f, 236f, boldPaint)

                        topTracks.forEachIndexed { idx, item ->
                            val rp = easeOutCubic((lt - idx * 0.13f) / 0.55f)
                            val y = 290f + idx * 150f
                            val sl = (1f - rp) * 90f
                            tmpRect.set(46f + sl, y, WIDTH - 46f + sl, y + 128f)
                            fillPaint.color = Color.argb((rp * 42f).toInt(), 18, 18, 18)
                            canvas.drawRoundRect(tmpRect, 24f, 24f, fillPaint)

                            boldPaint.textAlign = Paint.Align.CENTER; boldPaint.color = spBlack; boldPaint.textSize = 48f; boldPaint.alpha = (255 * rp).toInt()
                            canvas.drawText("${idx + 1}", tmpRect.left + 40f, y + 80f, boldPaint)

                            val mc = miniCovers.getOrNull(idx)
                            val cLeft = tmpRect.left + 78f
                            val cRect = RectF(cLeft, y + 22f, cLeft + 84f, y + 106f)
                            if (mc != null) canvas.drawBitmap(mc, null, cRect, bmpPaint)
                            else {
                                fillPaint.color = spBlack
                                canvas.drawRoundRect(cRect, 14f, 14f, fillPaint)
                            }

                            boldPaint.textAlign = Paint.Align.LEFT; boldPaint.textSize = 29f
                            canvas.drawText(ellipsize(boldPaint, item.optString("title"), 340f), cLeft + 102f, y + 58f, boldPaint)
                            regPaint.textAlign = Paint.Align.LEFT; regPaint.color = Color.argb((210 * rp).toInt(), 18, 18, 18); regPaint.textSize = 23f
                            canvas.drawText(ellipsize(regPaint, "${item.optString("artist")}  •  ${item.optInt("playCount", 0)}x", 360f), cLeft + 102f, y + 94f, regPaint)
                        }
                    }

                    // SAHNE 7: EN ÇOK DİNLENEN 5 SANATÇIN (#2D46B9 ELECTRIC COBALT + #FF99E5 PINK)
                    tSec < segTimes[7] -> {
                        val lt = tSec - segTimes[6]
                        val p = easeOutCubic(lt / 0.65f)
                        canvas.drawColor(spCobalt)

                        tmpRect.set(WIDTH - 320f, -120f, WIDTH + 120f, 320f)
                        canvas.drawBitmap(orbPink, null, tmpRect, null)

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spPastelPink; boldPaint.textSize = 26f; boldPaint.alpha = (255 * p).toInt()
                        canvas.drawText("FAVORİ SANATÇILARIN", 52f, 168f, boldPaint)
                        boldPaint.color = Color.WHITE; boldPaint.textSize = 54f
                        canvas.drawText(ellipsize(boldPaint, topArtists.firstOrNull()?.first ?: "Sanatçıların", 610f), 50f, 236f, boldPaint)

                        tmpRect.set(52f, 266f, 520f, 330f)
                        fillPaint.color = spPastelPink
                        canvas.drawRoundRect(tmpRect, 32f, 32f, fillPaint)
                        boldPaint.color = spBlack; boldPaint.textSize = 25f
                        canvas.drawText("En sıkı %$fanPercentile hayranları arasındasın", 80f, 307f, boldPaint)

                        topArtists.forEachIndexed { idx, (name, cnt) ->
                            val rp = easeOutCubic((lt - 0.15f - idx * 0.14f) / 0.6f)
                            val y = 395f + idx * 136f
                            val pct = ((cnt * 100f) / totalArtistPlays).toInt().coerceIn(8, 100)

                            boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = if (idx == 0) spPastelPink else Color.WHITE; boldPaint.textSize = 32f; boldPaint.alpha = (255 * rp).toInt()
                            canvas.drawText("${idx + 1}. ${ellipsize(boldPaint, name, 420f)}", 54f, y, boldPaint)
                            regPaint.textAlign = Paint.Align.RIGHT; regPaint.color = Color.argb((225 * rp).toInt(), 255, 255, 255); regPaint.textSize = 24f
                            canvas.drawText("$cnt çalma", WIDTH - 54f, y, regPaint)

                            tmpRect.set(54f, y + 20f, WIDTH - 54f, y + 48f)
                            fillPaint.color = Color.argb(55, 255, 255, 255)
                            canvas.drawRoundRect(tmpRect, 14f, 14f, fillPaint)

                            val fillW = max(32f, ((WIDTH - 108f) * (pct / 100f)) * rp)
                            tmpRect.set(54f, y + 20f, 54f + fillW, y + 48f)
                            fillPaint.color = if (idx == 0) spPastelPink else Color.WHITE
                            canvas.drawRoundRect(tmpRect, 14f, 14f, fillPaint)
                        }
                    }

                    // SAHNE 8: SES AURAN & MÜZİK KİŞİLİĞİN (#121212 + IRIDESCENT AURA)
                    tSec < segTimes[8] -> {
                        val lt = tSec - segTimes[7]
                        val p = easeOutCubic(lt / 0.7f)
                        canvas.drawColor(spBlack)

                        val pulse = 1f + 0.08f * sin(lt * 2.5f)
                        tmpRect.set(WIDTH * 0.18f - 320f * pulse, 280f - 320f * pulse, WIDTH * 0.18f + 320f * pulse, 280f + 320f * pulse)
                        canvas.drawBitmap(orbPurple, null, tmpRect, null)
                        tmpRect.set(WIDTH * 0.82f - 300f * pulse, 540f - 300f * pulse, WIDTH * 0.82f + 300f * pulse, 540f + 300f * pulse)
                        canvas.drawBitmap(orbGreen, null, tmpRect, null)
                        tmpRect.set(WIDTH * 0.45f - 280f, 840f - 280f, WIDTH * 0.45f + 280f, 840f + 280f)
                        canvas.drawBitmap(orbPink, null, tmpRect, null)

                        boldPaint.textAlign = Paint.Align.CENTER; boldPaint.color = spGreen; boldPaint.textSize = 28f; boldPaint.alpha = (255 * p).toInt()
                        canvas.drawText("SES AURAN & MÜZİK KİŞİLİĞİN", WIDTH / 2f, 430f, boldPaint)

                        boldPaint.color = Color.WHITE; boldPaint.textSize = 66f
                        val words = personality.split(" ")
                        if (words.size >= 3) {
                            canvas.drawText(words.take(2).joinToString(" "), WIDTH / 2f, 545f, boldPaint)
                            canvas.drawText(words.drop(2).joinToString(" "), WIDTH / 2f, 625f, boldPaint)
                        } else {
                            canvas.drawText(ellipsize(boldPaint, personality, 620f), WIDTH / 2f, 580f, boldPaint)
                        }

                        tmpRect.set(80f, 735f, WIDTH - 80f, 825f)
                        fillPaint.color = Color.argb(46, 255, 255, 255)
                        canvas.drawRoundRect(tmpRect, 45f, 45f, fillPaint)
                        boldPaint.color = spYellow; boldPaint.textSize = 30f
                        canvas.drawText("$streakDays Günlük Seri  •  $totalPlays Tam Dinleme", WIDTH / 2f, 791f, boldPaint)
                    }

                    // SAHNE 9: ICONIC SPOTIFY WRAPPED MASTER ÖZET KARTI
                    else -> {
                        val lt = tSec - segTimes[8]
                        val p = easeOutBack(lt / 0.75f).coerceAtMost(1.03f)
                        canvas.drawColor(Color.rgb(10, 10, 16))

                        tmpRect.set(-140f, -140f, 420f, 420f)
                        canvas.drawBitmap(orbGreen, null, tmpRect, null)
                        tmpRect.set(WIDTH - 420f, HEIGHT - 420f, WIDTH + 140f, HEIGHT + 140f)
                        canvas.drawBitmap(orbPurple, null, tmpRect, null)

                        // Master Poster Kartı
                        tmpRect.set(48f, 130f, WIDTH - 48f, 1110f)
                        fillPaint.color = spBlack
                        canvas.drawRoundRect(tmpRect, 40f, 40f, fillPaint)
                        strokePaint.color = spGreen; strokePaint.strokeWidth = 3.5f
                        canvas.drawRoundRect(tmpRect, 40f, 40f, strokePaint)

                        // Üst Kapak + Başlık
                        val artRect = RectF(84f, 174f, 254f, 344f)
                        if (topCoverRounded != null) canvas.drawBitmap(topCoverRounded, null, artRect, bmpPaint)
                        else {
                            fillPaint.color = spGreen
                            canvas.drawRoundRect(artRect, 22f, 22f, fillPaint)
                        }

                        boldPaint.textAlign = Paint.Align.LEFT; boldPaint.color = spGreen; boldPaint.textSize = 23f; boldPaint.alpha = (255 * p.coerceIn(0f, 1f)).toInt()
                        canvas.drawText("SUNIFY WRAPPED $yearNow", 282f, 222f, boldPaint)
                        boldPaint.color = Color.WHITE; boldPaint.textSize = 40f
                        canvas.drawText(ellipsize(boldPaint, username, 345f), 282f, 276f, boldPaint)
                        regPaint.textAlign = Paint.Align.LEFT; regPaint.color = Color.argb(200, 255, 255, 255); regPaint.textSize = 24f
                        canvas.drawText(ellipsize(regPaint, personality, 345f), 282f, 318f, regPaint)

                        // 2 Sütunlu Top Sanatçılar & Top Şarkılar
                        boldPaint.color = spGreen; boldPaint.textSize = 22f
                        canvas.drawText("EN İYİ SANATÇILAR", 84f, 426f, boldPaint)
                        canvas.drawText("EN İYİ ŞARKILAR", 380f, 426f, boldPaint)

                        topArtists.take(5).forEachIndexed { idx, (name, _) ->
                            boldPaint.color = Color.WHITE; boldPaint.textSize = 26f
                            canvas.drawText("${idx + 1} ${ellipsize(boldPaint, name, 255f)}", 84f, 476f + idx * 54f, boldPaint)
                        }
                        topTracks.take(5).forEachIndexed { idx, t ->
                            boldPaint.color = Color.WHITE; boldPaint.textSize = 26f
                            canvas.drawText("${idx + 1} ${ellipsize(boldPaint, t.optString("title"), 255f)}", 380f, 476f + idx * 54f, boldPaint)
                        }

                        // Ayırıcı çizgi
                        fillPaint.color = Color.argb(45, 255, 255, 255)
                        canvas.drawRect(84f, 775f, WIDTH - 84f, 778f, fillPaint)

                        // Alt 2'li İstatistikler
                        boldPaint.color = Color.argb(175, 255, 255, 255); boldPaint.textSize = 21f
                        canvas.drawText("DİNLENEN DAKİKA", 84f, 834f, boldPaint)
                        canvas.drawText("ZİRVE ZAMAN", 380f, 834f, boldPaint)

                        boldPaint.color = spGreen; boldPaint.textSize = 54f
                        canvas.drawText(String.format(java.util.Locale.forLanguageTag("tr-TR"), "%,d", totalMinutes), 84f, 902f, boldPaint)
                        boldPaint.color = Color.WHITE; boldPaint.textSize = 30f
                        canvas.drawText(peakWeekday, 380f, 882f, boldPaint)
                        regPaint.color = spYellow; regPaint.textSize = 25f
                        canvas.drawText(peakHourMood, 380f, 922f, regPaint)

                        boldPaint.color = Color.argb(175, 255, 255, 255); boldPaint.textSize = 21f
                        canvas.drawText("EN AKTİF AY", 84f, 984f, boldPaint)
                        canvas.drawText("DİNLEME SERİSİ", 380f, 984f, boldPaint)

                        boldPaint.color = Color.WHITE; boldPaint.textSize = 30f
                        canvas.drawText(topMonths.firstOrNull()?.first ?: "$yearNow", 84f, 1028f, boldPaint)
                        canvas.drawText("$streakDays gün  •  %$topPercentile", 380f, 1028f, boldPaint)
                    }
                }

                // Üst 9 sahneli Spotify Wrapped Story ilerleme çubuğu
                val barBgCol = if (isLightSlide) Color.argb(55, 18, 18, 18) else Color.argb(75, 255, 255, 255)
                val barFgCol = if (isLightSlide) spBlack else Color.WHITE
                for (s in 0 until segCount) {
                    val bx = 28f + s * (segBarW + 5f)
                    tmpRect.set(bx, 38f, bx + segBarW, 44f)
                    fillPaint.color = barBgCol
                    canvas.drawRoundRect(tmpRect, 3f, 3f, fillPaint)
                    val sp = ((tSec - segTimes[s]) / (segTimes[s + 1] - segTimes[s])).coerceIn(0f, 1f)
                    if (sp > 0f) {
                        tmpRect.set(bx, 38f, bx + segBarW * sp, 44f)
                        fillPaint.color = barFgCol
                        canvas.drawRoundRect(tmpRect, 3f, 3f, fillPaint)
                    }
                }

                // Alt Sunify Wrapped watermark
                canvas.drawBitmap(logoBmp, null, footerLogoRect, bmpPaint)
                boldPaint.textAlign = Paint.Align.LEFT; boldPaint.textSize = 23f
                boldPaint.color = if (isLightSlide) spBlack else Color.WHITE
                boldPaint.alpha = 225
                canvas.drawText("SUNIFY WRAPPED $yearNow", 102f, HEIGHT - 57f, boldPaint)
            }
        } finally {
            isGenerating = false
            topCoverRaw?.recycle()
            topCoverRounded?.recycle()
            miniCovers.forEach { it?.recycle() }
            orbGreen.recycle()
            orbPink.recycle()
            orbPurple.recycle()
            orbYellow.recycle()
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
