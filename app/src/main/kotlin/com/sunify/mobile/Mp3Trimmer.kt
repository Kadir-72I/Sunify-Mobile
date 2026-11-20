package com.sunify.mobile

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Process
import android.provider.MediaStore
import com.hualee.lame.LameControl
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteOrder
import kotlin.math.min

object Mp3Trimmer {
    private val trimLock = Any()

    data class TrimResult(
        val cacheFile: File,
        val fileName: String,
        val displayPath: String,
        val publicUri: String
    )

    fun trimToMp3(
        context: Context,
        sourceFile: File?,
        sourceUri: Uri?,
        startSec: Double,
        endSec: Double,
        title: String,
        artist: String,
        saveToDownloads: Boolean = true
    ): TrimResult {
        val safeStartSec = startSec.coerceAtLeast(0.0)
        val safeEndSec = endSec.coerceAtLeast(safeStartSec + 1.0)
        val startUs = (safeStartSec * 1_000_000.0).toLong()
        val endUs = (safeEndSec * 1_000_000.0).toLong()

        val prevPriority = runCatching { Process.getThreadPriority(Process.myTid()) }.getOrDefault(Process.THREAD_PRIORITY_DEFAULT)
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND) }

        val clipsDir = File(context.cacheDir, "clips").apply { mkdirs() }
        val cleanBase = "${artist.trim()} - ${title.trim()}"
            .replace(Regex("[\\\\/:*?\"<>|\\r\\n\\t]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .ifEmpty { "Sunify Klip" }
            .take(80)
        val fileName = "$cleanBase (${safeStartSec.toInt()}s-${safeEndSec.toInt()}s).mp3"
        val outFile = File(clipsDir, "clip_${System.currentTimeMillis()}.mp3")

        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        var lameInitialized = false

        try {
            when {
                sourceFile != null && sourceFile.exists() -> extractor.setDataSource(sourceFile.absolutePath)
                sourceUri != null -> extractor.setDataSource(context, sourceUri, null)
                else -> throw IllegalStateException("Kaynak ses dosyası bulunamadı.")
            }

            var audioTrackIndex = -1
            var trackFormat: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val fmt = extractor.getTrackFormat(i)
                if (fmt.getString(MediaFormat.KEY_MIME).orEmpty().startsWith("audio/")) {
                    audioTrackIndex = i
                    trackFormat = fmt
                    break
                }
            }
            val inputFormat = trackFormat ?: throw IllegalStateException("Ses kanalı okunamadı.")
            val mime = inputFormat.getString(MediaFormat.KEY_MIME).orEmpty()
            var sampleRate = if (inputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
            var channelCount = if (inputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2

            extractor.selectTrack(audioTrackIndex)
            if (startUs > 0L) {
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
            }

            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(inputFormat, null, null, 0)
            codec.start()

            BufferedOutputStream(FileOutputStream(outFile), 65536).use { out ->
                synchronized(trimLock) {
                    try {
                        val info = MediaCodec.BufferInfo()
                        val maxChunk = 8192
                        val mp3Buf = ByteArray((1.25 * maxChunk + 7200).toInt().coerceAtLeast(16384))
                        var leftChunk = ShortArray(maxChunk)
                        var rightChunk = ShortArray(maxChunk)
                        var inputDone = false
                        var outputDone = false

                        while (!outputDone) {
                            if (!inputDone) {
                                val inIdx = codec.dequeueInputBuffer(10_000)
                                if (inIdx >= 0) {
                                    val inBuf = codec.getInputBuffer(inIdx)
                                    if (inBuf != null) {
                                        val sampleSize = extractor.readSampleData(inBuf, 0)
                                        val pts = extractor.sampleTime
                                        if (sampleSize < 0 || pts > endUs + 200_000L) {
                                            codec.queueInputBuffer(inIdx, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                            inputDone = true
                                        } else {
                                            codec.queueInputBuffer(inIdx, 0, sampleSize, pts.coerceAtLeast(0L), 0)
                                            extractor.advance()
                                        }
                                    }
                                }
                            }

                            val outIdx = codec.dequeueOutputBuffer(info, 10_000)
                            when {
                                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                                    val nf = codec.outputFormat
                                    if (nf.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = nf.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                                    if (nf.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channelCount = nf.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                                }
                                outIdx >= 0 -> {
                                    val outBuf = codec.getOutputBuffer(outIdx)
                                    val pts = info.presentationTimeUs
                                    if (outBuf != null && info.size > 0 &&
                                        (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 &&
                                        pts >= startUs - 50_000L && pts <= endUs
                                    ) {
                                        if (!lameInitialized) {
                                            val sr = sampleRate.coerceIn(8000, 96000)
                                            LameControl.init(sr, 2, sr, 192, 4)
                                            lameInitialized = true
                                        }
                                        outBuf.position(info.offset)
                                        outBuf.limit(info.offset + info.size)
                                        outBuf.order(ByteOrder.LITTLE_ENDIAN)
                                        val ch = channelCount.coerceAtLeast(1)
                                        val frames = info.size / (ch * 2)
                                        val sb = outBuf.asShortBuffer()
                                        var proc = 0
                                        while (proc < frames) {
                                            val cnt = min(maxChunk, frames - proc)
                                            if (leftChunk.size < cnt) leftChunk = ShortArray(cnt)
                                            if (rightChunk.size < cnt) rightChunk = ShortArray(cnt)
                                            if (ch == 1) {
                                                for (i in 0 until cnt) {
                                                    val s = sb.get(proc + i)
                                                    leftChunk[i] = s
                                                    rightChunk[i] = s
                                                }
                                            } else {
                                                for (i in 0 until cnt) {
                                                    val base = (proc + i) * ch
                                                    leftChunk[i] = sb.get(base)
                                                    rightChunk[i] = sb.get(base + 1)
                                                }
                                            }
                                            val enc = LameControl.encode(leftChunk, rightChunk, cnt, mp3Buf)
                                            if (enc > 0) out.write(mp3Buf, 0, enc)
                                            proc += cnt
                                        }
                                    }
                                    val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0 || pts > endUs
                                    codec.releaseOutputBuffer(outIdx, false)
                                    if (eos) outputDone = true
                                }
                            }
                        }

                        if (lameInitialized) {
                            val flushed = LameControl.flush(mp3Buf)
                            if (flushed > 0) out.write(mp3Buf, 0, flushed)
                        }
                        out.flush()
                    } finally {
                        if (lameInitialized) runCatching { LameControl.close() }
                    }
                }
            }

            if (!outFile.exists() || outFile.length() < 1024L) {
                throw IllegalStateException("MP3 kesme başarısız oldu.")
            }

            var publicUri = ""
            var displayPath = "İndirilenler/Sunify/Klipler/$fileName"
            if (saveToDownloads) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                        put(MediaStore.MediaColumns.MIME_TYPE, "audio/mpeg")
                        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Sunify/Klipler")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    if (uri != null) {
                        context.contentResolver.openOutputStream(uri)?.use { os ->
                            outFile.inputStream().buffered(65536).use { it.copyTo(os, 65536) }
                        }
                        values.clear()
                        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                        context.contentResolver.update(uri, values, null, null)
                        publicUri = uri.toString()
                    }
                } else {
                    runCatching {
                        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Sunify/Klipler")
                        dir.mkdirs()
                        val dst = File(dir, fileName)
                        outFile.copyTo(dst, overwrite = true)
                        MediaScannerConnection.scanFile(context, arrayOf(dst.absolutePath), arrayOf("audio/mpeg"), null)
                        publicUri = dst.absolutePath
                    }
                }
            } else {
                displayPath = fileName
            }

            return TrimResult(outFile, fileName, displayPath, publicUri)
        } finally {
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            runCatching { extractor.release() }
            runCatching { Process.setThreadPriority(prevPriority) }
        }
    }
}
