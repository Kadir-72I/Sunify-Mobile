package com.sunify.mobile

import android.content.Context
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import android.media.audiofx.PresetReverb
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import kotlin.math.abs
import kotlin.math.roundToInt

class NativeAudioPlayer(context: Context) {

    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null

    private var equalizer: Equalizer? = null
    private var loudnessEnhancer: LoudnessEnhancer? = null
    private var presetReverb: PresetReverb? = null
    private var attachedSessionId: Int = C.AUDIO_SESSION_ID_UNSET

    private var currentEqBandsDb = FloatArray(10) { 0f }
    private var currentNormalization = false
    private var currentReverb = 0f
    private var currentRate = 1.0f
    private var currentPreservesPitch = true
    private var currentVolume = 1.0f
    private var pendingSeekMs = 0L

    @Volatile
    var lastPositionSec: Double = 0.0
        private set

    @Volatile
    var lastDurationSec: Double = 0.0
        private set

    @Volatile
    var isCurrentlyPlaying: Boolean = false
        private set

    var onEvent: ((type: String, posSec: Double, durSec: Double, paused: Boolean) -> Unit)? = null

    private val progressTicker = object : Runnable {
        override fun run() {
            val p = player ?: return
            if (p.isPlaying) {
                updateSnapshot(p)
                onEvent?.invoke("timeupdate", lastPositionSec, lastDurationSec, false)
                mainHandler.postDelayed(this, 250L)
            }
        }
    }

    @OptIn(UnstableApi::class)
    private fun ensurePlayer(): ExoPlayer {
        player?.let { return it }
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(15_000, 60_000, 1_500, 3_000)
            .build()
        val attrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val exo = ExoPlayer.Builder(appContext)
            .setLoadControl(loadControl)
            .build()
            .apply {
                setAudioAttributes(attrs, true)
                setHandleAudioBecomingNoisy(true)
                setWakeMode(C.WAKE_MODE_NETWORK)
                volume = currentVolume
                playbackParameters = PlaybackParameters(
                    currentRate,
                    if (currentPreservesPitch) 1.0f else currentRate
                )
                addListener(object : Player.Listener {
                    override fun onPlaybackStateChanged(playbackState: Int) {
                        updateSnapshot(this@apply)
                        when (playbackState) {
                            Player.STATE_READY -> {
                                if (pendingSeekMs > 0L && duration > pendingSeekMs) {
                                    seekTo(pendingSeekMs)
                                    pendingSeekMs = 0L
                                }
                                attachAudioEffectsIfNeeded(audioSessionId)
                                onEvent?.invoke("loadedmetadata", lastPositionSec, lastDurationSec, !isPlaying)
                            }
                            Player.STATE_ENDED -> {
                                mainHandler.removeCallbacks(progressTicker)
                                isCurrentlyPlaying = false
                                onEvent?.invoke("ended", lastDurationSec, lastDurationSec, true)
                            }
                        }
                    }

                    override fun onIsPlayingChanged(isPlaying: Boolean) {
                        isCurrentlyPlaying = isPlaying
                        updateSnapshot(this@apply)
                        mainHandler.removeCallbacks(progressTicker)
                        if (isPlaying) {
                            attachAudioEffectsIfNeeded(audioSessionId)
                            onEvent?.invoke("play", lastPositionSec, lastDurationSec, false)
                            mainHandler.postDelayed(progressTicker, 250L)
                        } else {
                            onEvent?.invoke("pause", lastPositionSec, lastDurationSec, true)
                        }
                    }

                    override fun onAudioSessionIdChanged(audioSessionId: Int) {
                        attachAudioEffectsIfNeeded(audioSessionId)
                    }

                    override fun onPlayerError(error: PlaybackException) {
                        mainHandler.removeCallbacks(progressTicker)
                        isCurrentlyPlaying = false
                        onEvent?.invoke("error", lastPositionSec, lastDurationSec, true)
                    }
                })
            }
        player = exo
        return exo
    }

    private fun updateSnapshot(p: ExoPlayer) {
        val pos = p.currentPosition.coerceAtLeast(0L)
        val dur = if (p.duration != C.TIME_UNSET && p.duration > 0L) p.duration else 0L
        lastPositionSec = pos / 1000.0
        lastDurationSec = dur / 1000.0
    }

    private fun attachAudioEffectsIfNeeded(sessionId: Int) {
        if (sessionId <= 0 || sessionId == C.AUDIO_SESSION_ID_UNSET) return
        if (attachedSessionId == sessionId && equalizer != null) {
            applyAllNativeFx()
            return
        }
        releaseEffects()
        attachedSessionId = sessionId
        runCatching { equalizer = Equalizer(0, sessionId) }
        runCatching { loudnessEnhancer = LoudnessEnhancer(sessionId) }
        runCatching { presetReverb = PresetReverb(0, sessionId) }
        applyAllNativeFx()
    }

    private fun releaseEffects() {
        runCatching { equalizer?.release() }
        runCatching { loudnessEnhancer?.release() }
        runCatching { presetReverb?.release() }
        equalizer = null
        loudnessEnhancer = null
        presetReverb = null
        attachedSessionId = C.AUDIO_SESSION_ID_UNSET
    }

    private fun applyAllNativeFx() {
        val eq = equalizer
        if (eq != null) {
            runCatching {
                val hasEq = currentEqBandsDb.any { abs(it) > 0.05f }
                eq.enabled = hasEq
                if (hasEq) {
                    val bands = eq.numberOfBands.toInt().coerceAtLeast(1)
                    val range = eq.bandLevelRange
                    val minMb = range[0].toInt()
                    val maxMb = range[1].toInt()
                    val jsFreqs = intArrayOf(32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)
                    for (b in 0 until bands) {
                        val centerHz = eq.getCenterFreq(b.toShort()) / 1000
                        var bestIdx = 0
                        var bestDist = Int.MAX_VALUE
                        for (i in jsFreqs.indices) {
                            val d = abs(jsFreqs[i] - centerHz)
                            if (d < bestDist) {
                                bestDist = d
                                bestIdx = i
                            }
                        }
                        val targetMb = (currentEqBandsDb[bestIdx] * 100f).roundToInt().coerceIn(minMb, maxMb)
                        eq.setBandLevel(b.toShort(), targetMb.toShort())
                    }
                }
            }
        }
        val le = loudnessEnhancer
        if (le != null) {
            runCatching {
                le.enabled = currentNormalization
                if (currentNormalization) le.setTargetGain(600)
            }
        }
        val rev = presetReverb
        if (rev != null) {
            runCatching {
                val active = currentReverb > 0.05f
                rev.enabled = active
                if (active) {
                    rev.preset = when {
                        currentReverb < 0.28f -> PresetReverb.PRESET_SMALLROOM
                        currentReverb < 0.58f -> PresetReverb.PRESET_MEDIUMHALL
                        else -> PresetReverb.PRESET_LARGEHALL
                    }
                }
            }
        }
    }

    fun setSourceAndPlay(url: String, autoPlay: Boolean, startSec: Double = 0.0) {
        mainHandler.post {
            val p = ensurePlayer()
            pendingSeekMs = if (startSec > 0.0) (startSec * 1000.0).toLong() else 0L
            lastPositionSec = 0.0
            lastDurationSec = 0.0
            val item = MediaItem.fromUri(Uri.parse(url))
            p.setMediaItem(item)
            p.prepare()
            p.playWhenReady = autoPlay
        }
    }

    fun play() {
        mainHandler.post {
            val p = ensurePlayer()
            p.playWhenReady = true
            p.play()
        }
    }

    fun pause() {
        mainHandler.post {
            player?.pause()
        }
    }

    fun seekToSec(sec: Double) {
        mainHandler.post {
            val p = player ?: return@post
            val targetMs = (sec.coerceAtLeast(0.0) * 1000.0).toLong()
            val clamped = if (p.duration != C.TIME_UNSET && p.duration > 0L) {
                targetMs.coerceIn(0L, p.duration)
            } else targetMs
            p.seekTo(clamped)
            updateSnapshot(p)
            onEvent?.invoke("seeked", lastPositionSec, lastDurationSec, !p.isPlaying)
        }
    }

    fun setVolume(vol: Float) {
        currentVolume = vol.coerceIn(0f, 1f)
        mainHandler.post {
            player?.volume = currentVolume
        }
    }

    fun setSpeedPitch(rate: Float, preservesPitch: Boolean) {
        currentRate = rate.coerceIn(0.75f, 1.35f)
        currentPreservesPitch = preservesPitch
        mainHandler.post {
            player?.playbackParameters = PlaybackParameters(
                currentRate,
                if (currentPreservesPitch) 1.0f else currentRate
            )
        }
    }

    fun setEqBands(bandsDb: FloatArray) {
        if (bandsDb.size >= 10) {
            for (i in 0 until 10) currentEqBandsDb[i] = bandsDb[i].coerceIn(-12f, 12f)
        }
        mainHandler.post {
            val sid = player?.audioSessionId ?: C.AUDIO_SESSION_ID_UNSET
            if (sid > 0) attachAudioEffectsIfNeeded(sid) else applyAllNativeFx()
        }
    }

    fun setNormalization(enabled: Boolean) {
        currentNormalization = enabled
        mainHandler.post {
            val sid = player?.audioSessionId ?: C.AUDIO_SESSION_ID_UNSET
            if (sid > 0) attachAudioEffectsIfNeeded(sid) else applyAllNativeFx()
        }
    }

    fun setReverb(amount: Float) {
        currentReverb = amount.coerceIn(0f, 1f)
        mainHandler.post {
            val sid = player?.audioSessionId ?: C.AUDIO_SESSION_ID_UNSET
            if (sid > 0) attachAudioEffectsIfNeeded(sid) else applyAllNativeFx()
        }
    }

    fun release() {
        mainHandler.post {
            mainHandler.removeCallbacks(progressTicker)
            releaseEffects()
            runCatching { player?.release() }
            player = null
        }
    }
}
