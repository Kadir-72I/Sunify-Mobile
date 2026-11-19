package com.sunify.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import okhttp3.Request

class MediaPlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "sunify_playback_channel"
        const val NOTIF_ID = 7201
        const val ACTION_UPDATE = "com.sunify.mobile.ACTION_UPDATE"
        const val ACTION_CONTROL = "com.sunify.mobile.ACTION_CONTROL"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_THUMBNAIL = "thumbnail"
        const val EXTRA_DURATION_MS = "durationMs"
        const val EXTRA_POSITION_MS = "positionMs"
        const val EXTRA_LIKED = "liked"
        const val EXTRA_COVER_RGB = "coverRgb"
        const val EXTRA_CONTROL = "control"

        var onMediaAction: ((String) -> Unit)? = null
    }

    private lateinit var mediaSession: MediaSessionCompat
    private val mainHandler = Handler(Looper.getMainLooper())

    private var lastTitle = "Sunify"
    private var lastArtist = "Müzik Çalar"
    private var lastPlaying = false
    private var lastThumbnailUrl = ""
    private var lastDurationMs = 0L
    private var lastPositionMs = 0L
    private var lastLiked = false
    private var lastCoverRgb = "181, 122, 255"
    private var lastArtwork: Bitmap? = null

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
                onMediaAction?.invoke("pause")
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        mediaSession = MediaSessionCompat(this, "SunifyMediaSession").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { onMediaAction?.invoke("play") }
                override fun onPause() { onMediaAction?.invoke("pause") }
                override fun onSkipToNext() { onMediaAction?.invoke("next") }
                override fun onSkipToPrevious() { onMediaAction?.invoke("previous") }
                override fun onSeekTo(pos: Long) { onMediaAction?.invoke("seek:${pos.coerceAtLeast(0L)}") }
            })
            isActive = true
        }
        runCatching {
            ContextCompat.registerReceiver(
                this,
                noisyReceiver,
                IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONTROL -> {
                val cmd = intent.getStringExtra(EXTRA_CONTROL) ?: return START_NOT_STICKY
                onMediaAction?.invoke(cmd)
            }
            ACTION_UPDATE, null -> {
                lastTitle = intent?.getStringExtra(EXTRA_TITLE)?.ifBlank { "Sunify" } ?: "Sunify"
                lastArtist = intent?.getStringExtra(EXTRA_ARTIST)?.ifBlank { "Müzik Çalar" } ?: "Müzik Çalar"
                lastPlaying = intent?.getBooleanExtra(EXTRA_PLAYING, false) ?: false
                lastDurationMs = intent?.getLongExtra(EXTRA_DURATION_MS, 0L) ?: 0L
                lastPositionMs = intent?.getLongExtra(EXTRA_POSITION_MS, 0L) ?: 0L
                lastLiked = intent?.getBooleanExtra(EXTRA_LIKED, false) ?: false
                lastCoverRgb = intent?.getStringExtra(EXTRA_COVER_RGB)?.ifBlank { "181, 122, 255" } ?: "181, 122, 255"

                val nextThumb = intent?.getStringExtra(EXTRA_THUMBNAIL).orEmpty().trim()
                if (nextThumb != lastThumbnailUrl) {
                    lastThumbnailUrl = nextThumb
                    lastArtwork = null
                    if (nextThumb.startsWith("http://", ignoreCase = true) || nextThumb.startsWith("https://", ignoreCase = true)) {
                        fetchArtworkAsync(nextThumb)
                    }
                }
                refreshNotificationAndWidget()
            }
        }
        return START_STICKY
    }

    private fun fetchArtworkAsync(url: String) {
        Thread {
            val bmp = runCatching {
                val req = Request.Builder()
                    .url(url)
                    .header("User-Agent", "Sunify/1.2.1")
                    .build()
                OkHttpDownloader.sharedClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use null
                    val bytes = resp.body?.bytes() ?: return@use null
                    val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@use null
                    val target = 256
                    if (raw.width > target || raw.height > target) {
                        Bitmap.createScaledBitmap(raw, target, target, true).also {
                            if (it !== raw) raw.recycle()
                        }
                    } else {
                        raw
                    }
                }
            }.getOrNull() ?: return@Thread

            mainHandler.post {
                if (lastThumbnailUrl == url) {
                    lastArtwork = bmp
                    refreshNotificationAndWidget()
                }
            }
        }.start()
    }

    private fun refreshNotificationAndWidget() {
        val metaBuilder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist)
        if (lastDurationMs > 0L) {
            metaBuilder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastDurationMs)
        }
        lastArtwork?.let {
            metaBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
            metaBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, it)
        }
        mediaSession.setMetadata(metaBuilder.build())

        val state = if (lastPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_SEEK_TO
                )
                .setState(state, lastPositionMs.coerceAtLeast(0L), if (lastPlaying) 1f else 0f)
                .build()
        )

        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        fun controlIntent(cmd: String, reqCode: Int): PendingIntent {
            val i = Intent(this, MediaPlaybackService::class.java).apply {
                action = ACTION_CONTROL
                putExtra(EXTRA_CONTROL, cmd)
            }
            return PendingIntent.getService(
                this,
                reqCode,
                i,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(lastTitle)
            .setContentText(lastArtist)
            .setSmallIcon(R.drawable.ic_sunify_notif)
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(lastPlaying)
            .addAction(android.R.drawable.ic_media_previous, "Önceki", controlIntent("previous", 1))
            .addAction(
                if (lastPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (lastPlaying) "Duraklat" else "Oynat",
                controlIntent("toggle", 2)
            )
            .addAction(android.R.drawable.ic_media_next, "Sonraki", controlIntent("next", 3))
            .addAction(
                if (lastLiked) R.drawable.ic_sunify_heart_filled else R.drawable.ic_sunify_heart,
                if (lastLiked) "Beğenildi" else "Beğen",
                controlIntent("like", 4)
            )
            .setStyle(
                MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )

        lastArtwork?.let { builder.setLargeIcon(it) }

        val notif: Notification = builder.build()
        startForeground(NOTIF_ID, notif)
        SunifyWidgetProvider.updateAllWidgets(this, lastTitle, lastArtist, lastPlaying, lastArtwork, lastCoverRgb)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Sunify Müzik Oynatma",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(noisyReceiver) }
        mediaSession.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
