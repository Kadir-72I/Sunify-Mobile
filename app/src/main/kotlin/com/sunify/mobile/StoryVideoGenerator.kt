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
import android.graphics.Rect
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
import android.os.Process
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
    private const val FPS = 30
    private const val BITRATE = 4_200_000

    data class VideoResult(
        val cacheFile: File,
        val fileName: String,
        val displayPath: String
    )

    private fun parseRgb(raw: String): IntArray {
        val parts = raw.split(",").mapNotNull { it.trim().toIntOrNull()?.coerceIn(0, 255) }
        return if (parts.size == 3) intArrayOf(parts[0], parts[1], parts[2]) else intArrayOf(181, 122, 255)
    }

    private fun fetchBitmap(url: String, maxDim: Int = 512): Bitmap? {
        if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) return null
        return runCatching {
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                .build()
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
                val x = (raw.width - side) / 2
                val y = (raw.height - side) / 2
                val sq = Bitmap.createBitmap(raw, x, y, side, side)
                if (sq !== raw) raw.recycle()
                if (side > maxDim) {
                    Bitmap.createScaledBitmap(sq, maxDim, maxDim, true).also {
                        if (it !== sq) sq.recycle()
                    }
                } else sq
            }
        }.getOrNull()
    }

    private fun easeOutCubic(t: Float): Float {
        val c = t.coerceIn(0f, 1f)
        val inv = 1f - c
        return 1f - inv * inv * inv
    }

    private fun easeInOut(t: Float): Float {
        val c = t.coerceIn(0f, 1f)
        return c * c * (3f - 2f * c)
    }

    private fun drawSunifyLogo(canvas: Canvas, cx: Float, cy: Float, radius: Float, rgb: IntArray, alpha: Int = 255) {
        val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(
                cx - radius, cy - radius, cx + radius, cy + radius,
                Color.argb(alpha, rgb[0], rgb[1], rgb[2]),
                Color.argb(alpha, (rgb[0] * 0.45f).toInt(), (rgb[1] * 0.35f).toInt(), (rgb[2] * 0.85f).toInt().coerceAtMost(255)),
                Shader.TileMode.CLAMP
            )
        }
        canvas.drawCircle(cx, cy, radius, bgPaint)

        val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = radius * 0.08f
            color = Color.argb((alpha * 0.65f).toInt(), 255, 255, 255)
        }
        canvas.drawCircle(cx, cy, radius * 0.94f, ringPaint)

        val wavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeWidth = radius * 0.14f
            color = Color.argb(alpha, 255, 255, 255)
        }
        val barHeights = floatArrayOf(0.28f, 0.56f, 0.82f, 0.52f, 0.26f)
        val spacing = radius * 0.28f
        for (i in barHeights.indices) {
            val bx = cx + (i - 2) * spacing
            val halfH = radius * barHeights[i] * 0.48f
            canvas.drawLine(bx, cy - halfH, bx, cy + halfH, wavePaint)
        }
    }

    private fun drawRoundedBitmap(canvas: Canvas, bmp: Bitmap, rect: RectF, radius: Float) {
        val save = canvas.save()
        val path = Path().apply { addRoundRect(rect, radius, radius, Path.Direction.CW) }
        canvas.clipPath(path)
        canvas.drawBitmap(bmp, null, rect, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        canvas.restoreToCount(save)
    }

    private fun ellipsize(paint: Paint, text: String, maxWidth: Float): String {
        if (paint.measureText(text) <= maxWidth) return text
        var s = text
        while (s.length > 2 && paint.measureText("$s…") > maxWidth) {
            s = s.dropLast(1)
        }
        return "$s…"
    }

    private fun wrapText(paint: Paint, text: String, maxWidth: Float): List<String> {
        val words = text.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val out = mutableListOf<String>()
        var cur = ""
        for (w in words) {
            val cand = if (cur.isEmpty()) w else "$cur $w"
            if (paint.measureText(cand) <= maxWidth) {
                cur = cand
            } else {
                if (cur.isNotEmpty()) out.add(cur)
                cur = w
            }
        }
        if (cur.isNotEmpty()) out.add(cur)
        return out
    }

    private fun drawAnimatedBg(canvas: Canvas, tSec: Float, rgb: IntArray, coverBmp: Bitmap?, dimCoverAlpha: Int = 55) {
        val bgPaint = Paint().apply {
            shader = LinearGradient(
                0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat(),
                intArrayOf(
                    Color.rgb((rgb[0] * 0.16f).toInt().coerceAtLeast(14), (rgb[1] * 0.12f).toInt().coerceAtLeast(10), (rgb[2] * 0.24f).toInt().coerceAtLeast(24)),
                    Color.rgb(9, 8, 16),
                    Color.rgb((rgb[0] * 0.20f).toInt().coerceAtLeast(18), (rgb[1] * 0.10f).toInt().coerceAtLeast(12), (rgb[2] * 0.26f).toInt().coerceAtLeast(26))
                ),
                floatArrayOf(0f, 0.52f, 1f),
                Shader.TileMode.CLAMP
            )
        }
        canvas.drawRect(0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat(), bgPaint)

        if (coverBmp != null && dimCoverAlpha > 0) {
            val scale = 1.12f + 0.04f * sin(tSec * 0.7f)
            val drawW = HEIGHT * scale
            val dx = (WIDTH - drawW) / 2f
            val dy = (HEIGHT - drawW) / 2f
            val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { alpha = dimCoverAlpha }
            canvas.drawBitmap(coverBmp, null, RectF(dx, dy, dx + drawW, dy + drawW), p)
            canvas.drawColor(Color.argb(175, 10, 8, 18))
        }

        val ox1 = WIDTH * 0.22f + cos(tSec * 0.8f) * 80f
        val oy1 = HEIGHT * 0.20f + sin(tSec * 0.6f) * 65f
        val orb1 = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = RadialGradient(
                ox1, oy1, 420f,
                intArrayOf(Color.argb(135, rgb[0], rgb[1], rgb[2]), Color.TRANSPARENT),
                null, Shader.TileMode.CLAMP
            )
        }
        canvas.drawCircle(ox1, oy1, 420f, orb1)

        val ox2 = WIDTH * 0.80f + sin(tSec * 0.7f) * 75f
        val oy2 = HEIGHT * 0.78f + cos(tSec * 0.9f) * 70f
        val orb2 = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = RadialGradient(
                ox2, oy2, 400f,
                intArrayOf(Color.argb(110, (rgb[0] * 0.85f).toInt(), (rgb[1] * 0.6f).toInt(), 255), Color.TRANSPARENT),
                null, Shader.TileMode.CLAMP
            )
        }
        canvas.drawCircle(ox2, oy2, 400f, orb2)
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

    private fun renderAndMuxVideo(
        context: Context,
        durationSec: Double,
        audioSourceFile: File?,
        audioStartSec: Double,
        fileName: String,
        drawFrame: (canvas: Canvas, tSec: Float, progress: Float) -> Unit
    ): VideoResult {
        val prevPriority = runCatching { Process.getThreadPriority(Process.myTid()) }.getOrDefault(Process.THREAD_PRIORITY_DEFAULT)
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND) }

        val storiesDir = File(context.cacheDir, "stories").apply { mkdirs() }
        val outFile = File(storiesDir, "story_${System.currentTimeMillis()}.mp4")

        val safeDur = durationSec.coerceIn(4.0, 30.0)
        val totalFrames = (safeDur * FPS).toInt().coerceAtLeast(FPS * 4)

        var encoder: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var audioExtractor: MediaExtractor? = null
        var muxerStarted = false

        try {
            var audioFormat: MediaFormat? = null
            var audioTrackInExtractor = -1
            if (audioSourceFile != null && audioSourceFile.exists() && audioSourceFile.length() > 4096L) {
                runCatching {
                    val ex = MediaExtractor()
                    ex.setDataSource(audioSourceFile.absolutePath)
                    for (i in 0 until ex.trackCount) {
                        val fmt = ex.getTrackFormat(i)
                        val mime = fmt.getString(MediaFormat.KEY_MIME).orEmpty()
                        if (mime.equals("audio/mp4a-latm", ignoreCase = true)) {
                            audioTrackInExtractor = i
                            audioFormat = fmt
                            break
                        }
                    }
                    if (audioTrackInExtractor >= 0) {
                        ex.selectTrack(audioTrackInExtractor)
                        audioExtractor = ex
                    } else {
                        ex.release()
                    }
                }
            }

            val videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
                setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            }

            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            encoder.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val inputSurface = encoder.createInputSurface()
            encoder.start()

            muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            var videoTrackIndex = -1
            var audioTrackIndex = -1
            val bufferInfo = MediaCodec.BufferInfo()

            fun drainEncoder(endOfStream: Boolean) {
                if (endOfStream) encoder.signalEndOfInputStream()
                while (true) {
                    val outIdx = encoder.dequeueOutputBuffer(bufferInfo, 10_000)
                    when {
                        outIdx == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                            if (!endOfStream) break
                        }
                        outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            videoTrackIndex = muxer.addTrack(encoder.outputFormat)
                            if (audioFormat != null) {
                                audioTrackIndex = muxer.addTrack(audioFormat!!)
                            }
                            muxer.start()
                            muxerStarted = true
                        }
                        outIdx >= 0 -> {
                            val encoded = encoder.getOutputBuffer(outIdx)
                            if (encoded != null && bufferInfo.size > 0 &&
                                (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 &&
                                muxerStarted
                            ) {
                                encoded.position(bufferInfo.offset)
                                encoded.limit(bufferInfo.offset + bufferInfo.size)
                                muxer.writeSampleData(videoTrackIndex, encoded, bufferInfo)
                            }
                            val isEos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            encoder.releaseOutputBuffer(outIdx, false)
                            if (isEos) break
                        }
                    }
                }
            }

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
            }
            drainEncoder(true)
            inputSurface.release()

            if (muxerStarted && audioTrackIndex >= 0 && audioExtractor != null) {
                val ex = audioExtractor!!
                val startUs = (audioStartSec.coerceAtLeast(0.0) * 1_000_000.0).toLong()
                val maxDurUs = (safeDur * 1_000_000.0).toLong()
                if (startUs > 0L) ex.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                val firstPts = ex.sampleTime.coerceAtLeast(0L)
                val audioBuf = ByteBuffer.allocate(256 * 1024)
                val aInfo = MediaCodec.BufferInfo()
                while (true) {
                    val sampleSize = ex.readSampleData(audioBuf, 0)
                    if (sampleSize < 0) break
                    val pts = ex.sampleTime
                    val relPts = (pts - firstPts).coerceAtLeast(0L)
                    if (relPts > maxDurUs) break
                    aInfo.offset = 0
                    aInfo.size = sampleSize
                    aInfo.presentationTimeUs = relPts
                    aInfo.flags = ex.sampleFlags
                    muxer.writeSampleData(audioTrackIndex, audioBuf, aInfo)
                    ex.advance()
                }
            }

            val displayPath = saveVideoToGallery(context, outFile, fileName)
            return VideoResult(outFile, fileName, displayPath)
        } finally {
            runCatching { audioExtractor?.release() }
            runCatching { encoder?.stop() }
            runCatching { encoder?.release() }
            if (muxerStarted) runCatching { muxer?.stop() }
            runCatching { muxer?.release() }
            runCatching { Process.setThreadPriority(prevPriority) }
        }
    }

    fun generateWrappedStoryVideo(
        context: Context,
        audioService: YouTubeAudioService,
        payload: JSONObject
    ): VideoResult {
        val username = payload.optString("username", "Sunify Dinleyicisi").ifBlank { "Sunify Dinleyicisi" }
        val coverRgb = parseRgb(payload.optString("coverRgb", "181, 122, 255"))
        val totalMinutes = payload.optInt("totalMinutes", 0)
        val totalPlays = payload.optInt("totalPlays", 0)
        val streakDays = payload.optInt("streakDays", 0)
        val topTracksArr = payload.optJSONArray("topTracks") ?: JSONArray()
        val topArtistsArr = payload.optJSONArray("topArtists") ?: JSONArray()

        val topTracks = mutableListOf<JSONObject>()
        for (i in 0 until min(5, topTracksArr.length())) {
            topTracksArr.optJSONObject(i)?.let { topTracks.add(it) }
        }
        val topArtists = mutableListOf<Pair<String, Int>>()
        for (i in 0 until min(4, topArtistsArr.length())) {
            val a = topArtistsArr.optJSONObject(i) ?: continue
            topArtists.add(a.optString("name") to a.optInt("count", 0))
        }

        val firstTrack = topTracks.firstOrNull()
        val topCoverBmp = firstTrack?.optString("thumbnail").orEmpty().let { fetchBitmap(it, 480) }
        var tempAudio: File? = null
        if (firstTrack != null) {
            tempAudio = downloadTempAacAudio(
                context,
                audioService,
                firstTrack.optString("id"),
                firstTrack.optString("title"),
                firstTrack.optString("artist")
            )
        }

        val personality = when {
            totalMinutes >= 600 -> "Müzik Tutkunu"
            streakDays >= 7 -> "Sadık Dinleyici"
            topTracks.size >= 4 -> "Ritim Kaşifi"
            else -> "Sunify Gezgini"
        }

        val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(200, 255, 255, 255)
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL)
        }
        val accentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2])
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }

        try {
            return renderAndMuxVideo(
                context = context,
                durationSec = 15.0,
                audioSourceFile = tempAudio,
                audioStartSec = 25.0,
                fileName = "Sunify-Dinleme-Ozeti-${System.currentTimeMillis()}.mp4"
            ) { canvas, tSec, _ ->
                drawAnimatedBg(canvas, tSec, coverRgb, topCoverBmp, 42)

                // Üst şık hikaye ilerleme çubukları (5 sahne)
                val segTimes = floatArrayOf(0f, 2.8f, 5.8f, 9.0f, 12.4f, 15.0f)
                val barW = (WIDTH - 64f - 4 * 8f) / 5f
                for (s in 0 until 5) {
                    val bx = 32f + s * (barW + 8f)
                    val bgP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(70, 255, 255, 255) }
                    canvas.drawRoundRect(RectF(bx, 42f, bx + barW, 48f), 3f, 3f, bgP)
                    val segProg = ((tSec - segTimes[s]) / (segTimes[s + 1] - segTimes[s])).coerceIn(0f, 1f)
                    if (segProg > 0f) {
                        val fgP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
                        canvas.drawRoundRect(RectF(bx, 42f, bx + barW * segProg, 48f), 3f, 3f, fgP)
                    }
                }

                when {
                    tSec < 2.8f -> {
                        val p = easeOutCubic(tSec / 1.1f)
                        val pulse = 1f + 0.04f * sin(tSec * 4.5f)
                        val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            shader = RadialGradient(
                                WIDTH / 2f, 470f, 220f * pulse,
                                intArrayOf(Color.argb(140, coverRgb[0], coverRgb[1], coverRgb[2]), Color.TRANSPARENT),
                                null, Shader.TileMode.CLAMP
                            )
                        }
                        canvas.drawCircle(WIDTH / 2f, 470f, 220f * pulse, glow)
                        drawSunifyLogo(canvas, WIDTH / 2f, 470f, 88f * p * pulse, coverRgb, (255 * p).toInt())

                        titlePaint.textAlign = Paint.Align.CENTER
                        titlePaint.textSize = 54f
                        titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("SUNIFY", WIDTH / 2f, 640f + (1f - p) * 40f, titlePaint)

                        accentPaint.textAlign = Paint.Align.CENTER
                        accentPaint.textSize = 36f
                        accentPaint.alpha = (255 * easeOutCubic((tSec - 0.35f) / 0.8f)).toInt()
                        canvas.drawText("DİNLEME ÖZETİN", WIDTH / 2f, 704f, accentPaint)

                        val badgeAlpha = (255 * easeOutCubic((tSec - 0.7f) / 0.8f)).toInt()
                        val pillRect = RectF(160f, 770f, WIDTH - 160f, 842f)
                        canvas.drawRoundRect(pillRect, 36f, 36f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            color = Color.argb((badgeAlpha * 0.16f).toInt(), 255, 255, 255)
                        })
                        subPaint.textAlign = Paint.Align.CENTER
                        subPaint.textSize = 28f
                        subPaint.alpha = badgeAlpha
                        canvas.drawText(ellipsize(subPaint, username, 340f), WIDTH / 2f, 816f, subPaint)
                    }

                    tSec < 5.8f -> {
                        val lt = tSec - 2.8f
                        val p = easeOutCubic(lt / 0.9f)
                        accentPaint.textAlign = Paint.Align.LEFT
                        accentPaint.textSize = 26f
                        accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("SENİN RİTMİN", 64f, 190f, accentPaint)

                        titlePaint.textAlign = Paint.Align.LEFT
                        titlePaint.textSize = 48f
                        titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("Müziğe Ayırdığın Zaman", 64f, 258f, titlePaint)

                        val countP = easeOutCubic(lt / 1.4f)
                        val cards = listOf(
                            Triple("${(totalMinutes * countP).toInt()} dk", "TOPLAM DİNLEME SÜRESİ", 360f),
                            Triple("${(totalPlays * countP).toInt()}", "TAMAMLANAN ŞARKI", 590f),
                            Triple("${(streakDays * countP).toInt()} gün", "AKTİF SERİ", 820f)
                        )
                        cards.forEachIndexed { idx, (bigVal, label, topY) ->
                            val cp = easeOutCubic((lt - idx * 0.22f) / 0.7f)
                            val slide = (1f - cp) * 70f
                            val cardRect = RectF(64f + slide, topY, WIDTH - 64f + slide, topY + 188f)
                            canvas.drawRoundRect(cardRect, 32f, 32f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = Color.argb((cp * 36f).toInt(), 255, 255, 255)
                            })
                            canvas.drawRoundRect(cardRect, 32f, 32f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                style = Paint.Style.STROKE
                                strokeWidth = 2f
                                color = Color.argb((cp * 115f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                            })
                            titlePaint.textSize = 68f
                            titlePaint.alpha = (255 * cp).toInt()
                            canvas.drawText(bigVal, cardRect.left + 36f, topY + 96f, titlePaint)

                            subPaint.textAlign = Paint.Align.LEFT
                            subPaint.textSize = 22f
                            subPaint.alpha = (200 * cp).toInt()
                            canvas.drawText(label, cardRect.left + 36f, topY + 148f, subPaint)
                        }
                    }

                    tSec < 9.0f -> {
                        val lt = tSec - 5.8f
                        val p = easeOutCubic(lt / 0.85f)
                        accentPaint.textAlign = Paint.Align.CENTER
                        accentPaint.textSize = 26f
                        accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("ZİRVEDEKİ PARÇAN", WIDTH / 2f, 180f, accentPaint)

                        titlePaint.textAlign = Paint.Align.CENTER
                        titlePaint.textSize = 46f
                        titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("En Çok Dinlediğin Şarkı", WIDTH / 2f, 242f, titlePaint)

                        val artSize = 400f * (0.78f + 0.22f * p)
                        val artLeft = (WIDTH - artSize) / 2f
                        val artTop = 320f
                        val artRect = RectF(artLeft, artTop, artLeft + artSize, artTop + artSize)

                        val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            shader = RadialGradient(
                                WIDTH / 2f, artTop + artSize / 2f, artSize * 0.72f,
                                intArrayOf(Color.argb(150, coverRgb[0], coverRgb[1], coverRgb[2]), Color.TRANSPARENT),
                                null, Shader.TileMode.CLAMP
                            )
                        }
                        canvas.drawCircle(WIDTH / 2f, artTop + artSize / 2f, artSize * 0.72f, halo)

                        if (topCoverBmp != null) {
                            drawRoundedBitmap(canvas, topCoverBmp, artRect, 42f)
                        } else {
                            canvas.drawRoundRect(artRect, 42f, 42f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = Color.argb(120, coverRgb[0], coverRgb[1], coverRgb[2])
                            })
                        }

                        val tTitle = firstTrack?.optString("title").orEmpty().ifBlank { "Henüz Veri Yok" }
                        val tArtist = firstTrack?.optString("artist").orEmpty()
                        val tPlays = firstTrack?.optInt("playCount", 0) ?: 0

                        val textP = easeOutCubic((lt - 0.35f) / 0.75f)
                        titlePaint.textAlign = Paint.Align.CENTER
                        titlePaint.textSize = 42f
                        titlePaint.alpha = (255 * textP).toInt()
                        canvas.drawText(ellipsize(titlePaint, tTitle, 600f), WIDTH / 2f, 825f, titlePaint)

                        subPaint.textAlign = Paint.Align.CENTER
                        subPaint.textSize = 28f
                        subPaint.alpha = (205 * textP).toInt()
                        canvas.drawText(ellipsize(subPaint, tArtist, 580f), WIDTH / 2f, 875f, subPaint)

                        val pillRect = RectF(200f, 926f, WIDTH - 200f, 994f)
                        canvas.drawRoundRect(pillRect, 34f, 34f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            color = Color.argb((textP * 195f).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                        })
                        titlePaint.textSize = 26f
                        canvas.drawText("$tPlays kez dinlendi", WIDTH / 2f, 970f, titlePaint)
                    }

                    tSec < 12.4f -> {
                        val lt = tSec - 9.0f
                        val p = easeOutCubic(lt / 0.7f)
                        accentPaint.textAlign = Paint.Align.LEFT
                        accentPaint.textSize = 24f
                        accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("TOP 5 PARÇA", 56f, 160f, accentPaint)

                        titlePaint.textAlign = Paint.Align.LEFT
                        titlePaint.textSize = 42f
                        titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText("Senin Liste Başların", 56f, 218f, titlePaint)

                        topTracks.forEachIndexed { idx, item ->
                            val rp = easeOutCubic((lt - idx * 0.16f) / 0.55f)
                            val y = 268f + idx * 124f
                            val slide = (1f - rp) * 90f
                            val r = RectF(56f + slide, y, WIDTH - 56f + slide, y + 104f)
                            canvas.drawRoundRect(r, 24f, 24f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = Color.argb((rp * 34f).toInt(), 255, 255, 255)
                            })
                            accentPaint.textAlign = Paint.Align.LEFT
                            accentPaint.textSize = 36f
                            accentPaint.alpha = (255 * rp).toInt()
                            canvas.drawText("#${idx + 1}", r.left + 26f, y + 65f, accentPaint)

                            titlePaint.textAlign = Paint.Align.LEFT
                            titlePaint.textSize = 27f
                            titlePaint.alpha = (255 * rp).toInt()
                            canvas.drawText(ellipsize(titlePaint, item.optString("title"), 390f), r.left + 96f, y + 48f, titlePaint)

                            subPaint.textAlign = Paint.Align.LEFT
                            subPaint.textSize = 21f
                            subPaint.alpha = (185 * rp).toInt()
                            canvas.drawText(ellipsize(subPaint, item.optString("artist"), 390f), r.left + 96f, y + 82f, subPaint)

                            subPaint.textAlign = Paint.Align.RIGHT
                            canvas.drawText("${item.optInt("playCount", 0)}x", r.right - 26f, y + 62f, subPaint)
                        }

                        if (topArtists.isNotEmpty()) {
                            val ap = easeOutCubic((lt - 0.9f) / 0.7f)
                            accentPaint.textAlign = Paint.Align.LEFT
                            accentPaint.textSize = 22f
                            accentPaint.alpha = (255 * ap).toInt()
                            canvas.drawText("FAVORİ SANATÇILAR", 56f, 945f, accentPaint)
                            val names = topArtists.take(3).joinToString("  •  ") { it.first }
                            titlePaint.textAlign = Paint.Align.LEFT
                            titlePaint.textSize = 26f
                            titlePaint.alpha = (255 * ap).toInt()
                            canvas.drawText(ellipsize(titlePaint, names, WIDTH - 112f), 56f, 992f, titlePaint)
                        }
                    }

                    else -> {
                        val lt = tSec - 12.4f
                        val p = easeOutCubic(lt / 0.8f)
                        drawSunifyLogo(canvas, WIDTH / 2f, 340f, 74f * p, coverRgb, (255 * p).toInt())

                        accentPaint.textAlign = Paint.Align.CENTER
                        accentPaint.textSize = 26f
                        accentPaint.alpha = (255 * p).toInt()
                        canvas.drawText("MÜZİK KİŞİLİĞİN", WIDTH / 2f, 490f, accentPaint)

                        titlePaint.textAlign = Paint.Align.CENTER
                        titlePaint.textSize = 54f
                        titlePaint.alpha = (255 * p).toInt()
                        canvas.drawText(personality, WIDTH / 2f, 566f, titlePaint)

                        val summaryRect = RectF(74f, 640f, WIDTH - 74f, 870f)
                        canvas.drawRoundRect(summaryRect, 34f, 34f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            color = Color.argb((p * 36f).toInt(), 255, 255, 255)
                        })
                        subPaint.textAlign = Paint.Align.CENTER
                        subPaint.textSize = 28f
                        subPaint.alpha = (230 * p).toInt()
                        canvas.drawText("$totalMinutes dakika  •  $totalPlays çalma  •  $streakDays gün seri", WIDTH / 2f, 735f, subPaint)
                        titlePaint.textSize = 28f
                        canvas.drawText(ellipsize(titlePaint, firstTrack?.optString("title").orEmpty().ifBlank { "Sunify" }, 520f), WIDTH / 2f, 804f, titlePaint)

                        subPaint.textSize = 24f
                        subPaint.alpha = (180 * p).toInt()
                        canvas.drawText("Sunify ile oluşturuldu", WIDTH / 2f, 1140f, subPaint)
                    }
                }

                // Alt köşe küçük Sunify marka imzası
                drawSunifyLogo(canvas, 76f, HEIGHT - 72f, 22f, coverRgb, 230)
                subPaint.textAlign = Paint.Align.LEFT
                subPaint.textSize = 22f
                subPaint.alpha = 215
                canvas.drawText("Sunify", 110f, HEIGHT - 64f, subPaint)
            }
        } finally {
            topCoverBmp?.recycle()
            runCatching { tempAudio?.delete() }
        }
    }

    fun generateLyricClipStoryVideo(
        context: Context,
        audioService: YouTubeAudioService,
        payload: JSONObject
    ): VideoResult {
        val trackId = payload.optString("id")
        val title = payload.optString("title", "Sunify").ifBlank { "Sunify" }
        val artist = payload.optString("artist", "")
        val thumbnail = payload.optString("thumbnail", "")
        val coverRgb = parseRgb(payload.optString("coverRgb", "181, 122, 255"))
        val startSec = payload.optDouble("startSec", 0.0).coerceAtLeast(0.0)
        val rawEndSec = payload.optDouble("endSec", startSec + 15.0)
        val durationSec = (rawEndSec - startSec).coerceIn(5.0, 30.0)
        val lyricsOffset = payload.optDouble("lyricsOffset", 0.0)
        val rawLines = payload.optJSONArray("lyrics") ?: JSONArray()

        data class LyricLine(val time: Double, val text: String)
        val lines = mutableListOf<LyricLine>()
        for (i in 0 until rawLines.length()) {
            val o = rawLines.optJSONObject(i) ?: continue
            val txt = o.optString("text").trim()
            if (txt.isNotEmpty()) lines.add(LyricLine(o.optDouble("time", 0.0), txt))
        }

        val coverBmp = fetchBitmap(thumbnail, 512)
        val tempAudio = downloadTempAacAudio(context, audioService, trackId, title, artist)

        val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(200, 255, 255, 255)
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL)
        }
        val activeLyricPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 42f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        val dimLyricPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(120, 255, 255, 255)
            textSize = 33f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }

        var smoothedScrollIdx = 0f
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
                audioSourceFile = tempAudio,
                audioStartSec = startSec,
                fileName = "$cleanName-Story.mp4"
            ) { canvas, tSec, progress ->
                drawAnimatedBg(canvas, tSec, coverRgb, coverBmp, 85)

                // Üst Liquid Glass Şarkı Kartı
                val headerRect = RectF(44f, 84f, WIDTH - 44f, 252f)
                canvas.drawRoundRect(headerRect, 34f, 34f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(150, 14, 12, 24)
                })
                canvas.drawRoundRect(headerRect, 34f, 34f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    style = Paint.Style.STROKE
                    strokeWidth = 2.2f
                    color = Color.argb(135, coverRgb[0], coverRgb[1], coverRgb[2])
                })

                val artRect = RectF(66f, 106f, 190f, 230f)
                if (coverBmp != null) {
                    drawRoundedBitmap(canvas, coverBmp, artRect, 22f)
                } else {
                    canvas.drawRoundRect(artRect, 22f, 22f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = Color.argb(160, coverRgb[0], coverRgb[1], coverRgb[2])
                    })
                }

                titlePaint.textAlign = Paint.Align.LEFT
                titlePaint.textSize = 32f
                titlePaint.alpha = 255
                canvas.drawText(ellipsize(titlePaint, title, 360f), 212f, 158f, titlePaint)

                subPaint.textAlign = Paint.Align.LEFT
                subPaint.textSize = 24f
                subPaint.alpha = 205
                canvas.drawText(ellipsize(subPaint, artist, 360f), 212f, 198f, subPaint)

                // Sağ üst Sunify logosu
                drawSunifyLogo(canvas, WIDTH - 94f, 168f, 28f, coverRgb, 255)

                // Orta Kayan Söz Alanı (Clipped)
                val lyricsTop = 300f
                val lyricsBottom = 1040f
                val centerY = (lyricsTop + lyricsBottom) / 2f
                val curSongTime = startSec + tSec + lyricsOffset

                var activeIdx = 0
                for (i in lines.indices) {
                    if (curSongTime >= lines[i].time) activeIdx = i
                }
                smoothedScrollIdx += (activeIdx.toFloat() - smoothedScrollIdx) * 0.16f

                val saveLyrics = canvas.save()
                canvas.clipRect(RectF(36f, lyricsTop, WIDTH - 36f, lyricsBottom))

                if (lines.isEmpty()) {
                    activeLyricPaint.textAlign = Paint.Align.CENTER
                    canvas.drawText(ellipsize(activeLyricPaint, title, 600f), WIDTH / 2f, centerY, activeLyricPaint)
                } else {
                    val lineSpacing = 148f
                    for (i in lines.indices) {
                        val delta = i - smoothedScrollIdx
                        if (abs(delta) > 3.6f) continue
                        val yBase = centerY + delta * lineSpacing
                        val distNorm = abs(delta).coerceIn(0f, 2.5f)
                        val isNearActive = abs(i - activeIdx) == 0

                        val paint = if (isNearActive) activeLyricPaint else dimLyricPaint
                        paint.textAlign = Paint.Align.LEFT
                        val alpha = when {
                            isNearActive -> 255
                            distNorm < 1.3f -> 135
                            else -> 68
                        }
                        paint.alpha = alpha

                        val wrapped = wrapText(paint, lines[i].text, WIDTH - 120f).take(2)
                        val blockOffset = if (wrapped.size > 1) -22f else 0f
                        wrapped.forEachIndexed { wi, wl ->
                            val ly = yBase + blockOffset + wi * (if (isNearActive) 50f else 42f)
                            if (isNearActive) {
                                paint.setShadowLayer(18f, 0f, 0f, Color.argb(170, coverRgb[0], coverRgb[1], coverRgb[2]))
                            } else {
                                paint.clearShadowLayer()
                            }
                            canvas.drawText(wl, 60f, ly, paint)
                        }
                    }
                    activeLyricPaint.clearShadowLayer()
                }
                canvas.restoreToCount(saveLyrics)

                // Alt Ritmik Dalga + İlerleme Çubuğu + Sunify İmzası
                val barCount = 28
                val vizLeft = 56f
                val vizW = WIDTH - 112f
                val gap = 6f
                val bw = (vizW - gap * (barCount - 1)) / barCount
                val vizBaseY = 1135f
                val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
                for (b in 0 until barCount) {
                    val wave = 0.25f + 0.75f * abs(sin((tSec * 4.2f + b * 0.45f).toDouble())).toFloat()
                    val bh = 10f + wave * 42f
                    val bx = vizLeft + b * (bw + gap)
                    barPaint.color = Color.argb((120 + wave * 120).toInt(), coverRgb[0], coverRgb[1], coverRgb[2])
                    canvas.drawRoundRect(RectF(bx, vizBaseY - bh / 2f, bx + bw, vizBaseY + bh / 2f), bw / 2f, bw / 2f, barPaint)
                }

                // İlerleme çubuğu
                val progRect = RectF(56f, 1185f, WIDTH - 56f, 1193f)
                canvas.drawRoundRect(progRect, 4f, 4f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(70, 255, 255, 255)
                })
                canvas.drawRoundRect(
                    RectF(56f, 1185f, 56f + (WIDTH - 112f) * progress, 1193f),
                    4f, 4f,
                    Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(coverRgb[0], coverRgb[1], coverRgb[2]) }
                )

                drawSunifyLogo(canvas, 76f, 1236f, 18f, coverRgb, 230)
                subPaint.textAlign = Paint.Align.LEFT
                subPaint.textSize = 21f
                subPaint.alpha = 215
                canvas.drawText("Sunify  •  Şarkı Klibi", 106f, 1244f, subPaint)
            }
        } finally {
            coverBmp?.recycle()
            runCatching { tempAudio?.delete() }
        }
    }

    private fun downloadTempAacAudio(
        context: Context,
        audioService: YouTubeAudioService,
        id: String,
        title: String,
        artist: String
    ): File? {
        return runCatching {
            val stream = audioService.resolveAudioStream(id.ifBlank { "$artist $title" }, title, artist)
            val tmp = File(context.cacheDir, "story_audio_${System.currentTimeMillis()}.m4a")
            val req = Request.Builder()
                .url(stream.url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36")
                .build()
            OkHttpDownloader.streamClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use null
                res.body?.byteStream()?.use { ins ->
                    tmp.outputStream().buffered(65536).use { ins.copyTo(it, 65536) }
                }
            }
            if (tmp.exists() && tmp.length() > 4096L) tmp else null
        }.getOrNull()
    }
}
