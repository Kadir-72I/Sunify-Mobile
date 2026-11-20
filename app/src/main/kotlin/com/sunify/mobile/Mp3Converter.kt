package com.sunify.mobile

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Process
import com.hualee.lame.LameControl
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

object Mp3Converter {
    private val lameLock = Any()

    fun convertToMp3(
        inputFile: File,
        outputFile: File,
        title: String,
        artist: String,
        coverBytes: ByteArray? = null
    ) {
        val prevPriority = runCatching { Process.getThreadPriority(Process.myTid()) }.getOrDefault(Process.THREAD_PRIORITY_DEFAULT)
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND) }

        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        var lameInitialized = false

        try {
            extractor.setDataSource(inputFile.absolutePath)
            var audioTrackIndex = -1
            var trackFormat: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val fmt = extractor.getTrackFormat(i)
                val mime = fmt.getString(MediaFormat.KEY_MIME).orEmpty()
                if (mime.startsWith("audio/")) {
                    audioTrackIndex = i
                    trackFormat = fmt
                    break
                }
            }
            val inputFormat = trackFormat ?: throw IllegalStateException("Ses kanalı okunamadı.")
            val mime = inputFormat.getString(MediaFormat.KEY_MIME).orEmpty()
            var sampleRate = if (inputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            } else 44100
            var channelCount = if (inputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else 2

            extractor.selectTrack(audioTrackIndex)
            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(inputFormat, null, null, 0)
            codec.start()

            outputFile.parentFile?.mkdirs()
            BufferedOutputStream(FileOutputStream(outputFile), 65536).use { out ->
                val id3Header = buildId3v23Tag(title, artist, "Sunify", coverBytes)
                out.write(id3Header)

                synchronized(lameLock) {
                    try {
                        val bufferInfo = MediaCodec.BufferInfo()
                        val maxChunkSamples = 8192
                        val mp3Buf = ByteArray((1.25 * maxChunkSamples + 7200).toInt().coerceAtLeast(16384))
                        var leftChunk = ShortArray(maxChunkSamples)
                        var rightChunk = ShortArray(maxChunkSamples)
                        var inputDone = false
                        var outputDone = false

                        while (!outputDone) {
                            if (!inputDone) {
                                val inIdx = codec.dequeueInputBuffer(10_000)
                                if (inIdx >= 0) {
                                    val inBuf = codec.getInputBuffer(inIdx)
                                    if (inBuf != null) {
                                        val sampleSize = extractor.readSampleData(inBuf, 0)
                                        if (sampleSize < 0) {
                                            codec.queueInputBuffer(
                                                inIdx, 0, 0, 0L,
                                                MediaCodec.BUFFER_FLAG_END_OF_STREAM
                                            )
                                            inputDone = true
                                        } else {
                                            val pts = extractor.sampleTime.coerceAtLeast(0L)
                                            codec.queueInputBuffer(inIdx, 0, sampleSize, pts, 0)
                                            extractor.advance()
                                        }
                                    }
                                }
                            }

                            val outIdx = codec.dequeueOutputBuffer(bufferInfo, 10_000)
                            when {
                                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                                    val newFmt = codec.outputFormat
                                    if (newFmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                                        sampleRate = newFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                                    }
                                    if (newFmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                                        channelCount = newFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                                    }
                                }

                                outIdx >= 0 -> {
                                    val outBuf: ByteBuffer? = codec.getOutputBuffer(outIdx)
                                    if (outBuf != null && bufferInfo.size > 0 && (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                                        if (!lameInitialized) {
                                            val safeRate = sampleRate.coerceIn(8000, 96000)
                                            LameControl.init(safeRate, 2, safeRate, 192, 4)
                                            lameInitialized = true
                                        }

                                        outBuf.position(bufferInfo.offset)
                                        outBuf.limit(bufferInfo.offset + bufferInfo.size)
                                        outBuf.order(ByteOrder.LITTLE_ENDIAN)

                                        val safeChannels = channelCount.coerceAtLeast(1)
                                        val bytesPerFrame = safeChannels * 2
                                        val totalFrames = bufferInfo.size / bytesPerFrame
                                        val shortBuf = outBuf.asShortBuffer()

                                        var processed = 0
                                        while (processed < totalFrames) {
                                            val count = min(maxChunkSamples, totalFrames - processed)
                                            if (leftChunk.size < count) leftChunk = ShortArray(count)
                                            if (rightChunk.size < count) rightChunk = ShortArray(count)

                                            if (safeChannels == 1) {
                                                for (i in 0 until count) {
                                                    val s = shortBuf.get(processed + i)
                                                    leftChunk[i] = s
                                                    rightChunk[i] = s
                                                }
                                            } else {
                                                for (i in 0 until count) {
                                                    val base = (processed + i) * safeChannels
                                                    leftChunk[i] = shortBuf.get(base)
                                                    rightChunk[i] = shortBuf.get(base + 1)
                                                }
                                            }

                                            val encoded = LameControl.encode(leftChunk, rightChunk, count, mp3Buf)
                                            if (encoded > 0) out.write(mp3Buf, 0, encoded)
                                            processed += count
                                        }
                                    }
                                    val isEos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                                    codec.releaseOutputBuffer(outIdx, false)
                                    if (isEos) outputDone = true
                                }
                            }
                        }

                        if (lameInitialized) {
                            val flushed = LameControl.flush(mp3Buf)
                            if (flushed > 0) out.write(mp3Buf, 0, flushed)
                        }
                        out.flush()
                    } finally {
                        if (lameInitialized) {
                            runCatching { LameControl.close() }
                            lameInitialized = false
                        }
                    }
                }
            }

            if (!outputFile.exists() || outputFile.length() < 2048L) {
                throw IllegalStateException("MP3 dönüştürme çıktı üretemedi.")
            }
        } finally {
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            runCatching { extractor.release() }
            runCatching { Process.setThreadPriority(prevPriority) }
        }
    }

    private fun buildId3v23Tag(
        title: String,
        artist: String,
        album: String,
        coverBytes: ByteArray?
    ): ByteArray {
        val frames = ByteArrayOutputStream()

        fun writeFrame(id: String, payload: ByteArray) {
            frames.write(id.toByteArray(Charsets.US_ASCII))
            val len = payload.size
            frames.write((len shr 24) and 0xFF)
            frames.write((len shr 16) and 0xFF)
            frames.write((len shr 8) and 0xFF)
            frames.write(len and 0xFF)
            frames.write(0)
            frames.write(0)
            frames.write(payload)
        }

        fun writeTextFrame(id: String, value: String) {
            val clean = value.trim()
            if (clean.isEmpty()) return
            val payload = ByteArrayOutputStream()
            payload.write(0x01) // UTF-16 with BOM
            payload.write(0xFF)
            payload.write(0xFE)
            payload.write(clean.toByteArray(Charsets.UTF_16LE))
            writeFrame(id, payload.toByteArray())
        }

        writeTextFrame("TIT2", title.ifBlank { "Bilinmeyen Şarkı" })
        writeTextFrame("TPE1", artist.ifBlank { "Bilinmeyen Sanatçı" })
        writeTextFrame("TALB", album)

        if (coverBytes != null && coverBytes.size in 100..(400 * 1024)) {
            val isPng = coverBytes.size >= 4 &&
                coverBytes[0] == 0x89.toByte() &&
                coverBytes[1] == 0x50.toByte() &&
                coverBytes[2] == 0x4E.toByte() &&
                coverBytes[3] == 0x47.toByte()
            val mime = if (isPng) "image/png" else "image/jpeg"
            val apic = ByteArrayOutputStream()
            apic.write(0x00) // ISO-8859-1 MIME + description
            apic.write(mime.toByteArray(Charsets.US_ASCII))
            apic.write(0x00)
            apic.write(0x03) // Front cover
            apic.write(0x00) // Empty description terminator
            apic.write(coverBytes)
            writeFrame("APIC", apic.toByteArray())
        }

        val frameBytes = frames.toByteArray()
        val tagSize = frameBytes.size
        val header = ByteArray(10)
        header[0] = 'I'.code.toByte()
        header[1] = 'D'.code.toByte()
        header[2] = '3'.code.toByte()
        header[3] = 3 // ID3v2.3
        header[4] = 0
        header[5] = 0
        header[6] = ((tagSize shr 21) and 0x7F).toByte()
        header[7] = ((tagSize shr 14) and 0x7F).toByte()
        header[8] = ((tagSize shr 7) and 0x7F).toByte()
        header[9] = (tagSize and 0x7F).toByte()
        return header + frameBytes
    }
}
