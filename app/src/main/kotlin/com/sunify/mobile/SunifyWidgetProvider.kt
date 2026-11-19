package com.sunify.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.widget.RemoteViews
import java.io.File

class SunifyWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val title = prefs.getString("title", "Sunify") ?: "Sunify"
        val artist = prefs.getString("artist", "Müzik Çalınmıyor") ?: "Müzik Çalınmıyor"
        val playing = prefs.getBoolean("playing", false)
        val coverRgb = prefs.getString("coverRgb", "181, 122, 255") ?: "181, 122, 255"
        val bmp = runCatching {
            val f = File(context.cacheDir, COVER_FILE)
            if (f.exists()) BitmapFactory.decodeFile(f.absolutePath) else null
        }.getOrNull()

        for (id in appWidgetIds) {
            appWidgetManager.updateAppWidget(id, buildRemoteViews(context, title, artist, playing, bmp, coverRgb))
        }
    }

    companion object {
        private const val PREFS_NAME = "sunify_widget_state"
        private const val COVER_FILE = "widget_cover.jpg"

        fun updateAllWidgets(
            context: Context,
            title: String,
            artist: String,
            playing: Boolean,
            artwork: Bitmap?,
            coverRgb: String
        ) {
            runCatching {
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                    .putString("title", title)
                    .putString("artist", artist)
                    .putBoolean("playing", playing)
                    .putString("coverRgb", coverRgb)
                    .apply()

                if (artwork != null) {
                    val out = File(context.cacheDir, COVER_FILE)
                    out.outputStream().use { artwork.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                }

                val mgr = AppWidgetManager.getInstance(context)
                val ids = mgr.getAppWidgetIds(ComponentName(context, SunifyWidgetProvider::class.java))
                if (ids.isEmpty()) return
                val views = buildRemoteViews(context, title, artist, playing, artwork, coverRgb)
                for (id in ids) {
                    mgr.updateAppWidget(id, views)
                }
            }
        }

        private fun parseAccentColor(rgbStr: String): Int {
            val parts = rgbStr.split(",").mapNotNull { it.trim().toIntOrNull() }
            if (parts.size == 3) {
                return Color.rgb(parts[0].coerceIn(0, 255), parts[1].coerceIn(0, 255), parts[2].coerceIn(0, 255))
            }
            return Color.rgb(181, 122, 255)
        }

        private fun controlPendingIntent(context: Context, cmd: String, reqCode: Int): PendingIntent {
            val intent = Intent(context, MediaPlaybackService::class.java).apply {
                action = MediaPlaybackService.ACTION_CONTROL
                putExtra(MediaPlaybackService.EXTRA_CONTROL, cmd)
            }
            return PendingIntent.getService(
                context,
                reqCode,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }

        private fun buildRemoteViews(
            context: Context,
            title: String,
            artist: String,
            playing: Boolean,
            artwork: Bitmap?,
            coverRgb: String
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_sunify_player)
            views.setTextViewText(R.id.widgetTitle, title)
            views.setTextViewText(R.id.widgetArtist, artist)
            views.setInt(R.id.widgetAccentDot, "setBackgroundColor", parseAccentColor(coverRgb))

            if (artwork != null) {
                views.setImageViewBitmap(R.id.widgetCover, artwork)
            } else {
                views.setImageViewResource(R.id.widgetCover, R.drawable.ic_sunify_notif)
            }

            views.setImageViewResource(
                R.id.widgetPlayBtn,
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
            )

            val openIntent = PendingIntent.getActivity(
                context,
                10,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            views.setOnClickPendingIntent(R.id.widgetMetaArea, openIntent)
            views.setOnClickPendingIntent(R.id.widgetCover, openIntent)
            views.setOnClickPendingIntent(R.id.widgetPrevBtn, controlPendingIntent(context, "previous", 21))
            views.setOnClickPendingIntent(R.id.widgetPlayBtn, controlPendingIntent(context, "toggle", 22))
            views.setOnClickPendingIntent(R.id.widgetNextBtn, controlPendingIntent(context, "next", 23))
            return views
        }
    }
}
